import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import {
  BRIDGED_APPROVAL_POLICY,
  bridgeDeliveryId,
  contractNeedsBridge,
  isBridgeDeliveryId,
} from '../../../src/domain/approvalPolicyBridge.js';
import { canonicalClone, hashCanonicalJson } from '../../../src/domain/canonicalJson.js';
import {
  projectLegacyTask,
  type ShadowGapCode,
} from '../../../src/domain/shadowProjection.js';
import type { Task } from '../../../src/domain/task.js';
import { SqliteStateStore } from '../../../src/control/state/sqliteStateStore.js';
import type {
  ControlStateStore,
  ShadowTaskState,
} from '../../../src/control/state/stateStore.js';
import {
  applyCommands,
  buildBridgeDelivery,
  buildShadowProjectionHistory,
  deliverShadowProjection,
  projectionCommandTaskId,
  reconcileShadowSnapshot,
  reconciliationDeliveryId,
  replayExpectedState,
  ShadowProjectionError,
  shadowDeliveryForGitRevision,
  type ReconciliationEntryKind,
  type ShadowDelivery,
  type ShadowReconciliationEntry,
  type ShadowReconciliationReport,
  type VersionedAuthoritySnapshot,
  assertNoIncompleteEnvelopes,
} from '../../../src/control/state/shadowReconciler.js';
import {
  createM4ObserverMemo,
  invalidateM4ObserverMemo,
  resetM4ObserverHistory,
} from '../../../src/control/state/shadowObserverMemo.js';
import { serializeTask } from '../../../src/control/taskFile.js';
import { buildSnapshot } from '../../../src/control/snapshot.js';
import { GitControlPort } from '../../../src/orchestrator/gitControlPort.js';

const roots: string[] = [];
const A = 'a'.repeat(40);

