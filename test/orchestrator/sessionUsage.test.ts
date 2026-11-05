import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { Orchestrator, type ControlPort } from '../../src/orchestrator/orchestrator.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import { CostLedgerStore } from '../../src/control/costLedgerStore.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { Task, TaskState } from '../../src/domain/task.js';

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state: 'todo' as TaskState,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: 'body',
    ...overrides,
  };
}

const repos: ReposConfig = {
  repos: {
    app: {
      key: 'app',
      url: 'x',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: null,
      readiness: 'ready',
    },
  },
};

class FakePort implements ControlPort {
  constructor(readonly tasks: Map<string, Task>) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos, tasks: [...this.tasks.values()], problems: [] };
  }
  async writeTask(next: Task): Promise<void> {
    this.tasks.set(next.id, next);
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(): Promise<{ committed: boolean }> {
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}
}

const policy = {
  costCaps: {
    enabled: true,
    billingMode: 'metered' as const,
    billingModeNote: null,
    perTask: { softUsd: null, hardUsd: null, softTokens: null, hardTokens: null },
    daily: { softUsd: 2, hardUsd: 3, softTokens: null, hardTokens: null },
  },
} as const;

describe('recordSessionUsage', () => {
  let dir: string;
  let nowMs: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hercules-session-usage-'));
    nowMs = Date.UTC(2026, 7, 4, 12);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function makeOrch(): Orchestrator {
    const port = new FakePort(new Map([task('A')].map((t) => [t.id, t])));
    return new Orchestrator({
      config: makeConfig('/ctrl', policy),
      control: port,
      agents: AgentRegistry.of(new FakeAdapter({ durationMs: 50_000, hang: true })),
      clock: () => nowMs,
      costLedgerStore: new CostLedgerStore({ rootDir: dir, clock: () => nowMs }),
    });
  }

  it('appends an rc turn receipt; idempotent by turn; reflects in costSummary.day; skips invalid scope', async () => {
    const orch = makeOrch();
    await orch.recordSessionUsage({
      scopeId: 'rc-abc12345',
      sessionId: 'rc-abc12345',
      turn: 1,
      usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.011989896 },
      atMs: nowMs,
    });

    const state1 = orch.getState();
    // Summary aggregates via addUsage (rounds USD to 1e-6).
    expect(state1.costSummary?.day.costUsd).toBeCloseTo(0.01199, 6);
    expect(state1.costSummary?.day.inputTokens).toBe(100);
    expect(state1.costSummary?.day.outputTokens).toBe(40);
    expect(state1.costSummary?.ledger?.receiptCount).toBe(1);

    // Same turn again — idempotent (one receipt).
    await orch.recordSessionUsage({
      scopeId: 'rc-abc12345',
      sessionId: 'rc-abc12345',
      turn: 1,
      usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.011989896 },
      atMs: nowMs,
    });
    expect(orch.getState().costSummary?.ledger?.receiptCount).toBe(1);
    expect(orch.getState().costSummary?.day.costUsd).toBeCloseTo(0.01199, 6);

    // Invalid scope id is skipped without throwing.
    await expect(
      orch.recordSessionUsage({
        scopeId: '../evil',
        sessionId: 'rc-abc12345',
        turn: 2,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 1 },
        atMs: nowMs,
      }),
    ).resolves.toBeUndefined();
    expect(orch.getState().costSummary?.ledger?.receiptCount).toBe(1);

    // Scope id is the receipt taskId — totals key by scope.
    expect(orch.getState().costSummary?.taskTotals?.['rc-abc12345']).toMatchObject({
      inputTokens: 100,
      outputTokens: 40,
    });
    expect(orch.getState().costSummary?.taskTotals?.['rc-abc12345']?.costUsd).toBeCloseTo(
      0.01199,
      6,
    );
  });

  it('uses runKey rc-<sessionId>-t<turn> for the durable receipt', async () => {
    const store = new CostLedgerStore({ rootDir: dir, clock: () => nowMs });
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', policy),
      control: new FakePort(new Map()),
      agents: AgentRegistry.of(new FakeAdapter({ durationMs: 50_000, hang: true })),
      clock: () => nowMs,
      costLedgerStore: store,
    });
    await orch.recordSessionUsage({
      scopeId: 'rc-abc12345',
      sessionId: 'rc-abc12345',
      turn: 1,
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
      atMs: nowMs,
    });
    const loaded = await store.load();
    expect(loaded.ledger.receipts).toHaveLength(1);
    expect(loaded.ledger.receipts[0]?.runKey).toBe('rc-rc-abc12345-t1');
    expect(loaded.ledger.receipts[0]?.taskId).toBe('rc-abc12345');
  });
});
