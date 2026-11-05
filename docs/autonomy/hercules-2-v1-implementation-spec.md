# Hercules 2.0 V1 — Autonomous Task Control Plane Implementation Specification

**Status:** Proposed implementation baseline  
**Audience:** Coding/implementation agents that have **no access to the prior design conversation**  
**Repository:** `AAlpha7/hercules-public`  
**Intended repo path:** `docs/autonomy/hercules-2-v1-implementation-spec.md`  
**Claim authority contract:** `docs/autonomy/hercules-2-v1-claim-authority.md`
**Scope:** Single-machine V1 with distributed-ready logical boundaries  
**Primary product requirement:** The operator should normally provide one goal and receive one trustworthy outcome. The system, not the operator, must absorb the complexity of planning, execution, verification, evaluation, retry, evidence collection, and audit.

---

## 0. How an implementation agent must use this document

This document is intentionally self-contained. Do not assume access to any chat history, memory, meeting notes, or undocumented owner intent.

Before modifying code, read these repository files in order:

1. The user-level Codex `AGENTS.md` and the machine continuity route it names, when running on a continuity-managed host.
2. `AGENTS.md`
3. `WORKFLOW.md`
4. This document
5. `docs/autonomy/hercules-2-v1-claim-authority.md`
6. the companion autonomous program contract (internal; not published) when executing more than one migration milestone
7. the program-state ledger (internal; not published) when it exists
8. `SPEC.md` only for the current design rationale relevant to the unit being changed
9. Existing focused documents under:
   - `docs/autonomy/`
   - `docs/repo-execution-policy.md`
   - `docs/readiness-pipeline.md`

The current executable policy in `WORKFLOW.md` remains authoritative until a reviewed migration unit explicitly changes it. This future design document does **not** authorize an agent to weaken gates, bypass the current state machine, change production policy, send external messages, spend money, deploy, merge protected code, delete legacy data, or self-modify policy.

### Mandatory implementation behavior

- Do not attempt this specification as one large change.
- Preserve existing behavior while introducing the V2 model additively.
- Implement in small, ordered, independently verifiable PRs.
- Re-ground against the current `main` before every PR; Hercules is actively changing.
- Keep `src/domain/` pure and obey all current mechanical dependency constraints.
- Do not silently reinterpret owner decisions in this document.
- Do not replace an unresolved policy choice with a hidden implementation default.
- Do not use agent self-report as proof.
- New Web UI decision paths require real render tests under `test/web/render/` and matching browser/L2 evidence where applicable, as required by `AGENTS.md`.
- Never add placeholder or disabled UI solely to satisfy a selector or evidence check.
- Any material boundary, compatibility, deletion, or cutover change requires a dedicated, reviewable migration unit.

### First action before code

Produce a short implementation note containing:

1. Current HEAD SHA.
2. Existing types/modules that overlap the proposed unit.
3. Exact files proposed for the first PR.
4. Explicit behavior that will remain unchanged.
5. Tests that will prove the unit.
6. Any conflict between this document and current code or executable policy.

The first coding PR should be an additive contract/model unit, not a control-plane cutover.

### Machine continuity and local synchronization

On a machine using the private Codex continuity protocol, the implementation agent must treat that protocol as the cross-session navigation and handoff layer. Before substantial work:

1. Read the user-level Codex `AGENTS.md` and locate the exact continuity checkout/index it names. Do not invent a local path.
2. Synchronize the local `example-org/review-ledger` checkout safely: inventory first, fetch, and fast-forward only when clean. Never overwrite dirty/divergent work or copy another host's paths.
3. Read, from the synchronized continuity checkout:
   - `PROTOCOL.md`;
   - `INDEX.md`;
   - `projects/hercules/CURRENT_STATE.md`;
   - the current machine manifest selected by the local continuity rules.
4. Synchronize Hercules from `origin/main` in a clean worktree without discarding unrelated local work.
5. Verify this specification, the claim authority contract, and the companion
   autonomous program contract exist locally and record their exact blob/commit
   SHAs.
6. Treat chat history, model memory, pasted transcripts, and provider session IDs as non-authoritative.
7. For a multi-PR program, create/resume the program-state ledger (internal; not published); after each merged milestone, update it and append a concise checkpoint to the Hercules continuity `CURRENT_STATE`.
8. Keep secrets, tokens, private host details, raw prompts, and raw private logs out of continuity artifacts.
9. Follow the continuity protocol's append-only/reverse-write rules; after two write conflicts, stop that write path for commander reconciliation rather than overwriting a whole file.

The program ledger in Hercules contains detailed machine-readable migration state. The continuity handoff contains only the concise current milestone, verified merge SHA, blocker, and next safe action. Neither replaces source code, executable policy, CI, or runtime verification.

---

# 1. Owner intent and product outcome

Hercules currently has substantial coding-agent orchestration capability: isolated worktrees, adapters, retries, gates, reviewer runs, evidence, review packets, Git integration, and a Web/mobile interface. The next version must preserve that execution substrate while evolving Hercules into a **general autonomous task execution control plane**.

The long-term interaction model is comparable to a dependable assistant:

> The operator states an outcome in ordinary language. Hercules selects and coordinates the required capabilities, executes in isolation, verifies the real result, independently evaluates the evidence, repairs failures automatically within policy, and reports a concise outcome. The operator sees process detail only when requested or when an exception requires a decision.

Hercules must eventually support multiple task families through the same control plane, including:

- code/repository changes;
- browser and website operations;
- information collection and structured research;
- file and document operations;
- bounded email operations;
- other tool-backed tasks;
- purchasing or spending only behind explicit risk and approval controls.

Cursor, Grok, Codex, Claude, browser automation, shell execution, and future runtimes are **replaceable workers/capabilities**, not the control plane itself.

The existing Hercules Web interface remains a first-class client. A generic API must also support Grok Bot, a future VS Code extension, CLI clients, and other agents without duplicating workflow logic.

---

# 2. Authoritative owner decisions

These decisions are settled for V1 unless the owner explicitly changes them.

## 2.1 V1 priority

First build the **reliable autonomous execution core**. Capability breadth should grow only through the same contracts, policy, evidence, and evaluation model.

## 2.2 Human intervention

The normal path is autonomous. Ask the operator only for:

- high-risk or irreversible actions;
- true product/value judgments;
- permissions not already granted;
- semantic changes to the task contract;
- conflicting evidence;
- repeated non-converging failures;
- cost that is materially disproportionate to expected value;
- policy conflicts that cannot be resolved mechanically.

Routine success must not require manual QA.

## 2.3 Automatic repair

An independent evaluation failure should normally create a new iteration and return structured findings to the appropriate execution stage automatically. Escalate only when retry, risk, evidence-conflict, or cost policy requires it.

## 2.4 State authority

The database becomes the primary control-plane state authority.

- **Database:** tasks, contracts, iterations, stages, events, policy decisions, verdicts, human decisions, and references.
- **Artifact store:** logs, screenshots, traces, build products, reports, and other large evidence.
- **Git:** source code, commits, branches, PRs, and auditable projections/references.

The existing Git/Markdown control repo must be migrated gradually, not discarded in one rewrite.

## 2.5 Deployment topology

V1 runs on one physical machine. Logical boundaries must be designed as though workers may later move to other machines.

## 2.6 API

Expose one versioned, generic Control API. The Hercules Web UI, Grok Bot, future VS Code extension, CLI, and other clients use the same semantics.

