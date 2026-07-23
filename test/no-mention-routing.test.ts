import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config/schema';
import type { Project } from '../src/project/registry';

const routing = vi.hoisted(() => ({
  project: undefined as Project | undefined,
  startThread: vi.fn(),
  listModels: vi.fn(),
}));

vi.mock('../src/core/logger', () => ({
  log: {
    info: () => undefined,
    warn: () => undefined,
    fail: () => undefined,
  },
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
  preferences: { access: { ownerOpenId: 'ou_owner' } },
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
    send: vi.fn(async () => ({ messageId: 'om_error' })),
    rawClient: {
      im: {
        v1: {
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
  } as never;
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
