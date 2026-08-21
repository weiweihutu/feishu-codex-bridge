/**
 * Evidence Ledger —— 单轮消息的进程内证据账本。
 *
 * 从归一化 AgentEvent 流实时记账：gbrain MCP 查询（source_id、命中数、状态）、
 * 业务 Skill 调用（SKILL_EVIDENCE 机读行）、router 意图声明（ROUTER_DECISION
 * 机读行）。账本是 Answer Gate 的唯一事实输入，也用于 Bridge 侧生成真实来源块，
 * 取代模型自述的来源元数据。
 *
 * 契约（与项目模板对齐，均为输出流中的单行 JSON，bridge 不读任何项目配置文件）：
 *   ROUTER_DECISION: {"intent":"knowledge","knowledge_sources":[...],"missing_params":[...]}
 *   SKILL_EVIDENCE: {"skill_id":"bsq-oms-order","status":"success_data","record_count":3}
 */
import type { AgentEvent } from '../agent/types';

/** gbrain 单次查询的确定性状态。success_hit 仅代表"有返回"，不代表相关。 */
export type GbrainCallStatus =
  | 'success_hit'
  | 'success_no_hit'
  | 'failed'
  | 'parse_failed';

export interface GbrainCall {
  sourceId: string | null;
  query: string | null;
  status: GbrainCallStatus;
  hitCount: number;
  /** G6：source 不在本轮 ROUTER_DECISION 声明集合内（有声明时才判定）。 */
  undeclaredSource: boolean;
  elapsedMs: number | null;
}

/** SKILL_EVIDENCE 行的 status 枚举；unknown = 调了 Skill 但未按契约输出。 */
export type SkillCallStatus =
  | 'success_data'
  | 'success_empty'
  | 'not_found'
  | 'failed'
  | 'unauthorized'
  | 'timeout'
  | 'unknown';

const SKILL_STATUSES: ReadonlySet<string> = new Set([
  'success_data',
  'success_empty',
  'not_found',
  'failed',
  'unauthorized',
  'timeout',
]);

export interface SkillCall {
  skillId: string;
  status: SkillCallStatus;
  recordCount: number | null;
}

export type RouterIntent =
  | 'knowledge'
  | 'realtime'
  | 'mixed'
  | 'clarify'
  | 'unsupported'
  | 'chat'
  | 'unknown';

const ROUTER_INTENTS: ReadonlySet<string> = new Set([
  'knowledge',
  'realtime',
  'mixed',
  'clarify',
  'unsupported',
  'chat',
]);

export interface RouterDecision {
  intent: RouterIntent;
  knowledgeSources: string[];
  missingParams: string[];
}

export interface LedgerSnapshot {
  routerDecision: RouterDecision | null;
  gbrainCalls: GbrainCall[];
  skillCalls: SkillCall[];
  /** 非 gbrain、非 Skill 的其余工具调用次数（G3 的"零工具调用"以三者合计判定）。 */
  otherToolCalls: number;
}

const ROUTER_LINE = /^\s*ROUTER_DECISION:\s*(\{.*\})\s*$/m;
const SKILL_LINE = /^\s*SKILL_EVIDENCE:\s*(\{.*\})\s*$/gm;

function parseJsonLine(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];
}

/** 从 router 工具输出提取声明行；无或非法 → null（Gate 按保守处理）。 */
export function parseRouterDecision(output: string): RouterDecision | null {
  const match = ROUTER_LINE.exec(output);
  if (!match?.[1]) return null;
  const obj = parseJsonLine(match[1]);
  if (!obj) return null;
  const rawIntent = typeof obj.intent === 'string' ? obj.intent : '';
  return {
    intent: ROUTER_INTENTS.has(rawIntent) ? (rawIntent as RouterIntent) : 'unknown',
    knowledgeSources: stringArray(obj.knowledge_sources),
    missingParams: stringArray(obj.missing_params),
  };
}

