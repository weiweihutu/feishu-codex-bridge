import { describe, expect, it } from 'vitest';
import { parseReplyPresentation, visibleReplyText } from '../src/core/reply-visibility';

describe('reply visibility', () => {
  const fullReply = [
    '结论：需要核对平台映射。',
    '',
    '排查建议：检查易仓返回的平台原值。',
    '',
    '来源：知识库',
    '系统：OMS',
    '知识库：oms-business-wiki',
    '说明：本次未做实时系统查询。',
  ].join('\n');

  it('separates a valid terminal metadata block from visible text', () => {
    expect(parseReplyPresentation(fullReply)).toEqual({
      fullText: fullReply,
      visibleText: '结论：需要核对平台映射。\n\n排查建议：检查易仓返回的平台原值。',
      metadata: {
        source: '知识库',
        system: 'OMS',
        knowledgeBases: 'oms-business-wiki',
        note: '本次未做实时系统查询。',
      },
    });
  });

  it('supports ASCII colons and multiline metadata values', () => {
    const reply = ['结论', '来源: 知识库', '系统: OMS', '说明: 第一行', '第二行'].join('\n');
    expect(parseReplyPresentation(reply)).toMatchObject({
      visibleText: '结论',
      metadata: { source: '知识库', system: 'OMS', note: '第一行\n第二行' },
    });
  });

  it('does not hide normal prose or an incomplete metadata suffix', () => {
    const prose = '结论：订单来源字段需要检查。\n来源：该字段由平台返回。';
    expect(parseReplyPresentation(prose)).toEqual({
      fullText: prose,
      visibleText: prose,
      metadata: {},
    });
  });

  it('hides a streaming suffix as soon as a standalone source label begins', () => {
    const partial = '结论：需要核对平台映射。\n\n来源：';
    expect(visibleReplyText(partial, 'streaming')).toBe('结论：需要核对平台映射。');
    expect(visibleReplyText(partial, 'terminal')).toBe(partial);
  });
});
