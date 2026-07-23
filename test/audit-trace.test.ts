import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  buildAuditContext,
  emitMessageCompletedAudit,
  emitTraceStep,
  traceArtifactPath,
  truncateAuditText,
  type AuditContext,
} from '../src/core/audit-trace';
import {
  currentLogContext,
  log,
  TEST_LOGS_DIR,
  withTrace,
  type LogContext,
} from '../src/core/logger';

const roots: string[] = [];
const fixedNow = new Date('2025-07-06T12:34:56.789Z');

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'audit-trace-test-'));
  roots.push(root);
  return root;
}

async function readRealLogEntry(marker: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      for (const name of readdirSync(TEST_LOGS_DIR)) {
        if (!name.endsWith('.log')) continue;
        for (const line of readFileSync(join(TEST_LOGS_DIR, name), 'utf8').split('\n')) {
          if (!line.includes(marker)) continue;
          return JSON.parse(line) as Record<string, unknown>;
        }
      }
    } catch {
      // The logger creates its temporary directory lazily.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`logger entry not flushed for marker ${marker}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('currentLogContext', () => {
  it('withTrace preserves the return type of a synchronous callback', () => {
    const result = withTrace(
      { traceId: 'trace-sync', chatId: 'chat-sync', msgId: 'msg-sync' },
      () => currentLogContext(),
    );

    expectTypeOf(result).toEqualTypeOf<Readonly<LogContext>>();
    expect(result).toEqual({
      traceId: 'trace-sync',
      chatId: 'chat-sync',
      msgId: 'msg-sync',
    });
  });

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
  it('exposes required message identity fields in AuditContext', () => {
    expectTypeOf<AuditContext>().toMatchTypeOf<{
      msgId: string;
      chatId: string;
      threadId: string | null;
      senderId: string | null;
    }>();
  });

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

  it('falls back to message content when text is nullish', () => {
    const audit = buildAuditContext(
      {
        messageId: 'om_content',
        chatId: 'oc_content',
        chatType: 'group',
        mentionedBot: true,
        content: 'message fallback',
        createTime: Date.parse('2025-07-02T00:00:00.000Z'),
      },
      undefined,
    );

    expect(audit.messageText).toBe('message fallback');
    expect(audit.messageTextTruncated).toBe(false);
  });

  it('does not let extras override core audit fields', () => {
    const audit = buildAuditContext(
      {
        messageId: 'om_core',
        chatId: 'oc_core',
        threadId: 'omt_core',
        senderId: 'ou_core',
        chatType: 'group',
        mentionedBot: true,
        createTime: Date.parse('2025-07-04T00:00:00.000Z'),
      },
      'core text',
      {
        msgId: 'bad-msg',
        chatId: 'bad-chat',
        threadId: 'bad-thread',
        senderId: 'bad-sender',
        chatType: 'bad-type',
        mentionedBot: false,
        messageText: 'bad-text',
        messageTextTruncated: true,
        receivedAt: 'bad-time',
        project: 'demo',
      },
    );

    expect(audit).toEqual({
      msgId: 'om_core',
      chatId: 'oc_core',
      threadId: 'omt_core',
      senderId: 'ou_core',
      chatType: 'group',
      mentionedBot: true,
      messageText: 'core text',
      messageTextTruncated: false,
      receivedAt: '2025-07-04T00:00:00.000Z',
      project: 'demo',
    });
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

  it('uses the local calendar date when UTC and local dates differ', () => {
    vi.stubEnv('TZ', 'Asia/Shanghai');
    const workspaceRoot = tempRoot();
    const localJulySix = new Date('2025-07-05T16:30:00.000Z');

    emitTraceStep({}, { workspaceRoot, now: () => localJulySix });

    expect(
      readFileSync(
        join(workspaceRoot, 'traces', 'logs', 'trace-20250706.log'),
        'utf8',
      ),
    ).toContain('"event":"trace_step"');
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

  it('writes undefined JSON content as null', () => {
    const workspaceRoot = tempRoot();
    const relative = traceArtifactPath(
      'om_undefined',
      'result.json',
      undefined,
      'json',
      { workspaceRoot, now: () => fixedNow },
    );

    expect(relative).toBe('traces/artifacts/20250706/om_undefined/result.json');
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe('null');
  });

  it('stringifies non-string message and artifact names before sanitizing', () => {
    const workspaceRoot = tempRoot();
    const relative = traceArtifactPath(
      12345,
      67890,
      'content',
      'text',
      { workspaceRoot, now: () => fixedNow },
    );

    expect(relative).toBe('traces/artifacts/20250706/12345/67890');
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe('content');
  });

  it('replaces dot-only path segments so artifacts stay under the dated message directory', () => {
    const workspaceRoot = tempRoot();
    const relative = traceArtifactPath(
      '..',
      '..',
      'safe content',
      'text',
      { workspaceRoot, now: () => fixedNow },
    );

    expect(relative).toBe(
      'traces/artifacts/20250706/unknown-message/artifact',
    );
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe('safe content');
  });

  it('keeps ordinary dot-prefixed names compatible', () => {
    const workspaceRoot = tempRoot();
    const relative = traceArtifactPath(
      '.message',
      '.result.json',
      { ok: true },
      'json',
      { workspaceRoot, now: () => fixedNow },
    );

    expect(relative).toBe(
      'traces/artifacts/20250706/.message/.result.json',
    );
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe(
      '{\n  "ok": true\n}',
    );
  });
});

describe('emitMessageCompletedAudit', () => {
  it('writes final correlation IDs at the top level of the real logger entry', async () => {
    expect(process.env.VITEST).toBeTruthy();
    const noContextRoot = tempRoot();
    const noContextMarker = `audit-real-no-context-${Date.now()}-${Math.random()}`;
    emitMessageCompletedAudit(
      {
        msgId: 'audit-msg',
        chatId: 'audit-chat',
        threadId: 'audit-thread',
        senderId: 'audit-sender',
      },
      {
        traceId: 'audit-trace',
        replyText: 'answer',
        testMarker: noContextMarker,
      },
      { workspaceRoot: noContextRoot, now: () => fixedNow },
    );

    const noContextEntry = await readRealLogEntry(noContextMarker);
    expect(noContextEntry).toEqual(
      expect.objectContaining({
        phase: 'audit',
        event: 'message_completed',
        traceId: 'audit-trace',
        chatId: 'audit-chat',
        msgId: 'audit-msg',
      }),
    );

    const overrideRoot = tempRoot();
    const overrideMarker = `audit-real-override-${Date.now()}-${Math.random()}`;
    withTrace(
      { traceId: 'outer-trace', chatId: 'outer-chat', msgId: 'outer-msg' },
      () => {
        emitMessageCompletedAudit(
          undefined,
          {
            traceId: 'field-trace',
            chatId: 'field-chat',
            msgId: 'field-msg',
            threadId: 'field-thread',
            replyText: 'answer',
            testMarker: overrideMarker,
          },
          { workspaceRoot: overrideRoot, now: () => fixedNow },
        );
      },
    );

    const overrideEntry = await readRealLogEntry(overrideMarker);
    expect(overrideEntry).toEqual(
      expect.objectContaining({
        phase: 'audit',
        event: 'message_completed',
        traceId: 'field-trace',
        chatId: 'field-chat',
        msgId: 'field-msg',
      }),
    );
    const traceEntry = JSON.parse(
      readFileSync(
        join(overrideRoot, 'traces', 'logs', 'trace-20250706.log'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(overrideEntry.traceId).toBe(traceEntry.trace_id);
    expect(overrideEntry.chatId).toBe(traceEntry.chat_id);
    expect(overrideEntry.msgId).toBe(traceEntry.msg_id);
  });

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
          startedAt: '2025-07-06T12:34:50.000Z',
          completedAt: '2025-07-06T12:34:56.000Z',
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
        event: 'trace_step',
        status: 'success',
        msg_id: 'ctx-msg',
        chat_id: 'ctx-chat',
        thread_id: 'omt_3',
        project: 'demo',
        trace_id: 'trace-3',
        step_name: 'codex.response_composed',
        step_type: 'compose',
        started_at: '2025-07-06T12:34:50.000Z',
        completed_at: '2025-07-06T12:34:56.000Z',
        elapsed_ms: 123,
        model: 'gpt-test',
        output_text: 'answer',
        response_json: {
          terminal: 'done',
          textChars: 6,
          images: 1,
          imageFiles: ['answer.png'],
        },
      }),
    );
  });

  it('accepts undefined audit and lets fields override the current log context', async () => {
    const workspaceRoot = tempRoot();
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);

    await withTrace({ traceId: 'context-trace', chatId: 'context-chat', msgId: 'context-msg' }, async () => {
      emitMessageCompletedAudit(
        undefined,
        {
          traceId: 'field-trace',
          chatId: 'field-chat',
          msgId: 'field-msg',
          replyText: 'answer',
        },
        { workspaceRoot, now: () => fixedNow },
      );
    });

    expect(info).toHaveBeenCalledWith(
      'audit',
      'message_completed',
      expect.objectContaining({
        traceId: 'field-trace',
        chatId: 'field-chat',
        msgId: 'field-msg',
      }),
    );
  });

  it('emits an empty imageFiles array when completion fields omit it', () => {
    const workspaceRoot = tempRoot();
    vi.spyOn(log, 'info').mockImplementation(() => undefined);
    emitMessageCompletedAudit(
      {
        msgId: 'om_no_images',
        chatId: 'oc_no_images',
        threadId: null,
        senderId: null,
      },
      { replyText: 'answer' },
      { workspaceRoot, now: () => fixedNow },
    );

    const entry = JSON.parse(
      readFileSync(join(workspaceRoot, 'traces', 'logs', 'trace-20250706.log'), 'utf8'),
    ) as { response_json: { imageFiles: unknown[] } };
    expect(entry.response_json.imageFiles).toEqual([]);
  });

  it('truncates a long reply in both audit and trace payloads', () => {
    const workspaceRoot = tempRoot();
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    emitMessageCompletedAudit(
      { msgId: 'om_4', chatId: 'oc_4', threadId: null, senderId: null },
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
    ) as { output_text: string };
    expect(entry.output_text).toHaveLength(20_000);
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
        { msgId: 'om_1', chatId: 'oc_1', threadId: null, senderId: null },
        { replyText: 'hello' },
        { workspaceRoot: invalidRoot, now: () => fixedNow },
      ),
    ).not.toThrow();
  });
});
