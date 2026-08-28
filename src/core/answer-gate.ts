/**
 * Answer Gate —— 确定性回复门禁（方案第 6 节）。
 *
 * 只包含机械可判的硬规则；语义判断（相关性、主张蕴含）不在此层。求值顺序固定：
 *   G6（证据过滤，已在 Ledger snapshot 中完成）→ G5 → G4 → G1-G3。
 * 降级正文由 Bridge 固定生成，不经模型；除 CLARIFY 外均携带 [NEED_HUMAN]，
 * 进入现有转人工与卡片审核流。
 */
import {
  buildSourceBlock,
  effectiveGbrainHits,
  effectiveSkillEvidence,
  type MissingParam,
  type LedgerSnapshot,
} from './evidence-ledger';
import { parseReplyPresentation } from './reply-visibility';

export type GateMode = 'off' | 'log-only' | 'enforce';

export type GateDecision =
  | 'pass'
  | 'degrade_no_evidence'
  | 'degrade_tool_failed'
  | 'degrade_clarify';

export type GateRule = 'G1' | 'G2' | 'G3' | 'G4' | 'G5';

export interface GateRuleSwitches {
  g1?: boolean;
  g2?: boolean;
  g3?: boolean;
  g4?: boolean;
}

export interface GateResult {
  decision: GateDecision;
  /** 触发的规则；pass 时记录放行路径（如 G5）。 */
  rule: GateRule | null;
  reasons: string[];
  /** enforce 时替换发送的正文（不含来源块，来源块由调用方追加）。 */
  degradedBody: string | null;
}

export type AnswerDisposition = 'answer' | 'clarify';

/** 契约枚举仅 answer|clarify；need_human 为旧会话兼容输入，解析时归一为
 * "文本标记存在"，不进入类型。转人工的唯一规范写法是正文末行 [NEED_HUMAN]。 */
const DISPOSITION_LINE = /^\s*ANSWER_DISPOSITION:\s*(answer|clarify|need_human)\s*$/m;
const NEED_HUMAN_MARK = '[NEED_HUMAN]';

/** 提取并剥离回复末尾的 ANSWER_DISPOSITION 机读行。缺失 → answer（保守）。
 * 旧会话输出的 need_human 归一为 answer + legacyNeedHuman（转人工信号统一由
 * [NEED_HUMAN] 标记表达，见 restoreNeedHumanMark）。 */
export function extractDisposition(replyText: string): {
  disposition: AnswerDisposition;
  declared: boolean;
  /** 旧契约的 ANSWER_DISPOSITION: need_human——需按标记补齐处理。 */
  legacyNeedHuman: boolean;
  cleanedText: string;
} {
  const match = DISPOSITION_LINE.exec(replyText);
  if (!match) {
    return { disposition: 'answer', declared: false, legacyNeedHuman: false, cleanedText: replyText };
  }
  const raw = match[1]!;
  return {
    disposition: raw === 'clarify' ? 'clarify' : 'answer',
    declared: true,
    legacyNeedHuman: raw === 'need_human',
    cleanedText: replyText.replace(DISPOSITION_LINE, '').trimEnd(),
  };
}

export interface GateInput {
  snapshot: LedgerSnapshot;
  /** 已剥离 disposition 行的模型回复全文。 */
  replyText: string;
  disposition: AnswerDisposition;
}

function needHuman(replyText: string): boolean {
  return replyText.includes(NEED_HUMAN_MARK);
}

function missingParams(snapshot: LedgerSnapshot): MissingParam[] {
  const all = [
    ...(snapshot.routerDecision?.missingParams ?? []),
    ...snapshot.skillCalls.flatMap((call) => call.missingParams ?? []),
  ];
  const byKey = new Map<string, MissingParam>();
  for (const param of all) {
    const existing = byKey.get(param.key);
    if (!existing) {
      byKey.set(param.key, { ...param });
      continue;
    }
    byKey.set(param.key, {
      ...existing,
      ...Object.fromEntries(
        (['label', 'type', 'format', 'group', 'operation'] as const)
          .filter((field) => !existing[field] && param[field])
          .map((field) => [field, param[field]]),
      ),
    });
  }
  return [...byKey.values()];
}

