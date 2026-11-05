/**
 * Minimal fixtures for web render tests — keep payloads small and explicit.
 */
import type { RepoDto, ReleasePanelEntryDto, Task } from '../../../src/web/api.js';

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-render-1',
    title: 'Render path task',
    repo: 'app',
    state: 'review',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 1,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: '',
    ...overrides,
  };
}

/** Green machine proof + one human AC — Approve gated on the checkbox. */
export function greenReviewBody(humanText = 'Spot-check on device'): string {
  return `## Goal
Ship the change.

## Definition of Done
- [ ] (human) ${humanText}
- [ ] (mechanical) tests pass

## Review packet
**✅ automated proof complete** (human Approve still required if human ACs exist)

**Definition of Done**
| Axis | Status |
|---|---|
| mechanical (L1) | ✅ pass |
`;
}

/**
 * Machine proof incomplete (no "automated proof complete") so override-approve
 * is offered once human ACs are checked.
 */
export function blockedReviewBody(humanText = 'Spot-check on device'): string {
  return `## Goal
Ship the change.

## Definition of Done
- [ ] (human) ${humanText}

## Review packet
**Status:** needs review — L2 flaky

**Definition of Done**
| Axis | Status |
|---|---|
| mechanical (L1) | ❌ fail |
`;
}

export function makeRepo(overrides: Partial<RepoDto> = {}): RepoDto {
  return {
    key: 'app',
    url: 'git@host:org/app.git',
    defaultBranch: 'main',
    workflow: 'WORKFLOW.md',
    maxConcurrent: 1,
    adapter: null,
    effectiveAdapter: 'grok',
    readiness: 'incomplete',
    executionPolicy: {
      explicit: false,
      profile: 'compatible',
      sandbox: 'none',
      network: 'unspecified',
      envAllowlist: ['PATH', 'HOME'],
      forbidProductionSecrets: true,
      forbidConnectorCredentials: true,
      forbidLivePersonalData: true,
      workspaceWrite: false,
    },
    autoMerge: null,
    ...overrides,
  };
}

export function makeReleaseRow(
  overrides: Partial<ReleasePanelEntryDto> = {},
): ReleasePanelEntryDto {
  return {
    repoKey: 'app',
    productionSha: 'prodsha01',
    productionDeployedAt: null,
    stagingSha: 'stagesha1',
    stagingStatus: 'ready',
    stagingVerifiedAt: null,
    stagingStartedAt: null,
    stagingVerifyTimeoutMs: 15 * 60 * 1000,
    promotingSha: null,
    mainSha: 'stagesha1',
    stagingDrift: true,
    canPromote: false,
    canRollback: true,
    rollbackTargetSha: 'prodsha01',
    stagingUrl: 'https://staging.example',
    hasProductionDeploy: true,
    aheadTasks: [],
    aheadCount: 0,
    mergeableTasks: [],
    packetBody: '## Release packet\n',
    failureReason: null,
    history: [],
    trustChain: 'trust',
    operatorMergedCount: 0,
    rangeRisk: null,
    evidenceCoverage: null,
    stagingScreenshots: [],
    rollbackPreview: {
      hasTarget: true,
      targetSha: 'prodsha01',
      deployedAt: null,
    },
    stagingUiToken: null,
    afterDeployChecks: [],
    ...overrides,
  };
}

/** Default TaskDetail props for decide-path tests (callbacks overridden per case). */
export function taskDetailDefaults(task: Task) {
  return {
    task,
    now: Date.now(),
    activity: [] as string[],
    pendingChat: [] as string[],
    chatOutcome: null as string | null,
    liveRun: null,
    verificationRun: null,
    busy: false,
    pending: null as string | null,
    stopping: false,
    agentLabel: 'grok',
    inheritAgent: 'grok',
    availableAgents: ['grok', 'codex'] as const,
    onClose: () => {},
    onAction: () => {},
    onForceAbort: () => {},
    onDelete: () => {},
    onClone: () => {},
    onSalvageFork: () => {},
    onQueueFront: () => {},
    onSetAdapter: () => {},
    onChat: () => {},
    onOpenLive: () => {},
    onOpenPr: () => {},
    onApprovePr: () => {},
    onSteerFromPr: () => {},
    onApprovePlan: () => {},
    onApproveHostOperation: () => {},
    onReverify: () => {},
  };
}