## 2.7 Reliability and cost

Reliability is more important than cost unless extra cost is clearly disproportionate to the task’s value and risk reduction. Verification depth must be risk-based rather than uniformly maximal.

## 2.8 Task-contract mutation policy

V1 default:

- An execution, verification, or evaluation agent may **not silently change** objective, acceptance criteria, constraints, forbidden actions, risk class, or approval policy.
- The system may update derived facts such as resolved SHAs, worker IDs, environment IDs, timestamps, artifact references, attempts, and observed facts.
- A semantic change requires a structured `ContractChangeRequest`.
- Low-impact clarifications that preserve meaning may be auto-resolved only if a deterministic policy explicitly permits them and records the decision.
- Any meaning-changing or risk-changing request requires operator approval.

---

# 3. Success definition

Hercules 2.0 V1 is successful when all of the following are true.

## 3.1 Operator experience

For a normal task, the operator can:

1. submit one goal;
2. leave the system unattended;
3. receive a concise, outcome-first completion;
4. determine within approximately 10–30 seconds whether the result is trustworthy;
5. expand supporting evidence only when desired;
6. safely approve, reject, request changes, or authorize a high-risk next action.

## 3.2 System behavior

The system can:

- create an immutable versioned task contract;
- execute through structured stage contracts;
- isolate execution from verification and evaluation;
- launch a fresh verifier when required;
- launch an evaluator that does not consume implementer self-justification as authority;
- map every acceptance criterion to a status and evidence;
- reject stale evidence or stale approvals;
- automatically create a new iteration after remediable failure;
- preserve every prior iteration;
- expose current state and history through the API and Web UI;
- recover after process restart without relying on agent conversation memory;
- run on one machine while preserving worker/control-plane protocol boundaries.

## 3.3 General-task proof

The V1 architecture must not hard-code “task = Git patch.” Before V1 is declared complete, the same Task API and stage model should demonstrate at least:

1. one code/repository task;
2. one browser/user-surface task;
3. one non-code bounded task such as structured information/file operation.

External sending, purchasing, deployment, and destructive actions may remain approval-gated.

---

# 4. Non-goals for the first implementation wave

The following are explicitly not first-wave goals:

- a multi-machine production fleet;
- a large autonomous DAG scheduler;
- replacing all current task Markdown immediately;
- rewriting `src/orchestrator/orchestrator.ts` or `src/web/App.tsx` in one PR;
- deleting current review-packet behavior before the replacement is proven;
- breaking existing `/api` consumers;
- allowing agents to alter policy or acceptance criteria silently;
- granting raw credentials to agents;
- automatic production deployment without policy and human gates;
- universal support for every external service;
- maximizing agent count or multi-agent ceremony.

The design should support later distribution and capability growth without paying that complexity in V1.

---

# 5. Core principles

## 5.1 Outcome over process exposure

The system may perform a complex internal workflow, but the default operator view is:

- what was requested;
- what happened;
- whether it passed;
- what remains risky;
- what decision, if any, is required.

Raw logs, internal prompts, intermediate plans, retries, and detailed traces are available through progressive disclosure, not shown by default.

## 5.2 Authority separation

Use a separation similar to execution, inspection, and adjudication:

- **Executor/Implementer:** performs the work.
- **Verifier:** exercises the real target and captures primary evidence.
- **Evaluator:** judges the immutable contract against primary evidence.
- **Control plane:** advances state, enforces policy, records authority, and does not perform domain reasoning.
- **Human:** defines goals/meaning and decides exceptional or high-risk matters.

The same agent run must not both perform the work and grant itself final authority.

## 5.3 Evidence before claims

A statement such as “done,” “tested,” or “looks correct” is not proof. Trust:

- immutable contract versions;
- repository SHAs;
- real-surface observations;
- deterministic test outputs;
- signed/hashed artifact manifests;
- independent verdicts;
- auditable human decisions.

All decision-bearing assertions additionally follow
`docs/autonomy/hercules-2-v1-claim-authority.md`. They are classified as
`verified`, `inference`, `unverified_pending`, or `opinion`. Only `verified`
assertions backed by a fresh exact contract/candidate/primary-evidence binding
may influence workflow state, merge recommendations, approval, deployment, or
automatic actions. Agent self-reports remain non-authoritative. Missing, stale,
contradictory, or tampered evidence fails closed to `need_more_evidence`.

This rule is enforced at the structured decision boundary. Hercules does not
claim it can semantically police every generated prose sentence; instead, no
decision-bearing path may consume raw prose as authority.

## 5.4 Freshness and binding

Every approval and verdict must bind to exact inputs:

- task ID;
- contract version/hash;
- iteration ID;
- implementation candidate SHA or artifact version;
- evidence-manifest hash;
- evaluator version/model/runtime;
- policy version.

A changed candidate always invalidates the prior verification receipt, verdict,
and approval. Policy-supported equivalence evidence may be reused as primary
evidence for fresh verification, but every new receipt, verdict, and approval
must bind the new exact candidate.

## 5.5 Structured internal communication

All component-to-component communication is structured. Human-readable summaries are projections from structured records.

## 5.6 Append history, do not overwrite it

A new attempt creates a new iteration/stage run. Never overwrite the authoritative history of a failed or superseded attempt.

## 5.7 Agent receives capabilities, not secrets

Workers or capability brokers use managed credentials. Agents receive bounded capability handles or commands, never raw secrets in prompts, environment variables, logs, or artifacts where avoidable.

## 5.8 Reliability proportional to risk

Low-risk reversible tasks should not incur the same cost as high-risk irreversible tasks. Policy selects verification depth, number of independent checks, approval requirements, and retry budgets.

---

# 6. Target logical architecture

```text
Clients
  ├─ Hercules Web UI
  ├─ Grok Bot
  ├─ VS Code Extension
  ├─ CLI
  └─ Other agents/services
          │
          ▼
Versioned Control API
          │
          ▼
Control Plane Service
  ├─ Task Intake / Contract Service
  ├─ Workflow & State Machine
  ├─ Policy / Risk / Permission Engine
  ├─ Scheduler
  ├─ Iteration & Stage Coordinator
  ├─ Result Aggregator
  ├─ Review Package Service
  ├─ Notification / Event Stream
  └─ State Store Port
          │
          ├────────────► Primary DB
          ├────────────► Artifact / Evidence Store
          ├────────────► Git / PR integrations
          │
          ▼
Worker Port / Job Protocol
          │
          ▼
Local Worker Service (V1)
  ├─ Workspace / worktree preparation
  ├─ Runtime launcher
  ├─ Process supervision
  ├─ Capability broker
  ├─ Secret-backed operations
  ├─ Environment cleanup
  └─ Result-package upload
          │
          ├─ Explorer / Planner Agent
          ├─ Design Reviewer Agent
          ├─ Implementer Agent
          ├─ Verifier Agent (fresh when required)
          ├─ Evaluator Agent (independent)
          └─ Learning Analyst Agent
```

One machine may host all boxes. They remain logically separate and communicate through explicit ports/contracts.

---

# 7. Proposed bounded contexts and code placement

Do not force all of these directories into the first PR. Introduce them only through narrow architecture changes with dependency rules and tests.

## 7.1 Domain contracts

Add pure domain modules, preferably as focused files under `src/domain/`:

