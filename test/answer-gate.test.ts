import { describe, expect, it } from 'vitest';
import { applyAnswerGate, evaluateGate, extractDisposition } from '../src/core/answer-gate';
import type { LedgerSnapshot, RouterIntent } from '../src/core/evidence-ledger';

function snap(partial: Partial<LedgerSnapshot> & { intent?: RouterIntent }): LedgerSnapshot {
  const { intent, ...rest } = partial;
  return {
    routerDecision:
      intent === undefined
        ? null
        : { intent, knowledgeSources: [], missingParams: [] },
    gbrainCalls: [],
    skillCalls: [],
    otherToolCalls: 0,
    ...rest,
  };
}

const hit = { sourceId: 's', query: 'q', status: 'success_hit' as const, hitCount: 2, undeclaredSource: false, elapsedMs: 1 };
const noHit = { ...hit, status: 'success_no_hit' as const, hitCount: 0 };
const failedCall = { ...hit, status: 'failed' as const, hitCount: 0 };
const undeclaredHit = { ...hit, undeclaredSource: true };
const skillData = { skillId: 'sk', status: 'success_data' as const, recordCount: 1 };
const skillFail = { skillId: 'sk', status: 'failed' as const, recordCount: null };

describe('extractDisposition', () => {
  it('parses and strips the machine line; defaults to answer', () => {
    const r = extractDisposition('回答正文\nANSWER_DISPOSITION: clarify');
    expect(r.disposition).toBe('clarify');
    expect(r.declared).toBe(true);
    expect(r.cleanedText).toBe('回答正文');
    expect(extractDisposition('no line').disposition).toBe('answer');
  });

  it('normalizes legacy need_human to answer + legacyNeedHuman', () => {
    const r = extractDisposition('正文\nANSWER_DISPOSITION: need_human');
    expect(r.disposition).toBe('answer');
    expect(r.legacyNeedHuman).toBe(true);
  });
});

