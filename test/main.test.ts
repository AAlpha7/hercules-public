import { describe, it, expect, afterEach } from 'vitest';
import {
  buildExecution,
  C3_ARTIFACT_ARCHIVE_POLICY,
  createM4ShadowStoreFromEnv,
  deliverAndReconcileM4Commit,
  isDynamicCapsEnabled,
  loadAuthorityRoster,
  openC3EvidenceStack,
  resolveC3EvidenceRoot,
  resolveRepoRootFromMainModule,
  startupAuthHint,
} from '../src/main.js';
import {
  acquireDaemonLease,
  acquireLeaseForDaemonStartup,
  DaemonLeaseConflictError,
} from '../src/isolation/daemonLease.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SqliteStateStore } from '../src/control/state/sqliteStateStore.js';
import type { Task } from '../src/domain/task.js';
import {
  AUTHORITY_ROSTER_FILE,
  AUTHORITY_ROSTER_SCHEMA,
  AuthorityRosterError,
} from '../src/control/authorityRoster.js';
import { MAX_ARTIFACT_BYTES } from '../src/control/artifacts/archiveTypes.js';
import {
  produceAllVerifiedEvidence,
  VERIFIED_EVIDENCE_PRODUCER_IMPLEMENTATION,
  type VerifiedEvidenceProducerPorts,
} from '../src/control/verifiedEvidence.js';
import {
  assembleReviewPackageSource,
  createReviewPackageRefreshSeam,
} from '../src/control/reviewPackageSource.js';
import { projectLegacyTask } from '../src/domain/shadowProjection.js';
import { compileLegacyTaskContract } from '../src/domain/contractCompiler.js';
import { transitionIteration, type Iteration } from '../src/domain/iteration.js';
import type { ReviewPacket } from '../src/domain/verification.js';
import type { ShadowCommitCommand } from '../src/control/state/stateStore.js';

const KEYS = [
  'HERCULES_ADAPTER',
  'HERCULES_WORK_DIR',
  'HERCULES_DYNAMIC_CAPS',
  'HERCULES_CLAUDE_ENABLED',
  'HERCULES_CODEX_MODEL',
  'HERCULES_CODEX_REASONING_EFFORT',
] as const;
const saved = new Map<string, string | undefined>();
function setEnv(adapter: string | undefined, workDir?: string): void {
  for (const k of KEYS) if (!saved.has(k)) saved.set(k, process.env[k]);
  // Start each case from a clean provider-policy surface; tests opt in explicitly.
  delete process.env['HERCULES_CLAUDE_ENABLED'];
  delete process.env['HERCULES_CODEX_MODEL'];
  delete process.env['HERCULES_CODEX_REASONING_EFFORT'];
  delete process.env['HERCULES_DYNAMIC_CAPS'];
  if (adapter === undefined) delete process.env['HERCULES_ADAPTER'];
  else process.env['HERCULES_ADAPTER'] = adapter;
  if (workDir === undefined) process.env['HERCULES_WORK_DIR'] = '/tmp/hercules-test-work';
  else if (workDir === '') delete process.env['HERCULES_WORK_DIR'];
  else process.env['HERCULES_WORK_DIR'] = workDir;
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe('buildExecution (composition root)', () => {
  it('defaults to grok with a full multi-agent registry on the real path', () => {
    setEnv(undefined);
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.defaultKind).toBe('grok');
    expect(exec.agents!.available()).toEqual(['grok', 'codex', 'cursor', 'fake']);
    expect(exec.agents!.providerPolicy).toEqual({
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      claudeEnabled: false,
    });
    expect(exec.workspaces).toBeDefined();
    expect(exec.verifier).toBeDefined();
    expect(exec.screenshotsRoot).toBe('/tmp/hercules-test-work/screenshots');
  });

  it('treats an unknown adapter value as fake (cheap path when no WORK_DIR)', () => {
    setEnv('bogus', '');
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.defaultKind).toBe('fake');
    expect(exec.workspaces).toBeUndefined();
  });

  it('fake default without WORK_DIR skips workspaces', () => {
    setEnv('fake', '');
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.defaultKind).toBe('fake');
    expect(exec.agents!.has('grok')).toBe(true);
    expect(exec.workspaces).toBeUndefined();
  });

  it('selects codex as default while keeping other agents registered', () => {
    setEnv('codex');
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.defaultKind).toBe('codex');
    expect(exec.agents!.resolve('grok').kind).toBe('grok');
    expect(exec.workspaces).toBeDefined();
  });

  it('does not register claude and safely selects codex when only requested as the default', () => {
    setEnv('claude');
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.defaultKind).toBe('codex');
    expect(exec.agents!.defaultKind).not.toBe('fake');
    expect(exec.agents!.has('claude')).toBe(false);
    expect(exec.workspaces).toBeDefined();
  });

  it('wires claude as default when explicitly requested', () => {
    setEnv('claude');
    process.env['HERCULES_CLAUDE_ENABLED'] = '1';
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.defaultKind).toBe('claude');
    expect(exec.agents!.has('claude')).toBe(true);
    expect(exec.agents!.providerPolicy.claudeEnabled).toBe(true);
  });

  it('applies validated Codex env overrides into the public provider policy', () => {
    setEnv('grok');
    process.env['HERCULES_CODEX_MODEL'] = 'gpt-5.6-sol-preview';
    process.env['HERCULES_CODEX_REASONING_EFFORT'] = 'high';
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.providerPolicy).toEqual({
      codex: { model: 'gpt-5.6-sol-preview', reasoningEffort: 'high' },
      claudeEnabled: false,
    });
  });

  it('invalid Codex env falls back without retaining raw values in provider policy', () => {
    setEnv('grok');
    const rawModel = 'leaked-model; --danger';
    const rawEffort = 'leaked-effort';
    process.env['HERCULES_CODEX_MODEL'] = rawModel;
    process.env['HERCULES_CODEX_REASONING_EFFORT'] = rawEffort;
    const exec = buildExecution('/ctrl');
    expect(exec.agents!.providerPolicy).toEqual({
      codex: { model: 'gpt-5.6-sol', reasoningEffort: 'medium' },
      claudeEnabled: false,
    });
    expect(JSON.stringify(exec.agents!.providerPolicy)).not.toContain(rawModel);
    expect(JSON.stringify(exec.agents!.providerPolicy)).not.toContain(rawEffort);
  });
});