- `taskContract.ts`
- `contractChange.ts`
- `iteration.ts`
- `stageRun.ts`
- `agentRun.ts`
- `artifact.ts`
- `criterionResult.ts`
- `verificationResult.ts`
- `evaluationVerdict.ts`
- `policyDecision.ts`
- `humanDecision.ts`
- `learningProposal.ts`
- `controlEvent.ts`
- `reviewPackage.ts`

These modules contain no filesystem, Git, database, process, or network access.

## 7.2 State persistence

Introduce a state-store port and a V1 local database implementation. Candidate logical location:

```text
src/control/state/
  stateStore.ts
  migrations/
  sqliteStateStore.ts
  repositories/
```

Exact location must respect the current dependency map. If a new top-level package is chosen, update `AGENTS.md`, ESLint dependency rules, and architecture tests in the same dedicated PR.

## 7.3 Artifact storage

Introduce:

```text
src/control/artifacts/
  artifactStore.ts
  filesystemArtifactStore.ts
  manifest.ts
  hashing.ts
```

The DB stores metadata/references. Large content stays outside the DB.

## 7.4 Workflow coordinator

Initially add V2 orchestration beside current behavior:

```text
src/orchestrator/v2/
  workflowEngine.ts
  stageCoordinator.ts
  retryPolicy.ts
  escalationPolicy.ts
  resultAggregator.ts
```

Do not move all current orchestration at once.

## 7.5 Worker boundary

Define a worker port before extracting a process/service:

```text
src/orchestrator/workerPort.ts
src/worker/
  localWorker.ts
  runtimeLauncher.ts
  capabilityBroker.ts
  jobProtocol.ts
```

V1 may use in-process or local IPC transport, but the control plane must send a serializable `JobSpec` and receive a serializable `ResultPackage`. Avoid passing live objects or closures across the boundary.

## 7.6 Verification and evaluation separation

Current `src/verification/` contains valuable building blocks. Preserve them, but separate these responsibilities:

```text
Verification:
  run target
  collect primary evidence
  report facts

Evaluation:
  read immutable contract
  read primary evidence
  issue structured verdict
```

A possible evolution is:

```text
src/verification/
  runners/
  evidence/
  existing compatibility packet/

src/evaluation/
  evaluatorPort.ts
  agentEvaluator.ts
  deterministicEvaluator.ts
  verdictPolicy.ts
```

Creating `src/evaluation/` is an architecture change and must include dependency enforcement.

## 7.7 Web review experience

Add focused components rather than further growing `src/web/App.tsx`:

```text
src/web/review/
  OutcomeHeader.tsx
  DecisionBanner.tsx
  AcceptanceMatrix.tsx
  EvidenceDrawer.tsx
  RiskSummary.tsx
  IterationHistory.tsx
  LearningProposalPanel.tsx
  SafeDecisionBar.tsx
```

Reuse existing primitives such as `ConfirmButton`, `Disclosure`, and `RunTimeline` where they satisfy the new safety requirements.

---

# 8. Authoritative data model

The exact SQL shape may evolve, but the semantic model below is required.

## 8.1 Task

Represents the long-lived operator intent and current aggregate status.

```ts
interface TaskV2 {
  id: string;
  title: string;
  taskType: string;
  currentContractVersion: number;
  currentIterationId: string | null;
  state:
    | 'draft'
    | 'queued'
    | 'running'
    | 'awaiting_human'
    | 'completed'
    | 'failed'
    | 'cancelled';
  riskClass: 'low' | 'medium' | 'high' | 'critical';
  createdAt: string;
  updatedAt: string;
}
```

## 8.2 TaskContract

Immutable after creation. A new semantic version creates a new row.

```ts
interface TaskContract {
  taskId: string;
  version: number;
  contractHash: string;
  objective: string;
  context: readonly ContextRef[];
  acceptanceCriteria: readonly ContractCriterion[];
  constraints: readonly string[];
  forbiddenActions: readonly string[];
  capabilityPolicy: CapabilityPolicy;
  verificationPolicy: VerificationPolicy;
  approvalPolicy: ApprovalPolicy;
  budgetPolicy: BudgetPolicy;
  createdBy: ActorRef;
  createdAt: string;
  supersedesVersion: number | null;
}
```

Each acceptance criterion has a stable ID and authority:

```ts
interface ContractCriterion {
  id: string;
  text: string;
  authority: 'mechanical' | 'verifier' | 'evaluator' | 'human';
  required: boolean;
  proofBinding?: ProofBinding;
}
```

Existing `mechanical`, `reviewer`, and `human` criteria must be mapped without losing meaning. Do not downgrade existing human authority.

## 8.3 ContractChangeRequest

```ts
interface ContractChangeRequest {
  id: string;
  taskId: string;
  baseContractVersion: number;
  requestedBy: ActorRef;
  reason: string;
  proposedPatch: readonly ContractPatchOperation[];
  meaningChange: boolean;
  riskChange: boolean;
  status: 'pending' | 'approved' | 'rejected' | 'superseded';
  policyDecisionId: string | null;
  humanDecisionId: string | null;
}
```

## 8.4 Iteration

A complete attempt to satisfy one exact contract version.

```ts
interface Iteration {
  id: string;
  taskId: string;
  contractVersion: number;
  ordinal: number;
  state:
    | 'planned'
    | 'executing'
    | 'verifying'
    | 'evaluating'
    | 'passed'
    | 'failed'
    | 'abandoned';
  candidateRef: CandidateRef | null;
  evidenceManifestId: string | null;
  finalVerdictId: string | null;
  createdAt: string;
  endedAt: string | null;
  supersedesIterationId: string | null;
}
```

## 8.5 StageRun

```ts
type StageType =
  | 'recon'
  | 'plan'
  | 'design_review'
  | 'implement'
  | 'verify'
  | 'evaluate'
  | 'deploy'
  | 'learn';

interface StageRun {
  id: string;
  iterationId: string;
  type: StageType;
  attempt: number;
  state: 'queued' | 'leased' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  jobSpecHash: string;
  workerId: string | null;
  agentRunIds: readonly string[];
  inputArtifactRefs: readonly string[];
  outputArtifactRefs: readonly string[];
  structuredResult: unknown;
  startedAt: string | null;
  endedAt: string | null;
  failureClass: FailureClass | null;
}
```

## 8.6 AgentRun

Records runtime identity and cost but is not an authority by itself.

```ts
interface AgentRun {
  id: string;
  stageRunId: string;
  role:
    | 'explorer'
    | 'planner'
    | 'design_reviewer'
    | 'implementer'
    | 'verifier'
    | 'evaluator'
    | 'learning_analyst';
  adapter: string;
  model: string | null;
  sessionId: string | null;
  freshContext: boolean;
  promptArtifactRef: string;
  resultArtifactRef: string | null;
  usage: UsageRecord | null;
  startedAt: string;
  endedAt: string | null;
}
```

## 8.7 ArtifactRef and EvidenceManifest

Artifacts are content-addressed.

```ts
interface ArtifactRef {
  id: string;
  sha256: string;
  mediaType: string;
  byteLength: number;
  storageKey: string;
  producerStageRunId: string;
  createdAt: string;
  trustClass: 'primary' | 'derived' | 'agent_claim';
  redactionState: 'none' | 'redacted' | 'restricted';
}
```