function missingParamsText(params: MissingParam[]): string {
  return params
    .map((param) => {
      const label = param.label?.trim() || param.key;
      const details = [
        param.type ? `类型：${param.type}` : '',
        param.format ? `格式：${param.format}` : '',
      ].filter(Boolean);
      return details.length > 0 ? `${label}（${details.join('，')}）` : label;
    })
    .join('、');
}

/** 降级正文不含 [NEED_HUMAN]——标记由 applyAnswerGate 追加到来源块之后，
 * 这样 split_reply_visibility 会把它归入元数据区而不是用户可见正文。 */
function degradeBodyNoEvidence(snapshot: LedgerSnapshot): string {
  const params = missingParams(snapshot);
  const hint =
    params.length > 0
      ? missingParamsText(params)
      : '可定位的业务信息（如订单号、店铺、SKU）';
  return [
    '结论：当前授权知识库和业务能力中没有找到能直接支持该问题的依据，为避免误导不作推测性回答，本条需人工回复。',
    '',
    `下一步建议：请补充 ${hint}，或等待系统负责人跟进。`,
  ].join('\n');
}

function degradeBodyToolFailed(): string {
  return [
    '结论：本次查询未能完成，暂时无法确认实际情况，本条需人工回复。此次失败不代表业务记录不存在。',
    '',
    '下一步建议：可稍后重试，或等待系统负责人跟进。',
  ].join('\n');
}

function routerSystemFailure(snapshot: LedgerSnapshot): string | null {
  const decision = snapshot.routerDecision;
  if (!decision) return null;

  const precheck = decision.knowledgePrecheck;
  const precheckIncomplete =
    precheck !== undefined &&
    !precheck.completed &&
    !['completed', 'no_hit'].includes(precheck.status);
  const legacyPrecheckMessage = decision.missingParams.some((param) =>
    param.key.includes('知识库预检索完成后才能继续'),
  );
  const explicitlyBlocked =
    decision.reason?.includes('知识库预检索') ||
    (decision.terminal === true &&
      decision.allowedNextAction === 'ask_clarification' &&
      decision.missingParams.length === 0 &&
      precheckIncomplete);

  if (precheckIncomplete && explicitlyBlocked) {
    return `knowledge precheck ${precheck.status}`;
  }
  if (legacyPrecheckMessage) return 'legacy knowledge precheck block';

  const toolCalls =
    snapshot.gbrainCalls.length +
    snapshot.skillCalls.length +
    snapshot.otherToolCalls;
  if (decision.terminal === true && toolCalls > 0) {
    return 'terminal router decision followed by tool execution';
  }
  return null;
}

function degradeBodyClarify(snapshot: LedgerSnapshot): string {
  const params = missingParams(snapshot);
  const ask = params.length > 0 ? missingParamsText(params) : '定位该问题所需的具体业务信息';
  return `请提供 ${ask}，我再继续核查。`;
}

/**
 * 求值门禁。规则开关默认全开；关闭的规则按 pass 处理（灰度用）。
 * 本函数只做判定，不做任何 IO —— log-only / enforce 的差异由调用方处理。
 */
