import { describe, expect, it } from 'vitest';
import {
  EvidenceLedger,
  buildSourceBlock,
  effectiveGbrainHits,
  parseGbrainHitCount,
  parseRouterDecision,
  parseSkillEvidence,
} from '../src/core/evidence-ledger';
import type { AgentEvent } from '../src/agent/types';

function gbrainUse(itemId: string, sourceId: string, query = 'q'): AgentEvent {
  return {
    type: 'tool_use',
    itemId,
    title: 'gbrain query',
    toolType: 'mcp',
    server: 'gbrain',
    tool: 'query',
    toolInput: { source_id: sourceId, query },
  };
}

function gbrainResult(itemId: string, output: string, error?: unknown): AgentEvent {
  return {
    type: 'tool_result',
    itemId,
    output,
    toolType: 'mcp',
    server: 'gbrain',
    error,
  };
}

function shellResult(itemId: string, output: string): AgentEvent[] {
  return [
    { type: 'tool_use', itemId, title: 'bash', toolType: 'command' },
    { type: 'tool_result', itemId, output, toolType: 'command' },
  ];
}

const mcpEnvelope = (arr: unknown[]) =>
  JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(arr) }] });

describe('parseRouterDecision', () => {
  it('parses a well-formed line', () => {
    const out = `分类完成\nROUTER_DECISION: {"intent":"knowledge","knowledge_sources":["oms-business-wiki"],"missing_params":[]}\n`;
    const d = parseRouterDecision(out)!;
    expect(d.intent).toBe('knowledge');
    expect(d.knowledgeSources).toEqual(['oms-business-wiki']);
  });

  it('preserves terminal, precheck, and reason fields from the router contract', () => {
    const d = parseRouterDecision(
      'ROUTER_DECISION: {"intent":"clarify","terminal":true,"allowed_next_action":"ask_clarification","knowledge_precheck":{"status":"not_configured","completed":false},"missing_params":[],"reason":"知识库预检索未完成"}',
    )!;
    expect(d).toMatchObject({
      intent: 'clarify',
      terminal: true,
      allowedNextAction: 'ask_clarification',
      missingParams: [],
      reason: '知识库预检索未完成',
      knowledgePrecheck: {
        status: 'not_configured',
        completed: false,
      },
    });
  });

  it('maps unknown intent values to unknown, missing line to null', () => {
    expect(parseRouterDecision('ROUTER_DECISION: {"intent":"weird"}')!.intent).toBe('unknown');
    expect(parseRouterDecision('no line here')).toBeNull();
    expect(parseRouterDecision('ROUTER_DECISION: not-json')).toBeNull();
  });
});

describe('parseSkillEvidence', () => {
  it('parses multiple lines and tolerates bad ones', () => {
    const out = [
      'SKILL_EVIDENCE: {"skill_id":"bsq-oms-order","status":"success_data","record_count":3}',
      'SKILL_EVIDENCE: {"skill_id":"bsq-oms-base","status":"nonsense"}',
      'SKILL_EVIDENCE: {"status":"success_data"}',
    ].join('\n');
    const calls = parseSkillEvidence(out);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ skillId: 'bsq-oms-order', status: 'success_data', recordCount: 3 });
    expect(calls[1]!.status).toBe('unknown');
  });

  it('parses structured validation details from Skill evidence', () => {
    const calls = parseSkillEvidence(
      'SKILL_EVIDENCE: {"skill_id":"bsq-ops-sales-performance","status":"validation_error","operation":"queryAsinStationSales","missing_params":[{"key":"searchBeginTime","label":"查询开始时间","type":"Date","format":"YYYY-MM-DD"},{"key":"searchEndTime","label":"查询结束时间","type":"Date","format":"YYYY-MM-DD"}],"message":"缺少查询开始时间、查询结束时间"}',
    );
    expect(calls).toEqual([
      {
        skillId: 'bsq-ops-sales-performance',
        status: 'validation_error',
        recordCount: null,
        operation: 'queryAsinStationSales',
        missingParams: [
          { key: 'searchBeginTime', label: '查询开始时间', type: 'Date', format: 'YYYY-MM-DD' },
          { key: 'searchEndTime', label: '查询结束时间', type: 'Date', format: 'YYYY-MM-DD' },
        ],
        message: '缺少查询开始时间、查询结束时间',
      },
    ]);
  });

  it('keeps legacy string missing parameters compatible', () => {
    const calls = parseSkillEvidence(
      'SKILL_EVIDENCE: {"skill_id":"bsq-oms-order","status":"validation_error","missing_params":["startTime","endTime"]}',
    );
    expect(calls[0]?.missingParams).toEqual([{ key: 'startTime' }, { key: 'endTime' }]);
  });
});

describe('parseGbrainHitCount', () => {
  it('counts results inside the MCP envelope', () => {
    expect(parseGbrainHitCount(mcpEnvelope([{ title: 'a' }, { title: 'b' }]))).toBe(2);
    expect(parseGbrainHitCount(mcpEnvelope([]))).toBe(0);
    expect(parseGbrainHitCount('')).toBe(0);
  });

  it('returns null on unparseable payloads (parse_failed)', () => {
    expect(parseGbrainHitCount('plain prose, not json')).toBeNull();
    expect(parseGbrainHitCount('{"content":[{"type":"text","text":"prose"}]}')).toBeNull();
  });
});