```ts
interface EvidenceManifest {
  id: string;
  taskId: string;
  contractVersion: number;
  iterationId: string;
  candidateRef: CandidateRef;
  entries: readonly EvidenceEntry[];
  manifestHash: string;
  createdAt: string;
}
```

Every evidence entry identifies the criterion(s) it supports, provenance, freshness, and observation surface.

## 8.8 CriterionResult

```ts
interface CriterionResult {
  criterionId: string;
  status: 'pass' | 'fail' | 'pending' | 'not_applicable' | 'insufficient_evidence';
  authority: ContractCriterion['authority'];
  evidenceRefs: readonly string[];
  observedAt: string | null;
  candidateBinding: string;
  explanation: string;
}
```

## 8.9 VerificationResult

The verifier reports observations, not final authority.

```ts
interface VerificationResult {
  id: string;
  iterationId: string;
  verifierAgentRunId: string | null;
  environmentRef: string;
  candidateRef: CandidateRef;
  criterionResults: readonly CriterionResult[];
  artifactRefs: readonly string[];
  status: 'completed' | 'failed_to_run' | 'partial';
  limitations: readonly string[];
}
```

## 8.10 EvaluationVerdict

```ts
interface EvaluationVerdict {
  id: string;
  iterationId: string;
  contractVersion: number;
  contractHash: string;
  evidenceManifestHash: string;
  candidateRef: CandidateRef;
  outcome: 'pass' | 'fail' | 'need_more_evidence';
  criterionResults: readonly CriterionResult[];
  blockingFindings: readonly Finding[];
  nonBlockingRisks: readonly Finding[];
  recommendedNextStage:
    | 'complete'
    | 'repair'
    | 'reverify'
    | 'request_contract_change'
    | 'escalate_human';
  evaluatorAgentRunId: string | null;
  createdAt: string;
}
```

Model confidence may be recorded for analysis, but it must never independently grant authority.

## 8.11 HumanDecision

```ts
interface HumanDecision {
  id: string;
  taskId: string;
  iterationId: string | null;
  decision:
    | 'approve_outcome'
    | 'reject_outcome'
    | 'request_changes'
    | 'approve_high_risk_action'
    | 'reject_high_risk_action'
    | 'approve_contract_change'
    | 'reject_contract_change'
    | 'approve_learning_proposal'
    | 'reject_learning_proposal';
  boundContractHash: string;
  boundCandidateRef: CandidateRef | null;
  boundEvidenceManifestHash: string | null;
  comment: string | null;
  actor: ActorRef;
  createdAt: string;
}
```

## 8.12 LearningProposal

Learning never directly edits policy.

```ts
interface LearningProposal {
  id: string;
  sourceTaskId: string;
  sourceIterationIds: readonly string[];
  category: 'architecture' | 'mechanical_rule' | 'workflow' | 'verification' | 'documentation';
  observation: string;
  proposedChange: string;
  expectedBenefit: string;
  risk: string;
  implementationCost: string;
  status: 'proposed' | 'approved' | 'rejected' | 'edited' | 'implemented';
}
```

## 8.13 ControlEvent

Use an append-only event log for audit and recovery.

Examples:

```text
TaskCreated
ContractVersionCreated
ContractChangeRequested
IterationStarted
StageQueued
StageLeased
AgentRunStarted
ArtifactRecorded
VerificationCompleted
EvaluationFailed
AutomaticRepairScheduled
HumanDecisionRequested
HumanDecisionRecorded
DeploymentAuthorized
LearningProposalCreated
```

Current state may be stored directly for efficient queries, but every authoritative mutation also appends a durable event in the same transaction.

---

# 9. V1 persistence design

## 9.1 Database

Use an embedded database on the single V1 machine behind a `ControlStateStore` port. SQLite in WAL mode is the expected default unless current repository constraints demonstrate a better embedded choice. Driver selection is an implementation detail; no design should make later PostgreSQL migration expensive.

Required properties:

- explicit schema migrations;
- foreign keys enabled;
- transactional mutation of state + append-only event;
- idempotency keys on externally retryable commands;
- unique constraints preventing duplicate iteration ordinals and duplicate stage attempts;
- startup integrity check;
- backup/export command;
- no agent process receives direct database write access.

## 9.2 Artifact store

V1 filesystem layout should be content-addressed, for example:

```text
<work-dir>/artifacts/
  sha256/ab/cd/<full-hash>
  manifests/<manifest-id>.json
```

Required properties:

- hash verified on write and read;
- atomic temporary-file-to-final rename;
- metadata stored in DB;
- no secret material by default;
- redaction/restriction metadata;
- configurable retention;
- an artifact referenced by a completed/reviewed iteration cannot disappear silently.

## 9.3 Git projection and compatibility

During migration:

- preserve existing task files and Git audit behavior;
- create a projection layer from DB state to compatible task Markdown where needed;
- never allow two independent authorities to diverge silently;
- run reconciliation checks in shadow/dual-write phases;
- expose divergence prominently and block cutover;
- preserve `verifiedSha`, PR state, leases, gates, and current workflow trust rules.

The database becomes authoritative only after parity, recovery, and rollback tests pass.

---

# 10. Task and iteration state machines

## 10.1 Task state

```text
draft
  └─ contract ready → queued

queued
  └─ scheduler lease → running

running
  ├─ high-risk decision required → awaiting_human
  ├─ final evaluation pass → completed
  ├─ non-recoverable/retry exhausted → failed
  └─ operator cancel → cancelled

awaiting_human
  ├─ approved → running or completed
  ├─ changes requested → running (new iteration)
  ├─ rejected → failed or cancelled
  └─ contract change approved → queued/running with new contract version
```

## 10.2 Iteration flow

```text
planned
  → executing
  → verifying
  → evaluating
      ├─ pass → passed
      ├─ repairable fail → failed + create next iteration
      ├─ evidence gap → verifying/reverification stage
      └─ human/contract issue → failed + escalation
```

## 10.3 Default stage flow

```text
recon/plan
  → design_review (when risk/complexity requires)
  → implement
  → verify
  → evaluate
  → optional human gate
  → optional deploy
  → learn
```

A simple, low-risk non-code task may use fewer stages. Verifier and evaluator separation remains unless deterministic verification fully proves the contract and policy marks an evaluator agent unnecessary.

## 10.4 Retry and escalation defaults

Initial configurable defaults:

- repair iterations: up to 2 for low/medium risk;
- verification reruns: up to 2 when the failure is environmental or flaky;
- evaluator infrastructure retry: separate from implementation retry;
- no automatic repeat of an irreversible action;
- no recursive self-remediation without a bounded platform-remediation policy;
- escalate when the same failure shape repeats without new evidence;
- escalate before cost exceeds the task’s budget policy.

Retries must create new stage attempts or iterations, not mutate previous records.

---

# 11. Worker and job protocol

## 11.1 JobSpec

Every worker job is serializable and immutable after lease.

```ts
interface JobSpec {
  id: string;
  idempotencyKey: string;
  taskId: string;
  contractVersion: number;
  contractHash: string;
  iterationId: string;
  stageRunId: string;
  stageType: StageType;
  role: AgentRun['role'];
  workspace: WorkspaceSpec;
  candidateRef: CandidateRef | null;
  inputArtifacts: readonly ArtifactRef[];
  capabilities: readonly CapabilityGrant[];
  forbiddenActions: readonly string[];
  outputSchema: JsonSchemaRef;
  timeoutPolicy: TimeoutPolicy;
  budgetPolicy: BudgetPolicy;
  policyVersion: string;
}
```