export function evaluateGate(input: GateInput, switches: GateRuleSwitches = {}): GateResult {
  const { snapshot, replyText, disposition } = input;
  const on = (rule: keyof GateRuleSwitches) => switches[rule] !== false;
  const intent = snapshot.routerDecision?.intent ?? 'unknown';
  const reasons: string[] = [];

  // G5：模型诚实转人工 → 放行（现有 NEED_HUMAN 机制接手）。
  if (needHuman(replyText)) {
    return { decision: 'pass', rule: 'G5', reasons: ['model self-escalated'], degradedBody: null };
  }

  // G4：系统编排失败不能伪装成用户缺参。包括知识库预检未完成、旧版
  // ROUTER_DECISION 将系统提示错误写入 missing_params，以及终止路由后仍继续调用工具。
  const systemFailure = routerSystemFailure(snapshot);
  if (on('g4') && systemFailure) {
    return {
      decision: 'degrade_tool_failed',
      rule: 'G4',
      reasons: [systemFailure],
      degradedBody: degradeBodyToolFailed(),
    };
  }

  // G4：router 要求追问，模型却直接作答。
  if (on('g4') && intent === 'clarify' && disposition !== 'clarify') {
    return {
      decision: 'degrade_clarify',
      rule: 'G4',
      reasons: ['router intent=clarify but model answered'],
      degradedBody: degradeBodyClarify(snapshot),
    };
  }

  const hits = effectiveGbrainHits(snapshot);
  const skillOk = effectiveSkillEvidence(snapshot);
  const gbrainAttempted = snapshot.gbrainCalls.length > 0;
  const skillAttempted = snapshot.skillCalls.length > 0;
  const anyToolCalls =
    gbrainAttempted || skillAttempted || snapshot.otherToolCalls > 0;
  const gbrainHadFailure = snapshot.gbrainCalls.some(
    (c) => c.status === 'failed' || c.status === 'parse_failed',
  );
  const requiredParams = missingParams(snapshot);

  // G3：非闲聊/非追问意图，却零工具调用 —— 纯常识作答。
  if (
    on('g3') &&
    intent !== 'chat' &&
    intent !== 'unsupported' &&
    intent !== 'clarify' &&
    intent !== 'unknown' &&
    !anyToolCalls
  ) {
    return {
      decision: 'degrade_no_evidence',
      rule: 'G3',
      reasons: [`intent=${intent} with zero tool calls`],
      degradedBody: degradeBodyNoEvidence(snapshot),
    };
  }

  // G1：知识类意图无任何有效命中（未调用 / 全部 no_hit / 命中全被 G6 剔除）。
  if (on('g1') && (intent === 'knowledge' || intent === 'mixed') && hits.length === 0) {
    if (!gbrainAttempted) reasons.push('gbrain never called');
    else if (gbrainHadFailure) reasons.push('gbrain calls failed');
    else reasons.push('gbrain success but zero relevant hits');
    if (requiredParams.length > 0) {
      return {
        decision: 'degrade_clarify',
        rule: 'G1',
        reasons: [...reasons, 'required parameters are missing'],
        degradedBody: degradeBodyClarify(snapshot),
      };
    }
    // mixed 意图下 Skill 证据可独立支撑实时部分；仅当两路都无效时才降级。
    if (intent !== 'mixed' || skillOk.length === 0) {
      const toolFailed = gbrainHadFailure && gbrainAttempted;
      return {
        decision: toolFailed ? 'degrade_tool_failed' : 'degrade_no_evidence',
        rule: 'G1',
        reasons,
        degradedBody: toolFailed ? degradeBodyToolFailed() : degradeBodyNoEvidence(snapshot),
      };
    }
  }

  // G2：实时类意图无任何有效 Skill 证据。
  if (on('g2') && (intent === 'realtime' || intent === 'mixed') && skillOk.length === 0) {
    // mixed 下知识命中可独立支撑知识部分；仅当两路都无效时才降级（上面 G1 已覆盖
    // 双无效场景，此处只拦 realtime 单意图）。
    if (requiredParams.length > 0) {
      return {
        decision: 'degrade_clarify',
        rule: 'G2',
        reasons: ['mixed: realtime leg has no valid skill evidence', 'required parameters are missing'],
        degradedBody: degradeBodyClarify(snapshot),
      };
    }
    if (intent === 'realtime') {
      return {
        decision: 'degrade_tool_failed',
        rule: 'G2',
        reasons: [skillAttempted ? 'all skill calls failed/unknown' : 'no skill called'],
        degradedBody: degradeBodyToolFailed(),
      };
    }
    reasons.push('mixed: realtime leg has no valid skill evidence');
  }

  return { decision: 'pass', rule: null, reasons, degradedBody: null };
}