describe('EvidenceLedger', () => {
  it('books gbrain hits, no-hits, failures and undeclared sources', () => {
    const ledger = new EvidenceLedger(() => 1000);
    for (const ev of shellResult('r1', 'ROUTER_DECISION: {"intent":"knowledge","knowledge_sources":["oms-business-wiki"]}')) {
      ledger.observe(ev);
    }
    ledger.observe(gbrainUse('g1', 'oms-business-wiki'));
    ledger.observe(gbrainResult('g1', mcpEnvelope([{ t: 1 }])));
    ledger.observe(gbrainUse('g2', 'ops-business-wiki'));
    ledger.observe(gbrainResult('g2', mcpEnvelope([{ t: 1 }])));
    ledger.observe(gbrainUse('g3', 'oms-business-wiki'));
    ledger.observe(gbrainResult('g3', '', new Error('boom')));

    const snap = ledger.snapshot();
    expect(snap.routerDecision?.intent).toBe('knowledge');
    expect(snap.gbrainCalls).toHaveLength(3);
    expect(snap.gbrainCalls[0]).toMatchObject({ status: 'success_hit', undeclaredSource: false });
    expect(snap.gbrainCalls[1]).toMatchObject({ status: 'success_hit', undeclaredSource: true });
    expect(snap.gbrainCalls[2]!.status).toBe('failed');
    // G6: undeclared hit is excluded from effective evidence
    expect(effectiveGbrainHits(snap)).toHaveLength(1);
    expect(snap.otherToolCalls).toBe(0); // router line does not count as "other"
    expect((snap.executionTrace ?? []).map((item) => item.kind)).toEqual([
      'router', 'gbrain', 'gbrain', 'gbrain',
    ]);
  });

  it('books skill evidence lines and counts other tools', () => {
    const ledger = new EvidenceLedger();
    for (const ev of shellResult('s1', 'ok\nSKILL_EVIDENCE: {"skill_id":"bsq-oms-order","status":"success_empty"}')) {
      ledger.observe(ev);
    }
    for (const ev of shellResult('s2', 'ls output, no markers')) ledger.observe(ev);
    const snap = ledger.snapshot();
    expect(snap.skillCalls).toEqual([
      { skillId: 'bsq-oms-order', status: 'success_empty', recordCount: null },
    ]);
    expect(snap.otherToolCalls).toBe(1);
  });

  it('without router declaration, no source is marked undeclared', () => {
    const ledger = new EvidenceLedger();
    ledger.observe(gbrainUse('g1', 'anything-wiki'));
    ledger.observe(gbrainResult('g1', mcpEnvelope([{}])));
    expect(ledger.snapshot().gbrainCalls[0]!.undeclaredSource).toBe(false);
  });

  it('keeps terminal router state available for downstream answer gating', () => {
    const ledger = new EvidenceLedger();
    for (const ev of shellResult(
      'r1',
      'ROUTER_DECISION: {"intent":"clarify","terminal":true,"allowed_next_action":"ask_clarification","knowledge_precheck":{"status":"not_configured","completed":false},"missing_params":[],"reason":"知识库预检索未完成"}',
    )) {
      ledger.observe(ev);
    }
    expect(ledger.snapshot().routerDecision).toMatchObject({
      intent: 'clarify',
      terminal: true,
      knowledgePrecheck: { status: 'not_configured', completed: false },
    });
  });
});

describe('buildSourceBlock', () => {
  it('renders multi-value lists with per-call status', () => {
    const ledger = new EvidenceLedger();
    for (const ev of shellResult('r1', 'ROUTER_DECISION: {"intent":"mixed","knowledge_sources":["oms-business-wiki"]}')) {
      ledger.observe(ev);
    }
    ledger.observe(gbrainUse('g1', 'oms-business-wiki'));
    ledger.observe(gbrainResult('g1', mcpEnvelope([{}, {}])));
    for (const ev of shellResult('s1', 'SKILL_EVIDENCE: {"skill_id":"bsq-oms-order","status":"timeout"}')) {
      ledger.observe(ev);
    }
    const block = buildSourceBlock(ledger.snapshot(), { system: 'OMS' });
    expect(block).toContain('来源：知识库');
    expect(block).toContain('oms-business-wiki(命中2条)');
    expect(block).toContain('bsq-oms-order(超时)');
    expect(block).toContain('bsq-oms-order 实时核验未完成');
  });

  it('aggregates origin deterministically and honors degraded flag', () => {
    const empty = new EvidenceLedger().snapshot();
    expect(buildSourceBlock(empty, { system: 'OMS' })).toContain('来源：未确认');
    expect(buildSourceBlock(empty, { system: 'OMS', degraded: true })).toContain('来源：未确认');
  });
});
