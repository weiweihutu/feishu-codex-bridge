import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentThread } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';

const routing = vi.hoisted(() => ({
  project: undefined as Project | undefined,
  startThread: vi.fn(),
  listModels: vi.fn(),
  messageCompleted: vi.fn(),
  traceStep: vi.fn(),
  fail: vi.fn(),
  send: vi.fn(),
  createdCards: [] as string[],
  updatedCards: [] as string[],
  elementContents: [] as string[],
}));

vi.mock('../src/core/logger', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const contexts = new AsyncLocalStorage<Record<string, string | undefined>>();
  return {
    log: {
      info: () => undefined,
      warn: () => undefined,
      fail: routing.fail,
    },
    currentLogContext: () => ({ ...(contexts.getStore() ?? {}) }),
    withTrace: <T>(
      ctx: { traceId?: string; chatId?: string; msgId?: string },
      fn: () => T,
    ): T => contexts.run(
      { ...ctx, traceId: ctx.traceId ?? `trace_${ctx.msgId ?? 'generated'}` },
      fn,
    ),
  };
});

vi.mock('../src/project/registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/project/registry')>();
  return {
    ...original,
    getProjectByChatId: vi.fn(async () => routing.project),
  };
});

vi.mock('../src/project/announcement', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/project/announcement')>();
  return {
    ...original,
    refreshBranch: vi.fn(async () => undefined),
  };
});

vi.mock('../src/bot/session-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/bot/session-store')>();
  return {
    ...original,
    getSession: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => []),
    patchSession: vi.fn(async () => undefined),
    upsertSession: vi.fn(async () => undefined),
  };
});

vi.mock('../src/core/audit-trace', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/audit-trace')>();
  return {
    ...original,
    emitMessageCompletedAudit: routing.messageCompleted,
    emitTraceStep: routing.traceStep,
  };
});

vi.mock('../src/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/agent')>();
  return {
    ...original,
    createBackend: vi.fn(() => ({
      id: 'codex-appserver',
      displayName: 'Codex',
      isAvailable: vi.fn(async () => true),
      doctor: vi.fn(async () => ({ ok: true })),
      listModels: routing.listModels,
      listThreads: vi.fn(async () => []),
      readHistory: vi.fn(async () => []),
      startThread: routing.startThread,
      resumeThread: vi.fn(),
    })),
  };
});

import { createOrchestrator, type Orchestrator } from '../src/bot/handle-message';

const cfg: AppConfig = {
  accounts: { app: { id: 'app', secret: 'secret', tenant: 'feishu' } },
  preferences: { access: { ownerOpenId: 'ou_owner' }, showToolCalls: true },
};

function project(noMention: boolean): Project {
  return {
    name: 'demo',
    chatId: 'oc_project',
    cwd: '/repo',
    blank: false,
    createdAt: 1,
    kind: 'multi',
    noMention,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    messageId: `om_${Math.random()}`,
    chatId: 'oc_project',
    chatType: 'group',
    content: 'start a fresh topic',
    senderId: 'ou_user',
    senderName: 'User',
    createTime: 1,
    mentionedBot: false,
    mentionAll: false,
    mentions: [],
    resources: [],
    ...overrides,
  } as never;
}

