/**
 * 需人工回复的值班人通知：回复以 [NEED_HUMAN] 收尾（模型自判或 Answer Gate
 * 降级）时，在同一话题内发一条原生 post 消息 @ 项目配置的值班人
 * （Project.escalationOpenId），走飞书真实提及/通知路径。Best-effort：
 * 发送失败只记日志，不影响本轮收尾。
 */
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

export interface EscalationNoticeInput {
  /** 话题内锚点消息（run 卡）。 */
  cardMsgId: string;
  escalationOpenId: string | string[];
  /** 用户原始问题摘要（截断后进通知正文）。 */
  summary?: string;
  replyInThread: boolean;
}

function compact(text: string | undefined, limit = 60): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '本轮问题';
  return t.length > limit ? `${t.slice(0, limit)}…` : t;
}

export function buildEscalationContent(input: Pick<EscalationNoticeInput, 'escalationOpenId' | 'summary'>): string {
  const escalationOpenIds = Array.isArray(input.escalationOpenId)
    ? input.escalationOpenId
    : [input.escalationOpenId];
  return JSON.stringify({
    zh_cn: {
      title: '',
      content: [
        [
          ...escalationOpenIds.map((user_id) => ({ tag: 'at' as const, user_id })),
          { tag: 'text', text: ` 🙋「${compact(input.summary)}」机器人未能给出可靠答案，需人工跟进。` },
        ],
        [{ tag: 'text', text: '详情见上方卡片；处理后请在卡片上反馈结果。' }],
      ],
    },
  });
}

export async function sendEscalationNotice(
  channel: LarkChannel,
  input: EscalationNoticeInput,
): Promise<'sent' | 'failed'> {
  try {
    await channel.rawClient.im.v1.message.reply({
      path: { message_id: input.cardMsgId },
      data: {
        msg_type: 'post',
        content: buildEscalationContent(input),
        reply_in_thread: input.replyInThread,
      },
    });
    log.info('card', 'escalation-notice', {
      to: Array.isArray(input.escalationOpenId) ? input.escalationOpenId : [input.escalationOpenId],
    });
    return 'sent';
  } catch (err) {
    log.fail('card', err, { phase: 'escalation-notice' });
    return 'failed';
  }
}
