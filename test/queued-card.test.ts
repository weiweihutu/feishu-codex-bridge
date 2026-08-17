import { describe, expect, it } from 'vitest';
import { buildQueuedCard, RC } from '../src/card/run-card';
import { initialState, reduce } from '../src/card/run-state';
import {
  activateQueuedTurn,
  emitOrdinaryTurnCompletion,
  pickIdleSessions,
  type QueuedTurn,
} from '../src/bot/handle-message';
import type { AuditContext } from '../src/core/audit-trace';

function buttons(node: unknown, acc: Record<string, any>[] = []): Record<string, any>[] {
  if (Array.isArray(node)) node.forEach((n) => buttons(n, acc));
  else if (node && typeof node === 'object') {
    const o = node as Record<string, any>;
    if (o.tag === 'button') acc.push(o);
    for (const k of Object.keys(o)) buttons(o[k], acc);
  }
  return acc;
}

// M-3: 排队占位卡 —— acquire 前可见、可 ⏹ 取消。
describe('buildQueuedCard', () => {
  it('shows the 1-based queue position and the shared-pool note while waiting', () => {
    const json = JSON.stringify(buildQueuedCard({ position: 3, cardKey: 'om_1' }));
    expect(json).toContain('排队中（第 **3** 位）');
    expect(json).toContain('全局并发池已满');
  });

  it('routes the ⏹ 取消 button through the run card\'s RC.stop action (cardKey = own messageId)', () => {
    const btns = buttons(buildQueuedCard({ position: 1, cardKey: 'om_1' }));
    expect(btns.length).toBe(1);
    expect(btns[0]!.behaviors[0].value).toMatchObject({ a: RC.stop, m: 'om_1' });
  });

  it('shows the one-shot reminder only when manual mode marks it available', () => {
    const available = buttons(
      buildQueuedCard({ position: 1, cardKey: 'om_1', completionReminder: 'available' }),
    );
    expect(available.map((b) => b.behaviors[0].value.a)).toEqual([RC.stop, RC.remind]);
    expect(JSON.stringify(available)).toContain('🔔 完成后提醒我');

    const automaticMode = buttons(buildQueuedCard({ position: 1, cardKey: 'om_1' }));
    expect(automaticMode.map((b) => b.behaviors[0].value.a)).toEqual([RC.stop]);
  });

  it('replaces the reminder button with an explicit enabled note after it is requested', () => {
    const card = buildQueuedCard({ position: 2, cardKey: 'om_1', completionReminder: 'requested' });
    expect(buttons(card).map((b) => b.behaviors[0].value.a)).toEqual([RC.stop]);
    const json = JSON.stringify(card);
    expect(json).toContain('本轮结束后会提醒发起人');
    expect(json).not.toContain('完成后提醒我');
  });

  it('has no button before the messageId exists (first frame)', () => {
    expect(buttons(buildQueuedCard({ position: 1 })).length).toBe(0);
  });

  it('cancelled layout is terminal: no buttons, tells about dropped queued messages', () => {
    const card = buildQueuedCard({ cancelled: true, dropped: 2 });
    expect(buttons(card).length).toBe(0);
    const json = JSON.stringify(card);
    expect(json).toContain('已取消排队');
    expect(json).toContain('2 条排队消息已丢弃');
    // 没有滞留的排队文案
    expect(json).not.toContain('排队中（第');
  });

  it('started layout (goal) is a short note with no buttons', () => {
    const card = buildQueuedCard({ started: true });
    expect(buttons(card).length).toBe(0);
    expect(JSON.stringify(card)).toContain('已开始执行');
  });
});

