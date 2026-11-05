import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRegistry } from '../../src/orchestrator/agentRegistry.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { Orchestrator, type ControlPort } from '../../src/orchestrator/orchestrator.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import { CostLedgerStore, COST_LEDGER_FILENAME } from '../../src/control/costLedgerStore.js';
import { makeUsageReceiptId, parseCostLedger } from '../../src/domain/costLedger.js';
import { parseCostCapsPolicy } from '../../src/domain/costCaps.js';
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

describe('durable cost ledger restart policy', () => {
  let dir: string;
  let nowMs: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hercules-ledger-restart-'));
    nowMs = Date.UTC(2026, 7, 4, 12);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function orchestrator(
    tasks: Task[],
    adapter: FakeAdapter,
    store = new CostLedgerStore({ rootDir: dir, clock: () => nowMs }),
  ): { orch: Orchestrator; port: FakePort } {
    const port = new FakePort(new Map(tasks.map((item) => [item.id, item])));
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', policy),
      control: port,
      agents: AgentRegistry.of(adapter),
      clock: () => nowMs,
      costLedgerStore: store,
    });
    return { orch, port };
  }

  it('preserves task/day totals and the hard decision across restart', async () => {
    const first = orchestrator(
      [task('A', { priority: 10 }), task('B', { priority: 50 })],
      new FakeAdapter({
        durationMs: 50,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 5 },
      }),
    );
    await first.orch.tick();
    nowMs += 100;
    await first.orch.tick();
    expect(first.port.tasks.get('A')?.state).toBe('review');
    expect(first.orch.getState().costSummary?.day.costUsd).toBe(5);
    const costRunId = first.port.tasks.get('A')?.costRunId;
    const raw = await readFile(join(dir, COST_LEDGER_FILENAME), 'utf8');
    const parsed = parseCostLedger(raw, { nowMs });
    expect(parsed.kind).toBe('ok');
    if (parsed.kind !== 'ok' || !costRunId) return;
    expect(parsed.ledger.receipts[0]?.runKey).toBe(makeUsageReceiptId('A', costRunId));

    nowMs += 100;
    const restarted = orchestrator(
      [task('A', { state: 'review' }), task('B', { priority: 50 })],
      new FakeAdapter({ durationMs: 50_000, hang: true }),
    );
    const report = await restarted.orch.tick();
    expect(report.dispatched).not.toContain('B');
    expect(restarted.port.tasks.get('B')?.state).toBe('todo');
    expect(restarted.orch.getState().costSummary).toMatchObject({
      level: 'hard',
      day: { inputTokens: 10, outputTokens: 5, costUsd: 5 },
      taskTotals: { A: { inputTokens: 10, outputTokens: 5, costUsd: 5 } },
      ledger: { status: 'ok', failClosed: false, receiptCount: 1 },
    });
  });

  it('dispatches the 2.70M-token/$0 recovery task under default subscription policy', async () => {
    const store = new CostLedgerStore({ rootDir: dir, clock: () => nowMs });
    let ledger = (await store.load()).ledger;
    ledger = (await store.appendReceipt(ledger, {
      runKey: makeUsageReceiptId('superseded', 'eebc71da-f27a-47e0-b79f-578f5314ae10'),
      taskId: 'superseded',
      atMs: nowMs,
      usage: { inputTokens: 1_500_000, outputTokens: 450_000, costUsd: 0 },
    })).ledger;
    await store.appendReceipt(ledger, {
      runKey: makeUsageReceiptId('recovery', '30b948b0-ae28-4724-9499-3277e529cc44'),
      taskId: 'recovery',
      atMs: nowMs,
      usage: { inputTokens: 2_000_000, outputTokens: 700_000, costUsd: 0 },
    });

    const subscriptionPolicy = {
      costCaps: parseCostCapsPolicy({
        HERCULES_COST_CAPS: '1',
        HERCULES_BILLING_MODE: 'subscription',
      }),
    };
    const port = new FakePort(new Map([
      ['recovery', task('recovery', { state: 'retrying' })],
    ]));
    const adapter = new FakeAdapter({ durationMs: 50_000, hang: true });
    const orch = new Orchestrator({
      config: makeConfig('/ctrl', subscriptionPolicy),
      control: port,
      agents: AgentRegistry.of(adapter),
      clock: () => nowMs,
      costLedgerStore: store,
    });

    const report = await orch.tick();
    expect(report.dispatched).toContain('recovery');
    expect(port.tasks.get('recovery')?.state).toBe('in_progress');
    expect(orch.getState().costSummary).toMatchObject({
      level: 'ok',
      day: { inputTokens: 3_500_000, outputTokens: 1_150_000, costUsd: 0 },
      taskTotals: {
        recovery: { inputTokens: 2_000_000, outputTokens: 700_000, costUsd: 0 },
      },
    });
  });

  it('uses the new UTC day while retaining the prior receipt for audit', async () => {
    nowMs = Date.UTC(2026, 7, 4, 23);
    const first = orchestrator(
      [task('A')],
      new FakeAdapter({ durationMs: 50, usage: { inputTokens: 1, outputTokens: 0, costUsd: 5 } }),
    );
    await first.orch.tick();
    nowMs += 100;
    await first.orch.tick();

    nowMs = Date.UTC(2026, 7, 5, 1);
    const restarted = orchestrator(
      [task('A', { state: 'review' }), task('B')],
      new FakeAdapter({ durationMs: 50_000, hang: true }),
    );
    const report = await restarted.orch.tick();
    expect(restarted.orch.getState().costSummary?.day.costUsd).toBe(0);
    expect(restarted.orch.getState().costSummary?.ledger?.receiptCount).toBe(1);
    expect(report.dispatched).toContain('B');
  });

  it('does not move a delayed duplicate into a new UTC day across restart', async () => {
    nowMs = Date.UTC(2026, 7, 4, 23, 59);
    const runKey = makeUsageReceiptId('A', 'a4a1e0db-80c1-4c55-8bb7-dae28d980ae6');
    const firstStore = new CostLedgerStore({ rootDir: dir, clock: () => nowMs });
    const first = await firstStore.appendReceipt(
      (await firstStore.load()).ledger,
      {
        runKey,
        taskId: 'A',
        atMs: nowMs,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 1 },
      },
    );

    nowMs = Date.UTC(2026, 7, 5, 0, 1);
    const replayStore = new CostLedgerStore({ rootDir: dir, clock: () => nowMs });
    const replay = await replayStore.appendReceipt((await replayStore.load()).ledger, {
      runKey,
      taskId: 'A',
      atMs: nowMs,
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 1 },
    });
    expect(first.applied).toBe(true);
    expect(replay.applied).toBe(false);

    const restarted = orchestrator(
      [task('A', { state: 'review' })],
      new FakeAdapter({ durationMs: 50_000, hang: true }),
    );
    await restarted.orch.tick();
    expect(restarted.orch.getState().costSummary).toMatchObject({
      day: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      taskTotals: { A: { inputTokens: 10, outputTokens: 5, costUsd: 1 } },
      ledger: { status: 'ok', failClosed: false, receiptCount: 1 },
    });
    const recovered = await new CostLedgerStore({ rootDir: dir, clock: () => nowMs }).load();
    expect(recovered.ledger.receipts[0]?.atMs).toBe(Date.UTC(2026, 7, 4, 23, 59));
  });

  it('sums distinct same-timestamp dispatches across restart', async () => {
    const first = orchestrator(
      [task('A')],
      new FakeAdapter({
        durationMs: 0,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 1 },
      }),
    );
    await first.orch.tick();
    const firstRunId = first.port.tasks.get('A')?.costRunId;
    await first.orch.tick();
    const completed = first.port.tasks.get('A');
    expect(completed?.state).toBe('review');
    if (!completed) return;

    first.port.tasks.set('A', {
      ...completed,
      state: 'retrying',
      endedAt: null,
      lastEventAt: null,
    });
    await first.orch.tick();
    const secondRunId = first.port.tasks.get('A')?.costRunId;
    expect(firstRunId).toBeTruthy();
    expect(secondRunId).toBeTruthy();
    expect(secondRunId).not.toBe(firstRunId);
    await first.orch.tick();
    expect(first.orch.getState().costSummary?.taskTotals['A']?.costUsd).toBe(2);

    const restarted = orchestrator(
      [task('A', { state: 'review' })],
      new FakeAdapter({ durationMs: 50_000, hang: true }),
    );
    await restarted.orch.tick();
    expect(restarted.orch.getState().costSummary).toMatchObject({
      day: { inputTokens: 20, outputTokens: 10, costUsd: 2 },
      taskTotals: { A: { inputTokens: 20, outputTokens: 10, costUsd: 2 } },
      ledger: { status: 'ok', failClosed: false, receiptCount: 2 },
    });
  });

  it('fails closed on corrupt current-day state and exposes a bounded reason', async () => {
    await new CostLedgerStore({ rootDir: dir, clock: () => nowMs }).load();
    await writeFile(join(dir, COST_LEDGER_FILENAME), '{broken', 'utf8');
    const restarted = orchestrator(
      [task('A')],
      new FakeAdapter({ durationMs: 50_000, hang: true }),
    );
    const report = await restarted.orch.tick();
    const summary = restarted.orch.getState().costSummary;
    expect(report.dispatched).not.toContain('A');
    expect(summary?.level).toBe('hard');
    expect(summary?.ledger).toMatchObject({ status: 'corrupt', failClosed: true });
    expect(summary?.reasons.join(' ')).toMatch(/corrupt|fail closed/i);
    expect(JSON.stringify(summary)).not.toMatch(/prompt|credential|provider.*payload|sessionId/i);
  });

  it('keeps a failed terminal persist fail-closed across restart', async () => {
    const realOps = CostLedgerStore.defaultFileOps();
    let tempWrites = 0;
    const failingStore = new CostLedgerStore({
      rootDir: dir,
      clock: () => nowMs,
      fileOps: {
        ...realOps,
        writeFile: async (path, data, options) => {
          if (String(path).endsWith('.json.tmp')) {
            tempWrites += 1;
            if (tempWrites > 1) {
              throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            }
          }
          await realOps.writeFile(path, data, options);
        },
      },
    });
    const first = orchestrator(
      [task('A', { priority: 10 }), task('B', { priority: 50 })],
      new FakeAdapter({
        durationMs: 50,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 1 },
      }),
      failingStore,
    );
    await first.orch.tick();
    nowMs += 100;
    await first.orch.tick();
    expect(first.orch.getState().costSummary?.ledger).toMatchObject({
      status: 'unavailable',
      failClosed: true,
    });

    nowMs += 100;
    const restarted = orchestrator(
      [task('A', { state: 'review' }), task('B', { priority: 50 })],
      new FakeAdapter({ durationMs: 50_000, hang: true }),
    );
    const report = await restarted.orch.tick();
    expect(report.dispatched).not.toContain('B');
    expect(restarted.orch.getState().costSummary?.ledger).toMatchObject({
      status: 'unavailable',
      failClosed: true,
    });
    expect(restarted.orch.getState().costSummary?.reasons.join(' ')).toMatch(/interrupted/i);
  });
});
