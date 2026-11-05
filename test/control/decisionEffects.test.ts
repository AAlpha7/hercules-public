import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { missingHumanAcknowledgements } from '../../src/domain/acceptance.js';
import {
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  computeAdmissionVerdictHash,
  type AdmissionVerdictV1,
  type ControlApiV2RequestV1,
  type DecisionPayloadV1,
} from '../../src/domain/controlApiV2.js';
import { projectAndAssertReviewPackageV2 } from '../../src/domain/reviewPackageV2.js';
import { compileM4LegacyContract } from '../../src/domain/shadowProjection.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import { buildEligibleControlApiV2ReviewSource } from '../../src/isolation/controlApiV2ReviewSeed.js';
import {
  adaptDecisionEffectStore,
  createDecisionEffectDriver,
  DECISION_EFFECT_EXPECTED_STATE,
  type DecisionEffectActionPort,
  type DecisionEffectLegacyPort,
  type DecisionEffectStorePort,
  type DecisionEventView,
} from '../../src/control/decisionEffects.js';
import { SqliteStateStore } from '../../src/control/state/sqliteStateStore.js';
import type { ReviewPackageRefreshInput, ReviewPackageRefreshSeam, V2PendingEffectRow } from '../../src/control/state/stateStore.js';

const cleanup: string[] = [];
const FIXED_CLOCK = '2026-09-04T12:00:00.000Z';
const SIMPLE_BODY =
  '## Definition of Done\n' +
  '- [ ] (mechanical) tests pass @gate:test\n';
const HUMAN_BODY =
  '## Definition of Done\n' +
  '- [ ] (mechanical) tests pass @gate:test\n' +
  '- [ ] (human) Operator reviewed the UI\n' +
  '- [ ] (human) Risks acknowledged on the control surface\n';

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function humanCriteriaFor(aggregateId: string, body: string = HUMAN_BODY) {
  return compileM4LegacyContract(task(aggregateId, { body })).acceptanceCriteria.filter(
    (criterion) => criterion.authority === 'human',
  );
}

function humanCodesFor(aggregateId: string, body: string = HUMAN_BODY): readonly string[] {
  return humanCriteriaFor(aggregateId, body)
    .map((criterion) => `human:${criterion.id}`)
    .sort();
}

function eligibleSeam(): ReviewPackageRefreshSeam {
  return (input: ReviewPackageRefreshInput) => ({
    kind: 'projected',
    reviewPackage: projectAndAssertReviewPackageV2({
      ...buildEligibleControlApiV2ReviewSource(input.aggregateId),
      humanDecisions: [...input.humanDecisions],
      projectedAt: FIXED_CLOCK,
    }),
  });
}

function openStore(): SqliteStateStore {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-decision-effects-'));
  cleanup.push(parent);
  const store = new SqliteStateStore({
    trustedRoot: join(parent, 'state'),
    databasePath: join(parent, 'state', 'shadow.sqlite'),
    busyTimeoutMs: 100,
    clock: () => FIXED_CLOCK,
    refreshReviewPackage: eligibleSeam(),
  });
  store.initialize();
  return store;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    repo: 'app',
    state: 'review',
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
    body: SIMPLE_BODY,
    ...overrides,
  };
}

let deliverySeq = 0;