// M-3: 空闲进程 reaper 的纯决策 —— busy / 新鲜 / 无打点的都不回收。
describe('pickIdleSessions', () => {
  const NOW = 1_000_000_000;
  const IDLE = 45 * 60_000;

  it('reaps only sessions idle past the threshold', () => {
    const touched = new Map<string, number>([
      ['stale', NOW - IDLE - 1],
      ['fresh', NOW - IDLE + 1_000],
      ['boundary', NOW - IDLE], // 恰好到阈值 → 回收（< idleMs 才算新鲜）
    ]);
    const out = pickIdleSessions(touched.keys(), touched, () => false, IDLE, NOW);
    expect(out.sort()).toEqual(['boundary', 'stale']);
  });

  it('skips busy sessions (active run/queue or doc-lock chain) even when stale', () => {
    const touched = new Map<string, number>([
      ['busy', NOW - IDLE * 2],
      ['idle', NOW - IDLE * 2],
    ]);
    const out = pickIdleSessions(touched.keys(), touched, (k) => k === 'busy', IDLE, NOW);
    expect(out).toEqual(['idle']);
  });

  it('never reaps a key without a touch timestamp (caller stamps it first)', () => {
    const out = pickIdleSessions(['unknown'], new Map(), () => false, IDLE, NOW);
    expect(out).toEqual([]);
  });
});

describe('queued follow-up requester isolation', () => {
  it('moves control ownership to that turn and clears the previous manual override', () => {
    const state = { requesterOpenId: 'ou_first', completionReminderRequested: true };
    const queued: QueuedTurn = {
      input: { text: '[本条消息的发信人：某用户（open_id：ou_second）]\n\nsecond turn' },
      titleSource: { text: 'second turn', rawContentType: 'text' },
      requesterOpenId: 'ou_second',
      requestedAt: 123_000,
      summary: 'second turn',
    };

    activateQueuedTurn(state, queued);

    expect(state).toEqual({ requesterOpenId: 'ou_second', completionReminderRequested: false });
    // Timing/title stay attached to the same turn object used by notification.
    expect(queued.requestedAt).toBe(123_000);
    expect(queued.summary).toBe('second turn');
    expect(queued.titleSource.text).toBe('second turn');
    expect(queued.input.text).toContain('open_id');
  });
});

