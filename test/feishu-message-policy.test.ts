import { describe, expect, it } from 'vitest';
import {
  appendFeishuContext,
  shouldRespondWithoutMention,
} from '../src/bot/feishu-message-policy';

describe('appendFeishuContext', () => {
  it('appends the exact identity block after the already-woven prompt', () => {
    expect(appendFeishuContext('woven prompt', {
      messageId: 'om_1',
      senderId: 'ou_1',
      chatId: 'oc_1',
      threadId: 'omt_1',
    })).toBe([
      'woven prompt',
      '',
      '[Feishu Context]',
      'message_id=om_1',
      'feishu_user_id=ou_1',
      'chat_id=oc_1',
      'thread_id=omt_1',
      '',
      'When running business skills, set FEISHU_USER_ID to feishu_user_id and REQUEST_ID to message_id.',
    ].join('\n'));
  });

  it('keeps optional sender and thread identity fields present but empty', () => {
    expect(appendFeishuContext('prompt', {
      messageId: 'om_2',
      chatId: 'oc_2',
    })).toContain('feishu_user_id=\nchat_id=oc_2\nthread_id=');
  });
});

describe('shouldRespondWithoutMention', () => {
  const ordinaryMessage = {
    content: 'create a topic',
    mentions: [],
    mentionAll: false,
  };

  it('accepts ordinary main-group text in an enabled multi project', () => {
    expect(shouldRespondWithoutMention({
      kind: 'multi',
      noMention: true,
      defaultNoMention: false,
    }, ordinaryMessage)).toBe(true);
  });

  it('accepts ordinary text in an enabled single project', () => {
    expect(shouldRespondWithoutMention({
      kind: 'single',
      noMention: true,
      defaultNoMention: false,
    }, ordinaryMessage)).toBe(true);
  });

  it('uses the default only when the project has no explicit override', () => {
    expect(shouldRespondWithoutMention({
      kind: 'multi',
      defaultNoMention: true,
    }, ordinaryMessage)).toBe(true);
    expect(shouldRespondWithoutMention({
      kind: 'multi',
      noMention: false,
      defaultNoMention: true,
    }, ordinaryMessage)).toBe(false);
  });

  it('rejects messages when effective noMention is disabled', () => {
    expect(shouldRespondWithoutMention({
      kind: 'single',
      defaultNoMention: false,
    }, ordinaryMessage)).toBe(false);
    expect(shouldRespondWithoutMention({
      kind: 'multi',
      defaultNoMention: false,
    }, {
      ...ordinaryMessage,
      threadId: 'omt_existing',
    })).toBe(false);
  });

  it('allows bot-only mentions when noMention is enabled', () => {
    expect(shouldRespondWithoutMention({
      kind: 'multi',
      noMention: true,
      defaultNoMention: false,
    }, {
      ...ordinaryMessage,
      mentions: [{ isBot: true }, { isBot: true }],
    })).toBe(true);
  });

  it('rejects @all and mentions of another real user', () => {
    const project = {
      kind: 'multi',
      noMention: true,
      defaultNoMention: false,
    } as const;
    expect(shouldRespondWithoutMention(project, {
      ...ordinaryMessage,
      mentionAll: true,
    })).toBe(false);
    expect(shouldRespondWithoutMention(project, {
      ...ordinaryMessage,
      mentions: [{ isBot: false }],
    })).toBe(false);
    expect(shouldRespondWithoutMention(project, {
      ...ordinaryMessage,
      mentions: [{}],
    })).toBe(false);
  });

  it('accepts a configured escalation mention even when the bot is not mentioned', () => {
    const project = {
      kind: 'multi',
      noMention: false,
      defaultNoMention: false,
      escalationOpenIds: ['ou_owner_1', 'ou_owner_2'],
    } as const;
    expect(shouldRespondWithoutMention(project, {
      ...ordinaryMessage,
      mentions: [{ openId: 'ou_owner_2', isBot: false }],
    })).toBe(true);
    expect(shouldRespondWithoutMention(project, {
      ...ordinaryMessage,
      mentions: [{ openId: 'ou_other', isBot: false }],
    })).toBe(false);
  });

  it('accepts an existing-thread message under the same enabled policy', () => {
    expect(shouldRespondWithoutMention({
      kind: 'multi',
      noMention: true,
      defaultNoMention: false,
    }, {
      ...ordinaryMessage,
      threadId: 'omt_existing',
    })).toBe(true);
  });
});
