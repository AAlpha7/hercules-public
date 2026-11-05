/**
 * Autonomy quality observability — reporting-only baselines + anomaly receipts.
 * Covers docs/autonomy/autonomy-observability.md rollout step 1–2.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_OBS_SCHEMA_VERSION,
  AUTONOMY_OBS_METRIC_KINDS,
  AUTONOMY_OBS_FAILURE_CLASSES,
  AUTONOMY_OBS_FORBIDDEN_ACTIONS,
  AUTONOMY_OBS_GAMING_SIGNALS,
  AutonomyObservabilityValidationError,
  emptyAutonomyObservabilityStore,
  makeAutonomySampleId,
  makeAnomalyReceiptId,
  makeCohortKey,
  classifyAutonomyFailure,
  resolveTaskClass,
  normalizeMetricSample,
  validateMetricSample,
  validateAnomalyReceipt,
  appendMetricSample,
  appendAnomalyReceipt,
  buildCohortBaseline,
  buildAnomalyReceipt,
  metricPresence,
  isUnknownNotGreen,
  autonomyObsMayMutateRuntime,
  autonomyObsAuthorizes,
  autonomyObsMode,
  scoreVerifiedDelivery,
  detectGamingSignals,
  serializeAutonomyObservabilityStore,
  parseAutonomyObservabilityStore,
  autonomyObsDigest,
  autonomyObsCanonical,
  type AutonomyMetricSample,
  type AutonomyAnomalyReceipt,
  type AutonomyMetricObservation,
} from '../../src/domain/autonomyObservability.js';

const NOW = Date.UTC(2026, 7, 7, 14);

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function observed(
  value: number,
  over: Partial<AutonomyMetricObservation> = {},
): AutonomyMetricObservation {
  return { presence: 'observed', value, ...over };
}

function unknownObs(
  over: Partial<AutonomyMetricObservation> = {},
): AutonomyMetricObservation {
  return { presence: 'unknown', value: null, ...over };
}

function baseSample(over: Partial<AutonomyMetricSample> = {}): AutonomyMetricSample {
  const taskClass = over.taskClass ?? 'implement:general';
  const repoKey = over.repoKey ?? 'hercules';
  const metricKind = over.metricKind ?? 'completion';
  const cohortKey =
    over.cohortKey ??
    makeCohortKey({ repoKey, taskClass, metricKind });
  const observation = over.observation ?? observed(1);
  const taskId = over.taskId ?? 'task-obs-1';
  const durableRunId = over.durableRunId ?? 'run-obs-aaaa-bbbb';
  const id =
    over.id ??
    makeAutonomySampleId({
      taskId,
      durableRunId,
      metricKind,
      observedAtMs: over.observedAtMs ?? NOW,
    });
  return {
    id,
    kind: 'metric_sample',
    taskId,
    durableRunId,
    repoKey,
    taskClass,
    cohortKey,
    metricKind,
    observation,
    failureClass: over.failureClass ?? 'unknown',
    observedAtMs: over.observedAtMs ?? NOW,
    evidenceDigests: over.evidenceDigests ?? [digest('gate-l1-ok')],
    gamingSignals: over.gamingSignals ?? [],
    summary: over.summary ?? 'normalized completion sample',
  };
}

describe('autonomyObservability vocabulary', () => {
  it('covers completion, verification, rework, conflicts, retries, cost, human burden', () => {
    expect([...AUTONOMY_OBS_METRIC_KINDS]).toEqual([
      'completion',
      'verification_quality',
      'rework',
      'conflicts',
      'retries',
      'cost',
      'human_burden',
    ]);
  });

  it('distinguishes product, agent, and infrastructure failures', () => {
    expect([...AUTONOMY_OBS_FAILURE_CLASSES]).toEqual([
      'product',
      'agent',
      'infrastructure',
      'unknown',
    ]);
    expect(classifyAutonomyFailure({ kind: 'verify_l1' })).toBe('product');
    expect(classifyAutonomyFailure({ kind: 'verify_l2' })).toBe('product');
    expect(classifyAutonomyFailure({ kind: 'agent_exit' })).toBe('agent');
    expect(classifyAutonomyFailure({ kind: 'stall' })).toBe('agent');
    expect(classifyAutonomyFailure({ kind: 'provision' })).toBe('infrastructure');
    expect(classifyAutonomyFailure({ kind: 'verify_infra' })).toBe('infrastructure');
    expect(classifyAutonomyFailure({ kind: 'mystery' })).toBe('unknown');
    expect(classifyAutonomyFailure({})).toBe('unknown');
  });

  it('reserves runtime mutation and anti-gaming actions reports never authorize', () => {
    expect([...AUTONOMY_OBS_FORBIDDEN_ACTIONS]).toEqual(
      expect.arrayContaining([
        'alter_scheduling',
        'alter_routing',
        'alter_context',
        'alter_concurrency',
        'alter_policy',
        'weaken_gates',
        'skip_tests',
        'broaden_permissions',
        'slice_tasks_unnecessarily',
      ]),
    );
    expect([...AUTONOMY_OBS_GAMING_SIGNALS]).toEqual(
      expect.arrayContaining([
        'weakened_gates',
        'skipped_tests',
        'broader_permissions',
        'unnecessary_task_slicing',
      ]),
    );
  });

  it('is reporting-only by contract', () => {
    expect(autonomyObsMode()).toBe('reporting_only');
  });
});

describe('task class / cohort normalization', () => {
  it('resolves task class from execution class + feature kind', () => {
    expect(resolveTaskClass({ executionClass: 'implement', featureKind: 'settings' })).toBe(
      'implement:settings',
    );
    expect(resolveTaskClass({ featureKind: 'bug' })).toBe('implement:bug');
    expect(resolveTaskClass({})).toBe('implement:general');
  });

  it('builds stable cohort keys per repo + task class + metric', () => {
    const a = makeCohortKey({
      repoKey: 'hercules',
      taskClass: 'implement:settings',
      metricKind: 'rework',
    });
    const b = makeCohortKey({
      repoKey: 'hercules',
      taskClass: 'implement:settings',
      metricKind: 'rework',
    });
    const c = makeCohortKey({
      repoKey: 'bookshelf',
      taskClass: 'implement:settings',
      metricKind: 'rework',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^cohort-/);
  });

  it('normalizes metrics into cohort-scoped samples', () => {
    const sample = normalizeMetricSample({
      taskId: 'task-norm-1',
      durableRunId: 'run-norm-1',
      repoKey: 'hercules',
      executionClass: 'verify',
      featureKind: 'form',
      metricKind: 'retries',
      observation: observed(2),
      failureClass: 'agent',
      observedAtMs: NOW,
      evidenceDigests: [digest('retry-receipt')],
      summary: 'two soft retries before green',
    });
    expect(sample.ok).toBe(true);
    if (!sample.ok) return;
    expect(sample.sample.taskClass).toBe('verify:form');
    expect(sample.sample.cohortKey).toBe(
      makeCohortKey({
        repoKey: 'hercules',
        taskClass: 'verify:form',
        metricKind: 'retries',
      }),
    );
    expect(sample.sample.failureClass).toBe('agent');
    expect(sample.sample.metricKind).toBe('retries');
  });
});

describe('missing evidence is unknown, never zero/green', () => {
  it('marks absent observations as unknown with null value', () => {
    const sample = baseSample({
      metricKind: 'verification_quality',
      observation: unknownObs(),
      evidenceDigests: [],
      summary: 'verification evidence not yet available',
    });
    const result = validateMetricSample(sample);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sample.observation.presence).toBe('unknown');
    expect(result.sample.observation.value).toBeNull();
    expect(metricPresence(result.sample)).toBe('unknown');
    expect(isUnknownNotGreen(result.sample)).toBe(true);
  });

  it('rejects inventing zero/green for unknown evidence', () => {
    const forged = validateMetricSample(
      baseSample({
        observation: { presence: 'unknown', value: 0 },
        summary: 'forged zero for missing evidence',
      }),
    );
    expect(forged.ok).toBe(false);

    const greenUnknown = validateMetricSample(
      baseSample({
        metricKind: 'verification_quality',
        observation: { presence: 'unknown', value: 1 },
        summary: 'forged green without evidence',
      }),
    );
    expect(greenUnknown.ok).toBe(false);
  });

  it('verified-delivery score stays unknown when evidence is missing', () => {
    const score = scoreVerifiedDelivery({
      completion: unknownObs(),
      verificationQuality: unknownObs(),
      rework: unknownObs(),
      gamingSignals: [],
    });
    expect(score.presence).toBe('unknown');
    expect(score.value).toBeNull();
    expect(score.green).toBe(false);
  });
});

describe('anomaly receipts', () => {
  it('requires evidence, likely cause, confidence, and safe next action', () => {
    const built = buildAnomalyReceipt({
      taskId: 'task-anom-1',
      durableRunId: 'run-anom-1',
      repoKey: 'hercules',
      taskClass: 'implement:settings',
      metricKind: 'rework',
      observedRegression: 'rework rate 0.6 vs cohort median 0.15',
      evidenceDigests: [digest('packet-rework-1'), digest('gate-l2-fail')],
      likelyCause: 'L2 evidence plan missed required settings hooks',
      confidence: 0.72,
      safeNextAction: 'Inspect L2 evidence plan; do not auto-relax gates',
      failureClass: 'product',
      observedAtMs: NOW,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const r = built.receipt;
    expect(r.kind).toBe('anomaly_receipt');
    expect(r.observedRegression).toMatch(/rework rate/);
    expect(r.evidenceDigests.length).toBeGreaterThan(0);
    expect(r.likelyCause.length).toBeGreaterThan(0);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(r.safeNextAction).toMatch(/not auto-relax/);
    expect(r.failureClass).toBe('product');
    expect(validateAnomalyReceipt(r).ok).toBe(true);
  });

  it('rejects receipts that embed raw logs or secret-bearing fields', () => {
    const built = buildAnomalyReceipt({
      taskId: 'task-anom-2',
      durableRunId: 'run-anom-2',
      repoKey: 'hercules',
      taskClass: 'implement:general',
      metricKind: 'cost',
      observedRegression: 'cost spike',
      evidenceDigests: [digest('cost')],
      likelyCause: 'Authorization: Bearer sk-secret-token-value in stream',
      confidence: 0.5,
      safeNextAction: 'Review cost caps; keep reporting only',
      failureClass: 'infrastructure',
      observedAtMs: NOW,
    });
    // Builder only projects known keys — rawLog/token never enter the receipt.
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.receipt).not.toHaveProperty('rawLog');
    expect(built.receipt).not.toHaveProperty('token');
    expect(built.receipt.likelyCause).not.toMatch(/sk-secret/);
    expect(JSON.stringify(built.receipt)).not.toMatch(/xai-secret/);
    expect(JSON.stringify(built.receipt)).not.toMatch(/SECRET=1/);

    const dirty = validateAnomalyReceipt({
      ...built.receipt,
      token: 'xai-secret',
      rawLog: 'huge stdout SECRET=1',
    });
    expect(dirty.ok).toBe(false);
  });

  it('rejects incomplete anomaly receipts', () => {
    const missingEvidence = validateAnomalyReceipt({
      id: makeAnomalyReceiptId({
        taskId: 't1',
        durableRunId: 'r1',
        metricKind: 'conflicts',
        observedAtMs: NOW,
      }),
      kind: 'anomaly_receipt',
      taskId: 't1',
      durableRunId: 'r1',
      repoKey: 'hercules',
      taskClass: 'implement:general',
      cohortKey: makeCohortKey({
        repoKey: 'hercules',
        taskClass: 'implement:general',
        metricKind: 'conflicts',
      }),
      metricKind: 'conflicts',
      observedRegression: 'conflict rate up',
      evidenceDigests: [],
      likelyCause: 'path lease contention',
      confidence: 0.4,
      safeNextAction: 'Inspect path leases; no auto-routing change',
      failureClass: 'infrastructure',
      observedAtMs: NOW,
      gamingSignals: [],
    });
    expect(missingEvidence.ok).toBe(false);
  });
});

describe('idempotent restart/replay', () => {
  it('append is restart/replay safe for the same sample id', () => {
    const sample = baseSample();
    const first = appendMetricSample(emptyAutonomyObservabilityStore(), sample);
    expect(first.applied).toBe(true);
    expect(first.store.samples).toHaveLength(1);

    const replay = appendMetricSample(first.store, sample);
    expect(replay.applied).toBe(false);
    expect(replay.conflict).toBe(false);
    expect(replay.doubleCountPrevented).toBe(true);
    expect(replay.store.samples).toHaveLength(1);
  });

  it('anomaly receipt append is idempotent and conflicts on body drift', () => {
    const built = buildAnomalyReceipt({
      taskId: 'task-idem-1',
      durableRunId: 'run-idem-1',
      repoKey: 'hercules',
      taskClass: 'implement:bug',
      metricKind: 'human_burden',
      observedRegression: 'interventions 3 vs cohort 0',
      evidenceDigests: [digest('intervention-1')],
      likelyCause: 'unjustified escalation on mechanical criterion',
      confidence: 0.66,
      safeNextAction: 'Keep human review; do not auto-change policy',
      failureClass: 'agent',
      observedAtMs: NOW,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    let store = emptyAutonomyObservabilityStore();
    store = appendAnomalyReceipt(store, built.receipt).store;
    const replay = appendAnomalyReceipt(store, built.receipt);
    expect(replay.applied).toBe(false);
    expect(replay.doubleCountPrevented).toBe(true);
    expect(replay.store.receipts).toHaveLength(1);

    const drifted: AutonomyAnomalyReceipt = {
      ...built.receipt,
      likelyCause: 'different cause packaging',
    };
    const clash = appendAnomalyReceipt(store, drifted);
    expect(clash.applied).toBe(false);
    expect(clash.conflict).toBe(true);
    expect(clash.store.receipts[0]?.likelyCause).toBe(built.receipt.likelyCause);
  });

  it('serialize/parse round-trip does not invent green metrics', () => {
    const unknownSample = baseSample({
      metricKind: 'cost',
      observation: unknownObs(),
      evidenceDigests: [],
      summary: 'cost evidence unavailable after restart',
    });
    const store = appendMetricSample(emptyAutonomyObservabilityStore(), unknownSample).store;
    const json = serializeAutonomyObservabilityStore(store);
    const parsed = parseAutonomyObservabilityStore(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.store.samples).toHaveLength(1);
    expect(parsed.store.samples[0]?.observation.presence).toBe('unknown');
    expect(parsed.store.samples[0]?.observation.value).toBeNull();
    expect(isUnknownNotGreen(parsed.store.samples[0]!)).toBe(true);
    expect(autonomyObsDigest(parsed.store)).toBe(autonomyObsDigest(store));
    expect(autonomyObsCanonical(parsed.store)).toBe(autonomyObsCanonical(store));
    expect(AUTONOMY_OBS_SCHEMA_VERSION).toBe(1);
  });

  it('returns typed schema errors on corrupt documents', () => {
    const bad = parseAutonomyObservabilityStore('{bad');
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors[0]?.code).toBe('schema');
    expect(() => {
      throw new AutonomyObservabilityValidationError(
        bad.errors[0]?.message ?? 'bad',
        bad.errors,
      );
    }).toThrow(AutonomyObservabilityValidationError);
  });
});

describe('reporting-only authority boundary', () => {
  it('cannot alter scheduling, routing, context, concurrency, or policy', () => {
    const store = appendMetricSample(emptyAutonomyObservabilityStore(), baseSample()).store;
    expect(autonomyObsMayMutateRuntime(store)).toBe(false);
    for (const action of AUTONOMY_OBS_FORBIDDEN_ACTIONS) {
      expect(autonomyObsAuthorizes(store, action)).toBe(false);
    }
    expect(autonomyObsAuthorizes(store, 'alter_scheduling')).toBe(false);
    expect(autonomyObsAuthorizes(store, 'alter_routing')).toBe(false);
    expect(autonomyObsAuthorizes(store, 'alter_context')).toBe(false);
    expect(autonomyObsAuthorizes(store, 'alter_concurrency')).toBe(false);
    expect(autonomyObsAuthorizes(store, 'alter_policy')).toBe(false);
  });
});

describe('metrics do not reward gate weakening or related gaming', () => {
  it('detects weakened gates, skipped tests, broader permissions, unnecessary slicing', () => {
    const signals = detectGamingSignals({
      gatesWeakened: true,
      testsSkipped: true,
      permissionsBroadened: true,
      unnecessaryTaskSlicing: true,
    });
    expect(signals).toEqual(
      expect.arrayContaining([
        'weakened_gates',
        'skipped_tests',
        'broader_permissions',
        'unnecessary_task_slicing',
      ]),
    );
  });

  it('verified-delivery score does not improve under gaming signals', () => {
    const clean = scoreVerifiedDelivery({
      completion: observed(1),
      verificationQuality: observed(1),
      rework: observed(0),
      gamingSignals: [],
    });
    expect(clean.presence).toBe('observed');
    expect(clean.green).toBe(true);
    expect(clean.value).toBeGreaterThan(0);

    const gamed = scoreVerifiedDelivery({
      completion: observed(1),
      verificationQuality: observed(1),
      rework: observed(0),
      gamingSignals: ['weakened_gates', 'skipped_tests'],
    });
    expect(gamed.presence).toBe('observed');
    expect(gamed.green).toBe(false);
    expect(gamed.value).toBeLessThan(clean.value!);
    expect(gamed.penalized).toBe(true);

    const sliced = scoreVerifiedDelivery({
      completion: observed(1),
      verificationQuality: observed(0.9),
      rework: observed(0),
      gamingSignals: ['unnecessary_task_slicing', 'broader_permissions'],
    });
    expect(sliced.green).toBe(false);
    expect(sliced.penalized).toBe(true);
    expect(sliced.value).toBeLessThan(clean.value!);
  });

  it('rejects metric samples that claim green while carrying gaming signals', () => {
    const bad = validateMetricSample(
      baseSample({
        metricKind: 'verification_quality',
        observation: observed(1),
        gamingSignals: ['skipped_tests'],
        summary: 'claimed green with skipped tests',
      }),
    );
    expect(bad.ok).toBe(false);
  });
});

describe('cohort baselines', () => {
  it('aggregates only observed samples and reports unknown counts separately', () => {
    const taskClass = 'implement:settings';
    const metricKind = 'rework' as const;
    const cohortKey = makeCohortKey({ repoKey: 'hercules', taskClass, metricKind });

    let store = emptyAutonomyObservabilityStore();
    const values = [0.1, 0.2, 0.15, 0.4];
    for (let i = 0; i < values.length; i += 1) {
      const sample = baseSample({
        id: makeAutonomySampleId({
          taskId: `task-base-${i}`,
          durableRunId: `run-base-${i}`,
          metricKind,
          observedAtMs: NOW + i,
        }),
        taskId: `task-base-${i}`,
        durableRunId: `run-base-${i}`,
        taskClass,
        metricKind,
        cohortKey,
        observation: observed(values[i]!),
        observedAtMs: NOW + i,
        summary: `rework sample ${i}`,
      });
      store = appendMetricSample(store, sample).store;
    }
    const unknown = baseSample({
      id: makeAutonomySampleId({
        taskId: 'task-base-unknown',
        durableRunId: 'run-base-unknown',
        metricKind,
        observedAtMs: NOW + 99,
      }),
      taskId: 'task-base-unknown',
      durableRunId: 'run-base-unknown',
      taskClass,
      metricKind,
      cohortKey,
      observation: unknownObs(),
      evidenceDigests: [],
      observedAtMs: NOW + 99,
      summary: 'missing rework evidence',
    });
    store = appendMetricSample(store, unknown).store;

    const baseline = buildCohortBaseline(store, {
      repoKey: 'hercules',
      taskClass,
      metricKind,
    });
    expect(baseline.cohortKey).toBe(cohortKey);
    expect(baseline.observedCount).toBe(4);
    expect(baseline.unknownCount).toBe(1);
    expect(baseline.median).not.toBeNull();
    expect(baseline.median).toBeCloseTo(0.175, 5);
    // Unknown never counted as zero in the central tendency.
    expect(baseline.mean).toBeCloseTo((0.1 + 0.2 + 0.15 + 0.4) / 4, 5);
  });
});