describe('evaluateGate', () => {
  it('G5: self-escalated replies pass untouched', () => {
    const r = evaluateGate({
      snapshot: snap({ intent: 'knowledge' }),
      replyText: '结论：需要人工。\n[NEED_HUMAN]',
      disposition: 'answer',
    });
    expect(r).toMatchObject({ decision: 'pass', rule: 'G5' });
  });

  it('G4: clarify intent answered directly is degraded to a clarify ask', () => {
    const r = evaluateGate({
      snapshot: snap({ intent: 'clarify' }),
      replyText: '这是编出来的答案',
      disposition: 'answer',
    });
    expect(r.decision).toBe('degrade_clarify');
    expect(r.rule).toBe('G4');
  });

  it('treats an incomplete knowledge precheck as a system failure requiring human reply', () => {
    const r = evaluateGate({
      snapshot: snap({
        routerDecision: {
          intent: 'clarify',
          knowledgeSources: [],
          missingParams: [],
          terminal: true,
          allowedNextAction: 'ask_clarification',
          knowledgePrecheck: { status: 'not_configured', completed: false },
          reason: '知识库预检索未完成，不能安全判断当前事实需求',
        },
        skillCalls: [skillFail],
      }),
      replyText: '请补充知识库预检索完成后才能继续当前查询，请稍后重试。',
      disposition: 'answer',
    });
    expect(r).toMatchObject({ decision: 'degrade_tool_failed', rule: 'G4' });
    expect(r.reasons).toContain('knowledge precheck not_configured');
    expect(r.degradedBody).toContain('本条需人工回复');
  });

  it('keeps the 4139-era legacy precheck message out of the user missing-param path', () => {
    const r = evaluateGate({
      snapshot: snap({
        intent: 'clarify',
        routerDecision: {
          intent: 'clarify',
          knowledgeSources: [],
          missingParams: [{ key: '知识库预检索完成后才能继续当前查询，请稍后重试。' }],
        },
      }),
      replyText: '请提供 知识库预检索完成后才能继续当前查询，请稍后重试。，我再继续核查。',
      disposition: 'answer',
    });
    expect(r).toMatchObject({ decision: 'degrade_tool_failed', rule: 'G4' });
    expect(r.degradedBody).toContain('本条需人工回复');
    expect(r.degradedBody).not.toContain('请提供 知识库预检索完成后');
  });

  it('escalates when a terminal router decision is followed by tool execution', () => {
    const r = evaluateGate({
      snapshot: snap({
        routerDecision: {
          intent: 'clarify',
          knowledgeSources: [],
          missingParams: [],
          terminal: true,
          allowedNextAction: 'ask_clarification',
          reason: '知识库预检索未完成',
        },
        gbrainCalls: [hit],
      }),
      replyText: '我已经查到结果',
      disposition: 'answer',
    });
    expect(r).toMatchObject({ decision: 'degrade_tool_failed', rule: 'G4' });
    expect(r.reasons).toContain('terminal router decision followed by tool execution');
  });

  it('G3: knowledge intent with zero tool calls is blocked', () => {
    const r = evaluateGate({
      snapshot: snap({ intent: 'knowledge' }),
      replyText: '常识回答',
      disposition: 'answer',
    });
    expect(r).toMatchObject({ decision: 'degrade_no_evidence', rule: 'G3' });
    expect(r.degradedBody).toContain('需人工回复'); // [NEED_HUMAN] 标记由 applyAnswerGate 追加在来源块后
  });

  it('G3 does not fire for chat/unknown intents or when tools ran', () => {
    for (const intent of ['chat', 'unsupported', 'unknown'] as const) {
      expect(
        evaluateGate({ snapshot: snap({ intent }), replyText: 'x', disposition: 'answer' }).decision,
      ).toBe('pass');
    }
    expect(
      evaluateGate({
        snapshot: snap({ intent: 'knowledge', otherToolCalls: 1, gbrainCalls: [hit] }),
        replyText: 'x',
        disposition: 'answer',
      }).decision,
    ).toBe('pass');
  });

  it('G1: knowledge intent with only no-hits degrades as NO_EVIDENCE', () => {
    const r = evaluateGate({
      snapshot: snap({ intent: 'knowledge', gbrainCalls: [noHit, noHit] }),
      replyText: '硬答',
      disposition: 'answer',
    });
    expect(r).toMatchObject({ decision: 'degrade_no_evidence', rule: 'G1' });
  });

  it('G1: failures degrade as TOOL_FAILED, undeclared-only hits count as none', () => {
    expect(
      evaluateGate({
        snapshot: snap({ intent: 'knowledge', gbrainCalls: [failedCall] }),
        replyText: 'x',
        disposition: 'answer',
      }),
    ).toMatchObject({ decision: 'degrade_tool_failed', rule: 'G1' });
    expect(
      evaluateGate({
        snapshot: snap({ intent: 'knowledge', gbrainCalls: [undeclaredHit] }),
        replyText: 'x',
        disposition: 'answer',
      }).decision,
    ).toBe('degrade_no_evidence');
  });

  it('G1 mixed: valid skill evidence keeps the reply alive', () => {
    const r = evaluateGate({
      snapshot: snap({ intent: 'mixed', gbrainCalls: [noHit], skillCalls: [skillData] }),
      replyText: 'x',
      disposition: 'answer',
    });
    expect(r.decision).toBe('pass');
  });

  it('mixed validation errors use producer-owned parameter metadata', () => {
    const r = evaluateGate({
      snapshot: snap({
        intent: 'mixed',
        skillCalls: [
          {
            skillId: 'bsq-ops-sales-performance',
            status: 'validation_error',
            recordCount: null,
            operation: 'queryAsinStationSales',
            missingParams: [
              {
                key: 'searchBeginTime',
                label: '查询开始时间',
                type: 'Date',
                format: 'YYYY-MM-DD',
              },
              {
                key: 'searchEndTime',
                label: '查询结束时间',
                type: 'Date',
                format: 'YYYY-MM-DD',
              },
            ],
          },
        ],
      }),
      replyText: '硬答',
      disposition: 'answer',
    });
    expect(r.decision).toBe('degrade_clarify');
    expect(r.rule).toBe('G1');
    expect(r.degradedBody).toContain('查询开始时间（类型：Date，格式：YYYY-MM-DD）');
    expect(r.degradedBody).toContain('查询结束时间（类型：Date，格式：YYYY-MM-DD）');
    expect(r.degradedBody).not.toContain('销量');
    expect(r.degradedBody).not.toContain('广告');
    expect(r.degradedBody).not.toContain('店铺');
    expect(r.degradedBody).not.toContain('ASIN');
  });

  it('uses a different producer-owned label for the same generic keys', () => {
    const r = evaluateGate({
      snapshot: snap({
        intent: 'realtime',
        skillCalls: [
          {
            skillId: 'bsq-tms-reconciliation',
            status: 'validation_error',
            recordCount: null,
            missingParams: [
              {
                key: 'startTime',
                label: '对账开始时间',
                type: 'Date',
                format: 'YYYY-MM-DD',
              },
              {
                key: 'endTime',
                label: '对账结束时间',
                type: 'Date',
                format: 'YYYY-MM-DD',
              },
            ],
          },
        ],
      }),
      replyText: '硬答',
      disposition: 'answer',
    });
    expect(r.decision).toBe('degrade_clarify');
    expect(r.degradedBody).toContain('对账开始时间（类型：Date，格式：YYYY-MM-DD）');
    expect(r.degradedBody).toContain('对账结束时间（类型：Date，格式：YYYY-MM-DD）');
    expect(r.degradedBody).not.toContain('销量');
    expect(r.degradedBody).not.toContain('广告');
  });

  it('merges router and skill missing parameters by key', () => {
    const r = evaluateGate({
      snapshot: snap({
        intent: 'realtime',
        routerDecision: {
          intent: 'realtime',
          knowledgeSources: [],
          missingParams: [{ key: 'startTime' }, { key: 'shopId', label: '店铺' }],
        },
        skillCalls: [
          {
            skillId: 'bsq-tms-reconciliation',
            status: 'validation_error',
            recordCount: null,
            missingParams: [
              { key: 'startTime', label: '对账开始时间', format: 'YYYY-MM-DD' },
              { key: 'endTime', label: '对账结束时间' },
            ],
          },
        ],
      }),
      replyText: '硬答',
      disposition: 'answer',
    });
    expect(r.degradedBody).toContain('对账开始时间（格式：YYYY-MM-DD）');
    expect(r.degradedBody).toContain('店铺');
    expect(r.degradedBody).toContain('对账结束时间');
    expect(r.degradedBody).not.toMatch(/startTime.*startTime/);
  });

  it('G2: realtime intent with failed/absent skills degrades as TOOL_FAILED', () => {
    expect(
      evaluateGate({
        snapshot: snap({ intent: 'realtime', skillCalls: [skillFail] }),
        replyText: 'x',
        disposition: 'answer',
      }),
    ).toMatchObject({ decision: 'degrade_tool_failed', rule: 'G2' });
    // success_empty is valid evidence ("查了但为空" is an honest answer)
    expect(
      evaluateGate({
        snapshot: snap({
          intent: 'realtime',
          skillCalls: [{ skillId: 'sk', status: 'success_empty', recordCount: 0 }],
        }),
        replyText: 'x',
        disposition: 'answer',
      }).decision,
    ).toBe('pass');
  });

  it('rule switches disable individual rules', () => {
    const r = evaluateGate(
      { snapshot: snap({ intent: 'knowledge' }), replyText: 'x', disposition: 'answer' },
      { g3: false, g1: false },
    );
    expect(r.decision).toBe('pass');
  });

  it('passes evidence-backed replies', () => {
    const r = evaluateGate({
      snapshot: snap({ intent: 'knowledge', gbrainCalls: [hit] }),
      replyText: '有依据的回答',
      disposition: 'answer',
    });
    expect(r.decision).toBe('pass');
  });
});

