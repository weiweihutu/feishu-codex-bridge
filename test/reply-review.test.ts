import { describe, expect, it } from 'vitest';
import {
  buildReplyReview,
  buildReplyReviewAuditFields,
  canActOnReplyReview,
  normalizeReplyReviewCategory,
  normalizeReplyReviewFeedback,
} from '../src/bot/handle-message';
import { normalizeEscalationOpenIds } from '../src/project/registry';

describe('reply review feedback', () => {
  it('starts a new reply review in the pending state', () => {
    expect(
      buildReplyReview(
        { msgId: 'om_question', threadId: 'omt_topic', senderId: 'ou_requester' },
        'ou_fallback',
      ),
    ).toEqual({
      msgId: 'om_question',
      threadId: 'omt_topic',
      requesterId: 'ou_requester',
      status: 'pending',
      revision: 0,
    });
  });

  it('normalizes submitted feedback and rejects blank input', () => {
    expect(normalizeReplyReviewFeedback('  回答没有解释部署失败原因。  ')).toBe(
      '回答没有解释部署失败原因。',
    );
    expect(normalizeReplyReviewFeedback(' \n\t ')).toBeUndefined();
    expect(normalizeReplyReviewFeedback('x'.repeat(1001))).toHaveLength(1000);
    expect(normalizeReplyReviewFeedback({ text: 'invalid' })).toBeUndefined();
  });

  it('accepts only configured problem categories', () => {
    expect(normalizeReplyReviewCategory(' 工具调用失败 ', ['工具调用失败'])).toBe('工具调用失败');
    expect(normalizeReplyReviewCategory('其他问题', ['工具调用失败'])).toBeUndefined();
  });

  it('builds structured unresolved audit fields with topic and actor identity', () => {
    expect(
      buildReplyReviewAuditFields({
        review: {
          msgId: 'om_question',
          threadId: 'omt_topic',
          requesterId: 'ou_requester',
          status: 'unresolved',
          revision: 1,
          feedback: '缺少部署失败原因',
        },
        cardMsgId: 'om_card',
        operatorId: 'ou_requester',
        operatedAt: '2026-08-11T12:00:00.000Z',
      }),
    ).toEqual({
      action: 'unresolved',
      decision: 'not_adopted',
      feedback: '缺少部署失败原因',
      badcaseType: '',
      threadId: 'omt_topic',
      cardMsgId: 'om_card',
      requesterId: 'ou_requester',
      operatorId: 'ou_requester',
      operatedAt: '2026-08-11T12:00:00.000Z',
    });
  });

  it.each([
    ['reply.resolve', 'ou_requester', true],
    ['reply.resolve', 'ou_escalation', true],
    ['reply.resolve', 'ou_other', false],
    ['reply.unresolved.open', 'ou_requester', false],
    ['reply.unresolved.open', 'ou_escalation', true],
    ['reply.unresolved.submit', 'ou_requester', false],
    ['reply.unresolved.submit', 'ou_escalation', true],
    ['reply.unresolved.cancel', 'ou_requester', false],
    ['reply.unresolved.cancel', 'ou_escalation', true],
  ] as const)('%s allows only the configured actors (%s)', (action, operator, allowed) => {
    expect(canActOnReplyReview(action, operator, 'ou_requester', 'ou_escalation')).toBe(allowed);
  });

  it('keeps the historical requester-only behavior when escalation is unset', () => {
    expect(canActOnReplyReview('reply.resolve', 'ou_requester', 'ou_requester')).toBe(true);
    expect(canActOnReplyReview('reply.resolve', 'ou_escalation', 'ou_requester')).toBe(false);
    expect(canActOnReplyReview('reply.unresolved.submit', 'ou_requester', 'ou_requester')).toBe(false);
  });

  it('supports multiple system owners and keeps legacy single-id configuration', () => {
    expect(normalizeEscalationOpenIds(' ou_owner ')).toEqual(['ou_owner']);
    expect(normalizeEscalationOpenIds(['ou_owner', '', 'ou_owner', 'ou_other'])).toEqual([
      'ou_owner',
      'ou_other',
    ]);
    expect(
      canActOnReplyReview('reply.unresolved.submit', 'ou_owner', 'ou_requester', [
        'ou_owner',
        'ou_other',
      ]),
    ).toBe(true);
    expect(
      canActOnReplyReview('reply.unresolved.submit', 'ou_other', 'ou_requester', [
        'ou_owner',
        'ou_other',
      ]),
    ).toBe(true);
    expect(
      canActOnReplyReview('reply.unresolved.submit', 'ou_guest', 'ou_requester', [
        'ou_owner',
        'ou_other',
      ]),
    ).toBe(false);
  });
});
