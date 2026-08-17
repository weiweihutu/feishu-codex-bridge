import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMessageRelation, getThreadId } from '../src/bot/handle-message';

// 不引真 LarkChannel——getThreadId 只摸 rawClient.im.v1.message.get 一条链。
type Channel = Parameters<typeof getThreadId>[0];
function fakeChannel(get: (...args: unknown[]) => Promise<unknown>): Channel {
  return { rawClient: { im: { v1: { message: { get } } } } } as unknown as Channel;
}
const resp = (
  tid?: string,
  rootId?: string,
  parentId?: string,
): unknown => ({
  data: {
    items: [
      tid
        ? { thread_id: tid, root_id: rootId, parent_id: parentId }
        : {},
    ],
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getThreadId 重试（M-5/F8：单次 API 抖动别滞留 pending: 键）', () => {
  it('首次抛错 → 500ms 后重试成功', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockRejectedValueOnce(new Error('api blip')).mockResolvedValueOnce(resp('omt_1'));
    const p = getThreadId(fakeChannel(get), 'om_x', 3);
    await vi.advanceTimersByTimeAsync(600);
    expect(await p).toBe('omt_1');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('响应缺 thread_id 同样算失败重试；穷尽后返回 undefined', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValue(resp(undefined));
    const p = getThreadId(fakeChannel(get), 'om_x', 3);
    await vi.advanceTimersByTimeAsync(1200);
    expect(await p).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('默认 attempts=1：失败不重试（旧语义不变）', async () => {
    const get = vi.fn().mockRejectedValue(new Error('api blip'));
    expect(await getThreadId(fakeChannel(get), 'om_x')).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('首次即成功：不睡 500ms、只调一次', async () => {
    const get = vi.fn().mockResolvedValue(resp('omt_2'));
    expect(await getThreadId(fakeChannel(get), 'om_x', 3)).toBe('omt_2');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('returns thread, root, and direct parent ids from one lookup', async () => {
    const get = vi.fn().mockResolvedValue(resp('omt_3', 'om_root', 'om_parent'));

    expect(await getMessageRelation(fakeChannel(get), 'om_x', 3)).toEqual({
      threadId: 'omt_3',
      rootId: 'om_root',
      parentId: 'om_parent',
    });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