describe('ordinary turn completion audit orchestration', () => {
  const audit = (msgId: string): AuditContext => ({
    msgId,
    chatId: 'oc_1',
    threadId: 'omt_1',
    rootId: null,
    parentId: null,
    senderId: `ou_${msgId}`,
    traceId: `trace_${msgId}`,
    startedAt: '2026-07-23T00:00:00.000Z',
    imageFiles: [`${msgId}.png`],
  });

  it('keeps first and queued turn completion ownership separate', () => {
    const emitted: Array<{ msgId: string; fields: Record<string, unknown> }> = [];
    const emit = (ctx: AuditContext | undefined, fields: Record<string, unknown> = {}) => {
      emitted.push({ msgId: ctx!.msgId, fields });
    };
    const queue: QueuedTurn[] = [];
    let current: QueuedTurn = {
      input: { text: 'first' },
      titleSource: { text: 'first', rawContentType: 'text' },
      requesterOpenId: 'ou_first',
      requestedAt: 1,
      audit: audit('om_first'),
    };
    queue.push({
      input: { text: 'queued' },
      titleSource: { text: 'queued', rawContentType: 'text' },
      requesterOpenId: 'ou_queued',
      requestedAt: 2,
      audit: audit('om_queued'),
    });
    const control = { requesterOpenId: current.requesterOpenId, completionReminderRequested: true };
    const done = reduce(structuredClone(initialState), { type: 'done', turnId: 'turn-first' });

    emitOrdinaryTurnCompletion(current, {
      kind: 'success',
      runState: done,
      images: 1,
      model: 'gpt-first',
    }, emit);
    emitOrdinaryTurnCompletion(current, {
      kind: 'success',
      runState: done,
      images: 1,
      model: 'gpt-first',
    }, emit);
    current = queue.shift()!;
    activateQueuedTurn(control, current);
    emitOrdinaryTurnCompletion(current, {
      kind: 'success',
      runState: done,
      images: 2,
      model: 'gpt-queued',
    }, emit);

    expect(queue).toHaveLength(0);
    expect(control).toEqual({ requesterOpenId: 'ou_queued', completionReminderRequested: false });
    expect(emitted.map((entry) => entry.msgId)).toEqual(['om_first', 'om_queued']);
    expect(emitted.map((entry) => entry.fields)).toEqual([
      expect.objectContaining({ msgId: 'om_first', traceId: 'trace_om_first' }),
      expect.objectContaining({ msgId: 'om_queued', traceId: 'trace_om_queued' }),
    ]);
  });

  it('emits one error completion with the turn images, files, and model', () => {
    const emitted: Array<{ ctx: AuditContext | undefined; fields: Record<string, unknown> }> = [];
    const turn = { audit: audit('om_error'), completionEmitted: false };

    emitOrdinaryTurnCompletion(turn, {
      kind: 'error',
      error: new Error('boom'),
      images: 3,
      model: 'gpt-error',
    }, (ctx, fields = {}) => emitted.push({ ctx, fields }));
    emitOrdinaryTurnCompletion(turn, {
      kind: 'error',
      error: new Error('again'),
      images: 3,
      model: 'gpt-error',
    }, (ctx, fields = {}) => emitted.push({ ctx, fields }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.ctx?.msgId).toBe('om_error');
    expect(emitted[0]?.fields).toMatchObject({
      terminal: 'error',
      error: 'boom',
      replyText: '',
      textChars: 0,
      images: 3,
      imageFiles: ['om_error.png'],
      model: 'gpt-error',
    });
  });

  it('uses only the final message text for a successful reply audit', () => {
    let state = structuredClone(initialState);
    state = reduce(state, { type: 'text_delta', itemId: 'progress', delta: 'progress that must not leak' });
    state = reduce(state, { type: 'text', itemId: 'progress', text: 'progress that must not leak' });
    state = reduce(state, { type: 'text_delta', itemId: 'final', delta: 'final answer' });
    state = reduce(state, { type: 'text', itemId: 'final', text: 'final answer' });
    state = reduce(state, { type: 'done', turnId: 'turn-reply' });
    const emitted: Record<string, unknown>[] = [];

    emitOrdinaryTurnCompletion(
      { audit: audit('om_reply'), completionEmitted: false },
      { kind: 'success', runState: state, images: 0, model: 'gpt-reply' },
      (_ctx, fields = {}) => emitted.push(fields),
    );

    expect(emitted[0]).toMatchObject({ replyText: 'final answer', textChars: 12 });
    expect(String(emitted[0]?.replyText)).not.toContain('progress');
  });

  it('emits the full reply, visible reply, and structured provenance separately', () => {
    const reply = [
      '结论：需要核对平台映射。',
      '',
      '来源：知识库',
      '系统：OMS',
      '知识库：oms-business-wiki',
      '说明：未实时查询。',
    ].join('\n');
    let state = structuredClone(initialState);
    state = reduce(state, { type: 'text', itemId: 'final', text: reply });
    state = reduce(state, { type: 'done', turnId: 'turn-visible-audit' });
    const emitted: Record<string, unknown>[] = [];

    emitOrdinaryTurnCompletion(
      { audit: audit('om_visible'), completionEmitted: false },
      { kind: 'success', runState: state, images: 0 },
      (_ctx, fields = {}) => emitted.push(fields),
    );

    expect(emitted[0]).toMatchObject({
      replyText: reply,
      visibleReplyText: '结论：需要核对平台映射。',
      replyMetadata: {
        source: '知识库',
        system: 'OMS',
        knowledgeBases: 'oms-business-wiki',
        note: '未实时查询。',
      },
      textChars: reply.length,
    });
  });

  it('does nothing when the launch has no audit context', () => {
    const emitted: Record<string, unknown>[] = [];
    emitOrdinaryTurnCompletion(
      { audit: undefined, completionEmitted: false },
      {
        kind: 'error',
        error: new Error('goal/comment launch'),
        images: 0,
        model: 'gpt-unused',
      },
      (_ctx, fields = {}) => emitted.push(fields),
    );
    expect(emitted).toEqual([]);
  });
});
