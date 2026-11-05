# Autonomy capability and operating-quality observability

## Do not optimize one score

Efficiency must not be a monotonic global number: task mix changes, and speed
alone rewards skipped checks. Compare rolling cohorts of similar task classes
and preserve quality, evidence, safety, and operator burden as first-class
guardrails.

## Measures

- **Verified delivery:** evidence-backed completion, rework, review reversals,
  post-merge regressions, and honest failures.
- **Normalized execution:** elapsed/queue time, retries, resource waits, cost,
  and contention for comparable tasks.
- **Decomposition quality:** predicted versus actual scope, missed dependencies,
  graph replans, integration failures, and merge conflicts.
- **Context quality:** retrieval relevance/use, stale or contradictory facts,
  budget pressure, and context-caused corrections.
- **Human burden:** interventions, unjustified escalations, and whether each
  interruption resolved a decision that automation could not prove.

Use control-style thresholds by task class. An anomaly report must state the
observed regression, evidence, likely cause, confidence, and safe next action.

## Correction policy

Low-risk reversible adjustments may tune retrieval ranking, context budget,
concurrency, or agent routing. Medium-risk changes are shadow-mode proposals.
High-risk findings create an evidence-backed improvement task and never alter
core security/permission policy automatically. Every automatic adjustment has a
rollback, an owner, and a success/guardrail measurement.

## Rollout

1. Normalize existing task, gate, retry, review, resource, and intervention
   events; publish reporting and alerts only.
   Domain: `src/domain/autonomyObservability.ts` (reporting-only).
2. Add cohort baselines and explanation-oriented anomaly reports.
   Domain: same module (`buildCohortBaseline`, `buildAnomalyReceipt`).
3. Run decomposition/routing/context recommendations in shadow mode.
   Domain: `src/domain/shadowRecommendationTuning.ts` — compares matched-cohort
   **success, guardrails, rework, cost, human burden**; mode is always `shadow`.
4. Permit only bounded reversible tuning after repeated measured benefit.
   Domain: same module — low-risk eligibility requires owner, explicit bound,
   rollback, expiry, and success/guardrail metrics. Specs are never
   `liveEnabled` / `applied` here; a separate explicit policy and approval are
   required before any live tuning. Medium-risk stays `proposal_only`;
   high-risk/security/permission creates `human_task_only` proposals.
   Forbidden: self-modification of core safety, evidence, merge, deploy,
   production, permission, security, or gate boundaries.

Success means comparable work becomes more reliably verified, has less rework
and unnecessary operator attention, and does not worsen safety or evidence.