## 11.2 ResultPackage

```ts
interface ResultPackage {
  jobId: string;
  stageRunId: string;
  workerId: string;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  structuredOutput: unknown;
  artifactRefs: readonly ArtifactRef[];
  observedFacts: readonly ObservedFact[];
  candidateRef: CandidateRef | null;
  usage: UsageRecord | null;
  failure: StructuredFailure | null;
  startedAt: string;
  endedAt: string;
}
```

## 11.3 Worker responsibilities

The local Worker Service:

- leases jobs;
- prepares/reuses an isolated workspace according to policy;
- launches the selected runtime;
- passes only approved structured inputs;
- supervises process trees;
- enforces timeouts and resource limits;
- mediates capabilities;
- obtains secrets only through infrastructure identity;
- captures outputs and telemetry;
- uploads artifacts;
- cleans up or preserves the environment according to evidence policy;
- returns a structured result;
- never decides the final task state.

## 11.4 Control-plane responsibilities

The control plane:

- creates contracts and stages;
- evaluates policy;
- schedules jobs;
- records authoritative state;
- validates worker result packages;
- starts verification/evaluation;
- decides automatic retry/escalation;
- creates review packages;
- records human decisions.

It does not perform domain-specific reasoning itself.

---

# 12. Capability model for general tasks

Do not expose unrestricted host access as a universal tool. Define bounded capabilities.

Candidate capability families:

```text
repo.read
repo.write_worktree
repo.commit
repo.open_pr
repo.merge

shell.run_sandboxed
filesystem.read_scope
filesystem.write_scope

browser.navigate
browser.interact
browser.capture

email.read
email.draft
email.send

web.fetch
research.search

commerce.search
commerce.prepare_order
commerce.place_order

artifact.read
artifact.write
```

Each grant includes:

- scope;
- allowed operations;
- expiry;
- risk class;
- whether human approval is required;
- idempotency behavior;
- audit requirements.

Examples:

- `email.draft` may be low/medium risk.
- `email.send` normally requires explicit approval unless a narrow pre-authorized policy exists.
- `commerce.prepare_order` may be autonomous.
- `commerce.place_order` requires explicit approval and a price/merchant/item binding.
- `repo.open_pr` may be autonomous.
- `repo.merge` is governed per repository/risk policy.
- destructive filesystem or deployment operations require bounded command scope and approval.

---

# 13. Secrets and identity

The agent must not receive raw secrets.

```text
Agent requests bounded capability
  → Worker capability broker
  → policy check
  → managed identity / Key Vault / OS credential store
  → broker performs operation
  → sanitized result returned to agent
```

Requirements:

- no secrets in prompt text;
- no secrets in agent environment variables unless unavoidable and explicitly policy-approved;
- no secrets in logs/artifacts;
- redaction scan before artifact persistence;
- separate credentials by capability and environment;
- least privilege;
- every secret-backed operation is auditable;
- worker identity, not agent prose, authorizes access.

---

# 14. Agent role contracts

## 14.1 Explorer/Planner

Inputs:

- immutable task contract;
- permitted repository/context sources;
- prior iteration facts when policy allows;
- no hidden owner conversation.

Outputs:

- structured understanding;
- assumptions and unknowns;
- plan;
- proposed verification approach;
- requested capabilities;
- contract-change requests if meaning is unclear.

Must not implement before the plan/flow permits it.

## 14.2 Design Reviewer

Inputs:

- exact contract;
- grounded design/plan;
- relevant code/context;
- rubric.

Outputs:

```text
pass
needs_revision
blocked
```

with structured findings and affected criteria/boundaries.

The reviewer does not rewrite the plan silently. The control plane returns revision findings to the planner/implementer through a new stage attempt.

## 14.3 Implementer

Inputs:

- immutable contract version;
- approved plan when required;
- structured reviewer findings;
- bounded workspace/capabilities.

Outputs:

- candidate reference;
- code/action artifacts;
- local checks;
- factual activity summary;
- limitations.

The implementer’s assessment is `agent_claim`, never final authority.

## 14.4 Verifier

Use a fresh context/runtime when practical.

Inputs:

- contract and criteria;
- candidate reference;
- verification policy;
- target environment;
- no implementer persuasive summary as authority.

Outputs:

- primary observations;
- criterion-level results;
- artifacts;
- limitations;
- environment facts.

The verifier does not decide product acceptance beyond observed facts.

## 14.5 Evaluator

Inputs:

- immutable contract;
- candidate binding;
- evidence manifest;
- verification result;
- deterministic gate outputs;
- evaluator rubric/policy.

Must not receive implementer self-evaluation as authoritative input. It may receive the implementer report only in a clearly labeled, low-trust evidence channel if necessary to locate artifacts; the verdict must rely on primary evidence.

Outputs a structured `EvaluationVerdict`.

## 14.6 Learning Analyst

Runs after completion/failure or periodically.

Outputs `LearningProposal` records only. It cannot modify architecture, rules, prompts, tests, policies, or workflow directly.

---

# 15. Evaluation policy

Use deterministic evaluation first.

Evaluation order:

1. contract/candidate/evidence binding integrity;
2. policy and permission compliance;
3. required mechanical gates;
4. required real-surface verification;
5. criterion evidence sufficiency;
6. independent model judgment only where mechanical proof is insufficient;
7. unresolved risk assessment;
8. next-stage recommendation.

A pass requires:

- all required criteria pass under the correct authority;
- no stale candidate or stale evidence;
- no blocking policy violation;
- no missing required evidence;
- no unresolved critical finding;
- contract hash and evidence hash match the decision record.

“Need more evidence” is distinct from “implementation failed.”

---

# 16. Outcome-first Hercules Web UI

This is a V1 product requirement, not optional polish.

The operator must be able to **quickly and safely verify** a task from the existing Hercules Web interface without reading internal logs.

## 16.1 Design goal

On the first screen, answer:

1. What did I ask for?
2. What is the outcome?
3. Is the result independently verified?
4. Which acceptance criteria passed or failed?
5. What risk or uncertainty remains?
6. What decision is required from me?
7. Is my decision bound to the exact verified candidate?

Everything else is expandable.

## 16.2 Task list / dashboard

Each task card should show:

- concise title;
- current lifecycle state;
- outcome state:
  - `Working`
  - `Verified`
  - `Blocked`
  - `Needs your decision`
  - `Completed`
  - `Failed`
- risk class;
- latest evaluator verdict;
- number of passed/failed/pending criteria;
- whether evidence is fresh;
- one clear next action.

Do not show large logs or full agent prose on the card.

## 16.3 Task detail: first viewport

The first viewport should contain an **Outcome Review Card**.

### A. Outcome statement

A short system-generated statement of what actually happened, not what the agent intended.

Example:

> Old registration entry removed. Direct URL now shows the retirement notice. Navigation and mobile entry were verified against candidate `abc1234`.

### B. Decision banner

One of:

- **Verified — no action required**
- **Safe to approve**
- **Approval required for high-risk next action**
- **Changes required**
- **Insufficient evidence**
- **Blocked — owner decision needed**

The banner is derived from structured state, not free-form agent text.

### C. Trust summary

Display separate axes:

```text
Contract binding     pass/fail
Mechanical checks    pass/fail/n/a
Real-surface proof   pass/fail/missing/n/a
Independent review   pass/fail/n/a
Independent eval     pass/fail/need evidence
Human decision       pending/approved/n/a
```

Do not collapse these into one false green indicator.

### D. Acceptance Criteria Matrix

Each row displays:

- criterion text;
- authority;
- status;
- evidence freshness;
- number/type of evidence artifacts;
- concise reason;
- “View evidence” action.

A user should be able to inspect the strongest evidence for one criterion in one click.

### E. Remaining risk

Separate:

- blocking findings;
- non-blocking risks;
- known limitations;
- external eventual-consistency concerns;
- cost or operational follow-up.

### F. Decision controls

Only show valid decisions for the current state.

Examples:

- Approve outcome
- Request changes
- Reject
- Approve high-risk action
- Approve deployment
- Approve/reject contract change
- Cancel task

## 16.4 Progressive disclosure

Collapsed by default:

- detailed plan;
- full iteration timeline;
- agent activity;
- raw logs;
- full diff;
- all screenshots;
- model prompts/responses;
- cost details;
- prior failed iterations.

These remain accessible for debugging/audit.

## 16.5 Evidence viewer

The evidence drawer/viewer must show:

- artifact type;
- producer;
- captured timestamp;
- target environment;
- candidate binding;
- criterion binding;
- primary vs derived vs agent claim;
- checksum;
- stale/fresh status;
- redaction/restriction state;
- preview/download where safe.

For screenshots or browser evidence, show the image plus the exact action/observation it proves. For logs, highlight relevant excerpts but allow full raw access.

## 16.6 Iteration history

Use the existing timeline concept but distinguish:

- implementation attempt;
- verification attempt;
- evaluation verdict;
- automatic repair;
- human feedback;
- contract version changes.

Prior iterations are immutable and visually marked as superseded/failed, never overwritten.

## 16.7 Learning proposals

Learning proposals appear in a separate panel after outcome review.

For each proposal the operator can:

- approve;
- reject;
- edit and approve;
- request more analysis.

Task approval must not implicitly approve learning proposals.

## 16.8 Safe decision binding

Every decision request sent by the UI includes:

- task ID;
- contract hash;
- iteration ID;
- candidate ref/verified SHA;
- evidence manifest hash;
- current state version/idempotency token.

The server rejects a decision when any binding is stale.

The UI must:

- refresh and clearly explain stale decisions;
- disable or hide impossible actions;
- use confirmation for irreversible/high-risk actions;
- display exactly what will happen;
- avoid ambiguous button labels such as only “OK”;
- never let a stale browser tab approve a newer candidate.

For critical actions, require a second confirmation or typed confirmation according to policy.

## 16.9 Mobile and accessibility

The current Web UI is mobile-oriented and must remain usable on iPhone.

Requirements:

- primary outcome and decision fit in the first mobile viewport as much as practical;
- criterion matrix becomes readable cards on narrow screens;
- no hover-only evidence access;
- keyboard and screen-reader labels;
- clear focus behavior;
- minimum touch targets;
- destructive and safe actions visually distinct without relying only on color.

## 16.10 Web UI acceptance criteria

The implementation is not complete until these are proven:

1. A user can open a completed task and understand outcome, evaluator verdict, criteria status, and remaining risk without opening raw logs.
2. Each criterion links to its bound evidence.
3. A changed candidate invalidates the existing decision action.
4. A stale tab cannot approve a newer iteration.
5. High-risk actions require the configured confirmation.
6. “Request changes” creates a new iteration and preserves prior history.
7. Learning proposals are reviewed separately from task outcome.
8. Failed/missing verification is never presented as green.
9. Agent self-assessment is visibly lower-trust when displayed.
10. Mobile layout supports the same safe decisions.
11. Render tests assert actual click-to-request payloads.
12. L2/browser evidence exercises the real task detail and decision path using seeded fixtures, not placeholder elements.

---

# 17. Control API V2

Do not break existing API consumers. Introduce `/api/v2` or an equivalent versioned boundary.

Suggested public endpoints:

```text
POST   /api/v2/tasks
GET    /api/v2/tasks
GET    /api/v2/tasks/:taskId
GET    /api/v2/tasks/:taskId/review-package
GET    /api/v2/tasks/:taskId/iterations
GET    /api/v2/iterations/:iterationId
GET    /api/v2/artifacts/:artifactId/metadata
GET    /api/v2/artifacts/:artifactId/content

POST   /api/v2/tasks/:taskId/decisions
POST   /api/v2/tasks/:taskId/contract-change-requests
POST   /api/v2/contract-change-requests/:id/decisions
POST   /api/v2/learning-proposals/:id/decisions

GET    /api/v2/events                  (SSE or resumable event stream)
POST   /api/v2/webhooks/subscriptions
```

Internal worker endpoints or transport:

```text
POST   /internal/v1/workers/register
POST   /internal/v1/jobs/lease
POST   /internal/v1/jobs/:id/heartbeat
POST   /internal/v1/jobs/:id/result
POST   /internal/v1/artifacts
```

Requirements:

- idempotency keys for creates/decisions;
- optimistic state/version checks;
- explicit error codes;
- no client directly mutates DB state;
- Web UI uses the same API semantics as Grok Bot/CLI;
- external clients receive outcome-oriented responses and event notifications;
- internal workflow details remain queryable but are not required to use the API.

Example task creation:

```json
{
  "title": "Remove the retired registration entry",
  "objective": "Users must no longer enter the retired flow.",
  "context": [{"type": "repo", "value": "site"}],
  "riskClass": "medium",
  "clientRequestId": "grokbot-...",
  "requestedCapabilities": ["repo.write_worktree", "browser.interact"]
}
```

Example completion event:

```json
{
  "type": "task.completed",
  "taskId": "task-...",
  "outcome": "Retired entry removed and real user paths verified.",
  "evaluation": "pass",
  "reviewPackageUrl": "/api/v2/tasks/task-.../review-package",
  "requiresHumanDecision": false
}
```

---

# 18. Human escalation and risk policy

## 18.1 Default autonomy

The system proceeds without human intervention for reversible, bounded actions when policy, evidence, and evaluation pass.

## 18.2 Always or normally escalate

- spending or purchase placement;
- sending external email/message unless narrowly pre-authorized;
- production deployment;
- destructive deletion beyond a reversible trash/quarantine;
- credential/permission expansion;
- legal/financial/medical/high-stakes communication;
- contract meaning change;
- critical security boundary change;
- merge to protected or production branches when repo policy requires;
- cost budget expansion;
- evaluator conflict or repeated failure.

## 18.3 Review package for escalation

The operator sees:

- exact requested action;
- why it is needed;
- risk;
- affected target;
- maximum scope/cost;
- evidence already gathered;
- rollback/recovery;
- exact binding;
- approve/reject/edit options.

---

# 19. Backward-compatible migration strategy

## Phase 0 — Baseline and contract tests

Before behavior change:

- capture current task/API/review packet fixtures;
- add compatibility tests for task-file parsing/writing and existing API paths;
- define baseline review-time and evidence metrics;
- identify current production control repo and backup path;
- ensure rollback instructions.

## Phase 1 — Add V2 pure domain contracts

Add the new pure types and state-transition functions. No runtime cutover.

Proof:

- unit tests;
- invariants;
- compile/lint;
- mapping tests from current `Task`/DoD types.