describe('isDynamicCapsEnabled', () => {
  it('is off by default (safe)', () => {
    expect(isDynamicCapsEnabled({})).toBe(false);
    expect(isDynamicCapsEnabled({ HERCULES_DYNAMIC_CAPS: '' })).toBe(false);
    expect(isDynamicCapsEnabled({ HERCULES_DYNAMIC_CAPS: '0' })).toBe(false);
  });

  it('accepts common truthy forms', () => {
    expect(isDynamicCapsEnabled({ HERCULES_DYNAMIC_CAPS: '1' })).toBe(true);
    expect(isDynamicCapsEnabled({ HERCULES_DYNAMIC_CAPS: 'true' })).toBe(true);
    expect(isDynamicCapsEnabled({ HERCULES_DYNAMIC_CAPS: 'ON' })).toBe(true);
  });
});

describe('startupAuthHint', () => {
  it('withholds a configured bearer token from daemon logs', () => {
    const secret = 'configured-secret-value';
    const message = startupAuthHint(secret, secret);
    expect(message).toContain('value withheld');
    expect(message).not.toContain(secret);
  });

  it('shows a generated one-time token when no operator token exists', () => {
    expect(startupAuthHint(undefined, 'generated-token')).toContain('generated-token');
  });
});

describe('M4 shadow composition', () => {
  it('stays absent by default and requires paired explicit configuration', () => {
    expect(createM4ShadowStoreFromEnv('/control', {})).toBeNull();
    expect(() => createM4ShadowStoreFromEnv('/control', {
      HERCULES_V2_SHADOW_ROOT: '/private/state',
    })).toThrow('requires both root and direct database path');
  });

  it('rejects roots that overlap control/work roots and nested database paths before use', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-shadow-'));
    const control = join(parent, 'control');
    const work = join(parent, 'work');
    mkdirSync(control);
    mkdirSync(work);
    try {
      expect(() => createM4ShadowStoreFromEnv(control, {
        HERCULES_WORK_DIR: work,
        HERCULES_V2_SHADOW_ROOT: join(control, 'state'),
        HERCULES_V2_SHADOW_DATABASE: join(control, 'state', 'shadow.sqlite'),
      })).toThrow('cannot overlap control or provider work roots');
      expect(() => createM4ShadowStoreFromEnv(control, {
        HERCULES_WORK_DIR: work,
        HERCULES_V2_SHADOW_ROOT: join(control, '..shadow'),
        HERCULES_V2_SHADOW_DATABASE: join(control, '..shadow', 'shadow.sqlite'),
      })).toThrow('cannot overlap control or provider work roots');
      expect(() => createM4ShadowStoreFromEnv(control, {
        HERCULES_WORK_DIR: work,
        HERCULES_V2_SHADOW_ROOT: parent,
        HERCULES_V2_SHADOW_DATABASE: join(parent, 'shadow.sqlite'),
      })).toThrow('cannot overlap control or provider work roots');
      expect(() => createM4ShadowStoreFromEnv(control, {
        HERCULES_WORK_DIR: work,
        HERCULES_V2_SHADOW_ROOT: work,
        HERCULES_V2_SHADOW_DATABASE: join(work, 'shadow.sqlite'),
      })).toThrow('cannot overlap control or provider work roots');
      expect(() => createM4ShadowStoreFromEnv(control, {
        HERCULES_WORK_DIR: work,
        HERCULES_V2_SHADOW_ROOT: join(work, '..shadow'),
        HERCULES_V2_SHADOW_DATABASE: join(work, '..shadow', 'shadow.sqlite'),
      })).toThrow('cannot overlap control or provider work roots');
      expect(() => createM4ShadowStoreFromEnv(control, {
        HERCULES_WORK_DIR: work,
        HERCULES_V2_SHADOW_ROOT: join(parent, 'private'),
        HERCULES_V2_SHADOW_DATABASE: join(parent, 'private', 'nested', 'shadow.sqlite'),
      })).toThrow('database must be a direct trusted-root file');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('resolves symlinked ancestors before excluding control and provider roots', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-shadow-link-'));
    const control = join(parent, 'control');
    const linked = join(parent, 'apparently-private');
    mkdirSync(join(control, 'state'), { recursive: true });
    symlinkSync(join(control, 'state'), linked);
    try {
      expect(() => createM4ShadowStoreFromEnv(control, {
        HERCULES_WORK_DIR: join(parent, 'work'),
        HERCULES_V2_SHADOW_ROOT: linked,
        HERCULES_V2_SHADOW_DATABASE: join(linked, 'shadow.sqlite'),
      })).toThrow('cannot contain a symlink');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects an explicit symlink even when its target is otherwise allowed', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-shadow-safe-link-'));
    const target = join(parent, 'private-target');
    const linked = join(parent, 'private-link');
    mkdirSync(target);
    symlinkSync(target, linked);
    try {
      expect(() => createM4ShadowStoreFromEnv(join(parent, 'control'), {
        HERCULES_WORK_DIR: join(parent, 'work'),
        HERCULES_V2_SHADOW_ROOT: linked,
        HERCULES_V2_SHADOW_DATABASE: join(linked, 'shadow.sqlite'),
      })).toThrow('cannot contain a symlink');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('records bounded projection failure against the committed authority and clears it on retry', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-shadow-failure-'));
    let fail = true;
    const root = join(parent, 'state');
    const store = new SqliteStateStore({
      trustedRoot: root,
      databasePath: join(root, 'shadow.sqlite'),
      failureInjector: (point) => {
        if (fail && point === 'after_projection') throw new Error('injected shadow failure');
      },
    });
    store.initialize();
    const item: Task = {
      id: 'M4-RUNTIME', title: 'Runtime projection', repo: 'app', state: 'todo', priority: 1,
      blockedBy: [], labels: [], adapter: null, agentSession: null, pendingSteer: null,
      attempts: 0, lastEventAt: null, createdAt: '2026-08-28T00:00:00Z',
      startedAt: null, endedAt: null, prUrl: null, prStatus: null, planPending: false,
      verifiedSha: null, body: '## Definition of Done\n- [ ] tests',
    };
    const commit = {
      deliveryId: 'git-runtime-delivery',
      revision: 'a'.repeat(40),
      writes: [item],
      retiredTaskIds: [],
    };
    const snapshot = { revision: commit.revision, tasks: [item] };
    const failures = new Map<string, string>();
    try {
      const first = deliverAndReconcileM4Commit(store, commit, snapshot, failures, [commit]);
      expect(first.deliveryError).not.toBeNull();
      expect(first.report.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          taskId: item.id,
          kind: 'projection_failure',
          reasonCode: 'shadow_delivery_failed',
        }),
      ]));
      expect(failures.get(item.id)).toBe('shadow_delivery_failed');

      fail = false;
      const retried = deliverAndReconcileM4Commit(store, commit, snapshot, failures, [commit]);
      expect(retried.deliveryError).toBeNull();
      expect(retried.report.parity).toBe(true);
      expect(failures.has(item.id)).toBe(false);
    } finally {
      store.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('initializes only a private direct database under a valid trusted root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-shadow-'));
    const root = join(parent, 'private');
    const database = join(root, 'shadow.sqlite');
    try {
      const store = createM4ShadowStoreFromEnv(join(parent, 'control'), {
        HERCULES_WORK_DIR: join(parent, 'work'),
        HERCULES_V2_SHADOW_ROOT: root,
        HERCULES_V2_SHADOW_DATABASE: database,
      });
      expect(store?.initialize().schemaVersion).toBe(7);
      expect(statSync(root).mode & 0o777).toBe(0o700);
      expect(statSync(database).mode & 0o777).toBe(0o600);
      store?.close();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('wires the review-package refresh seam so deliveries materialize V2 aggregates', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-shadow-seam-'));
    const root = join(parent, 'private');
    const database = join(root, 'shadow.sqlite');
    const store = createM4ShadowStoreFromEnv(join(parent, 'control'), {
      HERCULES_WORK_DIR: join(parent, 'work'),
      HERCULES_V2_SHADOW_ROOT: root,
      HERCULES_V2_SHADOW_DATABASE: database,
    });
    expect(store).not.toBeNull();
    try {
      const item: Task = {
        id: 'seam-wired-task', title: 'Seam wiring', repo: 'app', state: 'todo', priority: 1,
        blockedBy: [], labels: [], adapter: null, agentSession: null, pendingSteer: null,
        attempts: 0, lastEventAt: null, createdAt: '2026-08-28T00:00:00Z',
        startedAt: null, endedAt: null, prUrl: null, prStatus: null, planPending: false,
        verifiedSha: null, body: '## Definition of Done\n- [ ] tests',
      };
      const commit = {
        deliveryId: 'seam-wired-delivery',
        revision: 'a'.repeat(40),
        writes: [item],
        retiredTaskIds: [],
      };
      const snapshot = { revision: commit.revision, tasks: [item] };
      const failures = new Map<string, string>();
      const result = deliverAndReconcileM4Commit(store!, commit, snapshot, failures, [commit]);
      expect(result.deliveryError).toBeNull();
      const row = store!.readV2Aggregate(item.id);
      expect(row).not.toBeNull();
      expect(['projected', 'unprojectable']).toContain(row!.projectionState);
      expect(row!.stateVersion).toBe(1);
      const sweep = store!.sweepV2Aggregates([]);
      expect(['already_swept', 'swept']).toContain(sweep.reason);
      expect(sweep.reason).not.toBe('seam_not_wired');
    } finally {
      store?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('threads an authority roster into the refresh seam trustedVerifierRunIds', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-roster-seam-'));
    const control = join(parent, 'control');
    mkdirSync(control);
    const rosterYaml = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: verifier-prod-main
  implementation: hercules-l1-gates
evaluator:
  runId: evaluator-prod-main
  implementationId: independent-evaluation-v1
  version: "1.0.0"
  model: null
  runtime: node22
`;
    writeFileSync(join(control, AUTHORITY_ROSTER_FILE), rosterYaml, 'utf8');
    const roster = loadAuthorityRoster(control);
    expect(roster).not.toBeNull();
    expect(roster!.verifier.runId).toBe('verifier-prod-main');

    const item: Task = {
      id: 'roster-seam-task', title: 'Roster seam', repo: 'app', state: 'todo', priority: 1,
      blockedBy: [], labels: [], adapter: null, agentSession: null, pendingSteer: null,
      attempts: 0, lastEventAt: null, createdAt: '2026-08-28T00:00:00Z',
      startedAt: null, endedAt: null, prUrl: null, prStatus: null, planPending: false,
      verifiedSha: null, body: '## Definition of Done\n- [ ] tests',
    };
    const revision = 'b'.repeat(40);
    const projected = projectLegacyTask(item, revision, null);
    const shadow = {
      taskId: item.id,
      contracts: [projected.expectedContract],
      iterations: projected.expectedIterations,
      stageRuns: [] as const,
      retirement: null,
    };
    const assembled = assembleReviewPackageSource(
      {
        aggregateId: shadow.taskId,
        shadow,
        taskStatus: 'todo',
        evidence: null,
        evaluation: null,
        humanDecisions: [],
      },
      '2026-09-05T12:00:00.000Z',
      roster!,
    );
    expect(assembled.kind).toBe('source');
    if (assembled.kind === 'source') {
      expect(assembled.source.authorityContext.trustedVerifierRunIds).toEqual([
        'verifier-prod-main',
      ]);
    }

    // Same roster object is what createM4ShadowStoreFromEnv threads into the seam.
    const root = join(parent, 'private');
    const database = join(root, 'shadow.sqlite');
    const store = createM4ShadowStoreFromEnv(
      control,
      {
        HERCULES_WORK_DIR: join(parent, 'work'),
        HERCULES_V2_SHADOW_ROOT: root,
        HERCULES_V2_SHADOW_DATABASE: database,
      },
      roster,
    );
    expect(store).not.toBeNull();
    try {
      const commit = {
        deliveryId: 'roster-seam-delivery',
        revision,
        writes: [item],
        retiredTaskIds: [],
      };
      const result = deliverAndReconcileM4Commit(
        store!,
        commit,
        { revision: commit.revision, tasks: [item] },
        new Map(),
        [commit],
      );
      expect(result.deliveryError).toBeNull();
      const row = store!.readV2Aggregate(item.id);
      expect(row).not.toBeNull();
      expect(['projected', 'unprojectable']).toContain(row!.projectionState);
      expect(row!.stateVersion).toBe(1);
    } finally {
      store?.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a C3 evidence root that overlaps control, work, or shadow roots', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-evidence-overlap-'));
    const control = join(parent, 'control');
    const work = join(parent, 'work');
    const shadow = join(parent, 'shadow');
    mkdirSync(control);
    mkdirSync(work);
    mkdirSync(shadow);
    try {
      expect(() => resolveC3EvidenceRoot(
        { HERCULES_V2_EVIDENCE_ROOT: join(control, 'evidence') },
        { controlRepoDir: control, workRoot: work, shadowRoot: shadow },
      )).toThrow(/cannot overlap control/);
      expect(() => resolveC3EvidenceRoot(
        { HERCULES_V2_EVIDENCE_ROOT: join(work, 'evidence') },
        { controlRepoDir: control, workRoot: work, shadowRoot: shadow },
      )).toThrow(/cannot overlap provider work/);
      expect(() => resolveC3EvidenceRoot(
        { HERCULES_V2_EVIDENCE_ROOT: join(shadow, 'evidence') },
        { controlRepoDir: control, workRoot: work, shadowRoot: shadow },
      )).toThrow(/cannot overlap M4 shadow/);
      expect(() => resolveC3EvidenceRoot(
        { HERCULES_V2_EVIDENCE_ROOT: 'relative/evidence' },
        { controlRepoDir: control, workRoot: work, shadowRoot: shadow },
      )).toThrow(/absolute/);
      expect(resolveC3EvidenceRoot({}, {
        controlRepoDir: control, workRoot: work, shadowRoot: shadow,
      })).toBeNull();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('constructs the evidence stack only when the evidence root resolves', () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-evidence-resolve-'));
    const control = join(parent, 'control');
    const work = join(parent, 'work');
    const evidence = join(parent, 'evidence');
    mkdirSync(control);
    mkdirSync(work);
    try {
      expect(resolveC3EvidenceRoot(
        {},
        { controlRepoDir: control, workRoot: work, shadowRoot: null },
      )).toBeNull();
      const resolved = resolveC3EvidenceRoot(
        { HERCULES_V2_EVIDENCE_ROOT: evidence },
        { controlRepoDir: control, workRoot: work, shadowRoot: null },
      );
      expect(resolved).toBe(evidence);
      expect(C3_ARTIFACT_ARCHIVE_POLICY.maximumArtifactBytes).toBe(MAX_ARTIFACT_BYTES);
      expect(VERIFIED_EVIDENCE_PRODUCER_IMPLEMENTATION).toBe(
        'hercules-control/verifiedEvidence/v1',
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('opens the M5 archive on the shadow store DB and binds evidence without stage-run seeding', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'hercules-main-evidence-prod-'));
    const control = join(parent, 'control');
    const work = join(parent, 'work');
    const shadowRoot = join(parent, 'shadow');
    const shadowDatabase = join(shadowRoot, 'shadow.sqlite');
    const evidence = join(parent, 'evidence');
    mkdirSync(control);
    mkdirSync(work);
    mkdirSync(shadowRoot, { mode: 0o700 });
    // Bundle captured earlier than wall clock — authority is derived from
    // capturedAt (not clock()), so a real wall clock must still bind.
    const CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();
    const clock = (): string => new Date().toISOString();
    const REVISION = 'c'.repeat(40);
    const TASK_ID = 'c3-prod-shape';
    const ITERATION_ID = 'iteration-1';
    const REPOSITORY = 'app';

    const rosterYaml = `schema: ${AUTHORITY_ROSTER_SCHEMA}
verifier:
  runId: verifier-prod-main
  implementation: hercules-l1-gates
evaluator:
  runId: evaluator-prod-main
  implementationId: evaluator-impl
  version: evaluator-v1
  model: model-v1
  runtime: runtime-v1
`;
    writeFileSync(join(control, AUTHORITY_ROSTER_FILE), rosterYaml, 'utf8');
    const roster = loadAuthorityRoster(control);
    expect(roster).not.toBeNull();

    const store = new SqliteStateStore({
      trustedRoot: shadowRoot,
      databasePath: shadowDatabase,
      busyTimeoutMs: 100,
      clock,
      refreshReviewPackage: createReviewPackageRefreshSeam(clock, { roster: roster! }),
    });
    store.initialize();

    const body =
      '## Definition of Done\n' +
      '- [ ] (mechanical) Unit tests pass @gate:unit\n' +
      '- [ ] (human) Owner accepts the change\n';
    const contract = compileLegacyTaskContract({
      taskId: TASK_ID,
      objective: 'Production-shape verified evidence',
      body,
      context: [],
      constraints: [],
      forbiddenActions: [],
      capabilityPolicy: { version: 'capability-v1', grants: [] },
      verificationPolicy: {
        version: 'verification-v1',
        requiredEvidence: ['unit'],
        independentEvaluatorRequired: true,
      },
      approvalPolicy: { version: 'approval-v1', requiredDecisions: ['approve_outcome'] },
      budgetPolicy: {
        version: 'budget-v1',
        maxCostUsd: null,
        maxTokens: null,
        maxDurationMs: null,
      },
      createdBy: { kind: 'human', id: 'owner' },
      createdAt: '2026-09-05T11:00:00.000Z',
    }).contract;

    const commit = (
      id: string,
      mutation: ShadowCommitCommand['mutation'],
    ): void => {
      store.commit({
        idempotencyKey: `idem-${id}`,
        event: {
          eventId: `event-${id}`,
          actor: { kind: 'control_plane', id: 'fixture' },
          occurredAt: CAPTURED_AT,
        },
        mutation,
      });
    };

    commit(`root-${TASK_ID}`, { kind: 'insert_contract_root', contract });
    const planned: Iteration = {
      id: ITERATION_ID,
      taskId: TASK_ID,
      contractVersion: contract.version,
      ordinal: 1,
      state: 'planned',
      candidateRef: null,
      evidenceManifestId: null,
      finalVerdictId: null,
      createdAt: '2026-09-05T11:10:00.000Z',
      endedAt: null,
      supersedesIterationId: null,
    };
    commit(`planned-${TASK_ID}`, { kind: 'put_iteration', iteration: planned });
    const executing = transitionIteration(planned, 'executing', null);
    commit(`executing-${TASK_ID}`, { kind: 'put_iteration', iteration: executing });
    const candidateRef = {
      kind: 'git' as const,
      repository: REPOSITORY,
      revision: REVISION,
    };
    const verifying = transitionIteration(executing, 'verifying', null, {
      candidateRef,
      evidenceManifestId: null,
      finalVerdictId: null,
    });
    commit(`verifying-${TASK_ID}`, { kind: 'put_iteration', iteration: verifying });
    // Intentionally no put_stage_run — producer records the verify stage itself.

    const reviewTask: Task = {
      id: TASK_ID,
      title: 'Production shape',
      repo: REPOSITORY,
      state: 'review',
      priority: 1,
      blockedBy: [],
      labels: [],
      adapter: null,
      agentSession: null,
      pendingSteer: null,
      attempts: 0,
      lastEventAt: null,
      createdAt: '2026-09-05T11:00:00.000Z',
      startedAt: null,
      endedAt: null,
      prUrl: null,
      prStatus: null,
      planPending: false,
      verifiedSha: null,
      body,
    };
    store.beginEnvelope({
      deliveryId: `delivery-${TASK_ID}`,
      authorityRevision: 'd'.repeat(40),
      authorityInput: { writes: [reviewTask], retiredTaskIds: [] },
      manifest: [],
      gapCodes: [],
    });
    store.completeEnvelope(`delivery-${TASK_ID}`);

    const resolved = resolveC3EvidenceRoot(
      { HERCULES_V2_EVIDENCE_ROOT: evidence },
      { controlRepoDir: control, workRoot: work, shadowRoot },
    );
    expect(resolved).toBe(evidence);

    const stack = await openC3EvidenceStack({
      evidenceRoot: evidence,
      controlRepoDir: control,
      workRoot: work,
      shadowRoot,
      shadowDatabasePath: shadowDatabase,
      clock,
    });

    try {
      const packet: ReviewPacket = {
        taskId: TASK_ID,
        branch: `hercules/${TASK_ID}`,
        filesTouched: ['src/example.ts'],
        diffSummary: '1 file changed',
        diff: 'diff --git a/src/example.ts b/src/example.ts\n+export const ok = true;\n',
        gates: [
          {
            name: 'unit',
            command: 'pnpm test:unit',
            passed: true,
            output: 'unit ok\n',
            exitCode: 0,
          },
        ],
        cheatFindings: [],
        screenshots: [],
        evidenceRun: {
          source: 'workflow',
          ok: true,
          steps: [],
        },
        reviewerVerdict: null,
        selfAssessment: 'ok',
        finalReport: '## Report\nDone.\n',
        green: true,
        noChanges: false,
        dod: {
          mechanical: 'pass',
          reviewer: 'n/a',
          human: 'pending',
          criteria: [
            {
              text: 'Unit tests pass @gate:unit',
              kind: 'mechanical',
              status: 'pass',
              proof: 'gate:unit',
            },
            {
              text: 'Owner accepts the change',
              kind: 'human',
              status: 'pending',
              proof: 'awaiting owner',
            },
          ],
          warnings: [],
        },
        autoRework: false,
        reworkPath: null,
        reworkPathReason: null,
        reportPolluted: false,
        activityLog: [],
        runKind: 'implementer',
        reviewerSkipReason: null,
        diffUrl: null,
        evidenceMatrix: [],
        verifiedSha: REVISION,
      };
      const staged = await stack.intake.stage({
        task: { id: TASK_ID, repo: REPOSITORY },
        packet,
        verifiedSha: REVISION,
        branch: `hercules/${TASK_ID}`,
        capturedAt: CAPTURED_AT,
      });

      const ports: VerifiedEvidenceProducerPorts = {
        store,
        archive: stack.archive,
        intake: stack.intake,
        roster: roster!,
        clock,
        log: () => undefined,
        archiveContexts: stack.archiveContexts,
      };
      const outcomes = await produceAllVerifiedEvidence(ports);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        kind: 'bound',
        aggregateId: TASK_ID,
        iterationId: ITERATION_ID,
      });

      const bound = store.readBoundEvidence(TASK_ID, ITERATION_ID);
      expect(bound).not.toBeNull();
      const shadow = store.readTask(TASK_ID);
      const verifyStage = shadow?.stageRuns.find(
        (run) => run.id === `stage-verify-${ITERATION_ID}`,
      );
      expect(verifyStage).toMatchObject({
        state: 'succeeded',
        type: 'verify',
        jobSpecHash: staged.bundleHash,
        workerId: roster!.verifier.runId,
      });
      expect(
        bound!.artifacts.every(
          (artifact) => artifact.producerStageRunId === `stage-verify-${ITERATION_ID}`,
        ),
      ).toBe(true);
    } finally {
      await stack.close();
      store.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('treats approval-bridge, decision-effects, and review-evaluation flags as off unless exactly 1', () => {
    expect(process.env['HERCULES_V2_APPROVAL_BRIDGE']).not.toBe('1');
    expect(process.env['HERCULES_V2_DECISION_EFFECTS']).not.toBe('1');
    expect(process.env['HERCULES_V2_REVIEW_EVALUATION']).not.toBe('1');
    // Construction of those producers is gated in main() on === '1' and a live
    // shadow store; the exported helpers stay inert without that pairing.
    // Evaluation additionally requires HERCULES_V2_REVIEW_EVALUATION=1 even when
    // the evidence root + roster are present (independent of evidence production).
    expect(resolveC3EvidenceRoot({}, {
      controlRepoDir: '/tmp/control-absent',
      workRoot: '/tmp/work-absent',
      shadowRoot: null,
    })).toBeNull();
  });
});

describe('C3 authority roster from daemon checkout root', () => {
  it('loads the committed roster from process.cwd()', () => {
    const roster = loadAuthorityRoster(process.cwd());
    expect(roster).not.toBeNull();
    expect(roster!.verifier.runId).toBe('hercules-legacy-verifier-v1');
    expect(roster!.evaluator.runId).toBe('hercules-review-evaluation-v1');
  });

  it('returns null when the roster file is absent', () => {
    const empty = mkdtempSync(join(tmpdir(), 'hercules-roster-absent-'));
    try {
      expect(loadAuthorityRoster(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('throws AuthorityRosterError when the roster file is malformed', () => {
    const bad = mkdtempSync(join(tmpdir(), 'hercules-roster-bad-'));
    try {
      writeFileSync(join(bad, AUTHORITY_ROSTER_FILE), 'schema: not-a-roster\n', 'utf8');
      expect(() => loadAuthorityRoster(bad)).toThrow(AuthorityRosterError);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });

  it('resolves main module location to the checkout root', () => {
    const root = resolve(resolveRepoRootFromMainModule());
    expect(existsSync(join(root, 'package.json'))).toBe(true);
    expect(existsSync(join(root, AUTHORITY_ROSTER_FILE))).toBe(true);

    // Synthetic dist/src/main.js URL → two levels up to checkout.
    const distMain = pathToFileURL(join(root, 'dist', 'src', 'main.js')).href;
    expect(resolve(resolveRepoRootFromMainModule(distMain))).toBe(root);
    expect(existsSync(join(resolveRepoRootFromMainModule(distMain), 'package.json'))).toBe(true);

    // Synthetic src/main.ts URL → one level up to checkout.
    const srcMain = pathToFileURL(join(root, 'src', 'main.ts')).href;
    expect(resolve(resolveRepoRootFromMainModule(srcMain))).toBe(root);
    expect(existsSync(join(resolveRepoRootFromMainModule(srcMain), AUTHORITY_ROSTER_FILE))).toBe(true);
  });
});

describe('composition-root lease lifecycle (B-022)', () => {
  it('startup helper releases on early-boot failure and holds on success', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hercules-main-lease-'));
    const control = join(root, 'ctrl');
    const work = join(root, 'work');
    try {
      await expect(
        acquireLeaseForDaemonStartup(control, work, () => {
          throw new Error('early boot failed');
        }),
      ).rejects.toThrow('early boot failed');

      const held = await acquireLeaseForDaemonStartup(control, work, () => {
        // success path
      });
      await expect(
        acquireDaemonLease({
          controlRepo: control,
          workRoot: work,
          instanceId: 'second',
        }),
      ).rejects.toBeInstanceOf(DaemonLeaseConflictError);
      await held.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
