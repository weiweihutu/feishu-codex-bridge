export interface FeishuContextIdentity {
  messageId: string;
  senderId?: string;
  chatId: string;
  threadId?: string;
}

export function appendFeishuContext(text: string, msg: FeishuContextIdentity): string {
  const context = [
    '[Feishu Context]',
    `message_id=${msg.messageId}`,
    `feishu_user_id=${msg.senderId ?? ''}`,
    `chat_id=${msg.chatId}`,
    `thread_id=${msg.threadId ?? ''}`,
    '',
    'When running business skills, set FEISHU_USER_ID to feishu_user_id and REQUEST_ID to message_id.',
  ].join('\n');
  return `${text}\n\n${context}`;
}

export interface NoMentionProject {
  kind?: 'single' | 'multi';
  noMention?: boolean;
  defaultNoMention: boolean;
}

export interface NoMentionMessage {
  content: string;
  threadId?: string;
  mentionAll: boolean;
  mentions: Array<{ isBot?: boolean }>;
}

export function shouldRespondWithoutMention(
  project: NoMentionProject,
  msg: NoMentionMessage,
): boolean {
  if (!(project.noMention ?? project.defaultNoMention)) return false;
  if (msg.mentionAll || msg.mentions.some((mention) => !mention.isBot)) return false;
  return true;
}