## Phase 2 — Add embedded DB and event log in shadow mode

- migrations;
- state store port;
- shadow projection from current authoritative mutations;
- startup/restart/recovery tests;
- no user-visible behavior change.

Proof:

- every current mutation yields equivalent shadow state/event;
- divergence test blocks cutover;
- DB rebuild/export test.

## Phase 3 — Add content-addressed artifact/evidence manifest

- persist structured evidence refs;
- bind current packet outputs to candidate SHA;
- preserve existing Review Packet rendering.

Proof:

- hash integrity;
- missing/tampered artifact detection;
- criterion-to-evidence mappings;
- restart persistence.

## Phase 4 — Add V2 outcome review package API

Project current and new records into a structured `ReviewPackageV2`.

Proof:

- stable fixture schema;
- stale binding detection;
- existing API unchanged.

## Phase 5 — Add outcome-first Web UI behind a feature flag

- task detail first viewport;
- acceptance matrix;
- evidence viewer;
- safe decision payload;
- iteration history;
- learning panel placeholder only when backed by real data.

Proof:

- render tests;
- click-to-request payload assertions;
- L2 real browser scenes;
- mobile viewport checks;
- no placeholder selectors.

## Phase 6 — Separate verification and evaluation runs

- verifier result contract;
- evaluator input isolation;
- independent verdict;
- automatic repair routing.

Proof:

- evaluator does not rely on implementer self-report;
- failed criterion creates a new iteration;
- missing evidence routes to reverify, not arbitrary implementation rewrite;
- fresh verifier/evaluator records.

## Phase 7 — Add local Worker Port/JobSpec boundary

- control plane serializes job;
- local worker leases and runs it;
- structured result;
- heartbeats/recovery;
- same-machine deployment.

Proof:

- control service restart;
- worker restart;
- duplicate result/idempotency;
- lease expiry;
- no direct worker DB mutation.

## Phase 8 — Introduce Control API V2 clients

- Web UI moves to V2 for new review screen;
- generic task create/status/events;
- Grok Bot/CLI proof client.

Proof:

- same task semantics from two clients;
- idempotent create;
- event resume.

## Phase 9 — Controlled authority cutover

Only after shadow parity:

- DB becomes primary for V2 tasks;
- Git task files become compatibility/audit projection;
- current tasks remain supported;
- rollback remains possible.

This phase requires explicit owner approval.

## Phase 10 — General task capability slices

Add bounded task families through capability adapters, not bespoke orchestrator branches.

Suggested order:

1. code task;
2. browser task;
3. structured file/information task;
4. email draft/read;
5. external send/purchase only after approval UX and policy proof.

---

# 20. Recommended first PR sequence

Each PR must be narrow and independently verifiable.

## PR 1 — V2 domain vocabulary only

Add pure models and tests for:

- TaskContract
- ContractCriterion
- Iteration
- StageRun
- ArtifactRef
- EvidenceManifest
- EvaluationVerdict
- HumanDecision

No DB, API, UI, or current state changes.

## PR 2 — Contract mapping and hashing

- map current typed DoD to V2 criteria without authority loss;
- canonical contract serialization/hash;
- contract-change request model;
- mapping tests.

## PR 3 — State store port and migrations

- embedded DB setup;
- migration runner;
- event transaction;
- repository interfaces;
- restart/integrity tests.

No current authority cutover.

## PR 4 — Shadow task/iteration projection

- listen to current authoritative mutations;
- populate V2 shadow records;
- reconciliation report;
- no user-visible behavior change.

## PR 5 — Artifact store and evidence manifest

- filesystem content addressing;
- DB metadata;
- evidence binding;
- tamper/missing tests.

## PR 6 — ReviewPackageV2 projector/API

- outcome summary;
- trust axes;
- criterion matrix;
- remaining risks;
- safe decision bindings.

## PR 7 — Outcome-first Web review screen

- focused components under `src/web/review/`;
- feature flag;
- real render tests and L2 browser evidence.

## PR 8 — Evaluation boundary

- evaluator port;
- structured verdict;
- self-report isolation;
- need-more-evidence vs fail distinction.

## PR 9 — Automatic iteration repair

- new iteration creation;
- structured feedback;
- retry/escalation budget;
- prior-history preservation.

## PR 10 — Local worker protocol

- serializable JobSpec/ResultPackage;
- local worker;
- leases/heartbeats/idempotency.

## PR 11 — Generic Control API V2

- task creation/status/events;
- Web UI uses V2 path for the new flow;
- one CLI or test client.

## PR 12 — First non-code capability proof

- browser or bounded file/information task;
- same contract/evidence/evaluation/review experience.

Do not start PR 7 by rewriting all of `App.tsx`. Do not start PR 10 by deploying multiple machines.

---

# 21. Verification and evaluation of the migration itself

The project must prove that the redesign improves trust rather than only adding documents.

## 21.1 Baseline task corpus

Create a held-out corpus using representative current artifacts:

- small bug fix;
- feature spanning several files;
- browser/UI behavior change;
- failed gate;
- missing browser environment;
- stale verified SHA;
- reviewer rejection;
- automatic repair;
- no-file-change task;
- high-risk host/deploy action;
- intentionally misleading implementer report;
- evidence artifact tampering/missing file;
- task requiring human criterion.

## 21.2 Metrics

Track before/after:

- operator time to reach a correct decision;
- percentage of criteria with directly bound evidence;
- false-green rate;
- stale-approval prevention rate;
- automatic repair convergence;
- repeated-failure escalation quality;
- task completion rate;
- human-intervention rate by risk class;
- cost per successful task;
- duplicate/replayed action rate;
- evidence recovery after restart;
- cross-task isolation failures;
- API compatibility failures.

## 21.3 Critical security/reliability tests

- stale UI approval rejected;
- altered candidate invalidates verdict;
- altered evidence manifest invalidates verdict;
- implementer cannot set evaluator pass;
- worker cannot mutate control DB directly;
- duplicate external request is idempotent;
- no raw secret appears in prompt/log/artifact fixtures;
- irreversible action cannot replay after restart;
- failed verifier does not become pass due to evaluator prose;
- task contract cannot change without a new version/decision.

## 21.4 Web proof

The Web interface itself must be verified at three levels:

1. pure/domain projection tests;
2. jsdom/Testing Library click-to-request render tests;
3. real L2 browser evidence using seeded, non-production control fixtures.

The strongest proof is a real operator scenario:

> Open a completed task on a mobile viewport, inspect the outcome and one criterion’s evidence, attempt a stale approval and observe rejection, refresh to the current binding, request changes, and confirm a new iteration appears while the prior iteration remains immutable.

---

# 22. Review Package V2 schema

```ts
interface ReviewPackageV2 {
  task: {
    id: string;
    title: string;
    objective: string;
    riskClass: string;
    state: string;
  };
  binding: {
    contractVersion: number;
    contractHash: string;
    iterationId: string;
    candidateRef: CandidateRef;
    evidenceManifestHash: string;
  };
  outcome: {
    summary: string;
    status: 'verified' | 'blocked' | 'needs_human' | 'failed';
    evaluatorOutcome: EvaluationVerdict['outcome'];
    durationMs: number;
    cost: UsageRecord | null;
  };
  trustAxes: {
    contractBinding: AxisStatus;
    mechanical: AxisStatus;
    realSurface: AxisStatus;
    independentReview: AxisStatus;
    independentEvaluation: AxisStatus;
    human: AxisStatus;
  };
  criteria: readonly CriterionResultView[];
  blockingFindings: readonly Finding[];
  remainingRisks: readonly Finding[];
  requiredDecision: RequiredDecision | null;
  iterations: readonly IterationSummary[];
  evidence: readonly EvidenceSummary[];
  learningProposals: readonly LearningProposalSummary[];
  decisionToken: {
    stateVersion: number;
    idempotencyKey: string;
  } | null;
}
```

