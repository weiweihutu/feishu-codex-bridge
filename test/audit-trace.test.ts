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
  applyMessageRelationToAudit,
  buildAuditContext,
  emitMessageCompletedAudit,
  emitTraceStep,
  traceFieldsForAgentEvent,
  traceArtifactPath,
  truncateAuditText,
  type AuditContext,
  type TraceIo,
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

function waitableArtifactIo(workspaceRoot: string): {
  io: TraceIo;
  wait: () => Promise<void>;
} {
  let pending = Promise.resolve();
  return {
    io: {
      workspaceRoot,
      now: () => fixedNow,
      onArtifactWrite: (promise) => {
        pending = promise;
      },
    },
    wait: () => pending,
  };
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

describe('traceFieldsForAgentEvent', () => {
  it('maps gbrain MCP start metadata', () => {
    expect(traceFieldsForAgentEvent({
      type: 'tool_use',
      itemId: 'mcp-1',
      title: 'gbrain.query',
      toolType: 'mcp',
      server: 'gbrain',
      tool: 'query',
      toolInput: { id: 7 },
    })).toMatchObject({
      step_name: 'gbrain.mcp_started',
      step_type: 'mcp',
      item_id: 'mcp-1',
      tool_server: 'gbrain',
      tool_name: 'query',
      request_json: { id: 7 },
      status: 'success',
    });
  });

  it('maps ordinary tool start metadata', () => {
    expect(traceFieldsForAgentEvent({
      type: 'tool_use',
      itemId: 'tool-1',
      title: 'run command',
      toolType: 'command',
      tool: 'exec',
      toolInput: { cmd: 'pwd' },
    })).toEqual(expect.objectContaining({
      step_name: 'tool.started',
      step_type: 'command',
      item_id: 'tool-1',
      tool_name: 'exec',
      request_json: { cmd: 'pwd' },
      status: 'success',
    }));
  });

  it('maps gbrain MCP completion output and failure status', () => {
    expect(traceFieldsForAgentEvent({
      type: 'tool_result',
      itemId: 'mcp-1',
      toolType: 'mcp',
      server: 'gbrain',
      tool: 'query',
      output: '{"rows":[]}',
      status: 'failed',
      error: 'query failed',
    })).toEqual(expect.objectContaining({
      step_name: 'gbrain.mcp_completed',
      step_type: 'mcp',
      item_id: 'mcp-1',
      tool_server: 'gbrain',
      tool_name: 'query',
      output_text: '{"rows":[]}',
      status: 'error',
      error: 'query failed',
    }));
  });

  it('maps ordinary tool completion and ignores non-tool events', () => {
    expect(traceFieldsForAgentEvent({
      type: 'tool_result',
      itemId: 'tool-1',
      toolType: 'command',
      tool: 'exec',
      output: 'ok',
      status: 'completed',
    })).toEqual(expect.objectContaining({
      step_name: 'tool.completed',
      step_type: 'command',
      item_id: 'tool-1',
      tool_name: 'exec',
      output_text: 'ok',
      status: 'completed',
    }));
    expect(traceFieldsForAgentEvent({ type: 'text_delta', itemId: 'text-1', delta: 'hello' })).toBeNull();
  });
});

describe('buildAuditContext', () => {
  it('exposes required message identity fields in AuditContext', () => {
    expectTypeOf<AuditContext>().toMatchTypeOf<{
      msgId: string;
      chatId: string;
      threadId: string | null;
      rootId: string | null;
      parentId: string | null;
      senderId: string | null;
    }>();
  });

  it('preserves message identity and merges extras', () => {
    const audit = buildAuditContext(
      {
        messageId: 'om_1',
        chatId: 'oc_1',
        threadId: 'omt_1',
        rootId: 'om_root',
        replyToMessageId: 'om_parent',
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
      rootId: 'om_root',
      parentId: 'om_parent',
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
    expect(audit.rootId).toBeNull();
    expect(audit.parentId).toBeNull();
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
        rootId: 'om_root_core',
        replyToMessageId: 'om_parent_core',
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
        rootId: 'bad-root',
        parentId: 'bad-parent',
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
      rootId: 'om_root_core',
      parentId: 'om_parent_core',
      senderId: 'ou_core',
      chatType: 'group',
      mentionedBot: true,
      messageText: 'core text',
      messageTextTruncated: false,
      receivedAt: '2025-07-04T00:00:00.000Z',
      project: 'demo',
    });
  });

  it('backfills the resolved Feishu relation without using a role-suffixed session key', () => {
    const audit = buildAuditContext(
      {
        messageId: 'om_question',
        chatId: 'oc_topic',
        chatType: 'group',
        mentionedBot: true,
      },
      'question',
    );

    applyMessageRelationToAudit(audit, {
      threadId: 'omt_topic',
      rootId: 'om_question',
      parentId: 'om_question',
    });

    expect(audit).toMatchObject({
      threadId: 'omt_topic',
      rootId: 'om_question',
      parentId: 'om_question',
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
  it('returns the stable relative path before a waitable background write settles', async () => {
    const workspaceRoot = tempRoot();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled: Promise<void> | undefined;
    const io = {
      workspaceRoot,
      now: () => fixedNow,
      artifactWrite: async (file: string, body: string) => {
        await blocked;
        mkdirSync(join(file, '..'), { recursive: true });
        writeFileSync(file, body, 'utf8');
      },
      onArtifactWrite: (promise: Promise<void>) => {
        settled = promise;
      },
    } satisfies TraceIo;

    const relative = traceArtifactPath('om_async', 'result.txt', 'background', 'text', io);

    expect(relative).toBe('traces/artifacts/20250706/om_async/result.txt');
    expect(() => readFileSync(join(workspaceRoot, relative!), 'utf8')).toThrow();
    release();
    await settled;
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe('background');
  });

  it('absorbs a rejected background artifact write', async () => {
    let settled: Promise<void> | undefined;
    const relative = traceArtifactPath('om_failed', 'result.txt', 'content', 'text', {
      workspaceRoot: tempRoot(),
      now: () => fixedNow,
      artifactWrite: async () => {
        throw new Error('disk failed');
      },
      onArtifactWrite: (promise) => {
        settled = promise;
      },
    } satisfies TraceIo);

    expect(relative).toBe('traces/artifacts/20250706/om_failed/result.txt');
    await expect(settled).resolves.toBeUndefined();
  });

  it('sanitizes path segments and writes pretty JSON', async () => {
    const workspaceRoot = tempRoot();
    const artifact = waitableArtifactIo(workspaceRoot);
    const relative = traceArtifactPath(
      '../om:1',
      '../result?.json',
      { ok: true, nested: { count: 2 } },
      'json',
      artifact.io,
    );

    expect(relative).toBe('traces/artifacts/20250706/.._om_1/.._result_.json');
    await artifact.wait();
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe(
      '{\n  "ok": true,\n  "nested": {\n    "count": 2\n  }\n}',
    );
  });

  it('writes undefined JSON content as null', async () => {
    const workspaceRoot = tempRoot();
    const artifact = waitableArtifactIo(workspaceRoot);
    const relative = traceArtifactPath(
      'om_undefined',
      'result.json',
      undefined,
      'json',
      artifact.io,
    );

    expect(relative).toBe('traces/artifacts/20250706/om_undefined/result.json');
    await artifact.wait();
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe('null');
  });

  it('stringifies non-string message and artifact names before sanitizing', async () => {
    const workspaceRoot = tempRoot();
    const artifact = waitableArtifactIo(workspaceRoot);
    const relative = traceArtifactPath(
      12345,
      67890,
      'content',
      'text',
      artifact.io,
    );

    expect(relative).toBe('traces/artifacts/20250706/12345/67890');
    await artifact.wait();
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe('content');
  });

  it('replaces dot-only path segments so artifacts stay under the dated message directory', async () => {
    const workspaceRoot = tempRoot();
    const artifact = waitableArtifactIo(workspaceRoot);
    const relative = traceArtifactPath(
      '..',
      '..',
      'safe content',
      'text',
      artifact.io,
    );

    expect(relative).toBe(
      'traces/artifacts/20250706/unknown-message/artifact',
    );
    await artifact.wait();
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe('safe content');
  });

  it('keeps ordinary dot-prefixed names compatible', async () => {
    const workspaceRoot = tempRoot();
    const artifact = waitableArtifactIo(workspaceRoot);
    const relative = traceArtifactPath(
      '.message',
      '.result.json',
      { ok: true },
      'json',
      artifact.io,
    );

    expect(relative).toBe(
      'traces/artifacts/20250706/.message/.result.json',
    );
    await artifact.wait();
    expect(readFileSync(join(workspaceRoot, relative!), 'utf8')).toBe(
      '{\n  "ok": true\n}',
    );
  });
});

describe('emitMessageCompletedAudit', () => {
  it('ignores invalid field correlation IDs in favor of valid current context IDs', async () => {
    const workspaceRoot = tempRoot();
    const marker = `audit-invalid-fields-${Date.now()}-${Math.random()}`;

    withTrace(
      { traceId: 'context-trace', chatId: 'context-chat', msgId: 'context-msg' },
      () => {
        emitMessageCompletedAudit(
          {
            msgId: 'audit-msg',
            chatId: 'audit-chat',
            threadId: 'audit-thread',
            rootId: null,
            parentId: null,
            senderId: 'audit-sender',
          },
          {
            traceId: null,
            chatId: 42,
            msgId: '',
            replyText: 'answer',
            testMarker: marker,
          },
          { workspaceRoot, now: () => fixedNow },
        );
      },
    );

    const logEntry = await readRealLogEntry(marker);
    const traceEntry = JSON.parse(
      readFileSync(
        join(workspaceRoot, 'traces', 'logs', 'trace-20250706.log'),
        'utf8',
      ),
    ) as Record<string, unknown>;

    expect(logEntry).toEqual(
      expect.objectContaining({
        traceId: 'context-trace',
        chatId: 'context-chat',
        msgId: 'context-msg',
        _traceId: 'context-trace',
        _chatId: 'context-chat',
        _msgId: 'context-msg',
      }),
    );
    expect(traceEntry).toEqual(
      expect.objectContaining({
        trace_id: 'context-trace',
        chat_id: 'context-chat',
        msg_id: 'context-msg',
      }),
    );
  });

  it('generates one trace ID and omits invalid chat and message IDs without context', async () => {
    const workspaceRoot = tempRoot();
    const marker = `audit-generated-trace-${Date.now()}-${Math.random()}`;

    emitMessageCompletedAudit(
      undefined,
      {
        traceId: 123,
        chatId: null,
        msgId: '',
        replyText: 'answer',
        testMarker: marker,
      },
      { workspaceRoot, now: () => fixedNow },
    );

    const logEntry = await readRealLogEntry(marker);
    const traceEntry = JSON.parse(
      readFileSync(
        join(workspaceRoot, 'traces', 'logs', 'trace-20250706.log'),
        'utf8',
      ),
    ) as Record<string, unknown>;

    expect(logEntry.traceId).toEqual(expect.any(String));
    expect(logEntry.traceId).not.toBe('');
    expect(logEntry._traceId).toBe(logEntry.traceId);
    expect(traceEntry.trace_id).toBe(logEntry.traceId);
    expect(logEntry).not.toHaveProperty('chatId');
    expect(logEntry).not.toHaveProperty('_chatId');
    expect(logEntry).not.toHaveProperty('msgId');
    expect(logEntry).not.toHaveProperty('_msgId');
    expect(traceEntry).not.toHaveProperty('chat_id');
    expect(traceEntry).not.toHaveProperty('msg_id');
  });

  it('writes final correlation IDs at the top level of the real logger entry', async () => {
    expect(process.env.VITEST).toBeTruthy();
    const noContextRoot = tempRoot();
    const noContextMarker = `audit-real-no-context-${Date.now()}-${Math.random()}`;
    emitMessageCompletedAudit(
      {
        msgId: 'audit-msg',
        chatId: 'audit-chat',
        threadId: 'audit-thread',
        rootId: null,
        parentId: null,
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
        rootId: null,
        parentId: null,
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
      {
        msgId: 'om_4',
        chatId: 'oc_4',
        threadId: null,
        rootId: null,
        parentId: null,
        senderId: null,
      },
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
  it('does not throw when the workspace root cannot be created beneath a file', async () => {
    const root = tempRoot();
    const invalidRoot = join(root, 'not-a-directory');
    writeFileSync(invalidRoot, 'file', 'utf8');
    mkdirSync(root, { recursive: true });

    expect(() =>
      emitTraceStep({ input_text: 'hello' }, { workspaceRoot: invalidRoot, now: () => fixedNow }),
    ).not.toThrow();
    let artifactSettled: Promise<void> | undefined;
    expect(
      traceArtifactPath('om_1', 'result.txt', 'hello', 'text', {
        workspaceRoot: invalidRoot,
        now: () => fixedNow,
        onArtifactWrite: (promise) => {
          artifactSettled = promise;
        },
      }),
    ).toBe('traces/artifacts/20250706/om_1/result.txt');
    await expect(artifactSettled).resolves.toBeUndefined();
    expect(() =>
      emitMessageCompletedAudit(
        {
          msgId: 'om_1',
          chatId: 'oc_1',
          threadId: null,
          rootId: null,
          parentId: null,
          senderId: null,
        },
        { replyText: 'hello' },
        { workspaceRoot: invalidRoot, now: () => fixedNow },
      ),
    ).not.toThrow();
  });
});
