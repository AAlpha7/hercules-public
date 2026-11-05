import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSerialize, hashCanonicalJson } from '../../../src/domain/canonicalJson.js';
import {
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeAdmissionVerdictHash,
  computeReceiptHash,
  type AdmissionVerdictV1,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RequestV1,
  type DecisionPayloadV1,
} from '../../../src/domain/controlApiV2.js';
import {
  projectAndAssertReviewPackageV2,
  type ReviewPackageV2,
} from '../../../src/domain/reviewPackageV2.js';
import { compileLegacyTaskContract } from '../../../src/domain/contractCompiler.js';
import type { Task } from '../../../src/domain/task.js';
import type { TaskContract } from '../../../src/domain/taskContract.js';
import {
  buildEligibleControlApiV2ReviewPackage,
  buildEligibleControlApiV2ReviewSource,
} from '../../../src/isolation/controlApiV2ReviewSeed.js';
import {
  SqliteStateStore,
} from '../../../src/control/state/sqliteStateStore.js';
import {
  StateStoreError,
  V2_INITIAL_SWEEP_KEY,
  type ReviewPackageRefreshInput,
  type ReviewPackageRefreshSeam,
} from '../../../src/control/state/stateStore.js';

interface Paths {
  readonly parent: string;
  readonly root: string;
  readonly database: string;
}

const cleanup: string[] = [];
const FIXED_CLOCK = '2026-09-04T12:00:00.000Z';
const ACTOR = { kind: 'control_plane' as const, id: 'v2-aggregate-projection' };

function paths(): Paths {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-state-store-v2-'));
  cleanup.push(parent);
  const root = join(parent, 'state');
  return { parent, root, database: join(root, 'shadow.sqlite') };
}