The summary is a projection. The authoritative records remain contract, artifacts, criterion results, verdicts, events, and decisions.

---

# 23. Failure taxonomy

Use structured failure classes so the control plane chooses the right loop.

```text
implementation_defect
design_defect
contract_ambiguity
missing_evidence
verification_environment
verification_flake
evaluator_infrastructure
policy_denial
permission_missing
external_dependency
budget_exceeded
stale_candidate
artifact_integrity
platform_bug
platform_capability_gap
platform_limit
human_rejection
cancelled
```

Examples:

- `missing_evidence` → reverify.
- `implementation_defect` → new implementation iteration.
- `contract_ambiguity` → contract-change request/human.
- `verification_environment` → environment remediation, not code rewrite.
- `stale_candidate` → invalidate verdict and rerun on current candidate.
- `budget_exceeded` → human or policy decision.
- `policy_denial` → do not let an agent “work around” policy.

---

# 24. Learning feedback loop

After task closure or repeated failure:

1. collect structured friction/failure facts;
2. group recurring patterns;
3. create proposals in one of:
   - architecture;
   - mechanical constraint;
   - workflow;
   - verification;
   - documentation;
4. score expected benefit vs risk/cost;
5. present proposals separately in Web UI;
6. require approval for material changes;
7. implement through ordinary tasks and verification;
8. measure whether the change improves held-out outcomes.

Never let an agent directly rewrite its own governing prompt, policy, or evaluator rubric and then treat the new rule as trusted.

---

# 25. Stop conditions for implementation agents

Stop and request owner approval before:

- making the DB authoritative;
- deleting or ceasing to write current task files;
- changing existing public API semantics;
- introducing a new top-level dependency direction without mechanical enforcement;
- broad refactor of `orchestrator.ts`, `actions.ts`, `api.ts`, or `App.tsx`;
- enabling external email send, purchasing, production deployment, or destructive actions;
- changing merge/approval policy;
- weakening WORKFLOW gates;
- changing criterion authority;
- allowing automatic semantic contract changes;
- introducing raw-secret access to agents;
- removing rollback or compatibility paths.

A stop request must state the decision, alternatives, evidence, blast radius, and recommended option. Do not ask the owner to decide an empirically testable question; run the experiment first.

---

# 26. V1 completion checklist

## Control plane

- [ ] Database-backed primary state is proven and explicitly approved for cutover.
- [ ] Append-only events are transactional with state changes.
- [ ] Restart/recovery is tested.
- [ ] Generic Control API V2 is versioned and idempotent.
- [ ] Existing clients remain compatible or have an approved migration.

## Contracts and history

- [ ] Task contracts are immutable/versioned.
- [ ] Semantic changes use ContractChangeRequest.
- [ ] Iterations and stage attempts are immutable history.
- [ ] Decisions bind to exact contract/candidate/evidence.

## Execution

- [ ] Worker boundary uses JobSpec/ResultPackage.
- [ ] One-machine local worker is stable.
- [ ] Capabilities are bounded and auditable.
- [ ] Agents do not receive raw secrets.

## Verification and evaluation

- [ ] Verifier and evaluator roles are distinct.
- [ ] Fresh verifier/evaluator context is recorded when required.
- [ ] Evaluator ignores implementer self-report as authority.
- [ ] Every decision-bearing factual assertion is classified and only a
  `verified` assertion with a fresh exact primary-evidence binding is eligible.
- [ ] Inference, pending verification, opinion, and agent self-report cannot
  drive state, recommendation, approval, deployment, or automatic action.
- [ ] Missing, stale, contradictory, or tampered assertion evidence fails closed
  to `need_more_evidence`.
- [ ] Every required criterion has status and evidence.
- [ ] Missing evidence is not green.
- [ ] Automatic repair and escalation budgets work.

## Web UI

- [ ] Outcome-first review card exists.
- [ ] Operator can judge a normal task in 10–30 seconds.
- [ ] Criterion-to-evidence navigation is one click.
- [ ] Stale decisions are rejected and explained.
- [ ] High-risk confirmation is explicit.
- [ ] Mobile decision flow is usable.
- [ ] Learning proposals are separate.
- [ ] Render and L2 browser tests prove real interactions.

## General task proof

- [ ] Code task uses the V2 flow.
- [ ] Browser task uses the V2 flow.
- [ ] Non-code bounded task uses the V2 flow.
- [ ] Grok Bot or a generic test client can create and observe a task through the API.

## Measurement

- [ ] Baseline corpus exists.
- [ ] Before/after human review time is measured.
- [ ] False-green and evidence-coverage metrics are measured.
- [ ] Cost/reliability tradeoff is visible.

---

# 27. Copy-paste kickoff brief for the first implementation milestone

> You are implementing the first additive migration milestone for Hercules 2.0 V1. You have no access to the design conversation; repository documents and executable policy are authoritative. First read the user-level Codex `AGENTS.md`, locate and safely synchronize the local `example-org/review-ledger` checkout, and read `PROTOCOL.md`, `INDEX.md`, `projects/hercules/CURRENT_STATE.md`, and the selected current-machine manifest. Then locate and safely synchronize a clean Hercules worktree from current `origin/main`; do not discard unrelated work. Read Hercules `AGENTS.md`, `WORKFLOW.md`, this specification, the companion autonomous program contract (internal; not published), and the program-state YAML when present. Record exact source/document SHAs. Re-ground current code and map overlapping types. For the first coding milestone, propose and implement a narrow PR containing only pure V2 domain contracts plus tests. Preserve all current runtime, API, task-file, verification, UI, scheduling, and rollback behavior. Do not add a database, service, API route, or UI in that first coding PR. Do not change criterion authority or weaken gates. Produce exact files, dependency checks, type sketches, transition invariants, mapping strategy to current DoD, tests, verification commands, and independent-review evidence. If current code or executable policy conflicts with the specification, report the conflict with evidence rather than guessing. After merge, verify current main and update the Hercules program ledger and concise continuity handoff.

For an unattended multi-PR run, do not use this first-milestone brief alone. Use the copy-paste `/goal` instruction in the companion autonomous program contract (internal; not published), which authorizes and governs the ordered additive program through integrated qualification while preserving the final owner-only cutover gate.

---

# 28. Final design summary

Hercules 2.0 V1 is not “more agents” and not “more review text.”

It is a trustworthy autonomous task system with:

```text
one operator goal
→ immutable contract
→ structured workflow
→ bounded worker capabilities
→ isolated execution
→ real-surface verification
→ independent evaluation
→ automatic repair
→ concise outcome
→ safe human decisions only when needed
→ structured learning proposals
```

The existing Hercules execution foundation should be preserved. The migration succeeds when the operator no longer needs to understand the internal workflow in order to trust the outcome, while every important claim remains inspectable, bound, auditable, and recoverable.
