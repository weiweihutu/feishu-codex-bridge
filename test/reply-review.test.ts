import { describe, expect, it } from 'vitest';
import {
  buildReplyReview,
  buildReplyReviewAuditFields,
  normalizeReplyReviewFeedback,
} from '../src/bot/handle-message';

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
      threadId: 'omt_topic',
      cardMsgId: 'om_card',
      requesterId: 'ou_requester',
      operatorId: 'ou_requester',
      operatedAt: '2026-08-11T12:00:00.000Z',
    });
  });
});
