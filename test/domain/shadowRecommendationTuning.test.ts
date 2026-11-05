/**
 * Shadow recommendation comparison + bounded reversible tuning policy.
 * Covers docs/autonomy/autonomy-observability.md rollout steps 3–4.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SHADOW_REC_SCHEMA_VERSION,
  SHADOW_REC_MODE,
  SHADOW_REC_KINDS,
  SHADOW_COMPARISON_METRICS,
  SHADOW_REC_FORBIDDEN_TARGETS,
  SHADOW_REC_FORBIDDEN_ACTIONS,
  MIN_REPEATED_MEASURED_BENEFIT,
  makeShadowRecommendationId,
  makeShadowComparisonId,
  makeBoundedTuningId,
  classifyRecommendationRisk,
  isForbiddenTuningTarget,
  validateShadowRecommendation,
  buildShadowRecommendation,
  compareShadowAgainstCohort,
  evaluateRepeatedMeasuredBenefit,
  disposeShadowRecommendation,
  validateBoundedTuningSpec,
  buildBoundedTuningSpec,
  tryBuildBoundedTuningFromDisposition,
  buildHighRiskHumanTaskProposal,
  shadowRecMode,
  shadowRecLiveTuningEnabled,
  shadowRecMayMutateRuntime,
  shadowRecAuthorizes,
  shadowRecMayMutateCoreSafety,
  shadowRecMayEnableLiveTuning,
  serializeShadowRecommendationStore,
  parseShadowRecommendationStore,
  emptyShadowRecommendationStore,
  appendShadowComparison,
  type ShadowRecommendation,
  type ShadowCohortMetrics,
  type ShadowComparisonResult,
} from '../../src/domain/shadowRecommendationTuning.js';
import { makeCohortKey } from '../../src/domain/autonomyObservability.js';

const NOW = Date.UTC(2026, 7, 8, 16);

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function metrics(over: Partial<ShadowCohortMetrics> = {}): ShadowCohortMetrics {
  return {
    success: over.success ?? 0.8,
    guardrails: over.guardrails ?? 0.95,
    rework: over.rework ?? 0.2,
    cost: over.cost ?? 1.0,
    humanBurden: over.humanBurden ?? 0.15,
    sampleCount: over.sampleCount ?? 12,
    unknownCount: over.unknownCount ?? 0,
  };
}

function baseRec(over: Partial<ShadowRecommendation> = {}): ShadowRecommendation {
  const kind = over.recommendationKind ?? 'routing';
  const repoKey = over.repoKey ?? 'hercules';
  const taskClass = over.taskClass ?? 'implement:general';
  const cohortKey =
    over.cohortKey ??
    makeCohortKey({ repoKey, taskClass, metricKind: 'completion' });
  const id =
    over.id ??
    makeShadowRecommendationId({
      kind,
      repoKey,
      taskClass,
      targetKey: over.targetKey ?? 'adapter_preference_grok',
      observedAtMs: over.observedAtMs ?? NOW,
    });
  return {
    id,
    kind: 'shadow_recommendation',
    version: SHADOW_REC_SCHEMA_VERSION,
    mode: SHADOW_REC_MODE,
    recommendationKind: kind,
    riskClass: over.riskClass ?? 'low',
    repoKey,
    taskClass,
    cohortKey,
    targetKey: over.targetKey ?? 'adapter_preference_grok',
    summary: over.summary ?? 'Prefer grok for implement:general when latency is low',
    evidenceDigests: over.evidenceDigests ?? [digest('shadow-rec-1')],
    observedAtMs: over.observedAtMs ?? NOW,
    liveTuningEnabled: false,
    mutatesRuntime: false,
  };
}

describe('shadow recommendation vocabulary', () => {
  it('covers decomposition, routing, and context recommendation kinds', () => {
    expect([...SHADOW_REC_KINDS]).toEqual(['decomposition', 'routing', 'context']);
  });

  it('compares success, guardrails, rework, cost, and human burden', () => {
    expect([...SHADOW_COMPARISON_METRICS]).toEqual([
      'success',
      'guardrails',
      'rework',
      'cost',
      'human_burden',
    ]);
  });

  it('is shadow-only with live tuning disabled by contract', () => {
    expect(shadowRecMode()).toBe('shadow');
    expect(SHADOW_REC_MODE).toBe('shadow');
    expect(shadowRecLiveTuningEnabled()).toBe(false);
    expect(shadowRecMayMutateRuntime()).toBe(false);
    expect(shadowRecMayEnableLiveTuning()).toBe(false);
  });

  it('never authorizes core safety / merge / deploy / production mutation', () => {
    expect([...SHADOW_REC_FORBIDDEN_ACTIONS]).toEqual(
      expect.arrayContaining([
        'alter_core_safety',
        'alter_evidence_policy',
        'alter_merge_policy',
        'alter_deploy_policy',
        'alter_production_boundary',
        'alter_permissions',
        'alter_security_policy',
        'enable_live_tuning',
        'weaken_gates',
      ]),
    );
    for (const action of SHADOW_REC_FORBIDDEN_ACTIONS) {
      expect(shadowRecAuthorizes(action)).toBe(false);
    }
    expect(shadowRecMayMutateCoreSafety()).toBe(false);
  });
});

describe('risk classification', () => {
  it('classifies retrieval ranking / context budget / concurrency / routing as low-risk', () => {
    expect(classifyRecommendationRisk({ targetKey: 'retrieval_ranking_boost' })).toBe('low');
    expect(classifyRecommendationRisk({ targetKey: 'context_budget_tokens' })).toBe('low');
    expect(classifyRecommendationRisk({ targetKey: 'concurrency_soft_cap' })).toBe('low');
    expect(classifyRecommendationRisk({ targetKey: 'agent_routing_preference' })).toBe('low');
  });

  it('classifies graph shape / adapter default changes as medium-risk proposals', () => {
    expect(classifyRecommendationRisk({ targetKey: 'decomposition_graph_shape' })).toBe('medium');
    expect(classifyRecommendationRisk({ targetKey: 'default_adapter_switch' })).toBe('medium');
    expect(classifyRecommendationRisk({ targetKey: 'pipeline_stage_rewrite' })).toBe('medium');
  });

  it('classifies security / permission / safety / merge / deploy targets as high-risk', () => {
    expect(classifyRecommendationRisk({ targetKey: 'permission_policy_relax' })).toBe('high');
    expect(classifyRecommendationRisk({ targetKey: 'security_policy_change' })).toBe('high');
    expect(classifyRecommendationRisk({ targetKey: 'merge_auto_approve' })).toBe('high');
    expect(classifyRecommendationRisk({ targetKey: 'deploy_production_auto' })).toBe('high');
    expect(classifyRecommendationRisk({ targetKey: 'evidence_gate_skip' })).toBe('high');
    expect(classifyRecommendationRisk({ targetKey: 'core_safety_override' })).toBe('high');
  });

  it('forbids protected tuning targets', () => {
    expect([...SHADOW_REC_FORBIDDEN_TARGETS]).toEqual(
      expect.arrayContaining([
        'core_safety',
        'evidence_policy',
        'merge_policy',
        'deploy_policy',
        'production_boundary',
        'permission_policy',
        'security_policy',
        'gate_policy',
      ]),
    );
    expect(isForbiddenTuningTarget('merge_policy')).toBe(true);
    expect(isForbiddenTuningTarget('agent_routing_preference')).toBe(false);
  });
});

describe('shadow recommendation validation', () => {
  it('builds validated shadow recommendations with live tuning forced off', () => {
    const built = buildShadowRecommendation({
      recommendationKind: 'context',
      repoKey: 'hercules',
      taskClass: 'implement:settings',
      targetKey: 'context_budget_tokens',
      summary: 'Slightly raise context budget for settings tasks',
      evidenceDigests: [digest('ctx-rec')],
      observedAtMs: NOW,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.recommendation.mode).toBe('shadow');
    expect(built.recommendation.liveTuningEnabled).toBe(false);
    expect(built.recommendation.mutatesRuntime).toBe(false);
    expect(built.recommendation.riskClass).toBe('low');
    expect(built.recommendation.recommendationKind).toBe('context');
  });

  it('rejects recommendations that claim live tuning or runtime mutation', () => {
    const live = validateShadowRecommendation({
      ...baseRec(),
      liveTuningEnabled: true,
    });
    expect(live.ok).toBe(false);

    const mut = validateShadowRecommendation({
      ...baseRec(),
      mutatesRuntime: true,
    });
    expect(mut.ok).toBe(false);
  });

  it('rejects recommendations without evidence digests', () => {
    const noEv = validateShadowRecommendation({
      ...baseRec(),
      evidenceDigests: [],
    });
    expect(noEv.ok).toBe(false);
  });

  it('rejects forbidden target keys even if riskClass is forged low', () => {
    const forged = validateShadowRecommendation({
      ...baseRec({
        targetKey: 'permission_policy_relax',
        riskClass: 'low',
      }),
    });
    expect(forged.ok).toBe(false);
  });
});

describe('matched cohort shadow comparison', () => {
  it('measures success, guardrails, rework, cost, and human burden deltas', () => {
    const rec = baseRec({ recommendationKind: 'routing' });
    const baseline = metrics({
      success: 0.7,
      guardrails: 0.9,
      rework: 0.3,
      cost: 1.2,
      humanBurden: 0.25,
    });
    const candidate = metrics({
      success: 0.85,
      guardrails: 0.92,
      rework: 0.18,
      cost: 1.0,
      humanBurden: 0.12,
    });
    const cmp = compareShadowAgainstCohort({
      recommendation: rec,
      baseline,
      candidate,
      windowId: 'window-1',
      observedAtMs: NOW,
    });
    expect(cmp.ok).toBe(true);
    if (!cmp.ok) return;
    const r = cmp.comparison;
    expect(r.mode).toBe('shadow');
    expect(r.cohortKey).toBe(rec.cohortKey);
    expect(r.metrics.success.delta).toBeCloseTo(0.15, 5);
    expect(r.metrics.guardrails.delta).toBeCloseTo(0.02, 5);
    expect(r.metrics.rework.delta).toBeCloseTo(-0.12, 5);
    expect(r.metrics.cost.delta).toBeCloseTo(-0.2, 5);
    expect(r.metrics.human_burden.delta).toBeCloseTo(-0.13, 5);
    expect(r.verdict).toBe('benefit');
    expect(r.measuredBenefit).toBe(true);
    expect(r.appliesLiveTuning).toBe(false);
  });

  it('marks insufficient evidence when cohort sample counts are too low', () => {
    const cmp = compareShadowAgainstCohort({
      recommendation: baseRec(),
      baseline: metrics({ sampleCount: 1 }),
      candidate: metrics({ sampleCount: 1, success: 0.99 }),
      windowId: 'window-thin',
      observedAtMs: NOW,
    });
    expect(cmp.ok).toBe(true);
    if (!cmp.ok) return;
    expect(cmp.comparison.verdict).toBe('insufficient_evidence');
    expect(cmp.comparison.measuredBenefit).toBe(false);
  });

  it('reports regression when guardrails worsen even if success improves', () => {
    const cmp = compareShadowAgainstCohort({
      recommendation: baseRec({ recommendationKind: 'decomposition' }),
      baseline: metrics({ success: 0.7, guardrails: 0.95 }),
      candidate: metrics({ success: 0.9, guardrails: 0.7 }),
      windowId: 'window-guard',
      observedAtMs: NOW,
    });
    expect(cmp.ok).toBe(true);
    if (!cmp.ok) return;
    expect(cmp.comparison.verdict).toBe('regression');
    expect(cmp.comparison.measuredBenefit).toBe(false);
    expect(cmp.comparison.guardrailBreach).toBe(true);
  });

  it('reports regression when rework, cost, or human burden worsen materially', () => {
    const cmp = compareShadowAgainstCohort({
      recommendation: baseRec(),
      baseline: metrics({ rework: 0.1, cost: 1.0, humanBurden: 0.1 }),
      candidate: metrics({ success: 0.82, rework: 0.4, cost: 2.0, humanBurden: 0.5 }),
      windowId: 'window-burden',
      observedAtMs: NOW,
    });
    expect(cmp.ok).toBe(true);
    if (!cmp.ok) return;
    expect(cmp.comparison.verdict).toBe('regression');
    expect(cmp.comparison.measuredBenefit).toBe(false);
  });
});

describe('repeated measured benefit', () => {
  function benefitComparison(
    windowId: string,
    at: number,
  ): ShadowComparisonResult {
    const rec = baseRec();
    const built = compareShadowAgainstCohort({
      recommendation: rec,
      baseline: metrics({ success: 0.7 }),
      candidate: metrics({ success: 0.85, rework: 0.1, cost: 0.9, humanBurden: 0.1 }),
      windowId,
      observedAtMs: at,
    });
    if (!built.ok) throw new Error('expected benefit comparison');
    return built.comparison;
  }

  it(`requires at least ${MIN_REPEATED_MEASURED_BENEFIT} benefit windows`, () => {
    expect(MIN_REPEATED_MEASURED_BENEFIT).toBeGreaterThanOrEqual(2);
    const one = evaluateRepeatedMeasuredBenefit({
      comparisons: [benefitComparison('w1', NOW)],
    });
    expect(one.repeatedBenefit).toBe(false);
    expect(one.benefitCount).toBe(1);

    const windows: ShadowComparisonResult[] = [];
    for (let i = 0; i < MIN_REPEATED_MEASURED_BENEFIT; i++) {
      windows.push(benefitComparison(`w${i}`, NOW + i * 60_000));
    }
    const enough = evaluateRepeatedMeasuredBenefit({ comparisons: windows });
    expect(enough.repeatedBenefit).toBe(true);
    expect(enough.benefitCount).toBe(MIN_REPEATED_MEASURED_BENEFIT);
  });

  it('does not count regression or insufficient windows toward repeated benefit', () => {
    const good = benefitComparison('good', NOW);
    const badBuilt = compareShadowAgainstCohort({
      recommendation: baseRec(),
      baseline: metrics({ guardrails: 0.95 }),
      candidate: metrics({ success: 0.9, guardrails: 0.5 }),
      windowId: 'bad',
      observedAtMs: NOW + 1,
    });
    expect(badBuilt.ok).toBe(true);
    if (!badBuilt.ok) return;
    const thinBuilt = compareShadowAgainstCohort({
      recommendation: baseRec(),
      baseline: metrics({ sampleCount: 1 }),
      candidate: metrics({ sampleCount: 1, success: 0.99 }),
      windowId: 'thin',
      observedAtMs: NOW + 2,
    });
    expect(thinBuilt.ok).toBe(true);
    if (!thinBuilt.ok) return;
    const evaled = evaluateRepeatedMeasuredBenefit({
      comparisons: [good, badBuilt.comparison, thinBuilt.comparison],
    });
    expect(evaled.benefitCount).toBe(1);
    expect(evaled.repeatedBenefit).toBe(false);
  });
});

describe('disposition by risk class', () => {
  it('keeps medium-risk as proposals only', () => {
    const rec = baseRec({
      recommendationKind: 'decomposition',
      targetKey: 'decomposition_graph_shape',
      riskClass: 'medium',
    });
    const windows: ShadowComparisonResult[] = [];
    for (let i = 0; i < MIN_REPEATED_MEASURED_BENEFIT; i++) {
      const built = compareShadowAgainstCohort({
        recommendation: rec,
        baseline: metrics({ success: 0.7 }),
        candidate: metrics({ success: 0.9, rework: 0.1 }),
        windowId: `med-${i}`,
        observedAtMs: NOW + i,
      });
      if (!built.ok) throw new Error('cmp');
      windows.push(built.comparison);
    }
    const d = disposeShadowRecommendation({ recommendation: rec, comparisons: windows });
    expect(d.disposition).toBe('proposal_only');
    expect(d.mayBuildBoundedTuning).toBe(false);
    expect(d.requiresHumanTask).toBe(false);
    expect(d.liveTuningEnabled).toBe(false);
  });

  it('routes high-risk / security / permission changes to human tasks only', () => {
    const recBuilt = buildShadowRecommendation({
      recommendationKind: 'routing',
      repoKey: 'hercules',
      taskClass: 'implement:general',
      targetKey: 'permission_policy_relax',
      summary: 'Would relax workspace permission class — must not auto-apply',
      evidenceDigests: [digest('high-risk')],
      observedAtMs: NOW,
    });
    expect(recBuilt.ok).toBe(true);
    if (!recBuilt.ok) return;
    expect(recBuilt.recommendation.riskClass).toBe('high');

    const d = disposeShadowRecommendation({
      recommendation: recBuilt.recommendation,
      comparisons: [],
    });
    expect(d.disposition).toBe('human_task_only');
    expect(d.requiresHumanTask).toBe(true);
    expect(d.mayBuildBoundedTuning).toBe(false);
    expect(d.liveTuningEnabled).toBe(false);

    const task = buildHighRiskHumanTaskProposal({
      recommendation: recBuilt.recommendation,
      observedAtMs: NOW,
    });
    expect(task.ok).toBe(true);
    if (!task.ok) return;
    expect(task.proposal.kind).toBe('human_task_proposal');
    expect(task.proposal.autoApply).toBe(false);
    expect(task.proposal.evidenceDigests.length).toBeGreaterThan(0);
    expect(task.proposal.title).toMatch(/permission|security|human/i);
  });

  it('allows low-risk bounded tuning eligibility only after repeated measured benefit', () => {
    const rec = baseRec({
      targetKey: 'agent_routing_preference',
      riskClass: 'low',
    });
    const thin = disposeShadowRecommendation({
      recommendation: rec,
      comparisons: [],
    });
    expect(thin.disposition).toBe('shadow_continue');
    expect(thin.mayBuildBoundedTuning).toBe(false);

    const windows: ShadowComparisonResult[] = [];
    for (let i = 0; i < MIN_REPEATED_MEASURED_BENEFIT; i++) {
      const built = compareShadowAgainstCohort({
        recommendation: rec,
        baseline: metrics({ success: 0.7 }),
        candidate: metrics({ success: 0.88, rework: 0.1, cost: 0.9, humanBurden: 0.08 }),
        windowId: `low-${i}`,
        observedAtMs: NOW + i * 1000,
      });
      if (!built.ok) throw new Error('cmp');
      windows.push(built.comparison);
    }
    const ready = disposeShadowRecommendation({ recommendation: rec, comparisons: windows });
    expect(ready.disposition).toBe('bounded_tuning_eligible');
    expect(ready.mayBuildBoundedTuning).toBe(true);
    expect(ready.liveTuningEnabled).toBe(false);
  });
});

describe('bounded reversible tuning requirements', () => {
  it('requires owner, explicit bound, rollback, expiry, and success/guardrail metrics', () => {
    const built = buildBoundedTuningSpec({
      recommendationId: baseRec().id,
      targetKey: 'context_budget_tokens',
      owner: 'autonomy-ops',
      bound: {
        parameter: 'context_budget_tokens',
        maxDelta: 500,
        unit: 'tokens',
        direction: 'increase',
      },
      rollback: {
        strategy: 'restore_prior_value',
        priorValueDigest: digest('prior-budget-8000'),
      },
      expiryMs: NOW + 7 * 24 * 60 * 60 * 1000,
      successMetrics: ['success', 'rework'],
      guardrailMetrics: ['guardrails', 'human_burden'],
      observedAtMs: NOW,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const spec = built.spec;
    expect(spec.owner).toBe('autonomy-ops');
    expect(spec.bound.maxDelta).toBe(500);
    expect(spec.rollback.strategy).toBe('restore_prior_value');
    expect(spec.expiryMs).toBeGreaterThan(NOW);
    expect(spec.successMetrics).toEqual(expect.arrayContaining(['success', 'rework']));
    expect(spec.guardrailMetrics).toEqual(
      expect.arrayContaining(['guardrails', 'human_burden']),
    );
    expect(spec.liveEnabled).toBe(false);
    expect(spec.requiresSeparatePolicyApproval).toBe(true);
    expect(spec.applied).toBe(false);
  });

  it('rejects incomplete bounded tuning specs', () => {
    const missingOwner = validateBoundedTuningSpec({
      id: makeBoundedTuningId({ recommendationId: 'rec-1', observedAtMs: NOW }),
      kind: 'bounded_tuning_spec',
      recommendationId: baseRec().id,
      targetKey: 'context_budget_tokens',
      owner: '',
      bound: {
        parameter: 'context_budget_tokens',
        maxDelta: 100,
        unit: 'tokens',
        direction: 'increase',
      },
      rollback: {
        strategy: 'restore_prior_value',
        priorValueDigest: digest('prior'),
      },
      expiryMs: NOW + 1000,
      successMetrics: ['success'],
      guardrailMetrics: ['guardrails'],
      liveEnabled: false,
      requiresSeparatePolicyApproval: true,
      applied: false,
      observedAtMs: NOW,
    });
    expect(missingOwner.ok).toBe(false);

    const missingRollback = buildBoundedTuningSpec({
      recommendationId: baseRec().id,
      targetKey: 'context_budget_tokens',
      owner: 'ops',
      bound: {
        parameter: 'context_budget_tokens',
        maxDelta: 100,
        unit: 'tokens',
        direction: 'increase',
      },
      rollback: {
        strategy: 'restore_prior_value',
        priorValueDigest: '',
      },
      expiryMs: NOW + 1000,
      successMetrics: ['success'],
      guardrailMetrics: ['guardrails'],
      observedAtMs: NOW,
    });
    expect(missingRollback.ok).toBe(false);

    const noExpiry = buildBoundedTuningSpec({
      recommendationId: baseRec().id,
      targetKey: 'agent_routing_preference',
      owner: 'ops',
      bound: {
        parameter: 'agent_routing_preference',
        maxDelta: 1,
        unit: 'rank_steps',
        direction: 'either',
      },
      rollback: {
        strategy: 'restore_prior_value',
        priorValueDigest: digest('prior-route'),
      },
      expiryMs: NOW - 1,
      successMetrics: ['success'],
      guardrailMetrics: ['guardrails'],
      observedAtMs: NOW,
    });
    expect(noExpiry.ok).toBe(false);

    const noMetrics = buildBoundedTuningSpec({
      recommendationId: baseRec().id,
      targetKey: 'concurrency_soft_cap',
      owner: 'ops',
      bound: {
        parameter: 'concurrency_soft_cap',
        maxDelta: 1,
        unit: 'slots',
        direction: 'increase',
      },
      rollback: {
        strategy: 'restore_prior_value',
        priorValueDigest: digest('prior-cap'),
      },
      expiryMs: NOW + 10_000,
      successMetrics: [],
      guardrailMetrics: [],
      observedAtMs: NOW,
    });
    expect(noMetrics.ok).toBe(false);
  });

  it('never enables live tuning even when building from eligible disposition', () => {
    const rec = baseRec({ targetKey: 'retrieval_ranking_boost', riskClass: 'low' });
    const windows: ShadowComparisonResult[] = [];
    for (let i = 0; i < MIN_REPEATED_MEASURED_BENEFIT; i++) {
      const built = compareShadowAgainstCohort({
        recommendation: rec,
        baseline: metrics({ success: 0.7 }),
        candidate: metrics({ success: 0.9, rework: 0.1, cost: 0.8, humanBurden: 0.05 }),
        windowId: `elig-${i}`,
        observedAtMs: NOW + i,
      });
      if (!built.ok) throw new Error('cmp');
      windows.push(built.comparison);
    }
    const result = tryBuildBoundedTuningFromDisposition({
      recommendation: rec,
      comparisons: windows,
      owner: 'autonomy-ops',
      bound: {
        parameter: 'retrieval_ranking_boost',
        maxDelta: 0.05,
        unit: 'score',
        direction: 'increase',
      },
      rollback: {
        strategy: 'restore_prior_value',
        priorValueDigest: digest('prior-rank'),
      },
      expiryMs: NOW + 86_400_000,
      successMetrics: ['success', 'rework'],
      guardrailMetrics: ['guardrails', 'human_burden'],
      observedAtMs: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.liveEnabled).toBe(false);
    expect(result.spec.applied).toBe(false);
    expect(result.spec.requiresSeparatePolicyApproval).toBe(true);
    expect(result.liveTuningEnabled).toBe(false);
  });

  it('refuses bounded tuning for medium/high risk and forbidden targets', () => {
    const med = tryBuildBoundedTuningFromDisposition({
      recommendation: baseRec({
        targetKey: 'decomposition_graph_shape',
        riskClass: 'medium',
      }),
      comparisons: [],
      owner: 'ops',
      bound: {
        parameter: 'decomposition_graph_shape',
        maxDelta: 1,
        unit: 'nodes',
        direction: 'either',
      },
      rollback: {
        strategy: 'restore_prior_value',
        priorValueDigest: digest('g'),
      },
      expiryMs: NOW + 1000,
      successMetrics: ['success'],
      guardrailMetrics: ['guardrails'],
      observedAtMs: NOW,
    });
    expect(med.ok).toBe(false);

    const forbidden = buildBoundedTuningSpec({
      recommendationId: 'rec-x',
      targetKey: 'merge_policy',
      owner: 'ops',
      bound: {
        parameter: 'merge_policy',
        maxDelta: 1,
        unit: 'flags',
        direction: 'either',
      },
      rollback: {
        strategy: 'restore_prior_value',
        priorValueDigest: digest('m'),
      },
      expiryMs: NOW + 1000,
      successMetrics: ['success'],
      guardrailMetrics: ['guardrails'],
      observedAtMs: NOW,
    });
    expect(forbidden.ok).toBe(false);
  });

  it('rejects specs that claim liveEnabled or applied without separate policy', () => {
    // Invalid claim payloads: not BoundedTuningSpec (type locks liveEnabled/applied to false).
    const live = {
      id: makeBoundedTuningId({ recommendationId: 'r', observedAtMs: NOW }),
      kind: 'bounded_tuning_spec',
      recommendationId: baseRec().id,
      targetKey: 'context_budget_tokens',
      owner: 'ops',
      bound: {
        parameter: 'context_budget_tokens',
        maxDelta: 100,
        unit: 'tokens',
        direction: 'increase',
      },
      rollback: {
        strategy: 'restore_prior_value',
        priorValueDigest: digest('p'),
      },
      expiryMs: NOW + 10_000,
      successMetrics: ['success'],
      guardrailMetrics: ['guardrails'],
      liveEnabled: true,
      requiresSeparatePolicyApproval: true,
      applied: false,
      observedAtMs: NOW,
    };
    expect(validateBoundedTuningSpec(live).ok).toBe(false);

    const applied = { ...live, liveEnabled: false, applied: true };
    expect(validateBoundedTuningSpec(applied).ok).toBe(false);
  });
});

describe('store append / serialize (shadow only)', () => {
  it('appends comparisons without enabling live mutation', () => {
    let store = emptyShadowRecommendationStore();
    const recBuilt = buildShadowRecommendation({
      recommendationKind: 'routing',
      repoKey: 'hercules',
      taskClass: 'implement:general',
      targetKey: 'agent_routing_preference',
      summary: 'Prefer lower-latency adapter for general implement tasks',
      evidenceDigests: [digest('store-rec')],
      observedAtMs: NOW,
    });
    expect(recBuilt.ok).toBe(true);
    if (!recBuilt.ok) return;

    const cmpBuilt = compareShadowAgainstCohort({
      recommendation: recBuilt.recommendation,
      baseline: metrics({ success: 0.7 }),
      candidate: metrics({ success: 0.8 }),
      windowId: 'store-w1',
      observedAtMs: NOW,
    });
    expect(cmpBuilt.ok).toBe(true);
    if (!cmpBuilt.ok) return;

    const appended = appendShadowComparison(store, {
      recommendation: recBuilt.recommendation,
      comparison: cmpBuilt.comparison,
    });
    expect(appended.applied).toBe(true);
    store = appended.store;
    expect(store.mode).toBe('shadow');
    expect(store.liveTuningEnabled).toBe(false);
    expect(store.comparisons).toHaveLength(1);

    const json = serializeShadowRecommendationStore(store);
    const parsed = parseShadowRecommendationStore(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.store.liveTuningEnabled).toBe(false);
    expect(parsed.store.comparisons[0]?.appliesLiveTuning).toBe(false);
  });

  it('rejects store documents that claim live tuning', () => {
    const bad = parseShadowRecommendationStore(
      JSON.stringify({
        version: SHADOW_REC_SCHEMA_VERSION,
        mode: 'shadow',
        liveTuningEnabled: true,
        recommendations: [],
        comparisons: [],
        tuningSpecs: [],
      }),
    );
    expect(bad.ok).toBe(false);
  });
});

describe('id helpers', () => {
  it('builds stable recommendation and comparison ids', () => {
    const a = makeShadowRecommendationId({
      kind: 'routing',
      repoKey: 'hercules',
      taskClass: 'implement:general',
      targetKey: 'agent_routing_preference',
      observedAtMs: NOW,
    });
    const b = makeShadowRecommendationId({
      kind: 'routing',
      repoKey: 'hercules',
      taskClass: 'implement:general',
      targetKey: 'agent_routing_preference',
      observedAtMs: NOW,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^srec-/);

    const c = makeShadowComparisonId({
      recommendationId: a,
      windowId: 'w1',
      observedAtMs: NOW,
    });
    expect(c).toMatch(/^scmp-/);
  });
});