function store(failureInjector?: ConstructorParameters<typeof SqliteStateStore>[0]['failureInjector']) {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-m4-reconcile-'));
  roots.push(parent);
  const root = join(parent, 'state');
  const value = new SqliteStateStore({
    trustedRoot: root,
    databasePath: join(root, 'shadow.sqlite'),
    ...(failureInjector === undefined ? {} : { failureInjector }),
  });
  value.initialize();
  return { value, root, databasePath: join(root, 'shadow.sqlite') };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Project ${id}`,
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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('C3.46 replay memo shares immutable states', () => {
  it('a caller mutating the returned map cannot corrupt the memoized replay', async () => {
    const { value } = store();
    const item = task('M4-SHARE');
    deliverShadowProjection(value, {
      deliveryId: 'share-first', revision: A, writes: [item], retiredTaskIds: [],
    });
    const history = [{ deliveryId: 'share-first', revision: A, writes: [item], retiredTaskIds: [] }];
    const memo = createM4ObserverMemo();
    const first = replayExpectedState(value, history, { memo });
    const digestBefore = hashCanonicalJson([...first.entries()]);
    first.delete(item.id);
    first.set('M4-INJECTED', first.get(item.id) ?? (memo.replay!.states.get(item.id)!));
    const second = replayExpectedState(value, history, { memo });
    expect(hashCanonicalJson([...second.entries()])).toBe(digestBefore);
    expect(second.has('M4-INJECTED')).toBe(false);
    value.close();
  });
});

describe('C3.58 no-op deliveries append no envelope', () => {
  it('skips a delivery that projects nothing, keeps replay parity, stays idempotent', () => {
    const { value } = store();
    const item = task('M4-NOOP');
    const first = deliverShadowProjection(value, {
      deliveryId: 'sync-first', revision: A, writes: [item], retiredTaskIds: [],
    });
    expect(first.completed).toBe(true);
    expect(first.skipped).toBeUndefined();
    const B = 'b'.repeat(40);
    const noop = deliverShadowProjection(value, {
      deliveryId: 'sync-noop', revision: B, writes: [item], retiredTaskIds: [],
    });
    expect(noop).toMatchObject({ skipped: true, completed: true, acknowledgedCommands: 0, manifest: [] });
    expect(value.readEnvelope('sync-noop')).toBeNull();
    expect(value.listProjectionEnvelopeKeys().map((k) => k.deliveryId)).toEqual(['sync-first']);
    expect(deliverShadowProjection(value, {
      deliveryId: 'sync-noop', revision: B, writes: [item], retiredTaskIds: [],
    })).toEqual(noop);
    const rec = deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId({ revision: B, tasks: [item] }),
      revision: B, writes: [item], retiredTaskIds: [],
    });
    expect(rec.skipped).toBe(true);
    const history = [{ deliveryId: 'sync-first', revision: A, writes: [item], retiredTaskIds: [] }];
    const report = reconcileShadowSnapshot(value, { revision: B, tasks: [item] }, new Map(), history);
    expect(report.parity).toBe(true);
    value.close();
  });

  it('skips a zero-command delivery even when it reports gaps; the report still surfaces them', () => {
    const { value } = store();
    // A task that appears straight in review has no activation history: its
    // projection carries a standing gap on every later pass (the production
    // shape — iteration_state_mismatch / pre_activation_history_missing).
    const review = task('M4-GAPPED', { state: 'review' });
    const first = deliverShadowProjection(value, {
      deliveryId: 'review-first', revision: A, writes: [review], retiredTaskIds: [],
    });
    expect(first.skipped).toBeUndefined();
    expect(first.gapCodes.length).toBeGreaterThan(0);
    const B = 'b'.repeat(40);
    const gapped = deliverShadowProjection(value, {
      deliveryId: 'review-again', revision: B, writes: [review], retiredTaskIds: [],
    });
    expect(gapped.skipped).toBe(true);
    expect(gapped.gapCodes).toEqual(first.gapCodes);
    expect(value.readEnvelope('review-again')).toBeNull();
    // Gap codes are recomputed live by the reconciliation report, never read
    // back from envelopes — so nothing was lost by not persisting them.
    const history = [{ deliveryId: 'review-first', revision: A, writes: [review], retiredTaskIds: [] }];
    const report = reconcileShadowSnapshot(value, { revision: B, tasks: [review] }, new Map(), history);
    expect(report.parity).toBe(false);
    expect(report.entries.map((e) => e.reasonCode)).toEqual(expect.arrayContaining([...gapped.gapCodes]));
    value.close();
  });
});

describe('M4 shadow delivery and reconciliation', () => {
  it('delivers a committed write through an immutable envelope and reports parity', () => {
    const { value } = store();
    const item = task('M4-A');
    const envelope = deliverShadowProjection(value, {
      deliveryId: 'git-delivery-a',
      revision: A,
      writes: [item],
      retiredTaskIds: [],
    });
    expect(envelope).toMatchObject({ completed: true, acknowledgedCommands: 2 });
    expect(deliverShadowProjection(value, {
      deliveryId: 'git-delivery-a',
      revision: A,
      writes: [item],
      retiredTaskIds: [],
    })).toEqual(envelope);
    const history = [{ deliveryId: 'git-delivery-a', revision: A, writes: [item], retiredTaskIds: [] }];
    const report = reconcileShadowSnapshot(value, { revision: A, tasks: [item] }, new Map(), history);
    expect(report.parity).toBe(true);
    expect(report.cutoverEligible).toBe(false);
    expect(report.cutoverBlockers).toEqual(['m4_shadow_only', 'owner_database_authority_gate']);
    expect(report.entries).toMatchObject([{ kind: 'equal', taskId: 'M4-A' }]);
    expect(report.entries[0]?.expectedDigest).toBe(report.entries[0]?.actualDigest);
    value.close();
  });

  it('delivers mixed-case task ids in byte order (localeCompare regression, C1 soak)', () => {
    // Byte order puts 'Demo-ready-1' BEFORE 'demo-idle-scan' ('M' < 'm');
    // locale collation puts it after — and the store's authority-input
    // validation requires strict ascending byte order. With localeCompare
    // canonicalization every real-corpus delivery containing mixed-case ids
    // failed 'sorted disjoint task identities' — caught on the first C1
    // staging boot (202-task snapshot).
    const { value } = store();
    const upper = task('Demo-ready-1');
    const lower = task('demo-idle-scan');
    const envelope = deliverShadowProjection(value, {
      deliveryId: 'git-delivery-mixed-case',
      revision: A,
      // Intentionally byte-unsorted input — canonicalization must byte-sort.
      writes: [lower, upper],
      retiredTaskIds: [],
    });
    expect(envelope.completed).toBe(true);
    expect(envelope.authorityInput.writes.map((t) => t.id)).toEqual([
      'Demo-ready-1',
      'demo-idle-scan',
    ]);
    value.close();
  });

  it('replays a mixed-case reconciliation through history verification and parity', async () => {
    // The review of the one-hunk comparator fix proved a persisted mixed-case
    // reconcile envelope then CRASHED every boot: assertEnvelopeAuthorityInput
    // compares stored writes POSITIONALLY against the task tree re-read by
    // tasksAtRevision, which still sorted by localeCompare. This end-to-end
    // fixture covers the full path: deliver → buildShadowProjectionHistory
    // (must not throw) → reconcile (parity true).
    const control = mkdtempSync(join(tmpdir(), 'shadow-mixed-case-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const upper = task('Demo-ready-1');
    const lower = task('demo-idle-scan');
    writeFileSync(join(control, 'tasks', `${upper.id}.md`), serializeTask(upper));
    writeFileSync(join(control, 'tasks', `${lower.id}.md`), serializeTask(lower));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed mixed-case tasks');
    const revision = (await git.revparse(['HEAD'])).trim();

    const { value, root: storeRoot, databasePath: storeDb } = store();
    const snapshot = { revision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId(snapshot),
      revision,
      writes: snapshot.tasks,
      retiredTaskIds: [],
    });
    const history = await buildShadowProjectionHistory(value, control, revision);
    expect(history).toHaveLength(1);
    const report = reconcileShadowSnapshot(value, snapshot, new Map(), history);
    expect(report.parity).toBe(true);

    // REOPEN regression: #replayAndVerify's expected-criteria sort previously
    // used localeCompare over serialized JSON (contract_version-first key),
    // disagreeing with the SQL's byte-ordered (task_id, contract_version,
    // criterion_id) — a persisted mixed-case corpus bricked every reopen with
    // 'contract criterion projection differs from event replay'.
    value.close();
    const reopened = new SqliteStateStore({
      trustedRoot: storeRoot,
      databasePath: storeDb,
    });
    reopened.initialize();
    expect(reopened.readTask('Demo-ready-1')).not.toBeNull();
    reopened.close();
  });

  it('detects injected extra contract and iteration history instead of reporting equality', () => {
    const { value } = store();
    const item = task('M4-EXTRA');
    deliverShadowProjection(value, {
      deliveryId: 'extra-history', revision: A, writes: [item], retiredTaskIds: [],
    });
    const actual = value.readTask(item.id)!;
    const injected: ShadowTaskState = {
      ...actual,
      contracts: [...actual.contracts, actual.contracts[0]!],
      iterations: [...actual.iterations, { ...actual.iterations[0]!, id: 'injected-2', ordinal: 2 }],
    };
    const fake = {
      readTask: () => injected,
      listTaskIds: () => [item.id],
      listProjectionEnvelopes: () => value.listProjectionEnvelopes(),
      listProjectionEnvelopeKeys: () => value.listProjectionEnvelopeKeys(),
      readEnvelopeManifest: (id: string) => value.readEnvelopeManifest(id),
      listIncompleteEnvelopes: () => [],
    } as unknown as ControlStateStore;
    const history = [{ deliveryId: 'extra-history', revision: A, writes: [item], retiredTaskIds: [] }];
    const report = reconcileShadowSnapshot(fake, { revision: A, tasks: [item] }, new Map(), history);
    expect(report.parity).toBe(false);
    expect(report.entries.map((entry) => entry.reasonCode)).toEqual(expect.arrayContaining([
      'unexpected_contract_history',
      'unexpected_iteration_history',
    ]));
    expect(report.entries.every((entry) => entry.expectedDigest !== entry.actualDigest)).toBe(true);
    value.close();
  });

  it('detects a full-shape iteration mutation even when count and current state match', () => {
    const { value } = store();
    const item = task('M4-FULL-SHAPE');
    deliverShadowProjection(value, {
      deliveryId: 'full-shape', revision: A, writes: [item], retiredTaskIds: [],
    });
    const actual = value.readTask(item.id)!;
    const injected: ShadowTaskState = {
      ...actual,
      iterations: [{ ...actual.iterations[0]!, createdAt: 'forged-time' }],
    };
    const fake = {
      readTask: () => injected,
      listTaskIds: () => [item.id],
      listProjectionEnvelopes: () => value.listProjectionEnvelopes(),
      listProjectionEnvelopeKeys: () => value.listProjectionEnvelopeKeys(),
      readEnvelopeManifest: (id: string) => value.readEnvelopeManifest(id),
      listIncompleteEnvelopes: () => [],
    } as unknown as ControlStateStore;
    const history = [{ deliveryId: 'full-shape', revision: A, writes: [item], retiredTaskIds: [] }];
    const report = reconcileShadowSnapshot(fake, { revision: A, tasks: [item] }, new Map(), history);
    expect(report.parity).toBe(false);
    expect(report.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'iteration_mismatch', reasonCode: 'iteration_stale' }),
    ]));
    value.close();
  });

  it('retains every distinct projection gap in entries and cutover blockers', () => {
    const { value } = store();
    const original = task('M4-MULTI');
    deliverShadowProjection(value, {
      deliveryId: 'multi-root', revision: A, writes: [original], retiredTaskIds: [],
    });
    const changed = task('M4-MULTI', {
      title: 'Changed semantic objective',
      state: 'review',
      attempts: 1,
      verifiedSha: null,
    });
    const history = [{ deliveryId: 'multi-root', revision: A, writes: [original], retiredTaskIds: [] }];
    const report = reconcileShadowSnapshot(value, {
      revision: 'b'.repeat(40), tasks: [changed],
    }, new Map(), history);
    expect(report.entries.map((entry) => entry.reasonCode)).toEqual(expect.arrayContaining([
      'contract_change_requires_trusted_authority',
      'candidate_missing',
    ]));
    expect(report.cutoverBlockers).toEqual(expect.arrayContaining([
      'contract_change_requires_trusted_authority',
      'candidate_missing',
    ]));
    value.close();
  });

  it('accepts an honestly observed retry ordinal without an attempt burn', () => {
    const { value } = store();
    const initial = task('M4-RETRY');
    deliverShadowProjection(value, {
      deliveryId: 'retry-initial', revision: A, writes: [initial], retiredTaskIds: [],
    });
    const running = task('M4-RETRY', {
      state: 'in_progress', attempts: 0, startedAt: '2026-08-28T00:01:00Z',
      lastEventAt: '2026-08-28T00:01:00Z',
    });
    deliverShadowProjection(value, {
      deliveryId: 'retry-running', revision: 'b'.repeat(40), writes: [running], retiredTaskIds: [],
    });
    const retrying = task('M4-RETRY', {
      state: 'retrying', attempts: 0, endedAt: '2026-08-28T00:02:00Z',
      lastEventAt: '2026-08-28T00:02:00Z',
    });
    deliverShadowProjection(value, {
      deliveryId: 'retry-planned', revision: 'c'.repeat(40), writes: [retrying], retiredTaskIds: [],
    });
    const history: ShadowDelivery[] = [
      { deliveryId: 'retry-initial', revision: A, writes: [initial], retiredTaskIds: [] },
      { deliveryId: 'retry-running', revision: 'b'.repeat(40), writes: [running], retiredTaskIds: [] },
      { deliveryId: 'retry-planned', revision: 'c'.repeat(40), writes: [retrying], retiredTaskIds: [] },
    ];
    const report = reconcileShadowSnapshot(value, {
      revision: 'c'.repeat(40), tasks: [retrying],
    }, new Map(), history);
    expect(value.readTask(retrying.id)?.iterations).toHaveLength(2);
    expect(report.parity).toBe(true);
    expect(report.entries).toMatchObject([{ kind: 'equal' }]);
    value.close();
  });

  it('resumes only the missing suffix after a committed 256-command batch', () => {
    let projections = 0;
    const first = store((point) => {
      if (point === 'after_projection') {
        projections += 1;
        if (projections === 257) throw new Error('injected second-batch interruption');
      }
    });
    const tasks = Array.from({ length: 130 }, (_, index) => task(`M4-${String(index).padStart(3, '0')}`));
    expect(() => deliverShadowProjection(first.value, {
      deliveryId: 'git-delivery-batch',
      revision: A,
      writes: tasks,
      retiredTaskIds: [],
    })).toThrow('state database operation failed');
    expect(first.value.readEnvelope('git-delivery-batch')).toMatchObject({
      completed: false,
      acknowledgedCommands: 256,
    });
    first.value.close();

    const reopened = new SqliteStateStore({
      trustedRoot: first.root,
      databasePath: first.databasePath,
    });
    reopened.initialize();
    expect(deliverShadowProjection(reopened, {
      deliveryId: 'git-delivery-batch',
      revision: A,
      writes: tasks,
      retiredTaskIds: [],
    })).toMatchObject({ completed: true, acknowledgedCommands: 260 });
    expect(reopened.readEvents(0, 1000)).toHaveLength(260);
    reopened.close();
  });

  it('defers a live delivery while another envelope is incomplete, allows its own retry', () => {
    let projections = 0;
    const first = store((point) => {
      if (point === 'after_projection') {
        projections += 1;
        if (projections === 257) throw new Error('injected second-batch interruption');
      }
    });
    const tasks = Array.from({ length: 130 }, (_, index) => task(`M4-${String(index).padStart(3, '0')}`));
    expect(() => deliverShadowProjection(first.value, {
      deliveryId: 'git-delivery-batch',
      revision: A,
      writes: tasks,
      retiredTaskIds: [],
    })).toThrow('state database operation failed');
    expect(first.value.listIncompleteEnvelopes().map((envelope) => envelope.deliveryId))
      .toEqual(['git-delivery-batch']);
    expect(() => assertNoIncompleteEnvelopes(first.value, 'git-delivery-live'))
      .toThrow('live delivery git-delivery-live deferred: incomplete projection envelope(s) git-delivery-batch must resume first');
    expect(() => assertNoIncompleteEnvelopes(first.value, 'git-delivery-batch')).not.toThrow();
    first.value.close();

    const reopened = new SqliteStateStore({
      trustedRoot: first.root,
      databasePath: first.databasePath,
    });
    reopened.initialize();
    expect(deliverShadowProjection(reopened, {
      deliveryId: 'git-delivery-batch',
      revision: A,
      writes: tasks,
      retiredTaskIds: [],
    })).toMatchObject({ completed: true });
    expect(() => assertNoIncompleteEnvelopes(reopened, 'git-delivery-live')).not.toThrow();
    reopened.close();
  });

  it('fails parity for gaps, incomplete delivery, unexpected state, and retirement mismatch', () => {
    const { value } = store();
    const planned = task('M4-REVIEW');
    deliverShadowProjection(value, {
      deliveryId: 'planned', revision: A, writes: [planned], retiredTaskIds: [],
    });
    const review = task('M4-REVIEW', { state: 'review', attempts: 0 });
    deliverShadowProjection(value, {
      deliveryId: 'gap', revision: 'b'.repeat(40), writes: [review], retiredTaskIds: [],
    });
    value.beginEnvelope({
      deliveryId: 'unfinished', authorityRevision: A,
      authorityInput: { writes: [], retiredTaskIds: [] }, manifest: [], gapCodes: [],
    });
    const history: ShadowDelivery[] = [
      { deliveryId: 'planned', revision: A, writes: [planned], retiredTaskIds: [] },
      { deliveryId: 'gap', revision: 'b'.repeat(40), writes: [review], retiredTaskIds: [] },
      { deliveryId: 'unfinished', revision: A, writes: [], retiredTaskIds: [] },
    ];
    const report = reconcileShadowSnapshot(
      value, { revision: 'b'.repeat(40), tasks: [review] }, new Map(), history,
    );
    expect(report.parity).toBe(false);
    expect(report.entries.map((item) => item.kind)).toContain('coverage_gap');
    expect(report.entries.map((item) => item.kind)).toContain('projection_incomplete');
    expect(report.cutoverBlockers).toEqual(expect.arrayContaining([
      'candidate_missing', 'projection_incomplete', 'm4_shadow_only',
      'owner_database_authority_gate',
    ]));
    value.close();
  });

  it('retires a missing authority task without deleting its history', () => {
    const { value } = store();
    const item = task('M4-OLD');
    deliverShadowProjection(value, {
      deliveryId: 'create-old', revision: A, writes: [item], retiredTaskIds: [],
    });
    deliverShadowProjection(value, {
      deliveryId: 'retire-old', revision: 'b'.repeat(40), writes: [], retiredTaskIds: ['M4-OLD'],
    });
    expect(value.readTask('M4-OLD')).toMatchObject({
      contracts: [{ taskId: 'M4-OLD' }],
      retirement: { revision: 'b'.repeat(40) },
    });
    const history: ShadowDelivery[] = [
      { deliveryId: 'create-old', revision: A, writes: [item], retiredTaskIds: [] },
      { deliveryId: 'retire-old', revision: 'b'.repeat(40), writes: [], retiredTaskIds: ['M4-OLD'] },
    ];
    const report = reconcileShadowSnapshot(
      value, { revision: 'b'.repeat(40), tasks: [] }, new Map(), history,
    );
    expect(report.parity).toBe(true);
    expect(report.entries).toMatchObject([{ kind: 'equal', reasonCode: 'retired' }]);
    value.close();
  });

  it('rejects a retirement not reproduced by the exact deletion delivery', () => {
    const { value } = store();
    const item = task('M4-WRONG-RETIRE');
    deliverShadowProjection(value, {
      deliveryId: 'create-retire', revision: A, writes: [item], retiredTaskIds: [],
    });
    deliverShadowProjection(value, {
      deliveryId: 'delete-retire', revision: 'b'.repeat(40), writes: [],
      retiredTaskIds: [item.id],
    });
    const actual = value.readTask(item.id)!;
    const fake = {
      readTask: () => ({
        ...actual,
        retirement: { taskId: item.id, revision: 'c'.repeat(40) },
      }),
      listTaskIds: () => [item.id],
      listProjectionEnvelopes: () => value.listProjectionEnvelopes(),
      listProjectionEnvelopeKeys: () => value.listProjectionEnvelopeKeys(),
      readEnvelopeManifest: (id: string) => value.readEnvelopeManifest(id),
      listIncompleteEnvelopes: () => [],
    } as unknown as ControlStateStore;
    const history: ShadowDelivery[] = [
      { deliveryId: 'create-retire', revision: A, writes: [item], retiredTaskIds: [] },
      { deliveryId: 'delete-retire', revision: 'b'.repeat(40), writes: [], retiredTaskIds: [item.id] },
    ];
    const report = reconcileShadowSnapshot(
      fake, { revision: 'b'.repeat(40), tasks: [] }, new Map(), history,
    );
    expect(report.parity).toBe(false);
    expect(report.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'retirement_mismatch' }),
    ]));
    value.close();
  });

  it('replays a retirement only from the exact Git deletion revision', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-m4-history-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const item = task('M4-GIT-DELETE');
    writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed task');
    const createdRevision = (await git.revparse(['HEAD'])).trim();

    const { value } = store();
    const initial = { revision: createdRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId(initial),
      revision: createdRevision,
      writes: initial.tasks,
      retiredTaskIds: [],
    });
    await git.rm([`tasks/${item.id}.md`]);
    await git.commit('delete task');
    const deletedRevision = (await git.revparse(['HEAD'])).trim();
    const deletion = await shadowDeliveryForGitRevision(
      control, deletedRevision, `sync-${deletedRevision}`,
    );
    expect(deletion).toMatchObject({ retiredTaskIds: [item.id], writes: [] });
    deliverShadowProjection(value, deletion!);

    const history = await buildShadowProjectionHistory(value, control, deletedRevision);
    const report = reconcileShadowSnapshot(
      value, { revision: deletedRevision, tasks: [] }, new Map(), history,
    );
    expect(report.parity).toBe(true);
    expect(report.entries).toMatchObject([
      { taskId: item.id, kind: 'equal', reasonCode: 'retired' },
    ]);
    value.close();
  });

  it('retains declared no-op writes so every Git envelope gap replays exactly', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-m4-noop-history-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const changedBefore = task('M4-CHANGED');
    const gapTask = task('M4-NOOP-GAP', { state: 'review', verifiedSha: null });
    writeFileSync(join(control, 'tasks', `${changedBefore.id}.md`), serializeTask(changedBefore));
    writeFileSync(join(control, 'tasks', `${gapTask.id}.md`), serializeTask(gapTask));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed tasks');
    const initialRevision = (await git.revparse(['HEAD'])).trim();

    const { value } = store();
    const initial = { revision: initialRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId(initial), revision: initialRevision,
      writes: initial.tasks, retiredTaskIds: [],
    });
    const changedCanonical = initial.tasks.find((item) => item.id === changedBefore.id)!;
    const gapCanonical = initial.tasks.find((item) => item.id === gapTask.id)!;
    const changedAfter = { ...changedCanonical, priority: 2 };
    writeFileSync(join(control, 'tasks', `${changedAfter.id}.md`), serializeTask(changedAfter));
    await git.add(`tasks/${changedAfter.id}.md`);
    await git.commit('change one task while declaring another no-op');
    const revision = (await git.revparse(['HEAD'])).trim();
    deliverShadowProjection(value, {
      deliveryId: `git-${'1'.repeat(64)}`, revision,
      writes: [changedAfter, gapCanonical], retiredTaskIds: [],
    });

    const history = await buildShadowProjectionHistory(value, control, revision);
    expect(history.at(-1)?.writes.map((item) => item.id)).toEqual([
      changedAfter.id, gapTask.id,
    ]);
    const envelopes = value.listProjectionEnvelopes();
    const tampered = envelopes.map((envelope, index) =>
      index === envelopes.length - 1 ? { ...envelope, gapCodes: [] } : envelope);
    const fake = {
      readTask: value.readTask.bind(value),
      listTaskIds: value.listTaskIds.bind(value),
      listIncompleteEnvelopes: value.listIncompleteEnvelopes.bind(value),
      listProjectionEnvelopes: () => tampered,
      listProjectionEnvelopeKeys: () => value.listProjectionEnvelopeKeys(),
      // Replay reads manifests through this seam (never the full authority input).
      readEnvelopeManifest: (id: string) => {
        const envelope = tampered.find((item) => item.deliveryId === id);
        return envelope === undefined ? null : {
          deliveryId: envelope.deliveryId,
          authorityRevision: envelope.authorityRevision,
          manifest: envelope.manifest,
          gapCodes: envelope.gapCodes,
          manifestDigest: envelope.manifestDigest,
        };
      },
    } as unknown as ControlStateStore;
    const current = await buildSnapshot(control);
    expect(() => reconcileShadowSnapshot(
      fake, { revision, tasks: current.tasks }, new Map(), history,
    )).toThrow('projection envelope gaps do not replay from Git authority');
    value.close();
  });

  it('normalizes a real create delivery from its exact proposed Markdown before history replay', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-m4-create-history-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed control');
    const { value } = store();
    const port = new GitControlPort(control, {
      authoritativeTaskCommit: async (delivery) => {
        deliverShadowProjection(value, delivery);
      },
    });
    const created = task('M4-CREATE-NORMALIZE');
    expect(Object.hasOwn(created, 'fakeBehavior')).toBe(false);
    const result = await port.createTaskCommitted(created, 'create normalization task');
    expect(result).toMatchObject({ committed: true });
    const revision = result.hash!;

    const history = await buildShadowProjectionHistory(value, control, revision);
    expect(history).toHaveLength(1);
    expect(history[0]?.writes[0]).toMatchObject({
      id: created.id,
      fakeBehavior: null,
      agentSessionAdapter: null,
      verifiedSha: null,
      mergedSha: null,
      mergedVia: null,
    });
    const snapshot = await buildSnapshot(control);
    expect(reconcileShadowSnapshot(
      value, { revision, tasks: snapshot.tasks }, new Map(), history,
    ).parity).toBe(true);
    value.close();
  });

  it('uses the first-parent diff of a merge commit to observe task retirement', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-m4-merge-history-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    const item = task('M4-MERGE-DELETE');
    writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    writeFileSync(join(control, 'README.md'), 'seed\n');
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed task');
    await git.checkoutLocalBranch('delete-task');
    await git.rm([`tasks/${item.id}.md`]);
    await git.commit('delete task on branch');
    await git.checkout('main');
    writeFileSync(join(control, 'README.md'), 'main advance\n');
    await git.add('README.md');
    await git.commit('advance main');
    await git.merge(['--no-ff', 'delete-task', '-m', 'merge task deletion']);
    const revision = (await git.revparse(['HEAD'])).trim();

    await expect(shadowDeliveryForGitRevision(
      control, revision, `sync-${revision}`,
    )).resolves.toMatchObject({ writes: [], retiredTaskIds: [item.id] });
  });

  it('fails closed when a present authority blob cannot be read', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-m4-corrupt-blob-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    const item = task('M4-CORRUPT-BLOB');
    const path = `tasks/${item.id}.md`;
    writeFileSync(join(control, path), serializeTask(item));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed task');
    writeFileSync(join(control, path), serializeTask({ ...item, priority: 2 }));
    await git.add(path);
    await git.commit('change task');
    const revision = (await git.revparse(['HEAD'])).trim();
    const object = (await git.revparse([`${revision}:${path}`])).trim();
    unlinkSync(join(control, '.git', 'objects', object.slice(0, 2), object.slice(2)));

    await expect(shadowDeliveryForGitRevision(
      control, revision, `sync-${revision}`,
    )).rejects.toThrow();
  });

  it('bridges M4 locks through an empty envelope with live/replay parity', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c3-bridge-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const alpha = task('M4-BRIDGE-A');
    const beta = task('M4-BRIDGE-B');
    writeFileSync(join(control, 'tasks', `${alpha.id}.md`), serializeTask(alpha));
    writeFileSync(join(control, 'tasks', `${beta.id}.md`), serializeTask(beta));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed bridge tasks');
    const createdRevision = (await git.revparse(['HEAD'])).trim();

    const { value } = store();
    const initial = { revision: createdRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId(initial),
      revision: createdRevision,
      writes: initial.tasks,
      retiredTaskIds: [],
    });

    const before = reconcileShadowSnapshot(
      value, initial, new Map(),
      await buildShadowProjectionHistory(value, control, createdRevision),
    );
    expect(before.parity).toBe(true);
    expect(before.cutoverBlockers).toEqual(['m4_shadow_only', 'owner_database_authority_gate']);
    expect(value.readTask(alpha.id)?.contracts).toHaveLength(1);
    expect(contractNeedsBridge(value.readTask(alpha.id)!.contracts)).toBe(true);

    const bridge = buildBridgeDelivery(value, createdRevision);
    expect(bridge).toEqual({
      deliveryId: bridgeDeliveryId(createdRevision),
      revision: createdRevision,
      writes: [],
      retiredTaskIds: [],
    });
    const bridgeEnvelope = deliverShadowProjection(value, bridge!);
    expect(bridgeEnvelope).toMatchObject({
      completed: true,
      acknowledgedCommands: 2,
      authorityInput: { writes: [], retiredTaskIds: [] },
      gapCodes: [],
    });
    expect(deliverShadowProjection(value, bridge!)).toEqual(bridgeEnvelope);

    expect(value.readTask(alpha.id)?.contracts).toHaveLength(2);
    expect(value.readTask(beta.id)?.contracts.at(-1)).toMatchObject({
      version: 2,
      supersedesVersion: 1,
      approvalPolicy: {
        version: BRIDGED_APPROVAL_POLICY.version,
        requiredDecisions: [...BRIDGED_APPROVAL_POLICY.requiredDecisions],
      },
      verificationPolicy: {
        version: 'c3-legacy-compat-v1',
        independentEvaluatorRequired: false,
      },
    });
    expect(
      value.readTask(beta.id)!.contracts.at(-1)!.acceptanceCriteria
        .filter((criterion) => criterion.authority === 'mechanical')
        .every((criterion) => criterion.proofBinding === null),
    ).toBe(true);
    expect(contractNeedsBridge(value.readTask(alpha.id)!.contracts)).toBe(false);
    expect(buildBridgeDelivery(value, createdRevision)).toBeNull();

    const historyAfterBridge = await buildShadowProjectionHistory(value, control, createdRevision);
    expect(historyAfterBridge.map((item) => item.deliveryId)).toEqual([
      reconciliationDeliveryId(initial),
      bridgeDeliveryId(createdRevision),
    ]);
    const after = reconcileShadowSnapshot(value, initial, new Map(), historyAfterBridge);
    expect(after.parity).toBe(true);
    expect(after.cutoverBlockers).toEqual(['m4_shadow_only']);
    expect(after.entries.every((entry) => entry.kind === 'equal')).toBe(true);
    expect(after.entries.every(
      (entry) => entry.expectedDigest === entry.actualDigest,
    )).toBe(true);

    writeFileSync(join(control, 'tasks', `${alpha.id}.md`), serializeTask({
      ...alpha, priority: 2,
    }));
    await git.add(`tasks/${alpha.id}.md`);
    await git.commit('post-bridge git write');
    const postRevision = (await git.revparse(['HEAD'])).trim();
    const postDelivery = await shadowDeliveryForGitRevision(
      control, postRevision, `git-${postRevision}`,
    );
    // The write changes bytes but projects nothing → no envelope (C3.58).
    expect(deliverShadowProjection(value, postDelivery!)).toMatchObject({ skipped: true, completed: true });

    const fullHistory = await buildShadowProjectionHistory(value, control, postRevision);
    expect(fullHistory.map((item) => [
      item.deliveryId.startsWith('reconcile-') ? 'reconcile' :
        item.deliveryId.startsWith('bridge-') ? 'bridge' : 'git',
      item.revision,
    ])).toEqual([
      ['reconcile', createdRevision],
      ['bridge', createdRevision],
    ]);
    const postSnapshot = { revision: postRevision, tasks: (await buildSnapshot(control)).tasks };
    const postReport = reconcileShadowSnapshot(value, postSnapshot, new Map(), fullHistory);
    expect(postReport.parity).toBe(true);
    expect(postReport.cutoverBlockers).toEqual(['m4_shadow_only']);

    // Live twin vs replay twin: buildShadowProjectionHistory + reconcile
    // succeed only when deliveryCommandsFromState reproduces the exact
    // manifest bytes that deliverShadowProjection (live twin) stored.
    const bridgeStored = value.readEnvelope(bridgeDeliveryId(createdRevision))!;
    expect(bridgeStored.manifest).toHaveLength(2);
    expect(bridgeStored.gapCodes).toEqual([]);
    expect(fullHistory.some((item) => item.deliveryId === bridgeStored.deliveryId)).toBe(true);
    value.close();
  });

  it('refuses a live git delivery over an incomplete bridge envelope; the bridge resumes, then git lands (Codex round-3 B1)', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c3-bridge-overtake-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    // 257 legacy tasks → 257 bridge successor commands → the bridge straddles the 256 boundary.
    const tasks = Array.from({ length: 257 }, (_, index) => task(`OVT-${String(index).padStart(3, '0')}`));
    for (const item of tasks) writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed 257 tasks');
    const seedRevision = (await git.revparse(['HEAD'])).trim();

    const { value } = store();
    const initial = { revision: seedRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId(initial),
      revision: seedRevision,
      writes: initial.tasks,
      retiredTaskIds: [],
    });
    const bridge = buildBridgeDelivery(value, seedRevision)!;
    const originalCommitBatch = value.commitBatch.bind(value);
    value.commitBatch = ((deliveryIdArg, batchOrdinal, inputs) => {
      if (deliveryIdArg === bridge.deliveryId && batchOrdinal === 1) {
        throw new Error('injected bridge interruption after 256');
      }
      return originalCommitBatch(deliveryIdArg, batchOrdinal, inputs);
    }) as typeof value.commitBatch;
    expect(() => deliverShadowProjection(value, bridge)).toThrow('injected bridge interruption after 256');
    value.commitBatch = originalCommitBatch;
    expect(value.readEnvelope(bridge.deliveryId)).toMatchObject({ completed: false, acknowledgedCommands: 256 });
    const straggler = tasks.at(-1)!;
    expect(contractNeedsBridge(value.readTask(straggler.id)!.contracts)).toBe(true);

    // A live git commit changes the straggler while the bridge envelope is incomplete.
    writeFileSync(join(control, 'tasks', `${straggler.id}.md`), serializeTask({ ...straggler, priority: 2 }));
    await git.add('.');
    await git.commit('bump straggler priority');
    const bumpRevision = (await git.revparse(['HEAD'])).trim();
    const live = (await shadowDeliveryForGitRevision(control, bumpRevision, `git-${bumpRevision}`))!;
    expect(live).not.toBeNull();
    // main's live path: the guard refuses before any command is projected.
    expect(() => assertNoIncompleteEnvelopes(value, live.deliveryId)).toThrow(
      `live delivery git-${bumpRevision} deferred: incomplete projection envelope(s) ${bridge.deliveryId} must resume first`,
    );
    expect(value.readEnvelope(live.deliveryId)).toBeNull();
    expect(value.readTask(straggler.id)!.contracts).toHaveLength(1);

    // The observe pass resumes the bridge (its own id is exempt), then the git delivery lands.
    expect(() => assertNoIncompleteEnvelopes(value, bridge.deliveryId)).not.toThrow();
    expect(deliverShadowProjection(value, bridge)).toMatchObject({ completed: true, acknowledgedCommands: 257 });
    expect(contractNeedsBridge(value.readTask(straggler.id)!.contracts)).toBe(false);
    expect(buildBridgeDelivery(value, bumpRevision)).toBeNull();
    // The bumped priority projects nothing once the bridge landed → no envelope (C3.58).
    expect(deliverShadowProjection(value, live)).toMatchObject({ completed: true, skipped: true });
    expect(value.readTask(straggler.id)!.contracts.map((contract) => contract.version)).toEqual([1, 2]);

    const history = await buildShadowProjectionHistory(value, control, bumpRevision);
    expect(history.map((item) => item.deliveryId)).toEqual([
      reconciliationDeliveryId(initial),
      bridge.deliveryId,
    ]);
    const snapshot = { revision: bumpRevision, tasks: (await buildSnapshot(control)).tasks };
    const report = reconcileShadowSnapshot(value, snapshot, new Map(), history);
    expect(report.parity).toBe(true);
    expect(report.cutoverBlockers).toEqual(['m4_shadow_only']);
    value.close();
  }, 60_000);

  it('still detects forged extra contract history after a complete bridge', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c3-bridge-forge-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const item = task('M4-BRIDGE-FORGE');
    writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed forge task');
    const revision = (await git.revparse(['HEAD'])).trim();

    const { value } = store();
    const snapshot = { revision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId(snapshot),
      revision,
      writes: snapshot.tasks,
      retiredTaskIds: [],
    });
    deliverShadowProjection(value, buildBridgeDelivery(value, revision)!);
    const actual = value.readTask(item.id)!;
    const injected: ShadowTaskState = {
      ...actual,
      contracts: [...actual.contracts, actual.contracts[0]!],
    };
    const envelopes = value.listProjectionEnvelopes();
    const fake = {
      readTask: () => injected,
      listTaskIds: () => [item.id],
      listProjectionEnvelopes: () => envelopes,
      listProjectionEnvelopeKeys: () => value.listProjectionEnvelopeKeys(),
      readEnvelopeManifest: (id: string) => value.readEnvelopeManifest(id),
      listIncompleteEnvelopes: () => [],
    } as unknown as ControlStateStore;
    const history = await buildShadowProjectionHistory(value, control, revision);
    const report = reconcileShadowSnapshot(fake, snapshot, new Map(), history);
    expect(report.parity).toBe(false);
    expect(report.entries.map((entry) => entry.reasonCode)).toEqual(expect.arrayContaining([
      'unexpected_contract_history',
    ]));
    value.close();
  });

  it('refuses a forged bridge delivery id at live delivery before any envelope', () => {
    const { value } = store();
    const forgedId = `bridge-${'f'.repeat(64)}`;
    expect(() => deliverShadowProjection(value, {
      deliveryId: forgedId,
      revision: A,
      writes: [],
      retiredTaskIds: [],
    })).toThrow(ShadowProjectionError);
    expect(value.listProjectionEnvelopes()).toHaveLength(0);
    expect(value.listTaskIds()).toHaveLength(0);

    // Matching bridgeDeliveryId(revision) but non-empty writes also fail closed.
    expect(() => deliverShadowProjection(value, {
      deliveryId: bridgeDeliveryId(A),
      revision: A,
      writes: [task('M4-FORGED-WRITE')],
      retiredTaskIds: [],
    })).toThrow(/empty authority input/);
    expect(value.listProjectionEnvelopes()).toHaveLength(0);

    // Wrong revision binding: id for ffff… with revision A.
    const otherRevision = 'f'.repeat(40);
    expect(() => deliverShadowProjection(value, {
      deliveryId: bridgeDeliveryId(otherRevision),
      revision: A,
      writes: [],
      retiredTaskIds: [],
    })).toThrow(/not bound to bridgeDeliveryId/);
    expect(value.listProjectionEnvelopes()).toHaveLength(0);
    value.close();
  });

  it('projects a post-bridge new task with successor + iteration v2 (live/replay parity)', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c3-bridge-active-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const seed = task('M4-BRIDGE-SEED');
    writeFileSync(join(control, 'tasks', `${seed.id}.md`), serializeTask(seed));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed bridge-active task');
    const createdRevision = (await git.revparse(['HEAD'])).trim();

    const { value } = store();
    const initial = { revision: createdRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId(initial),
      revision: createdRevision,
      writes: initial.tasks,
      retiredTaskIds: [],
    });
    deliverShadowProjection(value, buildBridgeDelivery(value, createdRevision)!);
    expect(contractNeedsBridge(value.readTask(seed.id)!.contracts)).toBe(false);

    const newborn = task('M4-BRIDGE-NEW');
    writeFileSync(join(control, 'tasks', `${newborn.id}.md`), serializeTask(newborn));
    await git.add(`tasks/${newborn.id}.md`);
    await git.commit('post-bridge new task');
    const postRevision = (await git.revparse(['HEAD'])).trim();
    const postDelivery = await shadowDeliveryForGitRevision(
      control, postRevision, `git-${postRevision}`,
    );
    const envelope = deliverShadowProjection(value, postDelivery!);
    // root + bridge successor + first iteration
    expect(envelope.acknowledgedCommands).toBe(3);
    expect(envelope.manifest).toHaveLength(3);

    const newbornState = value.readTask(newborn.id)!;
    expect(newbornState.contracts).toHaveLength(2);
    expect(newbornState.contracts.map((c) => c.version)).toEqual([1, 2]);
    expect(newbornState.contracts.at(-1)).toMatchObject({
      approvalPolicy: {
        version: BRIDGED_APPROVAL_POLICY.version,
        requiredDecisions: [...BRIDGED_APPROVAL_POLICY.requiredDecisions],
      },
      verificationPolicy: {
        version: 'c3-legacy-compat-v1',
        independentEvaluatorRequired: false,
      },
    });
    expect(
      newbornState.contracts.at(-1)!.acceptanceCriteria
        .filter((criterion) => criterion.authority === 'mechanical')
        .every((criterion) => criterion.proofBinding === null),
    ).toBe(true);
    expect(newbornState.iterations).toMatchObject([
      { ordinal: 1, contractVersion: 2, state: 'planned' },
    ]);
    expect(contractNeedsBridge(newbornState.contracts)).toBe(false);

    const fullHistory = await buildShadowProjectionHistory(value, control, postRevision);
    expect(fullHistory.map((item) => [
      item.deliveryId.startsWith('reconcile-') ? 'reconcile' :
        item.deliveryId.startsWith('bridge-') ? 'bridge' : 'git',
      item.revision,
    ])).toEqual([
      ['reconcile', createdRevision],
      ['bridge', createdRevision],
      ['git', postRevision],
    ]);
    const postSnapshot = { revision: postRevision, tasks: (await buildSnapshot(control)).tasks };
    const postReport = reconcileShadowSnapshot(value, postSnapshot, new Map(), fullHistory);
    expect(postReport.parity).toBe(true);
    expect(postReport.cutoverBlockers).toEqual(['m4_shadow_only']);

    // Bounded history (2026-09-09 production OOM): with a memo, a
    // reconciliation delivery carries Git-derived tasks interned by blob oid —
    // the same Task object on every rebuild — never the envelope's own parsed
    // authority input.
    {
      const memo = createM4ObserverMemo();
      const reconstructed: string[] = [];
      const first = await buildShadowProjectionHistory(value, control, postRevision, {
        memo, onReconstruct: (id) => { reconstructed.push(id); },
      });
      expect(reconstructed).toHaveLength(3);
      expect(memo.taskBlobs.size).toBeGreaterThan(0);
      const reconcile = first[0]!;
      expect(reconcile.deliveryId.startsWith('reconcile-')).toBe(true);
      const stored = value.readEnvelope(reconcile.deliveryId)!;
      // C3.40: the envelope persists `{ id, state }` stubs, never task bodies;
      // the history delivery carries the Git-derived full tasks.
      expect(stored.authorityInput.writes).toEqual(
        reconcile.writes.map((task) => ({ id: task.id, state: task.state, reconciliationStub: true })),
      );
      expect(JSON.stringify(stored.authorityInput)).not.toContain('## ');
      expect(reconcile.writes[0]!.body.length).toBeGreaterThan(0);
      expect([...memo.taskBlobs.values()]).toContain(reconcile.writes[0]);
      const second = await buildShadowProjectionHistory(value, control, postRevision, { memo });
      expect(reconstructed).toHaveLength(3);
      expect(second[0]!.writes[0]).toBe(reconcile.writes[0]);
      expect(reconcileShadowSnapshot(value, postSnapshot, new Map(), second, { memo }).parity).toBe(true);
    }

    // Forged: strip the successor from the newborn → divergence.
    const forged: ShadowTaskState = {
      ...newbornState,
      contracts: [newbornState.contracts[0]!],
      iterations: newbornState.iterations.map((iteration) => ({
        ...iteration,
        contractVersion: 1,
      })),
    };
    const envelopes = value.listProjectionEnvelopes();
    const fake = {
      readTask: (taskId: string) => taskId === newborn.id ? forged : value.readTask(taskId),
      listTaskIds: () => value.listTaskIds(),
      listProjectionEnvelopes: () => envelopes,
      listProjectionEnvelopeKeys: () => value.listProjectionEnvelopeKeys(),
      readEnvelopeManifest: (id: string) => value.readEnvelopeManifest(id),
      listIncompleteEnvelopes: () => [],
    } as unknown as ControlStateStore;
    const forgedReport = reconcileShadowSnapshot(fake, postSnapshot, new Map(), fullHistory);
    expect(forgedReport.parity).toBe(false);
    expect(forgedReport.entries.map((entry) => entry.reasonCode)).toEqual(
      expect.arrayContaining(['contract_mismatch']),
    );

    // C3.40 legacy shape: a reconciliation envelope persisted BEFORE stubs
    // (full tasks, bodies included) still binds, replays, and resumes.
    {
      writeFileSync(join(control, 'NOTE.md'), 'no task change\n');
      await git.add('NOTE.md');
      await git.commit('non-task commit');
      const legacyRevision = (await git.revparse(['HEAD'])).trim();
      const legacyTasks = [...(await buildSnapshot(control)).tasks]
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      const legacyId = reconciliationDeliveryId({ revision: legacyRevision, tasks: legacyTasks });
      value.beginEnvelope({
        deliveryId: legacyId,
        authorityRevision: legacyRevision,
        authorityInput: { writes: legacyTasks, retiredTaskIds: [] },
        manifest: [],
        gapCodes: [],
      });
      value.completeEnvelope(legacyId);
      expect(JSON.stringify(value.readEnvelope(legacyId)!.authorityInput)).toContain('"body"');
      const history = await buildShadowProjectionHistory(value, control, legacyRevision);
      expect(history.at(-1)?.deliveryId).toBe(legacyId);
      expect(history.at(-1)?.writes.map((task) => task.id)).toEqual(legacyTasks.map((task) => task.id));
      const legacySnapshot = { revision: legacyRevision, tasks: (await buildSnapshot(control)).tasks };
      expect(reconcileShadowSnapshot(value, legacySnapshot, new Map(), history).parity).toBe(true);
      // Resuming the legacy envelope with a full delivery reproduces its input.
      expect(deliverShadowProjection(value, {
        deliveryId: legacyId, revision: legacyRevision, writes: legacyTasks, retiredTaskIds: [],
      }).completed).toBe(true);
      // A fresh reconciliation at a later revision persists stubs only.
      writeFileSync(join(control, 'NOTE.md'), 'still no task change\n');
      await git.add('NOTE.md');
      await git.commit('second non-task commit');
      const stubRevision = (await git.revparse(['HEAD'])).trim();
      const noopId = reconciliationDeliveryId({ revision: stubRevision, tasks: legacyTasks });
      // Nothing changed for the projection → no envelope at all (C3.58).
      expect(deliverShadowProjection(value, {
        deliveryId: noopId, revision: stubRevision, writes: legacyTasks, retiredTaskIds: [],
      })).toMatchObject({ skipped: true });
      expect(value.readEnvelope(noopId)).toBeNull();
      // A reconciliation that does project (a task created outside the live
      // path) persists {id,state} stubs only (C3.40).
      const newborn = task('M4-LEGACY-NEWBORN');
      writeFileSync(join(control, 'tasks', `${newborn.id}.md`), serializeTask(newborn));
      await git.add(`tasks/${newborn.id}.md`);
      await git.commit('newborn outside the live path');
      const newbornRevision = (await git.revparse(['HEAD'])).trim();
      // Bind to the exact parsed tree (in-memory objects are not byte-identical).
      const withNewborn = (await buildSnapshot(control)).tasks;
      const stubId = reconciliationDeliveryId({ revision: newbornRevision, tasks: withNewborn });
      expect(deliverShadowProjection(value, {
        deliveryId: stubId, revision: newbornRevision, writes: withNewborn, retiredTaskIds: [],
      }).skipped).toBeUndefined();
      const stubbed = value.readEnvelope(stubId)!;
      expect(stubbed.authorityInput.writes.every((write) => 'reconciliationStub' in write)).toBe(true);
      expect(JSON.stringify(stubbed.authorityInput)).not.toContain('"body"');
      const stubHistory = await buildShadowProjectionHistory(value, control, newbornRevision);
      expect(stubHistory.at(-1)?.writes.map((task) => task.id)).toEqual(withNewborn.map((task) => task.id));
      expect(reconcileShadowSnapshot(
        value, { revision: newbornRevision, tasks: (await buildSnapshot(control)).tasks }, new Map(), stubHistory,
      ).parity).toBe(true);
    }
    value.close();
  });

  it('resumes a bridge-active partial triple across the 256-command batch boundary (root only)', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c3-bridge-batch-root-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const seed = task('M4-BRIDGE-BATCH-SEED');
    writeFileSync(join(control, 'tasks', `${seed.id}.md`), serializeTask(seed));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed bridge-active batch task');
    const createdRevision = (await git.revparse(['HEAD'])).trim();

    const { value } = store();
    const initial = { revision: createdRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId(initial),
      revision: createdRevision,
      writes: initial.tasks,
      retiredTaskIds: [],
    });
    deliverShadowProjection(value, buildBridgeDelivery(value, createdRevision)!);

    // 86 post-bridge tasks → 258 commands (root+successor+iteration each).
    const postTasks = Array.from({ length: 86 }, (_, index) =>
      task(`POST-${String(index).padStart(3, '0')}`),
    );
    for (const item of postTasks) {
      writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    }
    await git.add('tasks');
    await git.commit('post-bridge 86 tasks straddling 256 boundary');
    const postRevision = (await git.revparse(['HEAD'])).trim();
    const deliveryId = `git-${postRevision}`;
    const postDelivery = await shadowDeliveryForGitRevision(control, postRevision, deliveryId);
    expect(postDelivery!.writes).toHaveLength(86);

    const originalCommitBatch = value.commitBatch.bind(value);
    let batchCalls = 0;
    value.commitBatch = ((deliveryIdArg, batchOrdinal, inputs) => {
      batchCalls += 1;
      if (batchCalls === 2) {
        throw new Error('injected second-batch interruption');
      }
      return originalCommitBatch(deliveryIdArg, batchOrdinal, inputs);
    }) as typeof value.commitBatch;

    expect(() => deliverShadowProjection(value, postDelivery!)).toThrow(
      'injected second-batch interruption',
    );
    value.commitBatch = originalCommitBatch;

    const interrupted = value.readEnvelope(deliveryId)!;
    expect(interrupted.completed).toBe(false);
    expect(interrupted.acknowledgedCommands).toBe(256);
    expect(interrupted.manifest).toHaveLength(258);
    const lastId = 'POST-085';
    expect(value.readTask(lastId)?.contracts).toHaveLength(1);
    expect(value.readTask(lastId)?.iterations).toHaveLength(0);
    expect(contractNeedsBridge(value.readTask(lastId)!.contracts)).toBe(true);

    const originalManifest = interrupted.manifest;
    const completed = deliverShadowProjection(value, postDelivery!);
    expect(completed.completed).toBe(true);
    expect(completed.acknowledgedCommands).toBe(258);
    expect(completed.manifest).toEqual(originalManifest);

    const last = value.readTask(lastId)!;
    expect(last.contracts.map((c) => c.version)).toEqual([1, 2]);
    expect(last.iterations).toMatchObject([
      { ordinal: 1, contractVersion: 2, state: 'planned' },
    ]);
    expect(contractNeedsBridge(last.contracts)).toBe(false);

    const fullHistory = await buildShadowProjectionHistory(value, control, postRevision);
    const postSnapshot = { revision: postRevision, tasks: (await buildSnapshot(control)).tasks };
    const postReport = reconcileShadowSnapshot(value, postSnapshot, new Map(), fullHistory);
    expect(postReport.parity).toBe(true);
    expect(postReport.cutoverBlockers).toEqual(['m4_shadow_only']);
    value.close();
  }, 30_000);

  it('resumes a bridge-active partial triple across the 256-command batch boundary (after successor)', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c3-bridge-batch-succ-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const seed = task('M4-BRIDGE-BATCH-SEED2');
    writeFileSync(join(control, 'tasks', `${seed.id}.md`), serializeTask(seed));
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'history@hercules.local');
    await git.addConfig('user.name', 'History');
    await git.add('.');
    await git.commit('seed bridge-active batch task');
    const createdRevision = (await git.revparse(['HEAD'])).trim();

    const { value } = store();
    const initial = { revision: createdRevision, tasks: (await buildSnapshot(control)).tasks };
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId(initial),
      revision: createdRevision,
      writes: initial.tasks,
      retiredTaskIds: [],
    });
    deliverShadowProjection(value, buildBridgeDelivery(value, createdRevision)!);

    const postTasks = Array.from({ length: 86 }, (_, index) =>
      task(`POST-${String(index).padStart(3, '0')}`),
    );
    for (const item of postTasks) {
      writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    }
    await git.add('tasks');
    await git.commit('post-bridge 86 tasks straddling 256 boundary');
    const postRevision = (await git.revparse(['HEAD'])).trim();
    const deliveryId = `git-${postRevision}`;
    const postDelivery = await shadowDeliveryForGitRevision(control, postRevision, deliveryId);

    const originalCommitBatch = value.commitBatch.bind(value);
    let batchCalls = 0;
    value.commitBatch = ((deliveryIdArg, batchOrdinal, inputs) => {
      batchCalls += 1;
      if (batchCalls === 2) {
        // Commit successor only (first of the 2-command second batch), then abort.
        originalCommitBatch(deliveryIdArg, batchOrdinal, inputs.slice(0, 1));
        throw new Error('injected after-successor interruption');
      }
      return originalCommitBatch(deliveryIdArg, batchOrdinal, inputs);
    }) as typeof value.commitBatch;

    expect(() => deliverShadowProjection(value, postDelivery!)).toThrow(
      'injected after-successor interruption',
    );
    value.commitBatch = originalCommitBatch;

    const interrupted = value.readEnvelope(deliveryId)!;
    expect(interrupted.completed).toBe(false);
    expect(interrupted.acknowledgedCommands).toBe(257);
    expect(interrupted.manifest).toHaveLength(258);
    const lastId = 'POST-085';
    expect(value.readTask(lastId)?.contracts.map((c) => c.version)).toEqual([1, 2]);
    expect(value.readTask(lastId)?.iterations).toHaveLength(0);

    const originalManifest = interrupted.manifest;
    const completed = deliverShadowProjection(value, postDelivery!);
    expect(completed.completed).toBe(true);
    expect(completed.acknowledgedCommands).toBe(258);
    expect(completed.manifest).toEqual(originalManifest);

    const last = value.readTask(lastId)!;
    expect(last.contracts.map((c) => c.version)).toEqual([1, 2]);
    expect(last.iterations).toMatchObject([
      { ordinal: 1, contractVersion: 2, state: 'planned' },
    ]);

    const fullHistory = await buildShadowProjectionHistory(value, control, postRevision);
    const postSnapshot = { revision: postRevision, tasks: (await buildSnapshot(control)).tasks };
    const postReport = reconcileShadowSnapshot(value, postSnapshot, new Map(), fullHistory);
    expect(postReport.parity).toBe(true);
    expect(postReport.cutoverBlockers).toEqual(['m4_shadow_only']);
    value.close();
  }, 30_000);
});

/**
 * Pre-C3.13 reconcile: deep-clones the entire replayed state map once per task.
 * Copied verbatim for byte-identical pins against the linear path.
 */
function reconcileShadowSnapshotReference(
  store: ControlStateStore,
  snapshot: VersionedAuthoritySnapshot,
  projectionFailures: ReadonlyMap<string, string>,
  projectionHistory: readonly ShadowDelivery[],
): ShadowReconciliationReport {
  function byteOrder(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  function byTaskIdByteOrder(
    left: { readonly id: string },
    right: { readonly id: string },
  ): number {
    return byteOrder(left.id, right.id);
  }
  function stateDigest(state: ShadowTaskState | null): string | null {
    return state === null ? null : hashCanonicalJson({
      contracts: state.contracts,
      iterations: state.iterations,
      retirement: state.retirement,
    });
  }
  function cloneStateMap(
    states: ReadonlyMap<string, ShadowTaskState>,
  ): Map<string, ShadowTaskState> {
    return new Map([...states].map(([taskId, state]) => [taskId, canonicalClone(state)]));
  }
  function gapKind(reason: ShadowGapCode): ReconciliationEntryKind {
    if (reason === 'contract_change_requires_trusted_authority') return 'contract_mismatch';
    if (reason === 'retired_task_resurrection') return 'retirement_mismatch';
    if (reason === 'candidate_mismatch' || reason === 'iteration_state_mismatch') {
      return 'iteration_mismatch';
    }
    return 'coverage_gap';
  }
  function entry(
    kind: ReconciliationEntryKind,
    taskId: string,
    revision: string,
    reasonCode: string,
    expectedDigest: string | null,
    actualDigest: string | null,
  ): ShadowReconciliationEntry {
    return { kind, taskId, authorityRevision: revision, reasonCode, expectedDigest, actualDigest };
  }

  const entries: ShadowReconciliationEntry[] = [];
  const replayed = replayExpectedState(store, projectionHistory);
  const bridgeActive = projectionHistory.some((delivery) => isBridgeDeliveryId(delivery.deliveryId));
  const authorityIds = new Set(snapshot.tasks.map((task) => task.id));
  for (const task of [...snapshot.tasks].sort(byTaskIdByteOrder)) {
    const actual = store.readTask(task.id);
    const desired = cloneStateMap(replayed);
    const projected = projectLegacyTask(
      task, snapshot.revision, replayed.get(task.id) ?? null, { bridgeActive },
    );
    applyCommands(desired, projected.commands);
    const expectedState = desired.get(task.id) ?? null;
    const expectedDigest = stateDigest(expectedState);
    const actualDigest = stateDigest(actual);
    const failure = projectionFailures.get(task.id);
    if (failure !== undefined) {
      entries.push(entry('projection_failure', task.id, snapshot.revision, failure, expectedDigest, actualDigest));
      continue;
    }
    for (const reason of projected.gapCodes) {
      entries.push(entry(gapKind(reason), task.id, snapshot.revision, reason, expectedDigest, actualDigest));
    }
    if (actual === null) {
      entries.push(entry('missing_shadow', task.id, snapshot.revision, 'task_missing', expectedDigest, null));
      continue;
    }
    if (expectedState === null || hashCanonicalJson(actual.contracts) !==
        hashCanonicalJson(expectedState.contracts)) {
      const reason = actual.contracts.length > (expectedState?.contracts.length ?? 0)
        ? 'unexpected_contract_history' : 'contract_mismatch';
      entries.push(entry('contract_mismatch', task.id, snapshot.revision, reason, expectedDigest, actualDigest));
    }
    if (hashCanonicalJson(actual.retirement) !== hashCanonicalJson(expectedState?.retirement ?? null)) {
      entries.push(entry(
        'retirement_mismatch', task.id, snapshot.revision,
        'retirement_mismatch', expectedDigest, actualDigest,
      ));
    }
    if (hashCanonicalJson(actual.iterations) !== hashCanonicalJson(expectedState?.iterations ?? [])) {
      const reason = actual.iterations.length > (expectedState?.iterations.length ?? 0)
        ? 'unexpected_iteration_history' : 'iteration_stale';
      entries.push(entry(
        'iteration_mismatch', task.id, snapshot.revision,
        reason, expectedDigest, actualDigest,
      ));
    }
    if (entries.some((item) => item.taskId === task.id)) continue;
    if (expectedDigest !== actualDigest) {
      entries.push(entry(
        'iteration_mismatch', task.id, snapshot.revision,
        'projection_representation_mismatch', expectedDigest, actualDigest,
      ));
      continue;
    }
    entries.push(entry('equal', task.id, snapshot.revision, 'equal', expectedDigest, actualDigest));
  }
  const shadowOnlyIds = store.listTaskIds().filter((id) => !authorityIds.has(id)).sort();
  for (const taskId of shadowOnlyIds) {
    const actual = store.readTask(taskId);
    const expected = replayed.get(taskId) ?? null;
    const expectedDigest = stateDigest(expected);
    const actualDigest = stateDigest(actual);
    const failure = projectionFailures.get(taskId);
    entries.push(failure !== undefined
      ? entry('projection_failure', taskId, snapshot.revision, failure, expectedDigest, actualDigest)
      : expected?.retirement === null || expected === null
      ? entry('unexpected_shadow', taskId, snapshot.revision, 'authority_task_missing', expectedDigest, actualDigest)
      : expectedDigest !== actualDigest
      ? entry('retirement_mismatch', taskId, snapshot.revision, 'retirement_mismatch', expectedDigest, actualDigest)
      : entry('equal', taskId, snapshot.revision, 'retired', expectedDigest, actualDigest));
  }
  for (const [taskId, failure] of [...projectionFailures].sort(([left], [right]) => byteOrder(left, right))) {
    if (authorityIds.has(taskId) || shadowOnlyIds.includes(taskId)) continue;
    entries.push(entry(
      'projection_failure', taskId, snapshot.revision, failure, null, null,
    ));
  }
  for (const envelope of store.listIncompleteEnvelopes()) {
    entries.push(entry(
      'projection_incomplete',
      `delivery:${envelope.deliveryId}`,
      snapshot.revision,
      'projection_incomplete',
      envelope.manifestDigest,
      null,
    ));
  }
  entries.sort((a, b) => byteOrder(a.taskId, b.taskId) || byteOrder(a.kind, b.kind));
  const parity = entries.every((item) => item.kind === 'equal');
  const divergence = entries.filter((item) => item.kind !== 'equal').map((item) => item.reasonCode);
  const ownerGateActive = store.listTaskIds().some((taskId) => {
    const state = store.readTask(taskId);
    return state !== null &&
      state.retirement === null &&
      contractNeedsBridge(state.contracts);
  });
  const cutoverBlockers = [...new Set([
    'm4_shadow_only',
    ...(ownerGateActive ? ['owner_database_authority_gate'] as const : []),
    ...divergence,
  ])].sort();
  const body = {
    authorityRevision: snapshot.revision,
    shadowSchemaVersion: 2,
    comparedTaskCount: snapshot.tasks.length,
    entries,
    parity,
    cutoverEligible: false as const,
    cutoverBlockers,
  };
  return canonicalClone({ ...body, reportDigest: hashCanonicalJson(body) });
}

describe('C3.13 live-path memo and linear reconcile', () => {
  async function seedMultiEnvelopeCorpus(taskCount: number, extraCommits: number): Promise<{
    control: string;
    store: SqliteStateStore;
    root: string;
    databasePath: string;
    revision: string;
    tasks: readonly Task[];
  }> {
    const control = mkdtempSync(join(tmpdir(), 'hercules-c313-corpus-'));
    roots.push(control);
    mkdirSync(join(control, 'tasks'));
    writeFileSync(join(control, 'repos.yaml'),
      'repos:\n  app:\n    url: git@github.com:example/app.git\n    default_branch: main\n');
    const items = Array.from({ length: taskCount }, (_, index) =>
      task(`C313-${String(index).padStart(3, '0')}`));
    for (const item of items) {
      writeFileSync(join(control, 'tasks', `${item.id}.md`), serializeTask(item));
    }
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 'c313@hercules.local');
    await git.addConfig('user.name', 'C313');
    await git.add('.');
    await git.commit('seed c313 corpus');
    let revision = (await git.revparse(['HEAD'])).trim();

    const { value, root, databasePath } = store();
    const initialTasks = (await buildSnapshot(control)).tasks;
    deliverShadowProjection(value, {
      deliveryId: reconciliationDeliveryId({ revision, tasks: initialTasks }),
      revision,
      writes: initialTasks,
      retiredTaskIds: [],
    });

    for (let step = 0; step < extraCommits; step += 1) {
      const target = items[step % items.length]!;
      writeFileSync(join(control, 'tasks', `${target.id}.md`), serializeTask({
        ...target,
        priority: 2 + step,
        title: `${target.title} bump-${step}`,
      }));
      await git.add(`tasks/${target.id}.md`);
      await git.commit(`c313 bump ${step}`);
      revision = (await git.revparse(['HEAD'])).trim();
      const delivery = await shadowDeliveryForGitRevision(
        control, revision, `git-${revision}`,
      );
      deliverShadowProjection(value, delivery!);
    }

    const tasks = (await buildSnapshot(control)).tasks;
    return { control, store: value, root, databasePath, revision, tasks };
  }

  it('history memo is byte-identical and reconstructs only new envelopes', async () => {
    const seeded = await seedMultiEnvelopeCorpus(12, 3);
    const memo = createM4ObserverMemo();
    const reconstructed: string[] = [];
    const cold = await buildShadowProjectionHistory(
      seeded.store, seeded.control, seeded.revision,
      { onReconstruct: (id) => { reconstructed.push(id); } },
    );
    expect(reconstructed.length).toBe(seeded.store.listProjectionEnvelopes().length);
    const coldHash = hashCanonicalJson(cold);

    reconstructed.length = 0;
    const warm = await buildShadowProjectionHistory(
      seeded.store, seeded.control, seeded.revision,
      { memo, onReconstruct: (id) => { reconstructed.push(id); } },
    );
    expect(hashCanonicalJson(warm)).toBe(coldHash);
    // First memoized build still reconstructs (cache empty).
    expect(reconstructed.length).toBe(cold.length);

    reconstructed.length = 0;
    const warmAgain = await buildShadowProjectionHistory(
      seeded.store, seeded.control, seeded.revision,
      { memo, onReconstruct: (id) => { reconstructed.push(id); } },
    );
    expect(hashCanonicalJson(warmAgain)).toBe(coldHash);
    expect(reconstructed).toEqual([]);

    // A projecting change (new task): a priority/title bump alone projects no
    // command and, since C3.58, appends no envelope to reconstruct.
    const appended = task('C313-APPEND');
    writeFileSync(join(seeded.control, 'tasks', `${appended.id}.md`), serializeTask(appended));
    const git = simpleGit(seeded.control);
    await git.add(`tasks/${appended.id}.md`);
    await git.commit('c313 append envelope');
    const newRevision = (await git.revparse(['HEAD'])).trim();
    const newDelivery = await shadowDeliveryForGitRevision(
      seeded.control, newRevision, `git-${newRevision}`,
    );
    deliverShadowProjection(seeded.store, newDelivery!);

    reconstructed.length = 0;
    const afterAppend = await buildShadowProjectionHistory(
      seeded.store, seeded.control, newRevision,
      { memo, onReconstruct: (id) => { reconstructed.push(id); } },
    );
    expect(reconstructed).toEqual([newDelivery!.deliveryId]);
    const uncached = await buildShadowProjectionHistory(
      seeded.store, seeded.control, newRevision,
    );
    expect(hashCanonicalJson(afterAppend)).toBe(hashCanonicalJson(uncached));

    invalidateM4ObserverMemo(memo);
    expect(memo.history.deliveries.size).toBeGreaterThan(0);
    expect(memo.revision).toBeNull();
    expect(memo.report).toBeNull();

    resetM4ObserverHistory(memo);
    expect(memo.history.deliveries.size).toBe(0);
    expect(memo.replay).toBeNull();
    seeded.store.close();
  }, 60_000);

  it('replay memo is byte-identical across warm reconcile calls', async () => {
    const seeded = await seedMultiEnvelopeCorpus(8, 2);
    const memo = createM4ObserverMemo();
    const history = await buildShadowProjectionHistory(
      seeded.store, seeded.control, seeded.revision, { memo },
    );
    const coldStates = replayExpectedState(seeded.store, history);
    const coldHash = hashCanonicalJson([...coldStates.entries()]);
    const warmStates = replayExpectedState(seeded.store, history, { memo });
    expect(hashCanonicalJson([...warmStates.entries()])).toBe(coldHash);
    const warmAgain = replayExpectedState(seeded.store, history, { memo });
    expect(hashCanonicalJson([...warmAgain.entries()])).toBe(coldHash);
    expect(memo.replay).not.toBeNull();
    expect(memo.replay!.keys).toHaveLength(history.length);
    seeded.store.close();
  }, 60_000);

  it('every projection command targets the projected task (root, bridge successor, iteration, retry)', () => {
    const fresh = task('CMD-TARGET-NEW');
    // New root with the bridge active: root + successor + iteration (three kinds).
    const bridged = projectLegacyTask(fresh, A, null, { bridgeActive: true });
    expect(bridged.commands.length).toBe(3);
    expect(bridged.commands.map((command) => command.mutation.kind)).toEqual([
      'insert_contract_root', 'append_contract_successor', 'put_iteration',
    ]);
    for (const command of bridged.commands) expect(projectionCommandTaskId(command)).toBe(fresh.id);
    // Existing task advancing with a retry: a fresh iteration only.
    const states = new Map();
    applyCommands(states, bridged.commands);
    const retried = projectLegacyTask(
      { ...fresh, attempts: 1, state: 'in_progress' }, A, states.get(fresh.id)!, { bridgeActive: true },
    );
    expect(retried.commands.length).toBeGreaterThan(0);
    for (const command of retried.commands) expect(projectionCommandTaskId(command)).toBe(fresh.id);
    // No bridge: root + iteration only, still one target.
    const plain = projectLegacyTask(fresh, A, null);
    expect(plain.commands.length).toBe(2);
    for (const command of plain.commands) expect(projectionCommandTaskId(command)).toBe(fresh.id);
  });

  it('linear reconcile matches the quadratic reference report byte-for-byte', async () => {
    const seeded = await seedMultiEnvelopeCorpus(24, 4);
    const history = await buildShadowProjectionHistory(
      seeded.store, seeded.control, seeded.revision,
    );
    const snapshot = { revision: seeded.revision, tasks: seeded.tasks };
    const failures = new Map<string, string>();
    const bridgeActive = history.some((delivery) => isBridgeDeliveryId(delivery.deliveryId));
    const replayed = replayExpectedState(seeded.store, history);
    for (const item of snapshot.tasks) {
      const projected = projectLegacyTask(
        item, snapshot.revision, replayed.get(item.id) ?? null, { bridgeActive },
      );
      for (const command of projected.commands) {
        expect(projectionCommandTaskId(command)).toBe(item.id);
      }
    }

    const reference = reconcileShadowSnapshotReference(
      seeded.store, snapshot, failures, history,
    );
    const optimized = reconcileShadowSnapshot(
      seeded.store, snapshot, failures, history,
    );
    expect(hashCanonicalJson(optimized)).toBe(hashCanonicalJson(reference));
    expect(optimized.reportDigest).toBe(reference.reportDigest);

    const memo = createM4ObserverMemo();
    const memoized = reconcileShadowSnapshot(
      seeded.store, snapshot, failures, history, { memo },
    );
    expect(hashCanonicalJson(memoized)).toBe(hashCanonicalJson(reference));
    seeded.store.close();
  }, 60_000);

  it.skipIf(process.env['HERCULES_BENCH'] !== '1')(
    'bench: warm history + linear reconcile on ~215-task / multi-envelope shape',
    async () => {
      const seeded = await seedMultiEnvelopeCorpus(215, 10);
      // Seeding calls listProjectionEnvelopes (assertLiveBridgeDelivery); reopen
      // for a true cold envelope-read measurement on a fresh process cache.
      seeded.store.close();
      const store = new SqliteStateStore({
        trustedRoot: seeded.root,
        databasePath: seeded.databasePath,
      });
      store.initialize();
      const memo = createM4ObserverMemo();
      const snapshot = { revision: seeded.revision, tasks: seeded.tasks };
      const failures = new Map<string, string>();

      const coldEnvelopeStart = performance.now();
      const coldEnvelopes = store.listProjectionEnvelopes();
      const coldEnvelopeListMs = performance.now() - coldEnvelopeStart;

      const warmEnvelopeStart = performance.now();
      const warmEnvelopes = store.listProjectionEnvelopes();
      const warmEnvelopeListMs = performance.now() - warmEnvelopeStart;
      expect(warmEnvelopes).toHaveLength(coldEnvelopes.length);
      for (let index = 0; index < coldEnvelopes.length; index += 1) {
        expect(warmEnvelopes[index]).toBe(coldEnvelopes[index]);
      }

      const coldHistoryStart = performance.now();
      const coldHistory = await buildShadowProjectionHistory(
        store, seeded.control, seeded.revision, { memo },
      );
      const coldHistoryMs = performance.now() - coldHistoryStart;

      const warmHistoryStart = performance.now();
      await buildShadowProjectionHistory(
        store, seeded.control, seeded.revision, { memo },
      );
      const warmHistoryMs = performance.now() - warmHistoryStart;

      const refStart = performance.now();
      const reference = reconcileShadowSnapshotReference(
        store, snapshot, failures, coldHistory,
      );
      const referenceMs = performance.now() - refStart;

      const newStart = performance.now();
      const optimized = reconcileShadowSnapshot(
        store, snapshot, failures, coldHistory, { memo },
      );
      const optimizedMs = performance.now() - newStart;

      const warmReconcileStart = performance.now();
      const warmOptimized = reconcileShadowSnapshot(
        store, snapshot, failures, coldHistory, { memo },
      );
      const warmReconcileMs = performance.now() - warmReconcileStart;

      // Warm live-commit sequence: deliver is a no-op here (already projected);
      // history + reconcile with memo is the repeated observe/commit tax.
      const warmLiveCommitStart = performance.now();
      const liveHistory = await buildShadowProjectionHistory(
        store, seeded.control, seeded.revision, { memo },
      );
      reconcileShadowSnapshot(
        store, snapshot, failures, liveHistory, { memo },
      );
      const warmLiveCommitMs = performance.now() - warmLiveCommitStart;

      expect(hashCanonicalJson(optimized)).toBe(hashCanonicalJson(reference));
      expect(hashCanonicalJson(warmOptimized)).toBe(hashCanonicalJson(reference));

      process.stderr.write(`${JSON.stringify({
        taskCount: snapshot.tasks.length,
        envelopeCount: coldHistory.length,
        coldEnvelopeListMs,
        warmEnvelopeListMs,
        coldHistoryMs,
        warmHistoryMs,
        referenceReconcileMs: referenceMs,
        optimizedReconcileMs: optimizedMs,
        warmReconcileMs,
        warmLiveCommitMs,
      })}\n`);

      expect(warmEnvelopeListMs).toBeLessThan(coldEnvelopeListMs);
      expect(warmHistoryMs).toBeLessThan(coldHistoryMs);
      expect(optimizedMs).toBeLessThan(referenceMs);
      store.close();
    },
    120_000,
  );
});
