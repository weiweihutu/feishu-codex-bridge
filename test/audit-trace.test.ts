import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuditContext,
  emitMessageCompletedAudit,
  emitTraceStep,
  traceArtifactPath,
  truncateAuditText,
} from '../src/core/audit-trace';
import { currentLogContext, log, withTrace } from '../src/core/logger';

const roots: string[] = [];
const fixedNow = new Date('2025-07-06T12:34:56.789Z');

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'audit-trace-test-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('currentLogContext', () => {
  it('returns a shallow copy that cannot mutate the active context', async () => {
    await withTrace({ traceId: 'trace-1', chatId: 'chat-1', msgId: 'msg-1' }, async () => {
      const copy = currentLogContext() as {
        traceId?: string;
        chatId?: string;
        msgId?: string;
      };
      copy.traceId = 'changed';
      copy.chatId = 'changed';

      expect(currentLogContext()).toEqual({
        traceId: 'trace-1',
        chatId: 'chat-1',
        msgId: 'msg-1',
      });
    });
  });
});

describe('truncateAuditText', () => {
  it('keeps text within the limit unchanged', () => {
    expect(truncateAuditText('hello', 5)).toEqual({ text: 'hello', truncated: false });
  });

  it('truncates text over the limit', () => {
    expect(truncateAuditText('abcdef', 5)).toEqual({ text: 'abcde', truncated: true });
  });
});

describe('buildAuditContext', () => {
  it('preserves message identity and merges extras', () => {
    const audit = buildAuditContext(
      {
        messageId: 'om_1',
        chatId: 'oc_1',
        threadId: 'omt_1',
        senderId: 'ou_1',
        chatType: 'group',
        mentionedBot: true,
        createTime: Date.parse('2025-07-01T01:02:03.000Z'),
      },
      'hello',
      { project: 'demo' },
    );

    expect(audit).toEqual({
      msgId: 'om_1',
      chatId: 'oc_1',
      threadId: 'omt_1',
      senderId: 'ou_1',
      chatType: 'group',
      mentionedBot: true,
      messageText: 'hello',
      messageTextTruncated: false,
      receivedAt: '2025-07-01T01:02:03.000Z',
      project: 'demo',
    });
  });

  it('uses null for absent thread and sender identity', () => {
    const audit = buildAuditContext(
      {
        messageId: 'om_2',
        chatId: 'oc_2',
        chatType: 'p2p',
        mentionedBot: false,
        createTime: Date.parse('2025-07-02T00:00:00.000Z'),
      },
      '',
    );
    expect(audit.threadId).toBeNull();
    expect(audit.senderId).toBeNull();
  });
});

describe('emitTraceStep', () => {
  it('writes a dated JSONL trace with defaults and injected time', () => {
    const workspaceRoot = tempRoot();
    emitTraceStep(
      { event: 'codex.started', msgId: 'om_1', input_text: 'prompt' },
      { workspaceRoot, now: () => fixedNow },
    );

    const file = join(workspaceRoot, 'traces', 'logs', 'trace-20250706.log');
    const line = readFileSync(file, 'utf8').trim();
    expect(JSON.parse(line)).toEqual({
      ts: fixedNow.toISOString(),
      event: 'codex.started',
      status: 'success',
      msgId: 'om_1',
      input_text: 'prompt',
    });
  });

  it('truncates 20001-character input and output text', () => {
    const workspaceRoot = tempRoot();
    emitTraceStep(
      { input_text: 'i'.repeat(20_001), output_text: 'o'.repeat(20_001) },
      { workspaceRoot, now: () => fixedNow },
    );

    const line = readFileSync(
      join(workspaceRoot, 'traces', 'logs', 'trace-20250706.log'),
      'utf8',
    ).trim();
    const entry = JSON.parse(line) as { input_text: string; output_text: string };
    expect(entry.input_text).toHaveLength(20_000);
    expect(entry.output_text).toHaveLength(20_000);
  });
});