/** 从任意工具输出提取全部 SKILL_EVIDENCE 行（一次执行可能串多个 Skill 步骤）。 */
export function parseSkillEvidence(output: string): SkillCall[] {
  const calls: SkillCall[] = [];
  for (const match of output.matchAll(SKILL_LINE)) {
    const obj = match[1] ? parseJsonLine(match[1]) : null;
    if (!obj || typeof obj.skill_id !== 'string' || !obj.skill_id) continue;
    const rawStatus = typeof obj.status === 'string' ? obj.status : '';
    calls.push({
      skillId: obj.skill_id,
      status: SKILL_STATUSES.has(rawStatus) ? (rawStatus as SkillCallStatus) : 'unknown',
      recordCount: typeof obj.record_count === 'number' ? obj.record_count : null,
    });
  }
  return calls;
}

/**
 * gbrain MCP 结果的命中数。返回体是 MCP content 包装的 JSON 数组文本；解析不出
 * 结构时返回 null（parse_failed，保守处理），空数组 → 0。
 */
export function parseGbrainHitCount(output: string): number | null {
  const trimmed = output.trim();
  if (!trimmed) return 0;
  try {
    const envelope = JSON.parse(trimmed);
    let text = '';
    if (envelope && typeof envelope === 'object' && Array.isArray(envelope.content)) {
      for (const part of envelope.content) {
        if (part && part.type === 'text' && typeof part.text === 'string') text += part.text;
      }
    } else if (typeof envelope === 'string') {
      text = envelope;
    } else if (Array.isArray(envelope)) {
      return envelope.length;
    }
    const body = text.trim();
    if (!body) return 0;
    const results = JSON.parse(body);
    return Array.isArray(results) ? results.length : null;
  } catch {
    return null;
  }
}

interface PendingTool {
  isGbrain: boolean;
  sourceId: string | null;
  query: string | null;
  startedAt: number;
}

/**
 * 消费本轮 AgentEvent 流。所有方法都不抛错：账本损坏不能影响消息处理，
 * 缺失的信息一律落到保守取值（unknown / parse_failed）。
 */
export class EvidenceLedger {
  private pending = new Map<string, PendingTool>();
  private gbrainCalls: GbrainCall[] = [];
  private skillCalls: SkillCall[] = [];
  private otherToolCalls = 0;
  private routerDecision: RouterDecision | null = null;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  observe(event: AgentEvent): void {
    try {
      if (event.type === 'tool_use') this.onToolUse(event);
      else if (event.type === 'tool_result') this.onToolResult(event);
    } catch {
      // Ledger bookkeeping must never break the turn.
    }
  }

  private onToolUse(event: Extract<AgentEvent, { type: 'tool_use' }>): void {
    const isGbrain = event.toolType === 'mcp' && event.server === 'gbrain';
    let sourceId: string | null = null;
    let query: string | null = null;
    if (isGbrain && event.toolInput && typeof event.toolInput === 'object') {
      const input = event.toolInput as Record<string, unknown>;
      if (typeof input.source_id === 'string') sourceId = input.source_id;
      if (typeof input.query === 'string') query = input.query;
    }
    this.pending.set(event.itemId, { isGbrain, sourceId, query, startedAt: this.now() });
  }

  private onToolResult(event: Extract<AgentEvent, { type: 'tool_result' }>): void {
    const started = this.pending.get(event.itemId);
    this.pending.delete(event.itemId);
    const output = event.output ?? '';
    const failed = Boolean(event.error) || event.status === 'error';
    const isGbrain =
      started?.isGbrain ?? (event.toolType === 'mcp' && event.server === 'gbrain');

    if (isGbrain) {
      let status: GbrainCallStatus;
      let hitCount = 0;
      if (failed) {
        status = 'failed';
      } else {
        const parsed = parseGbrainHitCount(output);
        if (parsed === null) status = 'parse_failed';
        else {
          hitCount = parsed;
          status = parsed > 0 ? 'success_hit' : 'success_no_hit';
        }
      }
      this.gbrainCalls.push({
        sourceId: started?.sourceId ?? null,
        query: started?.query ?? null,
        status,
        hitCount,
        undeclaredSource: false, // resolved in snapshot() once router decision is known
        elapsedMs: started ? this.now() - started.startedAt : null,
      });
      return;
    }

    // Non-gbrain output may carry router / skill machine-readable lines.
    if (!this.routerDecision) {
      const decision = parseRouterDecision(output);
      if (decision) {
        this.routerDecision = decision;
        return; // router 执行本身不计入"其他工具调用"
      }
    }
    const skills = parseSkillEvidence(output);
    if (skills.length > 0) {
      this.skillCalls.push(...skills);
      return;
    }
    this.otherToolCalls += 1;
  }