function channel() {
  return {
    send: routing.send,
    rawClient: {
      cardkit: {
        v1: {
          card: {
            create: vi.fn(async ({ data }: { data: { data: string } }) => {
              routing.createdCards.push(data.data);
              return { data: { card_id: 'card_run' } };
            }),
            update: vi.fn(async ({ data }: { data: { card: { data: string } } }) => {
              routing.updatedCards.push(data.card.data);
              return {};
            }),
          },
          cardElement: {
            content: vi.fn(async ({ data }: { data: { content: string } }) => {
              routing.elementContents.push(data.content);
              return {};
            }),
          },
        },
      },
      im: {
        v1: {
          message: {
            create: vi.fn(async () => ({ data: { message_id: 'om_run' } })),
            reply: vi.fn(async () => ({ data: { message_id: 'om_run' } })),
            get: vi.fn(async () => ({ data: { items: [{ thread_id: 'omt_run' }] } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
  } as never;
}

function ordinaryThread(events: AgentEvent[]): AgentThread {
  return {
    sessionId: 'session_run',
    runStreamed: () => ({
      events: (async function* () {
        for (const event of events) {
          yield event;
          await new Promise((resolve) => setTimeout(resolve, 170));
        }
      })(),
      turnId: () => 'turn-1',
      lastActivity: () => Date.now(),
    }),
    runGoal: vi.fn(),
    clearGoal: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ compacted: false, usage: null })),
    isAlive: () => true,
    close: vi.fn(async () => undefined),
  };
}

function queuedThread(
  inputs: Array<{ text: string }>,
  releaseFirst: Promise<void>,
  onFirstEntered: () => void,
  steeredInputs: Array<{ text: string }> = [],
  steerError?: Error,
): AgentThread {
  let turn = 0;
  return {
    ...ordinaryThread([]),
    steer: vi.fn(async (input) => {
      steeredInputs.push({ text: input.text ?? '' });
      if (steerError) throw steerError;
    }),
    runStreamed: (input) => {
      inputs.push({ text: input.text ?? '' });
      turn++;
      const current = turn;
      return {
        events: (async function* () {
          if (current === 1) {
            onFirstEntered();
            await releaseFirst;
          }
          yield { type: 'tool_use', itemId: `tool-${current}`, title: `tool ${current}` } as AgentEvent;
          yield { type: 'tool_result', itemId: `tool-${current}`, output: `result ${current}` } as AgentEvent;
          yield { type: 'text', itemId: `message-${current}`, text: `answer ${current}` } as AgentEvent;
          yield { type: 'done', turnId: `turn-${current}` } as AgentEvent;
        })(),
        turnId: () => `turn-${current}`,
        lastActivity: () => Date.now(),
      };
    },
  };
}

describe('createOrchestrator no-mention routing', () => {
  const orchestrators: Orchestrator[] = [];

  beforeEach(() => {
    routing.project = undefined;
    cfg.preferences ??= {};
    cfg.preferences.pendingPolicy = undefined;
    routing.startThread.mockReset().mockRejectedValue(new Error('stop at direct-topic boundary'));
    routing.listModels.mockReset().mockResolvedValue([{
      id: 'gpt-test',
      displayName: 'GPT Test',
      description: '',
      isDefault: true,
      supportedEfforts: ['medium'],
      defaultEffort: 'medium',
    }]);
    routing.messageCompleted.mockReset();
    routing.traceStep.mockReset();
    routing.fail.mockReset();
    routing.send.mockReset().mockResolvedValue({ messageId: 'om_error' });
    routing.createdCards.length = 0;
    routing.updatedCards.length = 0;
    routing.elementContents.length = 0;
  });

  afterEach(async () => {
    await Promise.all(orchestrators.splice(0).map((orchestrator) => orchestrator.shutdown()));
  });

  function create(): Orchestrator {
    const orchestrator = createOrchestrator(channel(), cfg, '/fallback');
    orchestrators.push(orchestrator);
    return orchestrator;
  }

  it('routes ordinary non-mentioned main-group text into the direct topic path when enabled', async () => {
    routing.project = project(true);
    await create().onMessage(message());

    await vi.waitFor(() => expect(routing.startThread).toHaveBeenCalledTimes(1));
    expect(routing.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/repo' }));
  });

  it('hides tools throughout an ordinary running and terminal card even when configured visible', async () => {
    routing.project = project(true);
    routing.startThread.mockResolvedValue(ordinaryThread([
      { type: 'tool_use', itemId: 't1', title: 'secret tool' },
      { type: 'tool_result', itemId: 't1', output: 'secret output' },
      { type: 'text', itemId: 'm1', text: 'final answer' },
      { type: 'done', turnId: 'turn-1' },
    ]));

    await create().onMessage(message({ messageId: 'om_tool_visibility' }));
    await vi.waitFor(
      () => expect(routing.updatedCards.at(-1)).toContain('final answer'),
      { timeout: 5_000 },
    );

    const cardFrames = [...routing.createdCards, ...routing.updatedCards];
    expect(cardFrames.length).toBeGreaterThan(1);
    for (const json of cardFrames) {
      expect(json).not.toContain('secret tool');
      expect(json).not.toContain('secret output');
      expect(json).not.toMatch(/1 个工具(?:调用)?/);
    }
    expect(routing.updatedCards.at(-1)).toContain('final answer');
  });

  it('queues a running-session message with its own Feishu context and trace identity', async () => {
    routing.project = project(true);
    cfg.preferences!.pendingPolicy = 'queue';
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const inputs: Array<{ text: string }> = [];
    routing.startThread.mockResolvedValue(queuedThread(inputs, firstBlocked, markFirstEntered));
    const orchestrator = create();
    const threadId = `omt_queue_trace_${Date.now()}`;

    await orchestrator.onMessage(message({
      messageId: 'om_first',
      threadId,
      content: 'first request',
      senderId: 'ou_first',
      senderName: 'First User',
    }));
    await vi.waitFor(() => expect(routing.startThread).toHaveBeenCalledTimes(1));
    await firstEntered;

    await orchestrator.onMessage(message({
      messageId: 'om_second',
      threadId,
      content: 'second request',
      senderId: 'ou_second',
      senderName: 'Second User',
      createTime: 2,
    }));
    releaseFirst();

    await vi.waitFor(() => expect(inputs).toHaveLength(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(
      routing.messageCompleted.mock.calls.some(([ctx]) => ctx.msgId === 'om_second'),
    ).toBe(true), { timeout: 5_000 });

    expect(inputs[1]?.text).toContain('second request');
    expect(inputs[1]?.text).toContain('[Feishu Context]');
    expect(inputs[1]?.text).toContain('message_id=om_second');
    expect(inputs[1]?.text).toContain('feishu_user_id=ou_second');
    expect(inputs[1]?.text).toContain('REQUEST_ID to message_id');
    expect(inputs[1]?.text).not.toContain('message_id=om_first');
    expect(inputs[1]?.text).not.toContain('feishu_user_id=ou_first');

    const promptSteps = routing.traceStep.mock.calls
      .map(([step]) => step)
      .filter((step) => step.step_name === 'codex.prompt_built');
    expect(promptSteps).toEqual(expect.arrayContaining([
      expect.objectContaining({ msg_id: 'om_first', trace_id: 'trace_om_first' }),
      expect.objectContaining({
        msg_id: 'om_second',
        trace_id: 'trace_om_second',
        session_id: 'session_run',
        input_text: expect.stringContaining('message_id=om_second'),
      }),
    ]));
    expect(promptSteps.filter((step) => step.msg_id === 'om_second')).toHaveLength(1);

    const secondToolSteps = routing.traceStep.mock.calls
      .map(([step]) => step)
      .filter((step) => step.msg_id === 'om_second' && String(step.step_name).startsWith('tool.'));
    expect(secondToolSteps.length).toBeGreaterThan(0);
    expect(secondToolSteps.every((step) => step.trace_id === 'trace_om_second')).toBe(true);
    expect(routing.messageCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ msgId: 'om_second', traceId: 'trace_om_second' }),
      expect.objectContaining({ msgId: 'om_second', traceId: 'trace_om_second' }),
    );
  }, 10_000);

  it('steers a running-session message with its own Feishu context and prompt trace', async () => {
    routing.project = project(true);
    cfg.preferences!.pendingPolicy = 'steer';
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const inputs: Array<{ text: string }> = [];
    const steeredInputs: Array<{ text: string }> = [];
    routing.startThread.mockResolvedValue(
      queuedThread(inputs, firstBlocked, markFirstEntered, steeredInputs),
    );
    const orchestrator = create();
    const threadId = `omt_steer_trace_${Date.now()}`;

    await orchestrator.onMessage(message({
      messageId: 'om_steer_first',
      threadId,
      content: 'first request',
      senderId: 'ou_first',
      senderName: 'First User',
    }));
    await firstEntered;

    await orchestrator.onMessage(message({
      messageId: 'om_steer_second',
      threadId,
      content: 'steer request',
      senderId: 'ou_second',
      senderName: 'Second User',
      createTime: 2,
    }));

    expect(steeredInputs).toHaveLength(1);
    expect(steeredInputs[0]?.text).toContain('steer request');
    expect(steeredInputs[0]?.text).toContain('message_id=om_steer_second');
    expect(steeredInputs[0]?.text).toContain('feishu_user_id=ou_second');
    expect(steeredInputs[0]?.text).toContain('REQUEST_ID to message_id');
    expect(steeredInputs[0]?.text).not.toContain('message_id=om_steer_first');

    const promptSteps = routing.traceStep.mock.calls
      .map(([step]) => step)
      .filter((step) => step.msg_id === 'om_steer_second' && step.step_name === 'codex.prompt_built');
    expect(promptSteps).toEqual([
      expect.objectContaining({
        trace_id: 'trace_om_steer_second',
        session_id: 'session_run',
        input_text: expect.stringContaining('message_id=om_steer_second'),
      }),
    ]);

    releaseFirst();
    await vi.waitFor(() => expect(
      routing.messageCompleted.mock.calls.some(([ctx]) => ctx.msgId === 'om_steer_first'),
    ).toBe(true), { timeout: 5_000 });
  }, 10_000);

  it('emits one prompt trace when failed steer falls back to the real queue', async () => {
    routing.project = project(true);
    cfg.preferences!.pendingPolicy = 'steer';
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const inputs: Array<{ text: string }> = [];
    const steeredInputs: Array<{ text: string }> = [];
    routing.startThread.mockResolvedValue(
      queuedThread(inputs, firstBlocked, markFirstEntered, steeredInputs, new Error('steer failed')),
    );
    const orchestrator = create();
    const threadId = `omt_steer_fallback_${Date.now()}`;

    await orchestrator.onMessage(message({
      messageId: 'om_fallback_first',
      threadId,
      content: 'first request',
      senderId: 'ou_first',
      senderName: 'First User',
    }));
    await firstEntered;

    await orchestrator.onMessage(message({
      messageId: 'om_fallback_second',
      threadId,
      content: 'fallback request',
      senderId: 'ou_second',
      senderName: 'Second User',
      createTime: 2,
    }));
    releaseFirst();

    await vi.waitFor(() => expect(inputs).toHaveLength(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(
      routing.messageCompleted.mock.calls.some(([ctx]) => ctx.msgId === 'om_fallback_second'),
    ).toBe(true), { timeout: 5_000 });

    expect(steeredInputs[0]?.text).toContain('message_id=om_fallback_second');
    expect(inputs[1]?.text).toContain('message_id=om_fallback_second');
    const promptSteps = routing.traceStep.mock.calls
      .map(([step]) => step)
      .filter((step) =>
        step.msg_id === 'om_fallback_second'
        && step.step_name === 'codex.prompt_built'
      );
    expect(promptSteps).toEqual([
      expect.objectContaining({
        trace_id: 'trace_om_fallback_second',
        session_id: 'session_run',
        input_text: expect.stringContaining('message_id=om_fallback_second'),
      }),
    ]);
  }, 10_000);

  it('audits a direct-topic intake failure once with the model known before startThread fails', async () => {
    routing.project = project(true);
    const msg = message({ messageId: 'om_intake_error' });

    await create().onMessage(msg);

    await vi.waitFor(() => expect(routing.messageCompleted).toHaveBeenCalledTimes(1));
    expect(routing.messageCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ msgId: 'om_intake_error', model: 'gpt-test' }),
      expect.objectContaining({
        terminal: 'error',
        error: 'stop at direct-topic boundary',
        images: 0,
        model: 'gpt-test',
        replyText: '',
      }),
    );
  });

  it('does not audit a direct-topic goal intake failure', async () => {
    routing.project = project(true);

    await create().onMessage(message({ content: '/goal finish the migration' }));

    await vi.waitFor(() => expect(routing.send).toHaveBeenCalledTimes(1));
    expect(routing.messageCompleted).not.toHaveBeenCalled();
  });

  it('does not respond to an unbound group without a bot mention', async () => {
    await create().onMessage(message());

    expect(routing.startThread).not.toHaveBeenCalled();
  });

  it('does not respond when noMention is explicitly disabled', async () => {
    routing.project = project(false);
    await create().onMessage(message());

    expect(routing.startThread).not.toHaveBeenCalled();
  });

  it.each([
    ['@all', { mentionAll: true }],
    ['another real user', { mentions: [{ isBot: false }] }],
  ])('does not respond when the message mentions %s', async (_label, overrides) => {
    routing.project = project(true);
    await create().onMessage(message(overrides));

    expect(routing.startThread).not.toHaveBeenCalled();
  });
});