function materialize(
  store: SqliteStateStore,
  aggregateId: string,
  state: TaskState = 'review',
  item: Task = task(aggregateId, { state }),
): void {
  const ordered = [{ ...item, state }];
  deliverySeq += 1;
  const deliveryId = `delivery-${aggregateId}-${state}-${deliverySeq}`;
  store.beginEnvelope({
    deliveryId,
    authorityRevision: 'a'.repeat(40),
    authorityInput: { writes: ordered, retiredTaskIds: [] },
    manifest: [],
    gapCodes: [],
  });
  store.completeEnvelope(deliveryId);
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

function admitVerdict(request: ControlApiV2RequestV1): AdmissionVerdictV1 {
  const withoutHash: Omit<AdmissionVerdictV1, 'verdictHash'> = {
    schema: 'hercules-control-api-admit-verdict/v2',
    resource: 'decision',
    aggregateId: request.aggregateId,
    keyHash: request.idempotencyKey!.keyHash,
    requestHash: request.requestHash,
    decidedAt: FIXED_CLOCK,
  };
  return { ...withoutHash, verdictHash: computeAdmissionVerdictHash(withoutHash) };
}

function commitDecision(
  store: SqliteStateStore,
  aggregateId: string,
  clientRequestId: string,
  payload: DecisionPayloadV1 = decisionPayload(),
  item?: Task,
): { readonly keyHash: string; readonly request: ControlApiV2RequestV1 } {
  materialize(store, aggregateId, item?.state ?? 'review', item ?? task(aggregateId));
  const row = store.readV2Aggregate(aggregateId)!;
  const request = submitRequest(
    aggregateId,
    row.stateVersion,
    row.projectionHash!,
    clientRequestId,
    payload,
  );
  const receipt = store.commitV2(request, admitVerdict(request));
  expect(receipt.outcome).toBe('committed');
  return { keyHash: request.idempotencyKey!.keyHash, request };
}

/** In-memory effect store for human-ack unit tests (avoids rebuilding an eligible package). */
function humanAckStorePort(input: {
  readonly aggregateId: string;
  readonly keyHash: string;
  readonly body: string;
  readonly acknowledgedRiskCodes: readonly string[];
}): DecisionEffectStorePort & { marker: V2PendingEffectRow } {
  const humanCriteria = humanCriteriaFor(input.aggregateId, input.body);
  const state = {
    marker: {
      keyHash: input.keyHash,
      aggregateId: input.aggregateId,
      action: 'approve_outcome' as const,
      eventSequence: 2,
      effectState: 'pending' as 'pending' | 'applied',
      appliedAtSequence: null as number | null,
    },
  };
  const decision: DecisionEventView = {
    aggregateId: input.aggregateId,
    action: 'approve_outcome',
    reason: 'Looks correct',
    actorId: 'actor-1',
    actorIssuer: 'hercules-web',
    decidedAt: FIXED_CLOCK,
    keyHash: input.keyHash,
    acknowledgedRiskCodes: input.acknowledgedRiskCodes,
  };
  return {
    get marker() {
      return state.marker;
    },
    readPendingEffect: (keyHash) =>
      keyHash === state.marker.keyHash ? { ...state.marker } : null,
    listPendingEffects: () =>
      state.marker.effectState === 'pending' ? [{ ...state.marker }] : [],
    markEffectApplied: (keyHash, appliedAtSequence) => {
      if (keyHash !== state.marker.keyHash) throw new Error('unknown marker');
      state.marker = {
        ...state.marker,
        effectState: 'applied',
        appliedAtSequence,
      };
      return { ...state.marker };
    },
    readDecisionEvent: (eventSequence) =>
      eventSequence === state.marker.eventSequence ? decision : null,
    readV2Aggregate: (aggregateId) =>
      aggregateId === input.aggregateId
        ? {
            taskStatus: 'review',
            updatedAtMs: Date.parse(FIXED_CLOCK),
            reviewPackage: {
              criteria: humanCriteria.map((criterion) => ({
                criterionId: criterion.id,
                authority: criterion.authority,
                required: criterion.required,
                text: criterion.text,
              })),
            },
          }
        : null,
    latestEventSequence: () => 3,
  };
}

function fakeLegacy(initial: readonly Task[]): DecisionEffectLegacyPort & {
  readonly tasks: Task[];
  setState(id: string, state: TaskState): void;
} {
  const tasks = initial.map((item) => ({ ...item }));
  return {
    tasks,
    setState(id, state) {
      const found = tasks.find((entry) => entry.id === id);
      if (found) found.state = state;
    },
    async read() {
      return { tasks: tasks.map((entry) => ({ ...entry })) };
    },
  };
}

function fakeActions(legacy: ReturnType<typeof fakeLegacy>): DecisionEffectActionPort & {
  readonly calls: Array<{ op: string; id: string; opts?: unknown; comment?: string }>;
  throwOn: Set<string>;
} {
  const calls: Array<{ op: string; id: string; opts?: unknown; comment?: string }> = [];
  const throwOn = new Set<string>();
  return {
    calls,
    throwOn,
    async approve(id, opts) {
      calls.push({ op: 'approve', id, opts });
      if (throwOn.has('approve')) throw new Error('approve refused');
      legacy.setState(id, 'done');
      return legacy.tasks.find((entry) => entry.id === id);
    },
    async reject(id) {
      calls.push({ op: 'reject', id });
      if (throwOn.has('reject')) throw new Error('reject refused');
      legacy.setState(id, 'todo');
      return legacy.tasks.find((entry) => entry.id === id);
    },
    async steer(id, comment) {
      calls.push({ op: 'steer', id, comment });
      if (throwOn.has('steer')) throw new Error('steer refused');
      legacy.setState(id, 'todo');
      return legacy.tasks.find((entry) => entry.id === id);
    },
  };
}

describe('decision effect driver', () => {
  it('(a) approve_outcome drives approve and marks applied (no human criteria)', async () => {
    const store = openStore();
    const { keyHash } = commitDecision(store, 'alpha', 'req-approve');
    const legacy = fakeLegacy([task('alpha')]);
    const actions = fakeActions(legacy);
    const lines: string[] = [];
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => store.listTaskIds(),
      log: (line) => lines.push(line),
    });

    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toEqual({
      kind: 'applied',
      keyHash,
      aggregateId: 'alpha',
      action: 'approve_outcome',
      via: 'drove',
    });
    expect(actions.calls).toHaveLength(1);
    expect(actions.calls[0]).toMatchObject({ op: 'approve', id: 'alpha' });
    expect(actions.calls[0]!.opts).toEqual({ humanAcknowledged: [] });
    const marker = store.readPendingEffect(keyHash)!;
    expect(marker.effectState).toBe('applied');
    expect(marker.appliedAtSequence).toBe(store.latestEventSequence());
    expect(lines.some((line) => line.includes('acknowledging'))).toBe(true);
    store.close();
  });

  it('approve with all human: codes passes exactly the committed package texts', async () => {
    const keyHash = 'sha256:' + 'a'.repeat(64);
    const codes = humanCodesFor('human-ok');
    expect(codes.length).toBeGreaterThan(0);
    const store = humanAckStorePort({
      aggregateId: 'human-ok',
      keyHash,
      body: HUMAN_BODY,
      acknowledgedRiskCodes: codes,
    });
    const legacy = fakeLegacy([task('human-ok', { body: HUMAN_BODY })]);
    const actions = fakeActions(legacy);
    const lines: string[] = [];
    const driver = createDecisionEffectDriver({
      store,
      actions,
      legacy,
      listAggregateIds: () => ['human-ok'],
      log: (line) => lines.push(line),
    });
    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toMatchObject({ kind: 'applied', via: 'drove' });
    const expectedHuman = missingHumanAcknowledgements(HUMAN_BODY, []);
    expect(actions.calls[0]!.opts).toEqual({ humanAcknowledged: expectedHuman });
    expect(store.marker.effectState).toBe('applied');
    expect(lines.some((line) => line.includes('acknowledging'))).toBe(true);
  });

  it('refuses approve when a body human criterion has no human: code', async () => {
    const keyHash = 'sha256:' + 'b'.repeat(64);
    const codes = humanCodesFor('no-code');
    const store = humanAckStorePort({
      aggregateId: 'no-code',
      keyHash,
      body: HUMAN_BODY,
      acknowledgedRiskCodes: codes.slice(0, 1),
    });
    const legacy = fakeLegacy([task('no-code', { body: HUMAN_BODY })]);
    const actions = fakeActions(legacy);
    const lines: string[] = [];
    const driver = createDecisionEffectDriver({
      store,
      actions,
      legacy,
      listAggregateIds: () => ['no-code'],
      log: (line) => lines.push(line),
    });
    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toMatchObject({ kind: 'pending', reason: 'action_refused' });
    expect(actions.calls).toEqual([]);
    expect(lines.some((line) => line.includes('missing human acknowledgement'))).toBe(true);
  });

  it('approve with required + after-deploy codes drives only the required human text', async () => {
    const afterDeployBody =
      '## Definition of Done\n' +
      '- [ ] (mechanical) tests pass @gate:test\n' +
      '- [ ] (human) Owner accepts the change\n' +
      '- [ ] (human, after deploy) Latency dashboard stays green\n';
    const keyHash = 'sha256:' + 'd'.repeat(64);
    const allCodes = humanCodesFor('after-deploy-ok', afterDeployBody);
    expect(allCodes).toHaveLength(2);
    const store = humanAckStorePort({
      aggregateId: 'after-deploy-ok',
      keyHash,
      body: afterDeployBody,
      acknowledgedRiskCodes: allCodes,
    });
    const legacy = fakeLegacy([task('after-deploy-ok', { body: afterDeployBody })]);
    const actions = fakeActions(legacy);
    const driver = createDecisionEffectDriver({
      store,
      actions,
      legacy,
      listAggregateIds: () => ['after-deploy-ok'],
      log: () => undefined,
    });
    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toMatchObject({ kind: 'applied', via: 'drove' });
    expect(actions.calls[0]!.opts).toEqual({
      humanAcknowledged: ['Owner accepts the change'],
    });
  });

  it('refuses approve when required human code is missing even if after-deploy is present', async () => {
    const afterDeployBody =
      '## Definition of Done\n' +
      '- [ ] (mechanical) tests pass @gate:test\n' +
      '- [ ] (human) Owner accepts the change\n' +
      '- [ ] (human, after deploy) Latency dashboard stays green\n';
    const keyHash = 'sha256:' + 'e'.repeat(64);
    const criteria = humanCriteriaFor('after-deploy-miss', afterDeployBody);
    const afterDeployOnly = criteria
      .filter((criterion) => criterion.required === false)
      .map((criterion) => `human:${criterion.id}`);
    expect(afterDeployOnly).toHaveLength(1);
    const store = humanAckStorePort({
      aggregateId: 'after-deploy-miss',
      keyHash,
      body: afterDeployBody,
      acknowledgedRiskCodes: afterDeployOnly,
    });
    const legacy = fakeLegacy([task('after-deploy-miss', { body: afterDeployBody })]);
    const actions = fakeActions(legacy);
    const lines: string[] = [];
    const driver = createDecisionEffectDriver({
      store,
      actions,
      legacy,
      listAggregateIds: () => ['after-deploy-miss'],
      log: (line) => lines.push(line),
    });
    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toMatchObject({ kind: 'pending', reason: 'action_refused' });
    expect(actions.calls).toEqual([]);
    expect(lines.some((line) => line.includes('missing human acknowledgement'))).toBe(true);
  });

  it('refuses approve when a human criterion is appended to the body after the decision', async () => {
    const keyHash = 'sha256:' + 'c'.repeat(64);
    const codes = humanCodesFor('mutated');
    const store = humanAckStorePort({
      aggregateId: 'mutated',
      keyHash,
      body: HUMAN_BODY,
      acknowledgedRiskCodes: codes,
    });
    const mutatedBody =
      HUMAN_BODY + '- [ ] (human) Extra criterion added after decision\n';
    const legacy = fakeLegacy([task('mutated', { body: mutatedBody })]);
    const actions = fakeActions(legacy);
    const lines: string[] = [];
    const driver = createDecisionEffectDriver({
      store,
      actions,
      legacy,
      listAggregateIds: () => ['mutated'],
      log: (line) => lines.push(line),
    });
    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toMatchObject({ kind: 'pending', reason: 'action_refused' });
    expect(actions.calls).toEqual([]);
    expect(lines.some((line) => line.includes('do not equal'))).toBe(true);
  });

  it('(b) reject_outcome drives reject', async () => {
    const store = openStore();
    const { keyHash } = commitDecision(
      store,
      'beta',
      'req-reject',
      decisionPayload({ action: 'reject_outcome', reason: 'Needs work' }),
    );
    const legacy = fakeLegacy([task('beta')]);
    const actions = fakeActions(legacy);
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => store.listTaskIds(),
      log: () => {},
    });
    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toMatchObject({ kind: 'applied', via: 'drove', action: 'reject_outcome' });
    expect(actions.calls).toEqual([{ op: 'reject', id: 'beta' }]);
    expect(store.readPendingEffect(keyHash)?.effectState).toBe('applied');
    store.close();
  });

  it('(c) request_changes drives steer with a reason-derived comment ≤ 4000', async () => {
    const store = openStore();
    // controlEvent MAX_TEXT is 512; use the max valid reason and assert the
    // driver still caps the composed steer comment at 4000.
    const longReason = 'R'.repeat(512);
    const { keyHash } = commitDecision(
      store,
      'gamma',
      'req-steer',
      decisionPayload({ action: 'request_changes', reason: longReason }),
    );
    const legacy = fakeLegacy([task('gamma')]);
    const actions = fakeActions(legacy);
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => store.listTaskIds(),
      log: () => {},
    });
    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toMatchObject({ kind: 'applied', via: 'drove', action: 'request_changes' });
    expect(actions.calls).toHaveLength(1);
    expect(actions.calls[0]!.op).toBe('steer');
    const comment = actions.calls[0]!.comment as string;
    expect(comment.startsWith('Control API V2 request_changes (hercules-web/actor-1,')).toBe(true);
    expect(comment.length).toBeLessThanOrEqual(4000);
    expect(comment).toContain(FIXED_CLOCK);
    expect(comment).toContain(longReason);
    store.close();
  });

  it('(d) action throw → pending action_refused; redriveAll succeeds when throw stops', async () => {
    const store = openStore();
    const { keyHash } = commitDecision(store, 'delta', 'req-refuse');
    const legacy = fakeLegacy([task('delta')]);
    const actions = fakeActions(legacy);
    actions.throwOn.add('approve');
    const lines: string[] = [];
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => store.listTaskIds(),
      log: (line) => lines.push(line),
    });

    const first = await driver.driveCommitted(keyHash);
    expect(first).toMatchObject({
      kind: 'pending',
      reason: 'action_refused',
      action: 'approve_outcome',
    });
    expect(store.readPendingEffect(keyHash)?.effectState).toBe('pending');
    expect(lines.some((line) => line.includes('refused:'))).toBe(true);

    actions.throwOn.delete('approve');
    const second = await driver.redriveAll();
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ kind: 'applied', via: 'drove' });
    expect(store.readPendingEffect(keyHash)?.effectState).toBe('applied');
    store.close();
  });

  it('(e) legacy already in expected state → applied/already_moved without calling action', async () => {
    const store = openStore();
    const { keyHash } = commitDecision(store, 'epsilon', 'req-moved');
    const legacy = fakeLegacy([task('epsilon', { state: 'done' })]);
    const actions = fakeActions(legacy);
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => store.listTaskIds(),
      log: () => {},
    });
    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toEqual({
      kind: 'applied',
      keyHash,
      aggregateId: 'epsilon',
      action: 'approve_outcome',
      via: 'already_moved',
    });
    expect(actions.calls).toEqual([]);
    expect(store.readPendingEffect(keyHash)?.effectState).toBe('applied');
    store.close();
  });

  it('(f) unexpected legacy state → pending legacy_state_unexpected; action not called', async () => {
    const store = openStore();
    const { keyHash } = commitDecision(store, 'zeta', 'req-unexpected');
    const legacy = fakeLegacy([task('zeta', { state: 'in_progress' })]);
    const actions = fakeActions(legacy);
    const lines: string[] = [];
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => store.listTaskIds(),
      log: (line) => lines.push(line),
    });
    const outcome = await driver.driveCommitted(keyHash);
    expect(outcome).toMatchObject({
      kind: 'pending',
      reason: 'legacy_state_unexpected',
    });
    expect(actions.calls).toEqual([]);
    expect(store.readPendingEffect(keyHash)?.effectState).toBe('pending');
    expect(lines.some((line) => line.includes('expected review or done'))).toBe(true);
    expect(DECISION_EFFECT_EXPECTED_STATE.approve_outcome).toBe('done');
    store.close();
  });

  it('(g) V2 replay does not create a second marker; drive after apply is skipped/not_pending', async () => {
    const store = openStore();
    const { keyHash, request } = commitDecision(store, 'eta', 'req-replay');
    const replay = store.commitV2(request, admitVerdict(request));
    expect(replay.outcome).toBe('committed');
    expect(store.listPendingEffects()).toHaveLength(1);

    const legacy = fakeLegacy([task('eta')]);
    const actions = fakeActions(legacy);
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => store.listTaskIds(),
      log: () => {},
    });
    expect(await driver.driveCommitted(keyHash)).toMatchObject({ kind: 'applied', via: 'drove' });
    expect(await driver.driveCommitted(keyHash)).toEqual({
      kind: 'skipped',
      keyHash,
      reason: 'not_pending',
    });
    store.close();
  });

  it('detectDivergence skips purged tasks (v2=deleted, legacy missing)', async () => {
    const store = openStore();
    materialize(store, 'purged');
    // Force the aggregate status to deleted via a fresh delivery that retires it.
    deliverySeq += 1;
    const deliveryId = `delivery-purged-deleted-${deliverySeq}`;
    store.beginEnvelope({
      deliveryId,
      authorityRevision: 'b'.repeat(40),
      authorityInput: { writes: [], retiredTaskIds: ['purged'] },
      manifest: [],
      gapCodes: [],
    });
    store.completeEnvelope(deliveryId);
    const row = store.readV2Aggregate('purged');
    expect(row?.taskStatus).toBe('deleted');

    const legacy = fakeLegacy([]);
    const actions = fakeActions(legacy);
    const nowMs = Date.parse(FIXED_CLOCK) + 60_000;
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => ['purged'],
      log: () => {},
      graceMs: 1_000,
      now: () => nowMs,
    });
    expect(await driver.detectDivergence()).toEqual([]);
    store.close();
  });

  it('(h) detectDivergence reports mismatch only without pending marker and past grace', async () => {
    const store = openStore();
    materialize(store, 'theta');
    // No decision — V2 is review; legacy is done → mismatch, no pending marker.
    const legacy = fakeLegacy([task('theta', { state: 'done' })]);
    const actions = fakeActions(legacy);
    let nowMs = Date.parse(FIXED_CLOCK);
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => ['theta'],
      log: () => {},
      graceMs: 1_000,
      now: () => nowMs,
    });

    // Within grace → empty.
    expect(await driver.detectDivergence()).toEqual([]);

    // Past grace → reported.
    nowMs = Date.parse(FIXED_CLOCK) + 5_000;
    expect(await driver.detectDivergence()).toEqual([{
      aggregateId: 'theta',
      v2Status: 'review',
      legacyState: 'done',
      pendingMarker: false,
    }]);

    // With a pending marker for the same aggregate → not reported (marker's job).
    const { keyHash } = commitDecision(store, 'iota', 'req-div-marker');
    expect(store.readPendingEffect(keyHash)?.effectState).toBe('pending');
    legacy.tasks.push(task('iota', { state: 'done' })); // mismatch vs v2 review, but pending
    const driverWithIota = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => ['theta', 'iota'],
      log: () => {},
      graceMs: 1_000,
      now: () => nowMs,
    });
    nowMs = Date.parse(FIXED_CLOCK) + 60_000;
    const withMarker = await driverWithIota.detectDivergence();
    expect(withMarker.map((entry) => entry.aggregateId)).toEqual(['theta']);
    expect(withMarker.every((entry) => entry.aggregateId !== 'iota')).toBe(true);
    store.close();
  });

  it('(i) shadow-delivery recompute leaves a pending marker untouched', async () => {
    const store = openStore();
    const { keyHash } = commitDecision(store, 'kappa', 'req-shadow');
    const before = store.readPendingEffect(keyHash);
    expect(before?.effectState).toBe('pending');

    materialize(store, 'kappa', 'review');
    expect(store.readPendingEffect(keyHash)).toEqual(before);
    expect(store.listPendingEffects().map((row) => row.keyHash)).toContain(keyHash);
    store.close();
  });

  it('reports legacy_task_missing when the legacy task is absent', async () => {
    const store = openStore();
    const { keyHash } = commitDecision(store, 'missing', 'req-missing');
    const legacy = fakeLegacy([]);
    const actions = fakeActions(legacy);
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => store.listTaskIds(),
      log: () => {},
    });
    expect(await driver.driveCommitted(keyHash)).toMatchObject({
      kind: 'pending',
      reason: 'legacy_task_missing',
    });
    expect(actions.calls).toEqual([]);
    store.close();
  });

  it('serializes concurrent driveCommitted calls for the same keyHash', async () => {
    const store = openStore();
    const { keyHash } = commitDecision(store, 'serial', 'req-serial');
    const legacy = fakeLegacy([task('serial')]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let approveCount = 0;
    const actions: DecisionEffectActionPort = {
      async approve(id) {
        approveCount += 1;
        await gate;
        legacy.setState(id, 'done');
        return undefined;
      },
      async reject() {
        throw new Error('unused');
      },
      async steer() {
        throw new Error('unused');
      },
    };
    const driver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(store),
      actions,
      legacy,
      listAggregateIds: () => store.listTaskIds(),
      log: () => {},
    });
    const first = driver.driveCommitted(keyHash);
    const second = driver.driveCommitted(keyHash);
    await Promise.resolve();
    expect(approveCount).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: 'applied', via: 'drove' });
    expect(approveCount).toBe(1);
    store.close();
  });
});

describe('decision effect expected-state map', () => {
  it('pins the three decision actions to their legacy targets', () => {
    expect(DECISION_EFFECT_EXPECTED_STATE).toEqual({
      approve_outcome: 'done',
      reject_outcome: 'todo',
      request_changes: 'todo',
    });
  });
});
