# Evidence memory and context compiler

## Principle

Do not preload organizational history into an agent window. Assemble a small,
traceable working packet for each task. The system learns from verified outcomes,
not from raw transcripts or agent self-reports.

## Four memory layers

1. **Core rules:** short stable safety, permission, and evidence invariants.
2. **Project knowledge:** versioned architecture maps, contracts, runbooks, and
   module facts, retrieved only for the task scope.
3. **Reusable experience:** structured `conditions -> recommendation -> outcome
   -> evidence` records.
4. **Raw receipts:** logs, diffs, tests, review packets, and operational output;
   retained for audit and loaded only on demand.

Every claim has project/module scope, source, version/time, confidence, and
supersession/expiry state. Prefer same-project, same-module, recent, verified
knowledge. Contradicted or stale knowledge is downgraded rather than silently
reused.

## Context compiler

For a proposed node, assemble within a declared budget: core rules; direct
project/module facts; direct DAG dependency contracts; a small set of similar,
verified cases; and links to raw evidence. Reserve sufficient context for code
reading and reasoning. Record what was retrieved and whether it was useful so
retrieval itself can be evaluated.

## Learning lifecycle

Capture task fingerprint, graph/decomposition features, adapter and permission
choice, duration/retries, gates/review, conflicts, human interventions,
integration evidence, and diagnosed cause. Promote raw events to a local
playbook only after verified repeat success; promote across projects only after
repeated cross-project proof. Roll out learned behavior in this order: record,
advisory recommendation, shadow comparison, bounded low-risk adoption, then
human-gated high-risk change.

## Implementation (advisory stage)

- Record-only store: `src/domain/evidenceMemory.ts`
- Shadow context compiler: `src/domain/contextCompiler.ts`
- Promotion / demotion / advisory recommendations:
  `src/domain/playbookAdvisory.ts` — recommendations never alter prompts,
  adapters, concurrency, permissions, or gates; human decisions and security
  policy are forbidden learning targets. Confirmed contradictions refuse
  promotion. Context-bridge reuse (`contextCandidateFromEvidenceRecord`) is
  fail-closed: demoted playbook knowledge is never emitted without store-aware
  `mayReuse`.
- Shadow comparison + bounded low-risk tuning policy (not live):
  `src/domain/shadowRecommendationTuning.ts` — matched-cohort comparison of
  decomposition/routing/context recommendations; bounded tuning specs require
  owner/bound/rollback/expiry/metrics and never enable live apply without a
  separate policy.