/** applyAnswerGate 的输出：最终正文 + 写入审计的门禁字段。 */
export interface GateApplication {
  /** 实际应发送的回复全文（enforce 降级时为降级模板 + 真实来源块）。 */
  finalReplyText: string;
  decision: GateDecision;
  rule: GateRule | null;
  reasons: string[];
  /** enforce 且正文被替换时 true。 */
  replaced: boolean;
  /** 被替换前的模型原文（未替换时为 null）。 */
  originalReplyText: string | null;
  /** 最终正文含 [NEED_HUMAN]（模型自判或 Gate 降级）→ 触发 escalation @。 */
  needHuman: boolean;
  /** 账本快照（审计 JSON 用）。 */
  snapshot: LedgerSnapshot;
}

/**
 * 门禁应用层：判定 + 按模式改写正文。off/log-only 不动正文（仅剥离
 * ANSWER_DISPOSITION 机读行）；enforce 时降级正文由 Bridge 模板 + 真实来源块
 * 组成，pass 正文替换模型来源块为 Bridge 生成的真实来源块（方案 7.1）。
 */
export function applyAnswerGate(opts: {
  replyText: string;
  snapshot: LedgerSnapshot;
  mode: GateMode;
  rules?: GateRuleSwitches;
  system: string;
}): GateApplication {
  const parsed = extractDisposition(opts.replyText);
  const { disposition } = parsed;
  // 统一写法：转人工唯一信号是 [NEED_HUMAN] 标记。旧会话的
  // ANSWER_DISPOSITION: need_human 在此归一——直接把标记补进正文，之后所有
  // 判定（G5、escalation、下游采集）只看标记这一个通道。
  let cleanedText = parsed.cleanedText;
  if (parsed.legacyNeedHuman && !cleanedText.includes(NEED_HUMAN_MARK)) {
    cleanedText = `${cleanedText}\n${NEED_HUMAN_MARK}`;
  }
  const result =
    opts.mode === 'off'
      ? ({ decision: 'pass', rule: null, reasons: [], degradedBody: null } as GateResult)
      : evaluateGate({ snapshot: opts.snapshot, replyText: cleanedText, disposition }, opts.rules);

  const selfEscalated = cleanedText.includes(NEED_HUMAN_MARK);

  let finalReplyText = cleanedText;
  let replaced = false;
  let originalReplyText: string | null = null;

  if (opts.mode === 'enforce') {
    if (result.decision !== 'pass' && result.degradedBody) {
      originalReplyText = cleanedText;
      replaced = true;
      finalReplyText =
        result.decision === 'degrade_clarify'
          ? result.degradedBody // 追问不带来源块（无结论可溯源），也不转人工
          : `${result.degradedBody}\n\n${buildSourceBlock(opts.snapshot, { system: opts.system, degraded: true })}\n${NEED_HUMAN_MARK}`;
    } else {
      // pass：模型来源块（若有）替换为 Bridge 生成的真实来源块。
      const visible = parseReplyPresentation(cleanedText).visibleText;
      if (visible) {
        finalReplyText = `${visible}\n\n${buildSourceBlock(opts.snapshot, { system: opts.system })}`;
        replaced = finalReplyText !== cleanedText;
        if (replaced) originalReplyText = cleanedText;
      }
      // pass 且自判转人工：来源块重写可能吃掉了末行标记 → 补回，保证下游
      // 转人工/审计链路能机读识别。
      if (selfEscalated && !finalReplyText.includes(NEED_HUMAN_MARK)) {
        finalReplyText = `${finalReplyText}\n${NEED_HUMAN_MARK}`;
        replaced = true;
        if (originalReplyText === null) originalReplyText = cleanedText;
      }
    }
  }

  return {
    finalReplyText,
    decision: result.decision,
    rule: result.rule,
    reasons: result.reasons,
    replaced,
    originalReplyText,
    needHuman: selfEscalated || finalReplyText.includes(NEED_HUMAN_MARK),
    snapshot: opts.snapshot,
  };
}
