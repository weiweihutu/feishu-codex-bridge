import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentThread } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';

const routing = vi.hoisted(() => ({
  project: undefined as Project | undefined,
  startThread: vi.fn(),
  listModels: vi.fn(),
  messageCompleted: vi.fn(),
  send: vi.fn(),
  createdCards: [] as string[],
  updatedCards: [] as string[],
  elementContents: [] as string[],
}));

vi.mock('../src/core/logger', () => ({
  log: {
    info: () => undefined,
    warn: () => undefined,
    fail: () => undefined,
  },
  currentLogContext: () => ({ traceId: 'trace_direct_topic' }),
  withTrace: async (_ctx: unknown, fn: () => Promise<void> | void) => fn(),
}));

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

vi.mock('../src/core/audit-trace', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/core/audit-trace')>();
  return {
    ...original,
    emitMessageCompletedAudit: routing.messageCompleted,
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

describe('createOrchestrator no-mention routing', () => {
  const orchestrators: Orchestrator[] = [];

  beforeEach(() => {
    routing.project = undefined;
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
