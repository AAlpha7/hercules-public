import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import type { Task } from '../../../src/domain/task.js';
import { SqliteStateStore } from '../../../src/control/state/sqliteStateStore.js';
import { serializeTask } from '../../../src/control/taskFile.js';
import { buildSnapshot } from '../../../src/control/snapshot.js';
import {
  createM4ObserverMemo,
  invalidateM4ObserverMemo,
  logM4ParityTransition,
  m4ObserverCacheEligible,
  m4ObserverFullyCaughtUp,
  resetM4ObserverHistory,
} from '../../../src/control/state/shadowObserverMemo.js';
import { observeM4AuthoritySnapshot } from '../../../src/main.js';
import {
  buildShadowProjectionHistory,
  deliverShadowProjection,
  reconciliationDeliveryId,
  type ShadowReconciliationReport,
} from '../../../src/control/state/shadowReconciler.js';

const roots: string[] = [];

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: 'Project ' + id,
    repo: 'app',
    state: 'todo',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: '2026-08-28T00:00:00Z',
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: '## Definition of Done\n- [ ] (mechanical) tests pass @gate:test',
    ...overrides,
  };
}

async function seedControl(label: string): Promise<{
  control: string;
  revision: string;
  tasks: readonly Task[];
}> {
  const control = mkdtempSync(join(tmpdir(), label));
  roots.push(control);
  mkdirSync(join(control, 'tasks'));
  writeFileSync(
    join(control, 'repos.yaml'),
    'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n',
  );
  const item = task('M4-MEMO');
  writeFileSync(join(control, 'tasks', item.id + '.md'), serializeTask(item));
  const git = simpleGit(control);
  await git.init(['-b', 'main']);
  await git.addConfig('user.email', 'memo@hercules.local');
  await git.addConfig('user.name', 'Memo');
  await git.add('.');
  await git.commit('seed');
  const revision = (await git.revparse(['HEAD'])).trim();
  const tasks = (await buildSnapshot(control)).tasks;
  return { control, revision, tasks };
}