describe('applyAnswerGate', () => {
  it('off mode never rewrites, only strips the disposition line', () => {
    const r = applyAnswerGate({
      replyText: '正文\nANSWER_DISPOSITION: answer',
      snapshot: snap({ intent: 'knowledge' }),
      mode: 'off',
      system: 'OMS',
    });
    expect(r).toMatchObject({ decision: 'pass', replaced: false, finalReplyText: '正文' });
  });

  it('log-only records the decision but keeps the model text', () => {
    const r = applyAnswerGate({
      replyText: '常识硬答',
      snapshot: snap({ intent: 'knowledge' }),
      mode: 'log-only',
      system: 'OMS',
    });
    expect(r.decision).toBe('degrade_no_evidence');
    expect(r.replaced).toBe(false);
    expect(r.finalReplyText).toBe('常识硬答');
  });

  it('enforce replaces the body with template + real source block + NEED_HUMAN', () => {
    const r = applyAnswerGate({
      replyText: '常识硬答',
      snapshot: snap({ intent: 'knowledge' }),
      mode: 'enforce',
      system: 'OMS',
    });
    expect(r.replaced).toBe(true);
    expect(r.originalReplyText).toBe('常识硬答');
    expect(r.needHuman).toBe(true);
    expect(r.finalReplyText).toContain('需人工回复');
    expect(r.finalReplyText).toContain('来源：未确认');
    expect(r.finalReplyText.trimEnd().endsWith('[NEED_HUMAN]')).toBe(true);
  });

  it('enforce pass rewrites the model source block with the ledger one', () => {
    const r = applyAnswerGate({
      replyText: '结论：有据回答。\n\n来源：知识库\n系统：OMS\n知识库：模型胡写的source\n说明：无',
      snapshot: snap({ intent: 'knowledge', gbrainCalls: [hit] }),
      mode: 'enforce',
      system: 'OMS',
    });
    expect(r.decision).toBe('pass');
    expect(r.finalReplyText).toContain('结论：有据回答。');
    expect(r.finalReplyText).not.toContain('模型胡写的source');
    expect(r.finalReplyText).toContain('来源：知识库');
  });

  it('legacy need_human disposition restores the marker and flags needHuman', () => {
    // 旧会话契约：只声明 ANSWER_DISPOSITION: need_human、正文无 [NEED_HUMAN] 标记
    const r = applyAnswerGate({
      replyText: '结论：超出能力范围。\n\n来源：未确认\n系统：OMS\n知识库：未查询\n说明：无\nANSWER_DISPOSITION: need_human',
      snapshot: snap({ intent: 'unsupported' }),
      mode: 'enforce',
      system: 'OMS',
    });
    expect(r.decision).toBe('pass');
    expect(r.rule).toBe('G5');
    expect(r.needHuman).toBe(true);
    expect(r.finalReplyText.trimEnd().endsWith('[NEED_HUMAN]')).toBe(true);
  });

  it('enforce clarify degrade asks a question without NEED_HUMAN', () => {
    const r = applyAnswerGate({
      replyText: '硬答了',
      snapshot: {
        routerDecision: {
          intent: 'clarify',
          knowledgeSources: [],
          missingParams: [{ key: '订单号' }],
        },
        gbrainCalls: [],
        skillCalls: [],
        otherToolCalls: 0,
      },
      mode: 'enforce',
      system: 'OMS',
    });
    expect(r.decision).toBe('degrade_clarify');
    expect(r.finalReplyText).toContain('订单号');
    expect(r.needHuman).toBe(false);
  });
});