  snapshot(): LedgerSnapshot {
    const declared = new Set(this.routerDecision?.knowledgeSources ?? []);
    const gbrainCalls = this.gbrainCalls.map((call) => ({
      ...call,
      undeclaredSource:
        declared.size > 0 && call.sourceId !== null && !declared.has(call.sourceId),
    }));
    return {
      routerDecision: this.routerDecision,
      gbrainCalls,
      skillCalls: [...this.skillCalls],
      otherToolCalls: this.otherToolCalls,
    };
  }
}

const GBRAIN_STATUS_LABEL: Record<GbrainCallStatus, string> = {
  success_hit: '命中',
  success_no_hit: '未命中',
  failed: '查询失败',
  parse_failed: '结果异常',
};

const SKILL_STATUS_LABEL: Record<SkillCallStatus, string> = {
  success_data: '成功',
  success_empty: '返回为空',
  not_found: '系统确认不存在',
  failed: '失败',
  unauthorized: '无权限',
  timeout: '超时',
  unknown: '状态未知',
};

/** 有效证据判定（与 Answer Gate 共用）：G6 剔除未声明源后的真实命中。 */
export function effectiveGbrainHits(snapshot: LedgerSnapshot): GbrainCall[] {
  return snapshot.gbrainCalls.filter(
    (c) => c.status === 'success_hit' && !c.undeclaredSource,
  );
}

export function effectiveSkillEvidence(snapshot: LedgerSnapshot): SkillCall[] {
  return snapshot.skillCalls.filter(
    (c) =>
      c.status === 'success_data' ||
      c.status === 'success_empty' ||
      c.status === 'not_found',
  );
}

/**
 * Bridge 生成的真实来源块（方案 7.1）。多知识库/多 Skill 逐项列出并带状态；
 * `来源：` 行按账本聚合机械判定。`degraded` 时固定为"未确认"。
 */
export function buildSourceBlock(
  snapshot: LedgerSnapshot,
  options: { system: string; degraded?: boolean },
): string {
  const hits = effectiveGbrainHits(snapshot);
  const skillOk = snapshot.skillCalls.filter((c) => c.status === 'success_data');
  const anyCalls = snapshot.gbrainCalls.length > 0 || snapshot.skillCalls.length > 0;

  let origin: string;
  if (options.degraded) origin = '未确认';
  else if (hits.length > 0 && skillOk.length > 0) origin = '组合来源';
  else if (hits.length > 0) origin = '知识库';
  else if (skillOk.length > 0) origin = '系统实时查询';
  else if (anyCalls) origin = '查询失败';
  else origin = '未确认';

  const kbLine =
    snapshot.gbrainCalls.length > 0
      ? snapshot.gbrainCalls
          .map((c) => {
            const label =
              c.status === 'success_hit'
                ? `命中${c.hitCount}条`
                : GBRAIN_STATUS_LABEL[c.status];
            const flag = c.undeclaredSource ? '、未声明源' : '';
            return `${c.sourceId ?? '未知source'}(${label}${flag})`;
          })
          .join('、')
      : '未查询';

  const skillLine =
    snapshot.skillCalls.length > 0
      ? snapshot.skillCalls
          .map((c) => `${c.skillId}(${SKILL_STATUS_LABEL[c.status]})`)
          .join('、')
      : '未调用';

  const boundary: string[] = [];
  for (const c of snapshot.gbrainCalls) {
    if (c.status === 'failed' || c.status === 'parse_failed') {
      boundary.push(`${c.sourceId ?? '知识库'}查询未完成`);
    }
    if (c.undeclaredSource) boundary.push(`${c.sourceId} 不在本轮路由声明内，其结果未采信`);
  }
  for (const c of snapshot.skillCalls) {
    if (c.status !== 'success_data' && c.status !== 'success_empty' && c.status !== 'not_found') {
      boundary.push(`${c.skillId} 实时核验未完成`);
    }
  }
  const note = boundary.length > 0 ? boundary.join('；') : '无';

  return [
    `来源：${origin}`,
    `系统：${options.system}`,
    `知识库：${kbLine}`,
    `Skill：${skillLine}`,
    `说明：${note}`,
  ].join('\n');
}