describe('traceArtifactPath', () => {
  it('sanitizes path segments and writes pretty JSON', () => {
    const workspaceRoot = tempRoot();
    const relative = traceArtifactPath(
      '../om:1',
      '../result?.json',
      { ok: true, nested: { count: 2 } },
      'json',
      { workspaceRoot, now: () => fixedNow },
    );

    expect(relative).toBe('traces/artifacts/20250706/.._om_1/.._result_.json');
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe(
      '{\n  "ok": true,\n  "nested": {\n    "count": 2\n  }\n}',
    );
  });
});

describe('emitMessageCompletedAudit', () => {
  it('logs the completed audit and emits the composed-response trace', async () => {
    const workspaceRoot = tempRoot();
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const audit = buildAuditContext(
      {
        messageId: 'om_3',
        chatId: 'oc_3',
        threadId: 'omt_3',
        senderId: 'ou_3',
        chatType: 'group',
        mentionedBot: true,
        createTime: Date.parse('2025-07-03T00:00:00.000Z'),
      },
      'question',
      { project: 'demo' },
    );

    await withTrace({ traceId: 'trace-3', chatId: 'ctx-chat', msgId: 'ctx-msg' }, async () => {
      emitMessageCompletedAudit(
        audit,
        {
          replyText: 'answer',
          elapsedMs: 123,
          model: 'gpt-test',
          terminal: 'done',
          textChars: 6,
          images: 1,
          imageFiles: ['answer.png'],
        },
        { workspaceRoot, now: () => fixedNow },
      );
    });

    expect(info).toHaveBeenCalledWith(
      'audit',
      'message_completed',
      expect.objectContaining({
        msgId: 'ctx-msg',
        chatId: 'ctx-chat',
        threadId: 'omt_3',
        traceId: 'trace-3',
        replyText: 'answer',
        replyTextTruncated: false,
      }),
    );
    const line = readFileSync(
      join(workspaceRoot, 'traces', 'logs', 'trace-20250706.log'),
      'utf8',
    ).trim();
    expect(JSON.parse(line)).toEqual(
      expect.objectContaining({
        ts: fixedNow.toISOString(),
        event: 'codex.response_composed',
        status: 'success',
        msgId: 'ctx-msg',
        chatId: 'ctx-chat',
        threadId: 'omt_3',
        project: 'demo',
        traceId: 'trace-3',
        elapsedMs: 123,
        model: 'gpt-test',
        replyText: 'answer',
        terminal: 'done',
        textChars: 6,
        images: 1,
        imageFiles: ['answer.png'],
      }),
    );
  });

  it('truncates a long reply in both audit and trace payloads', () => {
    const workspaceRoot = tempRoot();
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    emitMessageCompletedAudit(
      { msgId: 'om_4', chatId: 'oc_4', threadId: null },
      { replyText: 'x'.repeat(20_001) },
      { workspaceRoot, now: () => fixedNow },
    );

    const payload = info.mock.calls[0]?.[2] as {
      replyText: string;
      replyTextTruncated: boolean;
    };
    expect(payload.replyText).toHaveLength(20_000);
    expect(payload.replyTextTruncated).toBe(true);
    const entry = JSON.parse(
      readFileSync(join(workspaceRoot, 'traces', 'logs', 'trace-20250706.log'), 'utf8'),
    ) as { replyText: string };
    expect(entry.replyText).toHaveLength(20_000);
  });
});

describe('best-effort disk handling', () => {
  it('does not throw when the workspace root cannot be created beneath a file', () => {
    const root = tempRoot();
    const invalidRoot = join(root, 'not-a-directory');
    writeFileSync(invalidRoot, 'file', 'utf8');
    mkdirSync(root, { recursive: true });

    expect(() =>
      emitTraceStep({ input_text: 'hello' }, { workspaceRoot: invalidRoot, now: () => fixedNow }),
    ).not.toThrow();
    expect(
      traceArtifactPath('om_1', 'result.txt', 'hello', 'text', {
        workspaceRoot: invalidRoot,
        now: () => fixedNow,
      }),
    ).toBeNull();
    expect(() =>
      emitMessageCompletedAudit(
        { msgId: 'om_1', chatId: 'oc_1', threadId: null },
        { replyText: 'hello' },
        { workspaceRoot: invalidRoot, now: () => fixedNow },
      ),
    ).not.toThrow();
  });
});