function shadowRootContract(taskId: string): TaskContract {
  return compileLegacyTaskContract({
    taskId,
    objective: 'Persist a shadow projection',
    body: '## DoD\n- [ ] (mechanical) state tests pass @gate:test',
    context: [],
    constraints: ['legacy control files remain authoritative'],
    forbiddenActions: ['deploy'],
    capabilityPolicy: { version: '1', grants: [] },
    verificationPolicy: {
      version: '1',
      requiredEvidence: ['test'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: { version: '1', requiredDecisions: [] },
    budgetPolicy: { version: '1', maxCostUsd: null, maxTokens: null, maxDurationMs: null },
    createdBy: { kind: 'human', id: 'owner' },
    createdAt: FIXED_CLOCK,
  }).contract;
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

function sortedTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function packageFor(taskId: string, projectedAt = FIXED_CLOCK): ReviewPackageV2 {
  const base = buildEligibleControlApiV2ReviewPackage(taskId);
  const { projectionHash: _ignored, ...rest } = { ...base, projectedAt };
  return { ...rest, projectionHash: hashCanonicalJson(rest) };
}

function projectedSeam(
  packages: Map<string, ReviewPackageV2> | ((input: { aggregateId: string }) => ReviewPackageV2),
): ReviewPackageRefreshSeam {
  return (input) => {
    const reviewPackage = typeof packages === 'function'
      ? packages(input)
      : packages.get(input.aggregateId) ?? packageFor(input.aggregateId);
    return { kind: 'projected', reviewPackage };
  };
}

function unprojectableSeam(reason: 'empty_iteration_history' = 'empty_iteration_history'): ReviewPackageRefreshSeam {
  return () => ({ kind: 'unprojectable', reason });
}

function throwingSeam(): ReviewPackageRefreshSeam {
  return () => {
    throw new Error('seam infrastructure failure');
  };
}

function decisionAwareSeam(projectedAt = FIXED_CLOCK): ReviewPackageRefreshSeam {
  return (input: ReviewPackageRefreshInput) => ({
    kind: 'projected',
    reviewPackage: projectAndAssertReviewPackageV2({
      ...buildEligibleControlApiV2ReviewSource(input.aggregateId),
      humanDecisions: [...input.humanDecisions],
      projectedAt,
    }),
  });
}

function decisionPayload(
  overrides: Partial<DecisionPayloadV1> = {},
): DecisionPayloadV1 {
  return {
    kind: 'decision',
    action: 'approve_outcome',
    reason: 'Looks correct',
    acknowledgedRiskCodes: [],
    ...overrides,
  };
}

function submitRequest(
  aggregateId: string,
  stateVersion: number,
  projectionHash: string,
  clientRequestId: string,
  payload: DecisionPayloadV1 = decisionPayload(),
): ControlApiV2RequestV1 {
  return buildControlApiV2Request({
    resource: 'decision',
    operation: 'submit',
    aggregateId,
    idempotencyKey: buildIdempotencyKey({
      actorIssuer: 'hercules-web',
      actorId: 'actor-1',
      aggregateId,
      clientRequestId,
    }),
    concurrencyToken: buildConcurrencyToken({
      aggregateId,
      stateVersion,
      projectionHash,
    }),
    payload,
    issuedAt: FIXED_CLOCK,
  });
}

function admitVerdict(
  request: ControlApiV2RequestV1,
  decidedAt = FIXED_CLOCK,
): AdmissionVerdictV1 {
  const withoutHash: Omit<AdmissionVerdictV1, 'verdictHash'> = {
    schema: 'hercules-control-api-admit-verdict/v2',
    resource: 'decision',
    aggregateId: request.aggregateId,
    keyHash: request.idempotencyKey!.keyHash,
    requestHash: request.requestHash,
    decidedAt,
  };
  return {
    ...withoutHash,
    verdictHash: computeAdmissionVerdictHash(withoutHash),
  };
}

function materializeReviewAggregate(store: SqliteStateStore, aggregateId: string): void {
  completeZeroCommandDelivery(store, `delivery-${aggregateId}`, [
    task(aggregateId, { state: 'review' }),
  ]);
}

function storeAt(
  target: Paths,
  options: {
    readonly refreshReviewPackage?: ReviewPackageRefreshSeam;
    readonly clock?: () => string;
  } = {},
): SqliteStateStore {
  return new SqliteStateStore({
    trustedRoot: target.root,
    databasePath: target.database,
    busyTimeoutMs: 100,
    clock: options.clock ?? (() => FIXED_CLOCK),
    ...(options.refreshReviewPackage === undefined
      ? {}
      : { refreshReviewPackage: options.refreshReviewPackage }),
  });
}

function expectCode(
  action: () => unknown,
  code: StateStoreError['code'],
  message?: RegExp,
): void {
  try {
    action();
    throw new Error(`expected StateStoreError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(StateStoreError);
    expect((error as StateStoreError).code).toBe(code);
    if (message !== undefined) {
      expect((error as StateStoreError).message).toMatch(message);
    }
  }
}

// Drop the named immutability triggers, run the raw mutation, then recreate the
// triggers from their original DDL so the reopened store passes schema
// verification and the semantic integrity checks are what must catch the tamper.
function withTriggersDisabled(
  db: Database.Database,
  triggers: readonly string[],
  mutate: () => void,
): void {
  const ddl = triggers.map((name) => {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
    ).get(name) as { sql: string } | undefined;
    if (row === undefined) throw new Error(`missing trigger ${name}`);
    return row.sql;
  });
  for (const name of triggers) db.exec(`DROP TRIGGER ${name}`);
  mutate();
  for (const sql of ddl) db.exec(sql);
}

function completeZeroCommandDelivery(
  store: SqliteStateStore,
  deliveryId: string,
  writes: readonly Task[],
): void {
  const ordered = sortedTasks(writes);
  store.beginEnvelope({
    deliveryId,
    authorityRevision: 'a'.repeat(40),
    authorityInput: { writes: ordered, retiredTaskIds: [] },
    manifest: [],
    gapCodes: [],
  });
  store.completeEnvelope(deliveryId);
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('SQLite state store V2 aggregates', () => {
  it('keeps seam-less stores inert for deliveries and sweeps', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const item = task('alpha');
    completeZeroCommandDelivery(store, 'delivery-seamless', [item]);
    expect(store.readV2Aggregate('alpha')).toBeNull();
    expect(store.readEvents(0, 100)).toEqual([]);
    expect(store.sweepV2Aggregates([item])).toEqual({
      performed: false,
      reason: 'seam_not_wired',
      materializedCount: 0,
    });
    store.close();
  });

  it('materializes every write task on delivery including zero-command envelopes', () => {
    const target = paths();
    const pkgA = packageFor('alpha');
    const pkgB = packageFor('beta');
    const store = storeAt(target, {
      refreshReviewPackage: projectedSeam(new Map([
        ['alpha', pkgA],
        ['beta', pkgB],
      ])),
    });
    expect(store.initialize().schemaVersion).toBe(7);
    completeZeroCommandDelivery(store, 'delivery-zero', [task('beta'), task('alpha')]);

    const alpha = store.readV2Aggregate('alpha');
    const beta = store.readV2Aggregate('beta');
    expect(alpha).toMatchObject({
      aggregateId: 'alpha',
      stateVersion: 1,
      taskStatus: 'todo',
      projectionState: 'projected',
      unprojectableReason: null,
      projectionHash: pkgA.projectionHash,
    });
    expect(beta).toMatchObject({
      aggregateId: 'beta',
      stateVersion: 1,
      projectionHash: pkgB.projectionHash,
    });
    expect(alpha?.updatedAtSequence).toBe(1);
    expect(beta?.updatedAtSequence).toBe(2);

    const events = store.readEvents(0, 100);
    expect(events.map((event) => event.eventType)).toEqual([
      'V2AggregateMaterialized',
      'V2AggregateMaterialized',
    ]);
    expect(events.map((event) => event.eventId)).toEqual(['v2-alpha-1', 'v2-beta-1']);
    expect(events.every((event) => event.aggregateKind === 'task')).toBe(true);
    expect(events.map((event) => event.actor)).toEqual([ACTOR, ACTOR]);
    store.close();
  });

  it('treats projectedAt-only package changes as unchanged and bumps on status changes', () => {
    const target = paths();
    let current = packageFor('alpha', '2026-09-04T12:00:00.000Z');
    const seam: ReviewPackageRefreshSeam = () => ({ kind: 'projected', reviewPackage: current });
    const store = storeAt(target, { refreshReviewPackage: seam });
    store.initialize();
    completeZeroCommandDelivery(store, 'delivery-1', [task('alpha')]);
    expect(store.readV2Aggregate('alpha')?.stateVersion).toBe(1);
    expect(store.readEvents(0, 100)).toHaveLength(1);

    current = packageFor('alpha', '2026-09-04T13:00:00.000Z');
    completeZeroCommandDelivery(store, 'delivery-2', [task('alpha')]);
    expect(store.readV2Aggregate('alpha')?.stateVersion).toBe(1);
    expect(store.readEvents(0, 100)).toHaveLength(1);
    expect(store.readV2Aggregate('alpha')?.reviewPackage?.projectedAt).toBe('2026-09-04T12:00:00.000Z');

    current = packageFor('alpha', '2026-09-04T14:00:00.000Z');
    completeZeroCommandDelivery(store, 'delivery-3', [task('alpha', { state: 'review' })]);
    expect(store.readV2Aggregate('alpha')).toMatchObject({
      stateVersion: 2,
      taskStatus: 'review',
    });
    const events = store.readEvents(0, 100);
    expect(events.map((event) => event.eventType)).toEqual([
      'V2AggregateMaterialized',
      'V2AggregateRefreshed',
    ]);
    expect(events[1]?.eventId).toBe('v2-alpha-2');
    store.close();
  });

  it('records unprojectable results and rolls back when the seam throws', () => {
    const target = paths();
    const ok = storeAt(target, { refreshReviewPackage: unprojectableSeam() });
    ok.initialize();
    completeZeroCommandDelivery(ok, 'delivery-unproj', [task('alpha')]);
    expect(ok.readV2Aggregate('alpha')).toMatchObject({
      projectionState: 'unprojectable',
      unprojectableReason: 'empty_iteration_history',
      projectionHash: null,
      reviewPackage: null,
      stateVersion: 1,
    });
    expect(ok.readEnvelope('delivery-unproj')?.completed).toBe(true);
    ok.close();

    const failTarget = paths();
    const failing = storeAt(failTarget, { refreshReviewPackage: throwingSeam() });
    failing.initialize();
    failing.beginEnvelope({
      deliveryId: 'delivery-throw',
      authorityRevision: 'a'.repeat(40),
      authorityInput: { writes: [task('alpha')], retiredTaskIds: [] },
      manifest: [],
      gapCodes: [],
    });
    expectCode(() => failing.completeEnvelope('delivery-throw'), 'integrity');
    expect(failing.readEnvelope('delivery-throw')?.completed).toBe(false);
    expect(failing.readV2Aggregate('alpha')).toBeNull();
    expect(failing.readEvents(0, 100)).toEqual([]);
    failing.close();
  });

  it('sweeps once, marks completion, and stays green under double initialize', () => {
    const target = paths();
    const store = storeAt(target, {
      refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
    });
    const report = store.initialize();
    expect(report.schemaVersion).toBe(7);
    const first = store.sweepV2Aggregates([task('b'), task('a')]);
    expect(first).toEqual({ performed: true, reason: 'swept', materializedCount: 2 });
    expect(store.readV2Aggregate('a')?.stateVersion).toBe(1);
    expect(store.readV2Aggregate('b')?.stateVersion).toBe(1);
    expect(store.sweepV2Aggregates([task('a'), task('b')])).toEqual({
      performed: false,
      reason: 'already_swept',
      materializedCount: 0,
    });
    store.close();

    const reopened = storeAt(target, {
      refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
    });
    expect(reopened.initialize()).toMatchObject({ schemaVersion: 7, eventCount: 2 });
    expect(reopened.initialize()).toMatchObject({ schemaVersion: 7, eventCount: 2 });
    const raw = new Database(target.database, { readonly: true });
    const sweep = raw.prepare(
      'SELECT sweep_key, materialized_count FROM v2_sweeps WHERE sweep_key = ?',
    ).get(V2_INITIAL_SWEEP_KEY) as { sweep_key: string; materialized_count: number };
    expect(sweep).toEqual({ sweep_key: V2_INITIAL_SWEEP_KEY, materialized_count: 2 });
    raw.close();
    reopened.close();
  });

  it('fails boot integrity when V2 aggregate rows or events are tampered', () => {
    const target = paths();
    const store = storeAt(target, {
      refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
    });
    store.initialize();
    completeZeroCommandDelivery(store, 'delivery-integrity', [task('alpha')]);
    store.close();

    const cases: Array<{ label: string; mutate: (db: Database.Database) => void }> = [
      {
        label: 'state_version',
        mutate: (db) => {
          db.exec('DROP TRIGGER IF EXISTS v2_aggregate_state_monotonic');
          db.prepare('UPDATE v2_aggregate_state SET state_version = 9').run();
        },
      },
      {
        label: 'task_status',
        mutate: (db) => {
          db.pragma('foreign_keys = OFF');
          db.exec('DROP TRIGGER IF EXISTS v2_aggregate_state_monotonic');
          db.prepare("UPDATE v2_aggregate_state SET task_status = 'done'").run();
          db.pragma('foreign_keys = ON');
        },
      },
      {
        label: 'review_package_json',
        mutate: (db) => {
          db.pragma('foreign_keys = OFF');
          db.exec('DROP TRIGGER IF EXISTS v2_aggregate_state_monotonic');
          const row = db.prepare('SELECT review_package_json FROM v2_aggregate_state').get() as {
            review_package_json: string;
          };
          db.prepare('UPDATE v2_aggregate_state SET review_package_json = ?').run(
            `${row.review_package_json.slice(0, -1)}X`,
          );
          db.pragma('foreign_keys = ON');
        },
      },
      {
        label: 'review_package_json_field (valid canonical JSON, stale hash)',
        mutate: (db) => {
          db.pragma('foreign_keys = OFF');
          db.exec('DROP TRIGGER IF EXISTS v2_aggregate_state_monotonic');
          const row = db.prepare('SELECT review_package_json FROM v2_aggregate_state').get() as {
            review_package_json: string;
          };
          const tampered = { ...(JSON.parse(row.review_package_json) as ReviewPackageV2), projectedAt: '2027-01-01T00:00:00.000Z' };
          db.prepare('UPDATE v2_aggregate_state SET review_package_json = ?').run(canonicalSerialize(tampered));
          db.pragma('foreign_keys = ON');
        },
      },
      {
        label: 'projection_hash',
        mutate: (db) => {
          db.pragma('foreign_keys = OFF');
          db.exec('DROP TRIGGER IF EXISTS v2_aggregate_state_monotonic');
          db.prepare('UPDATE v2_aggregate_state SET projection_hash = ?').run(`sha256:${'c'.repeat(64)}`);
          db.pragma('foreign_keys = ON');
        },
      },
      {
        label: 'delete_v2_event',
        mutate: (db) => {
          db.pragma('foreign_keys = OFF');
          db.exec('DROP TRIGGER IF EXISTS control_events_no_delete');
          db.prepare("DELETE FROM control_events WHERE event_type = 'V2AggregateMaterialized'").run();
          db.pragma('foreign_keys = ON');
        },
      },
    ];

    for (const item of cases) {
      const caseTarget = paths();
      const seed = storeAt(caseTarget, {
        refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
      });
      seed.initialize();
      completeZeroCommandDelivery(seed, 'delivery-integrity', [task('alpha')]);
      seed.close();
      const raw = new Database(caseTarget.database);
      item.mutate(raw);
      raw.close();
      const reopened = storeAt(caseTarget, {
        refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
      });
      expectCode(() => reopened.initialize(), 'integrity');
      reopened.close();
    }
  });

  it('keeps a single linear hash chain across shadow and V2 events', () => {
    const target = paths();
    const store = storeAt(target, {
      refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
    });
    store.initialize();
    completeZeroCommandDelivery(store, 'delivery-a', [task('alpha')]);
    store.close();

    const interleaved = storeAt(target, {
      refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId, '2026-09-04T15:00:00.000Z')),
    });
    interleaved.initialize();
    // A shadow (legacy-projection) event lands between the two V2 events: both
    // families share the one control_events chain.
    interleaved.commit({
      idempotencyKey: 'idem-shadow-root',
      event: {
        eventId: 'event-shadow-root',
        actor: { kind: 'control_plane', id: 'shadow-projector' },
        occurredAt: FIXED_CLOCK,
      },
      mutation: { kind: 'insert_contract_root', contract: shadowRootContract('alpha') },
    });
    completeZeroCommandDelivery(interleaved, 'delivery-b', [task('alpha', { state: 'review' })]);
    const events = interleaved.readEvents(0, 100);
    expect(events.map((event) => event.eventType)).toEqual([
      'V2AggregateMaterialized',
      'ShadowContractRootProjected',
      'V2AggregateRefreshed',
    ]);
    for (let index = 0; index < events.length; index += 1) {
      expect(events[index]?.sequence).toBe(index + 1);
      if (index === 0) expect(events[index]?.previousEventHash).toBeNull();
      else expect(events[index]?.previousEventHash).toBe(events[index - 1]?.eventHash);
    }
    interleaved.close();

    const reopened = storeAt(target, {
      refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
    });
    expect(reopened.initialize()).toMatchObject({ eventCount: 3 });
    reopened.close();
  });

  it('returns no human decisions before any V2DecisionCommitted event', () => {
    const target = paths();
    const store = storeAt(target, {
      refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
    });
    store.initialize();
    completeZeroCommandDelivery(store, 'delivery-decisions', [task('alpha')]);
    expect(store.readV2HumanDecisions('alpha')).toEqual([]);
    store.close();
  });

  it('enforces permanence triggers on aggregate state and admission ledger', () => {
    const target = paths();
    const store = storeAt(target, {
      refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
    });
    store.initialize();
    completeZeroCommandDelivery(store, 'delivery-triggers', [task('alpha')]);
    store.close();

    const raw = new Database(target.database);
    expect(() => raw.prepare('DELETE FROM v2_aggregate_state').run()).toThrow(/permanent|ABORT/i);
    raw.prepare(
      `INSERT INTO v2_admission_ledger (key_hash, aggregate_id, request_hash, event_sequence, receipt_json)
       VALUES (?, 'alpha', ?, 1, ?)`,
    ).run(
      `sha256:${'e'.repeat(64)}`,
      `sha256:${'f'.repeat(64)}`,
      canonicalSerialize({ eventSequence: 1, stateVersion: 1 }),
    );
    expect(() => raw.prepare(
      'UPDATE v2_admission_ledger SET request_hash = ?',
    ).run(`sha256:${'a'.repeat(64)}`)).toThrow(/immutable|ABORT/i);
    raw.close();
  });

  it('refuses task-<hex64> create-namespace collisions', () => {
    const target = paths();
    const collidingId = `task-${'a'.repeat(64)}`;
    const store = storeAt(target, {
      refreshReviewPackage: projectedSeam((input) => packageFor(input.aggregateId)),
    });
    store.initialize();
    store.beginEnvelope({
      deliveryId: 'delivery-collision',
      authorityRevision: 'a'.repeat(40),
      authorityInput: { writes: [task(collidingId)], retiredTaskIds: [] },
      manifest: [],
      gapCodes: [],
    });
    expectCode(() => store.completeEnvelope('delivery-collision'), 'invalid_input');
    expect(store.readV2Aggregate(collidingId)).toBeNull();
    store.close();
  });
});

describe('SQLite state store commitV2', () => {
  it('commits a decision then refreshes, ledgering and marking a pending effect', () => {
    const target = paths();
    const seenDecisions: unknown[] = [];
    const seam: ReviewPackageRefreshSeam = (input) => {
      seenDecisions.push(input.humanDecisions);
      return decisionAwareSeam()(input);
    };
    const store = storeAt(target, { refreshReviewPackage: seam });
    store.initialize();
    materializeReviewAggregate(store, 'alpha');
    const before = store.readV2Aggregate('alpha');
    expect(before?.stateVersion).toBe(1);
    expect(before?.reviewPackage?.decisionBinding).not.toBeNull();

    const request = submitRequest(
      'alpha',
      before!.stateVersion,
      before!.projectionHash!,
      'req-commit-happy',
    );
    const verdict = admitVerdict(request);
    const receipt = store.commitV2(request, verdict);

    expect(receipt).toMatchObject({
      outcome: 'committed',
      resource: 'decision',
      aggregateId: 'alpha',
      keyHash: request.idempotencyKey!.keyHash,
      requestHash: request.requestHash,
      stateVersion: 2,
      reason: null,
      decidedAt: verdict.decidedAt,
    });
    expect(receipt.eventSequence).toBe(2);

    const after = store.readV2Aggregate('alpha');
    expect(after).toMatchObject({
      stateVersion: 3,
      taskStatus: 'review',
      projectionState: 'projected',
    });
    expect(after?.projectionHash).not.toBe(before?.projectionHash);
    expect(after?.reviewPackage?.validDecisions).toEqual(['request_changes']);
    expect(after?.reviewPackage?.decisionBinding).not.toBeNull();

    const events = store.readEvents(0, 100);
    expect(events.map((event) => event.eventType)).toEqual([
      'V2AggregateMaterialized',
      'V2DecisionCommitted',
      'V2AggregateRefreshed',
    ]);
    expect(events[1]?.eventId).toBe('v2-alpha-2');
    expect(events[2]?.eventId).toBe('v2-alpha-3');
    expect(events[1]?.occurredAt).toBe(verdict.decidedAt);
    expect(events[2]?.occurredAt).toBe(verdict.decidedAt);

    const decisions = store.readV2HumanDecisions('alpha');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      id: `decision-${request.idempotencyKey!.keyHash.slice('sha256:'.length)}`,
      decision: 'approve_outcome',
      comment: 'Looks correct',
      actor: { kind: 'human', id: 'actor-1' },
      createdAt: verdict.decidedAt,
    });
    expect(seenDecisions.at(-1)).toEqual(decisions);

    const raw = new Database(target.database, { readonly: true });
    const ledger = raw.prepare(
      'SELECT key_hash, aggregate_id, request_hash, event_sequence FROM v2_admission_ledger',
    ).all();
    expect(ledger).toEqual([{
      key_hash: request.idempotencyKey!.keyHash,
      aggregate_id: 'alpha',
      request_hash: request.requestHash,
      event_sequence: 2,
    }]);
    const pending = raw.prepare(
      'SELECT key_hash, aggregate_id, action, event_sequence, effect_state, applied_at_sequence FROM v2_pending_effects',
    ).all();
    expect(pending).toEqual([{
      key_hash: request.idempotencyKey!.keyHash,
      aggregate_id: 'alpha',
      action: 'approve_outcome',
      event_sequence: 2,
      effect_state: 'pending',
      applied_at_sequence: null,
    }]);
    raw.close();

    expect(store.initialize()).toMatchObject({ schemaVersion: 7, eventCount: 3 });
    store.close();
  });

  it('replays a commit byte-identically with no second effect', () => {
    const target = paths();
    const store = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    store.initialize();
    materializeReviewAggregate(store, 'alpha');
    const row = store.readV2Aggregate('alpha')!;
    const request = submitRequest('alpha', row.stateVersion, row.projectionHash!, 'req-replay');
    const verdict = admitVerdict(request);
    const first = store.commitV2(request, verdict);
    const second = store.commitV2(request, verdict);
    expect(second).toEqual(first);
    expect(store.readEvents(0, 100)).toHaveLength(3);
    expect(store.readV2Aggregate('alpha')?.stateVersion).toBe(3);
    const raw = new Database(target.database, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM v2_admission_ledger').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM v2_pending_effects').get()).toEqual({ n: 1 });
    raw.close();
    store.close();
  });

  it('returns idempotency_conflict and stale_version without ledger writes', () => {
    const target = paths();
    const store = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    store.initialize();
    materializeReviewAggregate(store, 'alpha');
    const row = store.readV2Aggregate('alpha')!;
    const request = submitRequest('alpha', row.stateVersion, row.projectionHash!, 'req-conflict');
    store.commitV2(request, admitVerdict(request));

    const conflict = submitRequest(
      'alpha',
      row.stateVersion,
      row.projectionHash!,
      'req-conflict',
      decisionPayload({ reason: 'Different reason' }),
    );
    expect(conflict.idempotencyKey!.keyHash).toBe(request.idempotencyKey!.keyHash);
    expect(conflict.requestHash).not.toBe(request.requestHash);
    const refusedConflict = store.commitV2(conflict, admitVerdict(conflict));
    expect(refusedConflict).toMatchObject({
      outcome: 'refused',
      reason: 'idempotency_conflict',
      stateVersion: null,
      eventSequence: null,
      decidedAt: FIXED_CLOCK,
    });

    const stale = submitRequest('alpha', 1, row.projectionHash!, 'req-stale');
    const refusedStale = store.commitV2(stale, admitVerdict(stale));
    expect(refusedStale).toMatchObject({
      outcome: 'refused',
      reason: 'stale_version',
      stateVersion: null,
      eventSequence: null,
    });

    const raw = new Database(target.database, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM v2_admission_ledger').get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM v2_pending_effects').get()).toEqual({ n: 1 });
    expect(store.readEvents(0, 100)).toHaveLength(3);
    raw.close();
    store.close();
  });

  it('throws unsupported for create and invalid_input without the refresh seam', () => {
    const target = paths();
    const store = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    store.initialize();
    materializeReviewAggregate(store, 'alpha');
    const create = buildControlApiV2Request({
      resource: 'task',
      operation: 'create',
      aggregateId: '',
      idempotencyKey: buildIdempotencyKey({
        actorIssuer: 'hercules-web',
        actorId: 'actor-1',
        aggregateId: '',
        clientRequestId: 'req-create',
      }),
      concurrencyToken: null,
      payload: {
        kind: 'create',
        taskContractHash: `sha256:${'a'.repeat(64)}`,
        intentDigest: `sha256:${'b'.repeat(64)}`,
      },
      issuedAt: FIXED_CLOCK,
    });
    expectCode(() => store.commitV2(create, {
      schema: 'hercules-control-api-admit-verdict/v2',
      resource: 'task',
      aggregateId: 'task-x',
      keyHash: create.idempotencyKey!.keyHash,
      requestHash: create.requestHash,
      decidedAt: FIXED_CLOCK,
      verdictHash: `sha256:${'c'.repeat(64)}`,
    }), 'unsupported');
    store.close();

    const seamless = storeAt(paths());
    seamless.initialize();
    const rowPackage = buildEligibleControlApiV2ReviewPackage('alpha');
    const request = submitRequest('alpha', 1, rowPackage.projectionHash, 'req-no-seam');
    expectCode(() => seamless.commitV2(request, admitVerdict(request)), 'invalid_input');
    seamless.close();
  });

  it('rolls back the full commit when the post-decision refresh throws', () => {
    const target = paths();
    const seam: ReviewPackageRefreshSeam = (input) => {
      if (input.humanDecisions.length > 0) {
        throw new Error('post-decision seam boom');
      }
      return decisionAwareSeam()(input);
    };
    const store = storeAt(target, { refreshReviewPackage: seam });
    store.initialize();
    materializeReviewAggregate(store, 'alpha');
    const row = store.readV2Aggregate('alpha')!;
    const request = submitRequest('alpha', row.stateVersion, row.projectionHash!, 'req-rollback');
    expectCode(() => store.commitV2(request, admitVerdict(request)), 'integrity');
    expect(store.readV2Aggregate('alpha')?.stateVersion).toBe(1);
    expect(store.readEvents(0, 100)).toHaveLength(1);
    expect(store.readV2HumanDecisions('alpha')).toEqual([]);
    const raw = new Database(target.database, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM v2_admission_ledger').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM v2_pending_effects').get()).toEqual({ n: 0 });
    raw.close();
    expect(store.initialize()).toMatchObject({ eventCount: 1 });
    store.close();
  });

  it('fails boot integrity on tampered ledger receipt_json or unpaired ledger rows', () => {
    const target = paths();
    const store = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    store.initialize();
    materializeReviewAggregate(store, 'alpha');
    const row = store.readV2Aggregate('alpha')!;
    const request = submitRequest('alpha', row.stateVersion, row.projectionHash!, 'req-tamper');
    store.commitV2(request, admitVerdict(request));
    store.close();

    const receiptCase = paths();
    const seedReceipt = storeAt(receiptCase, { refreshReviewPackage: decisionAwareSeam() });
    seedReceipt.initialize();
    materializeReviewAggregate(seedReceipt, 'alpha');
    const seeded = seedReceipt.readV2Aggregate('alpha')!;
    const seededRequest = submitRequest(
      'alpha',
      seeded.stateVersion,
      seeded.projectionHash!,
      'req-tamper-receipt',
    );
    seedReceipt.commitV2(seededRequest, admitVerdict(seededRequest));
    seedReceipt.close();
    const rawReceipt = new Database(receiptCase.database);
    rawReceipt.exec('DROP TRIGGER IF EXISTS v2_admission_ledger_no_update');
    const ledger = rawReceipt.prepare(
      'SELECT key_hash, receipt_json FROM v2_admission_ledger',
    ).get() as { key_hash: string; receipt_json: string };
    const parsed = JSON.parse(ledger.receipt_json) as {
      eventSequence: number;
      stateVersion: number;
      receiptHash: string;
    };
    parsed.eventSequence = 1;
    rawReceipt.prepare('UPDATE v2_admission_ledger SET receipt_json = ?').run(
      canonicalSerialize(parsed),
    );
    rawReceipt.close();
    const reopenReceipt = storeAt(receiptCase, { refreshReviewPackage: decisionAwareSeam() });
    expectCode(() => reopenReceipt.initialize(), 'integrity');
    reopenReceipt.close();

    const unpaired = paths();
    const seedUnpaired = storeAt(unpaired, { refreshReviewPackage: decisionAwareSeam() });
    seedUnpaired.initialize();
    materializeReviewAggregate(seedUnpaired, 'alpha');
    seedUnpaired.close();
    const rawUnpaired = new Database(unpaired.database);
    rawUnpaired.prepare(
      `INSERT INTO v2_admission_ledger (key_hash, aggregate_id, request_hash, event_sequence, receipt_json)
       VALUES (?, 'alpha', ?, 1, ?)`,
    ).run(
      `sha256:${'d'.repeat(64)}`,
      `sha256:${'e'.repeat(64)}`,
      canonicalSerialize({
        schema: 'hercules-control-api-receipt/v2',
        outcome: 'committed',
        resource: 'decision',
        aggregateId: 'alpha',
        keyHash: `sha256:${'d'.repeat(64)}`,
        requestHash: `sha256:${'e'.repeat(64)}`,
        stateVersion: 1,
        eventSequence: 1,
        reason: null,
        decidedAt: FIXED_CLOCK,
        receiptHash: `sha256:${'f'.repeat(64)}`,
      }),
    );
    rawUnpaired.close();
    const reopenUnpaired = storeAt(unpaired, { refreshReviewPackage: decisionAwareSeam() });
    expectCode(() => reopenUnpaired.initialize(), 'integrity');
    reopenUnpaired.close();
  });

  it('fails boot integrity when a ledger receipt is forged with a recomputed receiptHash', () => {
    // A self-consistent receipt (valid hash, valid shape) that no longer says what
    // its paired V2DecisionCommitted event says must not survive boot. Triggers are
    // restored after the tamper so schema verification passes and only the
    // ledger↔event binding can reject the row.
    const forgeries: ReadonlyArray<{
      readonly label: string;
      readonly forge: (db: Database.Database, receipt: ControlApiV2ReceiptV1) => void;
    }> = [
      {
        label: 'decidedAt',
        forge: (db, receipt) => {
          const { receiptHash: _dropped, ...withoutHash } = receipt;
          const forged = { ...withoutHash, decidedAt: '2026-09-05T00:00:00.000Z' };
          db.prepare('UPDATE v2_admission_ledger SET receipt_json = ?').run(
            canonicalSerialize({ ...forged, receiptHash: computeReceiptHash(forged) }),
          );
        },
      },
      {
        label: 'requestHash',
        forge: (db, receipt) => {
          const { receiptHash: _dropped, ...withoutHash } = receipt;
          const requestHash = `sha256:${'9'.repeat(64)}`;
          const forged = { ...withoutHash, requestHash };
          db.prepare(
            'UPDATE v2_admission_ledger SET request_hash = ?, receipt_json = ?',
          ).run(requestHash, canonicalSerialize({ ...forged, receiptHash: computeReceiptHash(forged) }));
        },
      },
    ];

    for (const forgery of forgeries) {
      const target = paths();
      const seed = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
      seed.initialize();
      materializeReviewAggregate(seed, 'alpha');
      const row = seed.readV2Aggregate('alpha')!;
      const request = submitRequest('alpha', row.stateVersion, row.projectionHash!, 'req-forge');
      seed.commitV2(request, admitVerdict(request));
      seed.close();

      const raw = new Database(target.database);
      const ledger = raw.prepare('SELECT receipt_json FROM v2_admission_ledger').get() as {
        receipt_json: string;
      };
      const receipt = JSON.parse(ledger.receipt_json) as ControlApiV2ReceiptV1;
      withTriggersDisabled(raw, ['v2_admission_ledger_no_update'], () => {
        forgery.forge(raw, receipt);
      });
      raw.close();

      const reopened = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
      expectCode(() => reopened.initialize(), 'integrity', /ledger receipt mismatch/);
      reopened.close();
    }
  });

  it('fails boot integrity when the post-decision refresh is truncated from the chain', () => {
    // Events after commitV2: [1] V2AggregateMaterialized, [2] V2DecisionCommitted,
    // [3] V2AggregateRefreshed. Drop [3] and rewrite the aggregate row to a
    // version-2 tail that is internally consistent (count, updated_at_sequence,
    // decision payload stateVersion all agree) so only the "decision must be
    // followed by its refresh" rule can reject the reopen.
    const target = paths();
    const seed = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    seed.initialize();
    materializeReviewAggregate(seed, 'alpha');
    const row = seed.readV2Aggregate('alpha')!;
    const request = submitRequest('alpha', row.stateVersion, row.projectionHash!, 'req-truncate');
    seed.commitV2(request, admitVerdict(request));
    expect(seed.readEvents(0, 100).map((event) => event.eventType)).toEqual([
      'V2AggregateMaterialized',
      'V2DecisionCommitted',
      'V2AggregateRefreshed',
    ]);
    seed.close();

    const raw = new Database(target.database);
    withTriggersDisabled(raw, ['control_events_no_delete', 'v2_aggregate_state_monotonic'], () => {
      raw.prepare(
        "UPDATE v2_aggregate_state SET state_version = 2, updated_at_sequence = 2 WHERE aggregate_id = 'alpha'",
      ).run();
      raw.prepare('DELETE FROM control_events WHERE sequence = 3').run();
    });
    raw.close();

    const reopened = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    expectCode(
      () => reopened.initialize(),
      'integrity',
      /decision at version 2 lacks its post-decision refresh/,
    );
    reopened.close();
  });

  it('exposes pending-effect reader/marker APIs without deleting rows', () => {
    const target = paths();
    const store = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    store.initialize();
    materializeReviewAggregate(store, 'alpha');
    expect(store.listPendingEffects()).toEqual([]);
    expect(store.latestEventSequence()).toBe(1);

    const row = store.readV2Aggregate('alpha')!;
    const request = submitRequest('alpha', row.stateVersion, row.projectionHash!, 'req-effect-api');
    const receipt = store.commitV2(request, admitVerdict(request));
    expect(receipt.outcome).toBe('committed');
    const keyHash = request.idempotencyKey!.keyHash;

    const pending = store.readPendingEffect(keyHash);
    expect(pending).toMatchObject({
      keyHash,
      aggregateId: 'alpha',
      action: 'approve_outcome',
      effectState: 'pending',
      appliedAtSequence: null,
    });
    expect(store.listPendingEffects()).toEqual([pending]);
    expect(store.readPendingEffect('sha256:' + '0'.repeat(64))).toBeNull();

    const decision = store.readDecisionEvent(pending!.eventSequence);
    expect(decision).toMatchObject({
      aggregateId: 'alpha',
      action: 'approve_outcome',
      reason: 'Looks correct',
      actorId: 'actor-1',
      actorIssuer: 'hercules-web',
      decidedAt: FIXED_CLOCK,
      keyHash,
      acknowledgedRiskCodes: [],
    });
    expect(store.readDecisionEvent(1)).toBeNull(); // materialize, not decision

    const appliedAt = store.latestEventSequence();
    const applied = store.markEffectApplied(keyHash, appliedAt);
    expect(applied).toMatchObject({
      keyHash,
      effectState: 'applied',
      appliedAtSequence: appliedAt,
    });
    expect(store.listPendingEffects()).toEqual([]);
    expect(store.readPendingEffect(keyHash)?.effectState).toBe('applied');
    // Idempotent same sequence; never deletes the row.
    expect(store.markEffectApplied(keyHash, appliedAt)).toEqual(applied);
    const raw = new Database(target.database, { readonly: true });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM v2_pending_effects').get()).toEqual({ n: 1 });
    raw.close();

    expectCode(
      () => store.markEffectApplied(keyHash, appliedAt + 1),
      'integrity',
    );
    expectCode(
      () => store.markEffectApplied('sha256:' + 'f'.repeat(64), appliedAt),
      'invalid_input',
    );
    store.close();
  });

  it('pending-effect guards: delete is aborted and applied→pending is refused; missing marker fails reopen', () => {
    const target = paths();
    const store = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    store.initialize();
    materializeReviewAggregate(store, 'guard');
    const row = store.readV2Aggregate('guard')!;
    const request = submitRequest('guard', row.stateVersion, row.projectionHash!, 'req-guard');
    store.commitV2(request, admitVerdict(request));
    const keyHash = request.idempotencyKey!.keyHash;
    const appliedAt = store.latestEventSequence();
    store.markEffectApplied(keyHash, appliedAt);
    store.close();

    const raw = new Database(target.database);
    // Drop the delete trigger to simulate a hostile delete, then recreate and reopen.
    raw.exec('DROP TRIGGER IF EXISTS v2_pending_effects_no_delete');
    raw.prepare('DELETE FROM v2_pending_effects WHERE key_hash = ?').run(keyHash);
    raw.exec(`
CREATE TRIGGER v2_pending_effects_no_delete BEFORE DELETE ON v2_pending_effects
BEGIN SELECT RAISE(ABORT, 'v2_pending_effects rows are permanent'); END;
`);
    raw.close();

    const reopened = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    expectCode(() => reopened.initialize(), 'integrity');
    reopened.close();

    // Fresh store: applied→pending update is refused by the forward-only trigger.
    const target2 = paths();
    const store2 = storeAt(target2, { refreshReviewPackage: decisionAwareSeam() });
    store2.initialize();
    materializeReviewAggregate(store2, 'guard2');
    const row2 = store2.readV2Aggregate('guard2')!;
    const request2 = submitRequest('guard2', row2.stateVersion, row2.projectionHash!, 'req-guard2');
    store2.commitV2(request2, admitVerdict(request2));
    const keyHash2 = request2.idempotencyKey!.keyHash;
    store2.markEffectApplied(keyHash2, store2.latestEventSequence());
    store2.close();

    const raw2 = new Database(target2.database);
    expect(() => {
      raw2.prepare(
        `UPDATE v2_pending_effects SET effect_state = 'pending', applied_at_sequence = NULL WHERE key_hash = ?`,
      ).run(keyHash2);
    }).toThrow(/pending→applied|forward|ABORT/i);
    raw2.close();
  });

  it('keeps a pending marker untouched across shadow-delivery recompute', () => {
    const target = paths();
    const store = storeAt(target, { refreshReviewPackage: decisionAwareSeam() });
    store.initialize();
    materializeReviewAggregate(store, 'alpha');
    const row = store.readV2Aggregate('alpha')!;
    const request = submitRequest('alpha', row.stateVersion, row.projectionHash!, 'req-shadow-keep');
    store.commitV2(request, admitVerdict(request));
    const keyHash = request.idempotencyKey!.keyHash;
    const before = store.readPendingEffect(keyHash);
    expect(before?.effectState).toBe('pending');

    // Shadow delivery recomputes task_status / package; must not clear the marker.
    completeZeroCommandDelivery(store, 'delivery-post-decision', [
      task('alpha', { state: 'review' }),
    ]);
    expect(store.readPendingEffect(keyHash)).toEqual(before);
    expect(store.listPendingEffects()).toHaveLength(1);
    store.close();
  });
});