function openStore(parent: string): {
  store: SqliteStateStore;
  root: string;
  databasePath: string;
} {
  const root = join(parent, 'state');
  const databasePath = join(root, 'shadow.sqlite');
  const store = new SqliteStateStore({ trustedRoot: root, databasePath });
  store.initialize();
  return { store, root, databasePath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('M4 observer revision memo', () => {
  it('m4ObserverFullyCaughtUp uses latestProjectionEnvelopeRevision', () => {
    const empty = {
      listIncompleteEnvelopes: () => [],
      listProjectionEnvelopes: () => [{ authorityRevision: 'should-not-be-read' }],
      latestProjectionEnvelopeRevision: () => null as string | null,
    };
    expect(m4ObserverFullyCaughtUp(empty, 'a'.repeat(40))).toBe(false);

    const caught = {
      listIncompleteEnvelopes: () => [],
      listProjectionEnvelopes: () => {
        throw new Error('listProjectionEnvelopes must not run for caught-up check');
      },
      latestProjectionEnvelopeRevision: () => 'c'.repeat(40),
    };
    expect(m4ObserverFullyCaughtUp(caught, 'c'.repeat(40))).toBe(true);
    expect(m4ObserverFullyCaughtUp(caught, 'd'.repeat(40))).toBe(false);
  });

  it('second observation at the same revision skips history rebuild and reconcile', async () => {
    const seeded = await seedControl('hercules-m4-memo-hit-');
    const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-memo-store-'));
    roots.push(parent);
    const { store } = openStore(parent);
    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>();
    const counters = { historyBuilds: 0, reconciles: 0 };
    const hooks = {
      onHistoryBuild: () => { counters.historyBuilds += 1; },
      onReconcile: () => { counters.reconciles += 1; },
    };
    const snapshot = {
      revision: seeded.revision,
      tasks: seeded.tasks,
      shadowPending: false as const,
    };
    try {
      const first = await observeM4AuthoritySnapshot(
        store, seeded.control, snapshot, failures, memo, hooks,
      );
      expect(first.parity).toBe(true);
      expect(counters.historyBuilds).toBeGreaterThan(0);
      expect(counters.reconciles).toBe(1);
      const buildsAfterFirst = counters.historyBuilds;
      const reconcilesAfterFirst = counters.reconciles;

      const second = await observeM4AuthoritySnapshot(
        store, seeded.control, snapshot, failures, memo, hooks,
      );
      expect(second).toBe(first);
      expect(counters.historyBuilds).toBe(buildsAfterFirst);
      expect(counters.reconciles).toBe(reconcilesAfterFirst);
      expect(m4ObserverCacheEligible(memo, store, seeded.revision, failures)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('revision change forces a full reconcile', async () => {
    const seeded = await seedControl('hercules-m4-memo-rev-');
    const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-memo-rev-store-'));
    roots.push(parent);
    const { store } = openStore(parent);
    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>();
    const counters = { historyBuilds: 0, reconciles: 0 };
    const hooks = {
      onHistoryBuild: () => { counters.historyBuilds += 1; },
      onReconcile: () => { counters.reconciles += 1; },
    };
    try {
      await observeM4AuthoritySnapshot(
        store,
        seeded.control,
        { revision: seeded.revision, tasks: seeded.tasks, shadowPending: false },
        failures,
        memo,
        hooks,
      );
      const buildsAfterFirst = counters.historyBuilds;
      const reconcilesAfterFirst = counters.reconciles;

      const updated = task('M4-MEMO', { title: 'Project M4-MEMO updated' });
      writeFileSync(join(seeded.control, 'tasks', updated.id + '.md'), serializeTask(updated));
      const git = simpleGit(seeded.control);
      await git.add('.');
      await git.commit('update task');
      const nextRevision = (await git.revparse(['HEAD'])).trim();
      const nextTasks = (await buildSnapshot(seeded.control)).tasks;

      const second = await observeM4AuthoritySnapshot(
        store,
        seeded.control,
        { revision: nextRevision, tasks: nextTasks, shadowPending: false },
        failures,
        memo,
        hooks,
      );
      expect(counters.historyBuilds).toBeGreaterThan(buildsAfterFirst);
      expect(counters.reconciles).toBe(reconcilesAfterFirst + 1);
      expect(second.authorityRevision).toBe(nextRevision);
    } finally {
      store.close();
    }
  });

  it('incomplete envelope forces a full reconcile', async () => {
    const seeded = await seedControl('hercules-m4-memo-inc-');
    const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-memo-inc-store-'));
    roots.push(parent);
    const { store } = openStore(parent);
    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>();
    const counters = { historyBuilds: 0, reconciles: 0 };
    const hooks = {
      onHistoryBuild: () => { counters.historyBuilds += 1; },
      onReconcile: () => { counters.reconciles += 1; },
    };
    const snapshot = {
      revision: seeded.revision,
      tasks: seeded.tasks,
      shadowPending: false as const,
    };
    try {
      await observeM4AuthoritySnapshot(
        store, seeded.control, snapshot, failures, memo, hooks,
      );
      const buildsAfterFirst = counters.historyBuilds;
      const reconcilesAfterFirst = counters.reconciles;

      const realIncomplete = store.listIncompleteEnvelopes.bind(store);
      let injectIncomplete = false;
      Object.defineProperty(store, 'listIncompleteEnvelopes', {
        configurable: true,
        value: () => {
          if (!injectIncomplete) return realIncomplete();
          return [{
            deliveryId: 'inject-incomplete',
            authorityRevision: seeded.revision,
            authorityInput: { writes: [], retiredTaskIds: [] },
            manifest: [],
            gapCodes: [],
            manifestDigest: 'inject',
            completed: false,
            acknowledgedCommands: 0,
          }];
        },
      });
      injectIncomplete = true;
      expect(m4ObserverCacheEligible(memo, store, seeded.revision, failures)).toBe(false);

      const second = await observeM4AuthoritySnapshot(
        store, seeded.control, snapshot, failures, memo, hooks,
      );
      expect(counters.historyBuilds).toBeGreaterThan(buildsAfterFirst);
      expect(counters.reconciles).toBe(reconcilesAfterFirst + 1);
      expect(second.parity).toBe(false);
      expect(second.entries.some((entry) => entry.kind === 'projection_incomplete')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('recorded projection failure forces a full reconcile', async () => {
    const seeded = await seedControl('hercules-m4-memo-fail-');
    const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-memo-fail-store-'));
    roots.push(parent);
    const { store } = openStore(parent);
    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>();
    const counters = { historyBuilds: 0, reconciles: 0 };
    const hooks = {
      onHistoryBuild: () => { counters.historyBuilds += 1; },
      onReconcile: () => { counters.reconciles += 1; },
    };
    const snapshot = {
      revision: seeded.revision,
      tasks: seeded.tasks,
      shadowPending: false as const,
    };
    try {
      await observeM4AuthoritySnapshot(
        store, seeded.control, snapshot, failures, memo, hooks,
      );
      const buildsAfterFirst = counters.historyBuilds;
      const reconcilesAfterFirst = counters.reconciles;

      failures.set('M4-MEMO', 'shadow_delivery_failed');
      expect(m4ObserverCacheEligible(memo, store, seeded.revision, failures)).toBe(false);
      const second = await observeM4AuthoritySnapshot(
        store,
        seeded.control,
        { ...snapshot, shadowPending: true },
        failures,
        memo,
        hooks,
      );
      expect(counters.historyBuilds).toBeGreaterThan(buildsAfterFirst);
      expect(counters.reconciles).toBe(reconcilesAfterFirst + 1);
      expect(second.parity).toBe(false);
      expect(second.entries.some((entry) => entry.kind === 'projection_failure')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('parity logging emits one line per transition or divergence-count change', async () => {
    const seeded = await seedControl('hercules-m4-memo-log-');
    const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-memo-log-store-'));
    roots.push(parent);
    const { store } = openStore(parent);
    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>();
    const lines: string[] = [];
    const hooks = { log: (line: string) => { lines.push(line); } };
    const snapshot = {
      revision: seeded.revision,
      tasks: seeded.tasks,
      shadowPending: false as const,
    };
    try {
      await observeM4AuthoritySnapshot(
        store, seeded.control, snapshot, failures, memo, hooks,
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('parity=true');

      await observeM4AuthoritySnapshot(
        store, seeded.control, snapshot, failures, memo, hooks,
      );
      expect(lines).toHaveLength(1);

      failures.set('M4-MEMO', 'shadow_delivery_failed');
      await observeM4AuthoritySnapshot(
        store, seeded.control, { ...snapshot, shadowPending: true }, failures, memo, hooks,
      );
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain('parity=false');

      await observeM4AuthoritySnapshot(
        store, seeded.control, { ...snapshot, shadowPending: true }, failures, memo, hooks,
      );
      expect(lines).toHaveLength(2);

      failures.clear();
      await observeM4AuthoritySnapshot(
        store, seeded.control, snapshot, failures, memo, hooks,
      );
      expect(lines).toHaveLength(3);
      expect(lines[2]).toContain('parity=true');
    } finally {
      store.close();
    }
  });

  it('store reopen invalidates the memo', async () => {
    const seeded = await seedControl('hercules-m4-memo-reopen-');
    const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-memo-reopen-store-'));
    roots.push(parent);
    const firstStore = openStore(parent);
    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>();
    const counters = { historyBuilds: 0, reconciles: 0 };
    const hooks = {
      onHistoryBuild: () => { counters.historyBuilds += 1; },
      onReconcile: () => { counters.reconciles += 1; },
    };
    const snapshot = {
      revision: seeded.revision,
      tasks: seeded.tasks,
      shadowPending: false as const,
    };
    await observeM4AuthoritySnapshot(
      firstStore.store, seeded.control, snapshot, failures, memo, hooks,
    );
    const buildsAfterFirst = counters.historyBuilds;
    firstStore.store.close();

    const reopened = new SqliteStateStore({
      trustedRoot: firstStore.root,
      databasePath: firstStore.databasePath,
    });
    reopened.initialize();
    try {
      expect(m4ObserverCacheEligible(memo, reopened, seeded.revision, failures)).toBe(false);
      await observeM4AuthoritySnapshot(
        reopened, seeded.control, snapshot, failures, memo, hooks,
      );
      expect(counters.historyBuilds).toBeGreaterThan(buildsAfterFirst);
      expect(counters.reconciles).toBe(2);
    } finally {
      reopened.close();
    }
  });

  it('shadowPending-skipped observe is not cache-eligible; later same-revision catch-up rebuilds', async () => {
    const seeded = await seedControl('hercules-m4-memo-pending-skip-');
    const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-memo-pending-store-'));
    roots.push(parent);
    const { store } = openStore(parent);
    const memo = createM4ObserverMemo();
    const failures = new Map<string, string>();
    const counters = { historyBuilds: 0, reconciles: 0 };
    const hooks = {
      onHistoryBuild: () => { counters.historyBuilds += 1; },
      onReconcile: () => { counters.reconciles += 1; },
    };
    const base = {
      revision: seeded.revision,
      tasks: seeded.tasks,
    };
    try {
      expect(store.listProjectionEnvelopes()).toHaveLength(0);
      const skipped = await observeM4AuthoritySnapshot(
        store,
        seeded.control,
        { ...base, shadowPending: true },
        failures,
        memo,
        hooks,
      );
      expect(store.listProjectionEnvelopes()).toHaveLength(0);
      expect(m4ObserverCacheEligible(memo, store, seeded.revision, failures)).toBe(false);
      const buildsAfterSkip = counters.historyBuilds;
      const reconcilesAfterSkip = counters.reconciles;
      expect(buildsAfterSkip).toBeGreaterThan(0);
      expect(reconcilesAfterSkip).toBe(1);
      const caughtUp = await observeM4AuthoritySnapshot(store, seeded.control, { ...base, shadowPending: false }, failures, memo, hooks);
      expect(caughtUp).not.toBe(skipped);
      expect(counters.historyBuilds).toBeGreaterThan(buildsAfterSkip);
      expect(counters.reconciles).toBe(reconcilesAfterSkip + 1);
      expect(store.listProjectionEnvelopes().at(-1)?.authorityRevision).toBe(seeded.revision);
      expect(caughtUp.parity).toBe(true);
      expect(m4ObserverCacheEligible(memo, store, seeded.revision, failures)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('invalidateM4ObserverMemo keeps history; resetM4ObserverHistory clears it on reopen', async () => {
    const seeded = await seedControl('hercules-m4-memo-history-');
    const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-memo-history-store-'));
    roots.push(parent);
    const { store } = openStore(parent);
    const memo = createM4ObserverMemo();
    const snapshot = {
      revision: seeded.revision,
      tasks: seeded.tasks,
      shadowPending: false as const,
    };
    deliverShadowProjection(store, {
      deliveryId: reconciliationDeliveryId(snapshot),
      revision: seeded.revision,
      writes: seeded.tasks,
      retiredTaskIds: [],
    });
    await buildShadowProjectionHistory(store, seeded.control, seeded.revision, { memo });
    expect(memo.history.deliveries.size).toBe(1);
    invalidateM4ObserverMemo(memo);
    expect(memo.history.deliveries.size).toBe(1);
    expect(memo.report).toBeNull();

    // First remember from an unbound memo must not wipe history just filled.
    await observeM4AuthoritySnapshot(
      store, seeded.control, snapshot, new Map(), memo, {},
    );
    expect(memo.history.deliveries.size).toBeGreaterThan(0);
    expect(memo.store).toBe(store);

    resetM4ObserverHistory(memo);
    expect(memo.history.deliveries.size).toBe(0);
    store.close();
  });

  it('binds the memo store on first history use so a later reopen drops the caches (live-commit-only path)', async () => {
    const seeded = await seedControl('hercules-m4-memo-bind-');
    const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-memo-bind-store-'));
    roots.push(parent);
    const first = openStore(parent);
    const memo = createM4ObserverMemo();
    const snapshot = { revision: seeded.revision, tasks: seeded.tasks, shadowPending: false as const };
    deliverShadowProjection(first.store, {
      deliveryId: reconciliationDeliveryId(snapshot),
      revision: seeded.revision,
      writes: seeded.tasks,
      retiredTaskIds: [],
    });
    // Live-commit shape: history/reconcile with the memo but no observer remember.
    await buildShadowProjectionHistory(first.store, seeded.control, seeded.revision, { memo });
    expect(memo.store).toBe(first.store);
    expect(memo.history.deliveries.size).toBe(1);
    first.store.close();

    const second = openStore(parent);
    const reconstructed: string[] = [];
    await buildShadowProjectionHistory(second.store, seeded.control, seeded.revision, {
      memo,
      onReconstruct: (deliveryId) => { reconstructed.push(deliveryId); },
    });
    // A reopened store handle never reuses the prior instance's caches.
    expect(reconstructed).toEqual([reconciliationDeliveryId(snapshot)]);
    expect(memo.store).toBe(second.store);
    second.store.close();
  });

  it('logM4ParityTransition skips identical repeats and logs divergence-count changes', () => {
    const memo = createM4ObserverMemo();
    const lines: string[] = [];
    const log = (line: string) => { lines.push(line); };
    const base = {
      authorityRevision: 'a'.repeat(40),
      shadowSchemaVersion: 2,
      comparedTaskCount: 1,
      reportDigest: 'digest',
      parity: true,
      cutoverEligible: false as const,
      cutoverBlockers: ['m4_shadow_only', 'owner_database_authority_gate'],
    };
    const equalReport: ShadowReconciliationReport = {
      ...base,
      entries: [{
        kind: 'equal',
        taskId: 'T1',
        authorityRevision: base.authorityRevision,
        reasonCode: 'equal',
        expectedDigest: 'x',
        actualDigest: 'x',
      }],
    };
    logM4ParityTransition(memo, equalReport, log);
    logM4ParityTransition(memo, equalReport, log);
    expect(lines).toHaveLength(1);

    const diverged: ShadowReconciliationReport = {
      ...base,
      parity: false,
      cutoverBlockers: ['m4_shadow_only', 'owner_database_authority_gate', 'task_missing'],
      entries: [{
        kind: 'missing_shadow',
        taskId: 'T1',
        authorityRevision: base.authorityRevision,
        reasonCode: 'task_missing',
        expectedDigest: 'x',
        actualDigest: null,
      }],
    };
    logM4ParityTransition(memo, diverged, log);
    expect(lines).toHaveLength(2);
  });
});
