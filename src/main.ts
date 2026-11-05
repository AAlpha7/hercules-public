/**
 * Composition root.
 *
 * Wires the orchestration loop and the HTTP/UI server to a real git-backed
 * control repo. Agent selection:
 *   - Daemon default: HERCULES_ADAPTER (default `grok`)
 *   - Per-repo override: repos.yaml `adapter:` (phone UI / API; hot — next tick)
 *
 * Usage: node dist/src/main.js <control-repo-dir>
 * Env:   HERCULES_TOKEN    (auth; configured values are never logged)
 *        HERCULES_PORT     (default 8787)
 *        HERCULES_ADAPTER  (grok | codex | claude | cursor | fake; default grok)
 *        HERCULES_CURSOR_API_KEY / CURSOR_API_KEY (Cursor Cloud adapter)
 *        HERCULES_DISPATCH_ENABLED (set 0 for read-only staging/observer mode)
 *        HERCULES_WORK_DIR (worktree/mirrors/screenshots root)
 *        HERCULES_V2_SHADOW_ROOT / HERCULES_V2_SHADOW_DATABASE
 *          (both required to enable the M4 private shadow store)
 *        HERCULES_V2_EVIDENCE_ROOT (absolute; M5 archive + C3 evidence production)
 *        HERCULES_V2_REVIEW_EVALUATION (set 1 to enable C3 evaluation ports; requires
 *          evidence root + authority roster; independent of evidence production)
 *        HERCULES_V2_APPROVAL_BRIDGE (set 1 to deliver C3 approval-policy bridge)
 *        HERCULES_V2_DECISION_EFFECTS (set 1 to drive committed V2 decisions to legacy)
 *        HERCULES_PUSH     (set to 1 to push hercules/<id> branches)
 *        HERCULES_PORT_BASE (first port for per-task allocation; default 4100)
 *        HERCULES_REVIEWER (default on; set 0 to disable L3 independent review)
 *        HERCULES_ANALYST  (default on when L3 reviewer is on; set 0 to disable intent analyst)
 *        HERCULES_GROK_MODEL (pin `grok -m`; default grok-4.5; set `auto` for CLI default)
 *        HERCULES_CODEX_MODEL (default gpt-5.6-sol)
 *        HERCULES_CODEX_REASONING_EFFORT (default medium)
 *        HERCULES_CLAUDE_ENABLED (set 1 to register the Claude compatibility adapter)
 *        HERCULES_SELF_UPDATE (default on; set 0 to disable Settings pull/build/restart)
 *        HERCULES_SERVICE  (systemd unit for self-update; default hercules)
 *        HERCULES_DYNAMIC_CAPS (set 1 to lower global/heavy caps under low MemAvailable)
 *        HERCULES_COST_CAPS (set 1 to enable per-task + daily USD caps;
 *          tokens are advisory unless an explicit token override is configured)
 *        HERCULES_BILLING_MODE (subscription | metered; missing/invalid → metered)
 *        HERCULES_TASK_COST_SOFT_USD / _HARD_USD, HERCULES_DAY_COST_* (optional overrides)
 *        HERCULES_TASK_TOKENS_SOFT / _HARD, HERCULES_DAY_TOKENS_* (optional overrides)
 *        HERCULES_STALL_TIMEOUT_MS (idle stream stall when process not alive; default 10m)
 *        HERCULES_MAX_RUN_MS (hard wall-clock even if processAlive; default 2h)
 *        HERCULES_ADAPTER_FAILOVER (default on; set 0 to disable provider failover on agent_exit streak)
 *        HERCULES_AUTO_REBASE (set 1 to rebase task branch onto default + re-L1 when behind; default off)
 *        HERCULES_WORKTREE_GC_DAYS (terminal worktree GC retention; default 7; 0=off)
 *        HERCULES_WORKTREE_GC_DRY_RUN (set 1 to only log candidates, no deletes)
 *        HERCULES_WORKTREE_GC_SCREENSHOTS (set 1 to purge screenshots/<id> with GC)
 *        HERCULES_CARGO_TARGET_DIR (shared cargo target roots for auto-prune; abs paths)
 *        HERCULES_CARGO_CACHE_RETAIN_DAYS (keep large debug/deps; default 2)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, statfs, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  makeConfig,
  DEFAULT_CONFIG,
  stallOverridesFromEnv,
  stagingDebounceFromEnv,
  stagingVerifyTimeoutFromEnv,
  cargoCachePruneFromEnv,
  dispatchEnabledFromEnv,
} from './config.js';
import { DEFAULT_DYNAMIC_CAPS, type CapPair } from './domain/dynamicCaps.js';
import { parseCostCapsPolicy } from './domain/costCaps.js';
import { isAutoRebaseEnabled } from './domain/baseDrift.js';
import { Orchestrator, type OrchestratorDeps } from './orchestrator/orchestrator.js';
import {
  GitControlPort,
  type AuthoritativeTaskCommit,
} from './orchestrator/gitControlPort.js';
import { withControlSnapshotRefresh } from './orchestrator/controlRefresh.js';
import { FakeAdapter } from './orchestrator/fakeAdapter.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter, resolveCodexPolicy } from './adapters/codex.js';
import { CursorCloudAdapter } from './adapters/cursorCloud.js';
import { createCursorCloudClientFromEnv } from './adapters/cursorCloudClient.js';
import { GrokAdapter } from './adapters/grok.js';
import { AgentRegistry } from './orchestrator/agentRegistry.js';
import { isAdapterKind, type AdapterKind } from './domain/agents.js';
import { isAdapterFailoverEnabled } from './domain/adapterFailover.js';
import { GitWorkspaces, type Workspaces } from './isolation/worktree.js';
import type { AnalystActivityListener } from './domain/analystActivity.js';
import type { RepoConfig } from './domain/repos.js';
import { PortAllocator } from './isolation/ports.js';
import { storeHardlinksAcrossWorktrees } from './isolation/store.js';
import { WorktreeVerifier, type BehavioralRunner } from './orchestrator/verifier.js';
import {
  makeDeployRunner,
  ReleaseReconciler,
} from './orchestrator/releaseReconciler.js';
import { PromoteService } from './orchestrator/promoteService.js';
import { Semaphore } from './orchestrator/semaphore.js';
import {
  ChromiumDriver,
  findChromium,
  formatChromiumMiss,
  scanChromium,
} from './verification/browser.js';
import { LiveBehavioralRunner } from './verification/liveBehavioral.js';
import { runEvidencePlan } from './verification/evidenceDrive.js';
import { Reviewer, ReviewerInfraError } from './verification/reviewer.js';
import { reviewChildEnv } from './adapters/policyEnv.js';
import {
  createAnalystSandboxHealthCheck,
  createGrokReviewRunner,
  createGrokReviewerHealthCheck,
} from './verification/grokReviewRunner.js';
import { Analyst, ANALYST_SESSION_RULES } from './orchestrator/analyst.js';
import {
  ANALYST_SANDBOX_PROFILE,
  createAnalystSnapshots,
  renderAnalystSandboxToml,
} from './orchestrator/analystSnapshot.js';
import { compileAnalystContext } from './orchestrator/analystContext.js';
import { readMemAvailableBytes } from './control/meminfo.js';
import { ActionService } from './orchestrator/actions.js';
import { MergeOperationService } from './orchestrator/mergeOperationService.js';
import { MergeOperationStore } from './isolation/mergeOperationStore.js';
import { MergeFailureReceiptStore } from './isolation/mergeFailureReceiptStore.js';
// Merge ops store/service constructed near ActionService wiring.
import { GitRepoProbe } from './orchestrator/repoProbe.js';
import { startServer, resolveBindHost } from './server/serve.js';
import { createSelfUpdateService } from './server/selfUpdate.js';
import { SessionManager } from './sessions/manager.js';
import { SessionStore } from './sessions/store.js';
import { CostLedgerStore } from './control/costLedgerStore.js';
import type { RuntimeView } from './orchestrator/orchestrator.js';
import { NoopWorkspaces } from './isolation/worktree.js';
import { connectGrokAcp } from './adapters/grokAcp.js';
import { currentBuildContains, resolveBuildInfo } from './buildInfo.js';
import { resolveGrokCodeModel } from './server/xaiApi.js';
import { autoSeedL2FixtureIfNeeded } from './control/l2FixtureBoot.js';
import { SqliteStateStore } from './control/state/sqliteStateStore.js';
import { createReviewPackageRefreshSeam } from './control/reviewPackageSource.js';
import { openControlApiV2Deps } from './control/controlApiV2Provider.js';
import { ControlGit } from './control/git.js';
import { buildSnapshot } from './control/snapshot.js';
import {
  AUTHORITY_ROSTER_FILE,
  parseAuthorityRoster,
  type AuthorityRoster,
} from './control/authorityRoster.js';
import {
  createVerifiedEvidenceIntake,
  type VerifiedEvidenceIntake,
} from './control/verifiedEvidenceIntake.js';
import {
  produceAllVerifiedEvidence,
  VERIFIED_EVIDENCE_PRODUCER_IMPLEMENTATION,
  type VerifiedEvidenceProducerPorts,
} from './control/verifiedEvidence.js';
import {
  createUnavailableEvaluatorPort,
  evaluateAllAwaiting,
  type ReviewEvaluationPorts,
} from './control/reviewEvaluation.js';
import {
  adaptDecisionEffectStore,
  createDecisionEffectDriver,
  type DecisionEffectDriver,
} from './control/decisionEffects.js';
import {
  openArtifactEvidenceArchive,
  type ArtifactEvidenceArchive,
} from './control/artifacts/evidenceArchive.js';
import {
  MAX_ARCHIVE_ARRAY_ITEMS,
  MAX_ARTIFACT_BYTES,
  MAX_CAPTURE_CLOCK_SKEW_MS,
  MAX_LOCK_ACQUIRE_TIMEOUT_MS,
  openArchiveCapabilityIssuerForComposition,
  type ArtifactArchivePolicy,
  type Sha256Digest,
} from './control/artifacts/archiveTypes.js';
import { contractNeedsBridge } from './domain/approvalPolicyBridge.js';
import {
  deliverShadowProjection,
  buildBridgeDelivery,
  buildShadowProjectionHistory,
  reconcileShadowSnapshot,
  reconciliationDeliveryId,
  shadowDeliveryForGitRevision,
  type ShadowDelivery,
  type ShadowReconciliationReport,
  type VersionedAuthoritySnapshot,
  assertNoIncompleteEnvelopes,
} from './control/state/shadowReconciler.js';
import {
  createM4ObserverMemo,
  invalidateM4ObserverMemo,
  logM4ParityTransition,
  m4ObserverCacheEligible,
  rememberM4ObserverReport,
  resetM4ObserverHistory,
  type M4ObserverHooks,
  type M4ObserverMemo,
} from './control/state/shadowObserverMemo.js';
import {
  acquireLeaseForDaemonStartup,
  DaemonLeaseConflictError,
  defaultWorkRoot,
} from './isolation/daemonLease.js';
import type { DaemonLeaseIdentity } from './domain/daemonLease.js';
import { TaskPathLeaseStore } from './isolation/taskPathLeaseStore.js';
import { verifyPreparedCliEvidence } from './verification/readinessCliEvidence.js';
import { effectiveRepoExecutionPolicy } from './domain/repoExecutionPolicy.js';
import type {
  GuardianHarnessCapabilities,
  GuardianReadinessReceipt,
} from './domain/guardianReadiness.js';
import { openIsolatedM7ReviewApiDeps } from './server/api.js';

/** Pinned production M5 archive policy (composition root only). */
export const C3_ARTIFACT_ARCHIVE_POLICY: Readonly<ArtifactArchivePolicy> = Object.freeze({
  maximumArtifactBytes: MAX_ARTIFACT_BYTES,
  lockAcquireTimeoutMs: MAX_LOCK_ACQUIRE_TIMEOUT_MS,
  clockSkewMs: MAX_CAPTURE_CLOCK_SKEW_MS,
  maximumCommandEntries: MAX_ARCHIVE_ARRAY_ITEMS,
  maximumManifestCriteria: MAX_ARCHIVE_ARRAY_ITEMS,
  inventoryPageSize: 256,
  retentionDays: null,
  orphanGraceDays: 7,
});

const C3_ALLOWED_MEDIA_TYPES = Object.freeze([
  'text/plain',
  'text/x-diff',
  'image/png',
  'image/jpeg',
  'image/webp',
  'video/webm',
  'video/mp4',
] as const);

/** Merge that contains B-022 stages 1-5; stage 6 may only attest descendants. */
const B022_MERGED_CONTROL_BASE = 'd44073d2607a6bd14a701294dad627de0008d277';

interface Execution extends Pick<OrchestratorDeps, 'agents' | 'workspaces' | 'verifier' | 'autoRebase'> {
  readonly screenshotsRoot?: string;
  /** True when HERCULES_REVIEWER opts out of L3 (analyst follows the reviewer). */
  readonly reviewerDisabled?: boolean;
}

/** Env truthy for HERCULES_DYNAMIC_CAPS (off by default — conservative). */
export function isDynamicCapsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env['HERCULES_DYNAMIC_CAPS'] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

/** Generic truthy env flag (`1` / `true` / `on` / `yes`). */
function envFlagTruthy(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/** Never place an operator-configured bearer token in persistent daemon logs. */
export function startupAuthHint(
  configuredToken: string | undefined,
  effectiveToken: string,
): string {
  return configuredToken
    ? '[hercules] auth token configured (value withheld from logs)'
    : `[hercules] generated one-time auth token: ${effectiveToken}`;
}

export interface BuildExecutionOptions {
  /** Gate new L2/browser work when memory pressure zeroes the heavy cap. */
  readonly isHeavyAllowed?: () => boolean;
  /** Composition-root lease identity injected into GitWorkspaces reclaim. */
  readonly leaseIdentity?: DaemonLeaseIdentity;
}

/** Claude execution is a paid third-party compatibility path and must be explicit. */
export function isClaudeEnabled(
  env: Readonly<Record<string, string | undefined>> = {},
): boolean {
  return env['HERCULES_CLAUDE_ENABLED']?.trim() === '1';
}

/**
 * Build the multi-agent registry + workspaces/verifier.
 *
 * Registers grok, codex, cursor, and fake; Claude is compatibility-only and
 * requires HERCULES_CLAUDE_ENABLED=1. Workspaces are provisioned unless the
 * *default* is fake and HERCULES_WORK_DIR is unset — pure dry-run stays cheap.
 */
export function buildExecution(
  controlRepoDir: string,
  options: BuildExecutionOptions = {},
): Execution {
  const raw = (process.env['HERCULES_ADAPTER'] ?? 'grok').toLowerCase();
  const claudeEnabled = isClaudeEnabled(process.env);
  const requestedKind: AdapterKind = isAdapterKind(raw) ? raw : 'fake';
  const defaultKind: AdapterKind = requestedKind === 'claude' && !claudeEnabled
    ? 'codex'
    : requestedKind;
  if (!isAdapterKind(raw) && raw !== 'fake') {
    console.error(`[hercules] unknown HERCULES_ADAPTER='${raw}' — falling back to fake`);
  }
  if (requestedKind === 'claude' && !claudeEnabled) {
    console.error(
      '[hercules] Claude adapter disabled; using Codex (set HERCULES_CLAUDE_ENABLED=1 to opt in)',
    );
  }

  // Pin headless Grok to the current frontier model unless HERCULES_GROK_MODEL=auto.
  // Resolved once so adapters + L3 + ACP share the same pin.
  const grokModel = resolveGrokCodeModel();
  const codexPolicy = resolveCodexPolicy(process.env);
  const agents = new AgentRegistry(
    {
      grok: new GrokAdapter(grokModel ? { model: grokModel } : {}),
      codex: new CodexAdapter({
        model: codexPolicy.model,
        reasoningEffort: codexPolicy.reasoningEffort,
      }),
      ...(claudeEnabled ? { claude: new ClaudeAdapter({}) } : {}),
      cursor: new CursorCloudAdapter({
        client: createCursorCloudClientFromEnv(process.env),
      }),
      fake: new FakeAdapter({ durationMs: 5_000 }),
    },
    defaultKind,
    {
      codex: {
        model: codexPolicy.model,
        reasoningEffort: codexPolicy.reasoningEffort,
      },
      claudeEnabled,
    },
  );
  if (grokModel) {
    console.error(`[hercules] Grok code model: ${grokModel}`);
  }
  console.error(
    `[hercules] Codex policy: model=${codexPolicy.model} reasoning=${codexPolicy.reasoningEffort}`,
  );
  if (codexPolicy.usedConservativeFallback) {
    console.error('[hercules] invalid Codex policy override; using conservative defaults');
  }

  // Pure fake-default dry-run: no worktrees (matches previous HERCULES_ADAPTER=fake).
  if (defaultKind === 'fake' && !process.env['HERCULES_WORK_DIR']) {
    return { agents };
  }

  const root = process.env['HERCULES_WORK_DIR'] ?? join(controlRepoDir, '..', 'hercules-work');
  const screenshotsRoot = join(root, 'screenshots');
  // SPEC §8.4: pnpm hard-links node_modules from its store into each worktree
  // only when store and work root share a filesystem. Warn loudly if not —
  // otherwise every worktree silently duplicates node_modules on the box.
  {
    const storeDir =
      process.env['PNPM_STORE_PATH'] ??
      join(process.env['HOME'] ?? '/root', '.local/share/pnpm/store');
    const store = storeHardlinksAcrossWorktrees(storeDir, root);
    console.error(
      store.ok
        ? `[hercules] pnpm store shares work-root filesystem — node_modules hard-linked (SPEC §8.4)`
        : `[hercules] WARN §8.4: ${store.reason}`,
    );
  }
  const ports = new PortAllocator(Number(process.env['HERCULES_PORT_BASE'] ?? 4100), 20);
  const wsOpts: {
    root: string;
    ports: PortAllocator;
    push: boolean;
    leaseIdentity?: DaemonLeaseIdentity;
  } = { root, ports, push: process.env['HERCULES_PUSH'] === '1' };
  if (options.leaseIdentity !== undefined) wsOpts.leaseIdentity = options.leaseIdentity;
  const workspaces = new GitWorkspaces(wsOpts);

  // L2 always wired: Chromium path is resolved at each use (short TTL +
  // existence check). Playwright cache rotation must not require a restart.
  const behavioral: BehavioralRunner = new LiveBehavioralRunner({
    permit: new Semaphore(DEFAULT_CONFIG.heavyValidationPermits),
    browser: new ChromiumDriver(),
    screenshotsRoot,
    ...(options.isHeavyAllowed ? { isHeavyAllowed: options.isHeavyAllowed } : {}),
  });
  {
    const probe = findChromium();
    console.error(
      probe
        ? `[hercules] Chromium available (${probe}); path re-resolved per L2 use`
        : `[hercules] Chromium not found yet — L2 will re-check on each use (not disabled at boot)`,
    );
  }

  // L3 independent reviewer: on by default; HERCULES_REVIEWER=0 opts out.
  const reviewerDisabled =
    (process.env['HERCULES_REVIEWER'] ?? '1').trim() === '0' ||
    (process.env['HERCULES_REVIEWER'] ?? '').toLowerCase() === 'false' ||
    (process.env['HERCULES_REVIEWER'] ?? '').toLowerCase() === 'off';
  const reviewer = reviewerDisabled
    ? undefined
    : new Reviewer(
        createGrokReviewRunner({
          cwd: root,
          ...(grokModel ? { model: grokModel } : {}),
        }),
      );
  if (reviewerDisabled) {
    console.error('[hercules] L3 reviewer disabled (HERCULES_REVIEWER=0)');
  } else {
    console.error(
      `[hercules] L3 reviewer: grok${grokModel ? ` -m ${grokModel}` : ''} (fresh session; changeful green)`,
    );
  }

  // Pre-review auto-rebase: off by default. When on, verify rebases hercules/<id>
  // onto default (local only) and re-runs L1 — never force-pushes, never merges main.
  const autoRebase = isAutoRebaseEnabled(process.env);
  if (autoRebase) {
    console.error(
      '[hercules] auto-rebase: enabled (HERCULES_AUTO_REBASE=1 — task branch only; never main)',
    );
  }

  return {
    agents,
    workspaces,
    autoRebase,
    verifier: new WorktreeVerifier({
      workspaces: {
        readWorkflow: (repo) => workspaces.readWorkflow(repo),
        readTrustedFile: (repo, path) => workspaces.readTrustedFile(repo, path),
        readTrustedDefaultRevisionSnapshot: (repo) =>
          workspaces.readTrustedDefaultRevisionSnapshot(repo),
      },
      ...(behavioral ? { behavioral } : {}),
      ...(reviewer ? { reviewer } : {}),
      reviewerDisabled,
      autoRebase,
      screenshotsRoot,
    }),
    screenshotsRoot,
    reviewerDisabled,
  };
}

/** Set after lease acquire so fatal catch can release before exit. */
let heldDaemonLease: Awaited<ReturnType<typeof acquireLeaseForDaemonStartup>> | undefined;

function canonicalProspectivePath(path: string): string {
  let existing = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('M4 shadow path has no existing trusted ancestor');
    suffix.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...suffix);
}

function assertNoExplicitSymlink(path: string): void {
  let current = resolve(path);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error('M4 shadow configuration cannot contain a symlink');
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function pathInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertRootsDoNotOverlap(
  label: string,
  candidate: string,
  others: Readonly<Record<string, string>>,
): void {
  for (const [otherLabel, other] of Object.entries(others)) {
    if (pathInside(other, candidate) || pathInside(candidate, other)) {
      throw new Error(`${label} cannot overlap ${otherLabel}`);
    }
  }
}

/**
 * Resolve the running daemon's code checkout root from main's module URL.
 * Handles both `src/main.ts` (vitest/dev) and `dist/src/main.js` (built).
 */
export function resolveRepoRootFromMainModule(
  moduleUrl: string = import.meta.url,
): string {
  const here = dirname(fileURLToPath(moduleUrl));
  if (here.endsWith(`${join('dist', 'src')}`) || here.endsWith('/dist/src')) {
    return join(here, '..', '..');
  }
  return join(here, '..');
}

/**
 * Read the reviewed `authority-roster.yaml` from the daemon's own code
 * checkout root (ships with the source; control repos carry no roster).
 * Absent → null (producers disabled). Present but malformed → fail-closed throw.
 */
export function loadAuthorityRoster(
  repoRootDir: string,
): AuthorityRoster | null {
  const rosterPath = join(resolve(repoRootDir), AUTHORITY_ROSTER_FILE);
  if (!existsSync(rosterPath)) return null;
  return parseAuthorityRoster(readFileSync(rosterPath, 'utf8'));
}

/** Resolve and validate `HERCULES_V2_EVIDENCE_ROOT` (absolute, non-overlapping). */
export function resolveC3EvidenceRoot(
  env: NodeJS.ProcessEnv,
  roots: {
    readonly controlRepoDir: string;
    readonly workRoot: string;
    readonly shadowRoot: string | null;
  },
): string | null {
  const raw = env['HERCULES_V2_EVIDENCE_ROOT'];
  if (raw === undefined || raw.trim() === '') return null;
  if (!isAbsolute(raw)) {
    throw new Error('HERCULES_V2_EVIDENCE_ROOT must be an absolute path');
  }
  assertNoExplicitSymlink(raw);
  const evidenceRoot = canonicalProspectivePath(resolve(raw));
  const controlRoot = canonicalProspectivePath(resolve(roots.controlRepoDir));
  const workRoot = canonicalProspectivePath(resolve(roots.workRoot));
  const others: Record<string, string> = {
    'control repository root': controlRoot,
    'provider work root': workRoot,
  };
  if (roots.shadowRoot !== null) {
    others['M4 shadow state root'] = canonicalProspectivePath(resolve(roots.shadowRoot));
  }
  assertRootsDoNotOverlap('C3 evidence root', evidenceRoot, others);
  return evidenceRoot;
}

export interface C3EvidenceStack {
  readonly archive: ArtifactEvidenceArchive;
  readonly intake: VerifiedEvidenceIntake;
  readonly archiveContexts: VerifiedEvidenceProducerPorts['archiveContexts'];
  readonly close: () => Promise<void>;
}

/** Open the M5 archive + intake + composition capability contexts for C3. */
export async function openC3EvidenceStack(input: {
  readonly evidenceRoot: string;
  readonly controlRepoDir: string;
  readonly workRoot: string;
  /** M4 shadow trusted root — archive metadata lives on the shadow database. */
  readonly shadowRoot: string;
  /** M4 shadow database path (direct child of shadowRoot), already initialized. */
  readonly shadowDatabasePath: string;
  readonly clock?: () => string;
}): Promise<C3EvidenceStack> {
  const clock = input.clock ?? (() => new Date().toISOString());
  const root = resolve(input.evidenceRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'artifacts'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'exports'), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'staged'), { recursive: true, mode: 0o700 });
  const databaseTrustedRoot = canonicalProspectivePath(resolve(input.shadowRoot));
  const databasePath = canonicalProspectivePath(resolve(input.shadowDatabasePath));
  const archive = await openArtifactEvidenceArchive({
    artifactRoot: join(root, 'artifacts'),
    databasePath,
    databaseTrustedRoot,
    exportRoot: join(root, 'exports'),
    controlRepositoryRoot: resolve(input.controlRepoDir),
    providerWorkRoots: [resolve(input.workRoot)],
    policy: C3_ARTIFACT_ARCHIVE_POLICY,
    clock,
  });
  const intake = createVerifiedEvidenceIntake({ root: join(root, 'staged') });
  const issuer = openArchiveCapabilityIssuerForComposition({
    issuer: 'hercules-composition/c3-evidence',
  });
  const archiveContexts: VerifiedEvidenceProducerPorts['archiveContexts'] = {
    /**
     * Control-plane-internal capture authority: a pure function of the staged
     * bundle. `stageStartedAt = issuedAt = bundle.capturedAt` (passed as
     * `stageStartedAt`); `expiresAt = capturedAt + 30 days`. Observation uses
     * `observedAt = capturedAt`, so the permitted capture window
     * `[stageStartedAt, capturedAt]` collapses to the staged instant while
     * `assertLiveWindow` still requires wall-clock `now ∈ [issuedAt, expiresAt]`.
     * Identical command bytes on retry make `issueCaptureAuthorization`
     * idempotent for the same idempotency key.
     */
    authority(authorityInput) {
      const issuedAt = authorityInput.stageStartedAt;
      const expiresAt = new Date(
        Date.parse(issuedAt) + 30 * 24 * 60 * 60 * 1000,
      ).toISOString();
      return issuer.issueArchiveAuthority({
        issuer: VERIFIED_EVIDENCE_PRODUCER_IMPLEMENTATION,
        taskId: authorityInput.taskId,
        contractVersion: authorityInput.contractVersion,
        iterationId: authorityInput.iterationId,
        producerStageRunId: authorityInput.producerStageRunId,
        stageType: 'verify',
        stageStartedAt: issuedAt,
        candidateRef: authorityInput.candidateRef,
        environmentRef: authorityInput.environmentRef,
        surface: authorityInput.surface,
        maximumTrustClass: 'primary',
        maximumAccessClass: 'operator',
        maximumByteLength: MAX_ARTIFACT_BYTES,
        allowedMediaTypes: [...C3_ALLOWED_MEDIA_TYPES],
        issuedAt,
        expiresAt,
      });
    },
    observation(observationInput) {
      return issuer.issueCaptureObservation({
        authorizationId: observationInput.authorizationId,
        sha256: observationInput.sha256 as Sha256Digest,
        byteLength: observationInput.byteLength,
        redactionState: 'none',
        accessClass: 'operator',
        observedAt: observationInput.observedAt,
      });
    },
  };
  return {
    archive,
    intake,
    archiveContexts,
    close: () => archive.close(),
  };
}

async function readExactM4Authority(controlRepoDir: string): Promise<VersionedAuthoritySnapshot> {
  const git = new ControlGit(controlRepoDir);
  const before = await git.headHash();
  if (before === null) throw new Error('M4 authority snapshot requires a control HEAD');
  if (!(await git.isClean())) throw new Error('M4 authority snapshot requires exact clean bytes');
  const snapshot = await buildSnapshot(controlRepoDir);
  const after = await git.headHash();
  if (after !== before || !(await git.isClean())) {
    throw new Error('M4 authority changed during snapshot read');
  }
  return { revision: before, tasks: snapshot.tasks };
}

export function deliverAndReconcileM4Commit(
  store: SqliteStateStore,
  commit: AuthoritativeTaskCommit,
  snapshot: VersionedAuthoritySnapshot,
  projectionFailures: Map<string, string>,
  projectionHistory: readonly ShadowDelivery[],
): { readonly report: ShadowReconciliationReport; readonly deliveryError: unknown | null } {
  let deliveryError: unknown | null = null;
  const affected = [...commit.writes.map((task) => task.id), ...commit.retiredTaskIds];
  try {
    deliverShadowProjection(store, {
      deliveryId: commit.deliveryId,
      revision: commit.revision,
      writes: commit.writes,
      retiredTaskIds: commit.retiredTaskIds,
    });
    for (const taskId of affected) projectionFailures.delete(taskId);
  } catch (error) {
    deliveryError = error;
    for (const taskId of affected) projectionFailures.set(taskId, 'shadow_delivery_failed');
  }
  return {
    report: reconcileShadowSnapshot(store, snapshot, projectionFailures, projectionHistory),
    deliveryError,
  };
}

export function createM4ShadowStoreFromEnv(
  controlRepoDir: string,
  env: NodeJS.ProcessEnv = process.env,
  roster: AuthorityRoster | null = null,
): SqliteStateStore | null {
  const rootValue = env['HERCULES_V2_SHADOW_ROOT'];
  const databaseValue = env['HERCULES_V2_SHADOW_DATABASE'];
  if ((rootValue === undefined) !== (databaseValue === undefined)) {
    throw new Error('M4 shadow mode requires both root and direct database path');
  }
  if (rootValue === undefined || databaseValue === undefined) return null;
  assertNoExplicitSymlink(rootValue);
  assertNoExplicitSymlink(databaseValue);
  const root = resolve(rootValue);
  const controlRoot = resolve(controlRepoDir);
  const workRoot = resolve(env['HERCULES_WORK_DIR'] ?? defaultWorkRoot(controlRepoDir));
  const canonicalRoot = canonicalProspectivePath(root);
  const canonicalControl = canonicalProspectivePath(controlRoot);
  const canonicalWork = canonicalProspectivePath(workRoot);
  if (pathInside(canonicalControl, canonicalRoot) || pathInside(canonicalRoot, canonicalControl) ||
      pathInside(canonicalWork, canonicalRoot) || pathInside(canonicalRoot, canonicalWork)) {
    throw new Error('M4 shadow state root cannot overlap control or provider work roots');
  }
  const store = new SqliteStateStore({
    trustedRoot: canonicalRoot,
    databasePath: canonicalProspectivePath(resolve(databaseValue)),
    refreshReviewPackage: createReviewPackageRefreshSeam(
      () => new Date().toISOString(),
      roster === null ? {} : { roster },
    ),
  });
  store.initialize();
  return store;
}

export async function observeM4AuthoritySnapshot(
  store: SqliteStateStore,
  controlRepoDir: string,
  snapshot: VersionedAuthoritySnapshot & { readonly shadowPending: boolean },
  projectionFailures: Map<string, string>,
  memo: M4ObserverMemo,
  hooks: M4ObserverHooks = {},
): Promise<ShadowReconciliationReport> {
  const logLine = hooks.log ?? ((line: string) => { console.error(line); });
  if (memo.store !== null && memo.store !== store) {
    // Store-instance reopen: drop immutable caches bound to the prior handle
    // and clear any stale report before binding the new store so a later
    // rememberM4ObserverReport does not reset history we are about to fill.
    resetM4ObserverHistory(memo);
    invalidateM4ObserverMemo(memo);
    memo.store = store;
  }
  if (m4ObserverCacheEligible(memo, store, snapshot.revision, projectionFailures)) {
    const cached = memo.report!;
    logM4ParityTransition(memo, cached, logLine);
    return cached;
  }

  const buildHistory = async (): Promise<readonly ShadowDelivery[]> => {
    hooks.onHistoryBuild?.();
    return buildShadowProjectionHistory(store, controlRepoDir, snapshot.revision, { memo });
  };
  const reconcile = (
    history: readonly ShadowDelivery[],
  ): ShadowReconciliationReport => {
    hooks.onReconcile?.();
    return reconcileShadowSnapshot(store, snapshot, projectionFailures, history, { memo });
  };

  // Resume incomplete envelopes FIRST and unconditionally: a pending outbox
  // delivery (shadowPending) is a LATER revision that the live path refused
  // while an envelope was incomplete (assertNoIncompleteEnvelopes); gating the
  // resume on it would deadlock both. Only advancing Git history waits.
  let resumed = true;
  {
    const envelopes = store.listProjectionEnvelopeKeys();
    const existingHistory = envelopes.some((envelope) => !envelope.completed)
      ? await buildHistory()
      : null;
    for (let index = 0; index < envelopes.length; index += 1) {
      if (envelopes[index]!.completed) continue;
      const delivery = existingHistory![index]!;
      const affected = [...delivery.writes.map((task) => task.id), ...delivery.retiredTaskIds];
      try {
        deliverShadowProjection(store, delivery);
        for (const taskId of affected) projectionFailures.delete(taskId);
      } catch {
        for (const taskId of affected) projectionFailures.set(taskId, 'shadow_delivery_failed');
        resumed = false;
        break;
      }
    }
  }
  let canAdvance = resumed && !snapshot.shadowPending;
  if (canAdvance) {
    const git = new ControlGit(controlRepoDir);
    // C3.58: the durable cursor marks no-op revisions too; envelopes alone
    // would make every pass re-walk Git history back to the last non-empty one.
    // A crash between an envelope write and the cursor write leaves the cursor
    // BEHIND the latest envelope; re-delivering that range would project a
    // skipped revision after a later envelope (e.g. retired_task_resurrection)
    // and wedge history ordering (Codex C3.58 B1). Resume from whichever of
    // the two is later on head's first-parent history.
    const cursor = store.observedAuthorityRevision();
    const latestEnvelope = store.latestProjectionEnvelopeRevision();
    let lastRevision = cursor ?? latestEnvelope ?? undefined;
    if (cursor !== null && latestEnvelope !== null && cursor !== latestEnvelope) {
      const order = new Map(
        (await git.firstParentHistory(snapshot.revision)).map((revision, index) => [revision, index]),
      );
      const cursorAt = order.get(cursor);
      const envelopeAt = order.get(latestEnvelope);
      lastRevision =
        cursorAt === undefined ? latestEnvelope
        : envelopeAt === undefined ? cursor
        : envelopeAt > cursorAt ? latestEnvelope : cursor;
    }
    const revisions = lastRevision === undefined || lastRevision === snapshot.revision
      ? []
      : await git.firstParentAfter(lastRevision, snapshot.revision);
    for (const revision of revisions) {
      const delivery = await shadowDeliveryForGitRevision(
        controlRepoDir, revision, `sync-${revision}`,
      );
      if (delivery === null) {
        store.recordObservedAuthorityRevision(revision);
        continue;
      }
      const affected = [...delivery.writes.map((task) => task.id), ...delivery.retiredTaskIds];
      try {
        deliverShadowProjection(store, delivery);
        // Advance the cursor per processed revision so a crash resumes here.
        store.recordObservedAuthorityRevision(revision);
        for (const taskId of affected) projectionFailures.delete(taskId);
      } catch {
        for (const taskId of affected) projectionFailures.set(taskId, 'shadow_delivery_failed');
        canAdvance = false;
        break;
      }
    }
    if (canAdvance) {
      const reconciliation: ShadowDelivery = {
        deliveryId: reconciliationDeliveryId(snapshot),
        revision: snapshot.revision,
        writes: snapshot.tasks,
        retiredTaskIds: [],
      };
      try {
        deliverShadowProjection(store, reconciliation);
        store.recordObservedAuthorityRevision(snapshot.revision);
        for (const task of snapshot.tasks) projectionFailures.delete(task.id);
      } catch {
        for (const task of snapshot.tasks) projectionFailures.set(task.id, 'shadow_delivery_failed');
        canAdvance = false;
      }
    }
  }
  const history = await buildHistory();
  const report = reconcile(history);
  if (canAdvance) {
    rememberM4ObserverReport(memo, store, snapshot.revision, report, projectionFailures);
  } else {
    invalidateM4ObserverMemo(memo);
  }
  logM4ParityTransition(memo, report, logLine);
  return report;
}

async function main(): Promise<void> {
  const controlRepoDir = process.argv[2];
  if (!controlRepoDir) {
    console.error('usage: hercules <control-repo-dir>');
    process.exit(2);
  }


  const workRootForLease =
    process.env['HERCULES_WORK_DIR'] ?? defaultWorkRoot(controlRepoDir);
  const daemonLease = await acquireLeaseForDaemonStartup(
    controlRepoDir,
    workRootForLease,
    () => {
      try {
        autoSeedL2FixtureIfNeeded(controlRepoDir);
      } catch (err) {
        console.error(
          '[hercules] L2 fixture auto-seed failed: ' + (err as Error).message,
        );
        throw err;
      }
    },
  );
  heldDaemonLease = daemonLease;

  // Fail-closed: if the util-linux flock child dies while we still claim
  // ownership, stop the daemon before any further mutation. Intentional
  // release (shutdown) does not fire whenLost.
  void daemonLease.whenLost.then(() => {
    if (heldDaemonLease !== daemonLease) return;
    console.error(
      '[hercules] daemon lease lost unexpectedly — fail-closed exit',
    );
    heldDaemonLease = undefined;
    process.exit(1);
  });

  const configuredToken = process.env['HERCULES_TOKEN'];
  const token = configuredToken ?? randomUUID();
  const port = Number(process.env['HERCULES_PORT'] ?? 8787);
  const webDir = fileURLToPath(new URL('../web', import.meta.url));
  const build = resolveBuildInfo();
  const b022BuildAttested = currentBuildContains(B022_MERGED_CONTROL_BASE);
  const b022Capabilities: GuardianHarnessCapabilities = {
    buildAttested: b022BuildAttested,
    daemonWorkrootLease: b022BuildAttested,
    taskBranchExactLease: b022BuildAttested,
    taskPathLeases: b022BuildAttested,
    protectedPathDrift: b022BuildAttested,
    cliBehavioralEvidence: b022BuildAttested,
  };
  console.error(
    `[hercules] build ${build.version}${build.dirty ? ' (tracked changes)' : ''}`,
  );

  // Dynamic caps: off by default. When enabled, low MemAvailable lowers global
  // (dispatch) and may pause new heavy/browser work until free memory recovers.
  const dynamicCapsOn = isDynamicCapsEnabled();
  // Cost caps: off by default. When enabled, per-task + UTC-day soft warn / hard
  // stop use adapter-reported usage. USD defaults follow HERCULES_BILLING_MODE
  // (subscription vs metered); explicit HERCULES_*_COST_*_USD overrides win.
  const costCaps = parseCostCapsPolicy(process.env);
  const stallOverrides = stallOverridesFromEnv();
  const stagingDebounce = stagingDebounceFromEnv();
  const stagingVerifyTimeout = stagingVerifyTimeoutFromEnv();
  const dispatchEnabled = dispatchEnabledFromEnv();
  const config = makeConfig(controlRepoDir, {
    dynamicCaps: { ...DEFAULT_DYNAMIC_CAPS, enabled: dynamicCapsOn },
    costCaps,
    ...stallOverrides,
    ...stagingDebounce,
    ...stagingVerifyTimeout,
    ...dispatchEnabled,
  });
  if (!config.dispatchEnabled) {
    console.error(
      '[hercules] task orchestration disabled (HERCULES_DISPATCH_ENABLED=0) — read-only observer mode',
    );
  }
  const effectiveCaps: { current: CapPair } = {
    current: {
      globalCap: config.globalCap,
      heavyValidationPermits: config.heavyValidationPermits,
    },
  };
  // C3 roster from the daemon checkout root (not the control repo).
  const repoRootDir = resolveRepoRootFromMainModule();
  const authorityRoster = loadAuthorityRoster(repoRootDir);
  const rosterPath = join(resolve(repoRootDir), AUTHORITY_ROSTER_FILE);
  console.error(
    `[hercules] C3 authority roster ${rosterPath} ${authorityRoster === null ? 'absent' : 'loaded'}`,
  );
  const shadowStore = createM4ShadowStoreFromEnv(controlRepoDir, process.env, authorityRoster);
  const shadowFailures = new Map<string, string>();
  const shadowMemo = createM4ObserverMemo();
  if (shadowStore !== null) {
    // createM4ShadowStoreFromEnv already ran the boot integrity pass; a second
    // initialize() re-verifies every envelope row (93 s on production 2026-09-09).
    const integrity = shadowStore.startupReport();
    console.error(`[hercules] M4 shadow store schema=${integrity.schemaVersion} events=${integrity.eventCount}`);
  }

  const workRootForC3 =
    process.env['HERCULES_WORK_DIR'] ?? defaultWorkRoot(controlRepoDir);
  const shadowRootForC3 = process.env['HERCULES_V2_SHADOW_ROOT'] ?? null;
  let c3EvidenceStack: C3EvidenceStack | null = null;
  let c3EvidencePorts: VerifiedEvidenceProducerPorts | null = null;
  let c3EvaluationPorts: ReviewEvaluationPorts | null = null;
  const c3Clock = (): string => new Date().toISOString();
  const c3Log = (line: string): void => {
    console.error(line);
  };

  if (shadowStore !== null && authorityRoster === null) {
    console.error(
      '[hercules] C3 authority roster absent — evidence/evaluation producers disabled',
    );
  } else if (shadowStore !== null && authorityRoster !== null) {
    console.error(
      `[hercules] C3 authority roster verifier=${authorityRoster.verifier.runId} ` +
        `evaluator=${authorityRoster.evaluator.runId}`,
    );
    const evidenceRoot = resolveC3EvidenceRoot(process.env, {
      controlRepoDir,
      workRoot: workRootForC3,
      shadowRoot: shadowRootForC3,
    });
    const shadowDatabaseForC3 = process.env['HERCULES_V2_SHADOW_DATABASE'] ?? null;
    if (evidenceRoot !== null && shadowRootForC3 !== null && shadowDatabaseForC3 !== null) {
      c3EvidenceStack = await openC3EvidenceStack({
        evidenceRoot,
        controlRepoDir,
        workRoot: workRootForC3,
        shadowRoot: shadowRootForC3,
        shadowDatabasePath: shadowDatabaseForC3,
        clock: c3Clock,
      });
      c3EvidencePorts = {
        store: shadowStore,
        archive: c3EvidenceStack.archive,
        intake: c3EvidenceStack.intake,
        roster: authorityRoster,
        clock: c3Clock,
        log: c3Log,
        archiveContexts: c3EvidenceStack.archiveContexts,
      };
      console.error(`[hercules] C3 evidence root enabled at ${evidenceRoot}`);
      // Evaluation is independently gated: evidence production can stay on
      // while evaluation rolls back to C2 view-only (Codex B7).
      if (process.env['HERCULES_V2_REVIEW_EVALUATION'] === '1') {
        c3EvaluationPorts = {
          store: shadowStore,
          roster: authorityRoster,
          clock: c3Clock,
          evaluatorPort: createUnavailableEvaluatorPort(),
          deadlineMs: 60_000,
          log: c3Log,
        };
        console.error('[hercules] C3 review evaluation enabled');
      }
    }
  }

  const c3ApprovalBridgeOn =
    shadowStore !== null && process.env['HERCULES_V2_APPROVAL_BRIDGE'] === '1';
  if (c3ApprovalBridgeOn) {
    console.error('[hercules] C3 approval-policy bridge enabled');
  }

  async function runC3Producers(): Promise<void> {
    if (c3EvidencePorts !== null) {
      try {
        const outcomes = await produceAllVerifiedEvidence(c3EvidencePorts);
        for (const outcome of outcomes) {
          if (outcome.kind === 'bound') {
            console.error(
              `[hercules] c3 evidence bound ${outcome.aggregateId} ` +
                `iteration=${outcome.iterationId} hash=${outcome.evidenceHash}`,
            );
          } else if (outcome.kind === 'skipped') {
            console.error(
              `[hercules] c3 evidence skipped ${outcome.aggregateId} reason=${outcome.reason}`,
            );
          } else {
            console.error(
              `[hercules] c3 evidence failed ${outcome.aggregateId}: ${outcome.error}`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[hercules] c3 evidence producer crashed: ${(err as Error).message}`,
        );
      }
    }
    if (c3EvaluationPorts !== null) {
      try {
        const outcomes = await evaluateAllAwaiting(c3EvaluationPorts);
        for (const outcome of outcomes) {
          if (outcome.kind === 'bound') {
            console.error(
              `[hercules] c3 evaluation bound ${outcome.aggregateId} ` +
                `iteration=${outcome.iterationId} hash=${outcome.evaluationHash}`,
            );
          } else if (outcome.kind === 'skipped') {
            console.error(
              `[hercules] c3 evaluation skipped ${outcome.aggregateId} reason=${outcome.reason}`,
            );
          } else {
            console.error(
              `[hercules] c3 evaluation failed ${outcome.aggregateId}: ${outcome.error}`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[hercules] c3 evaluation producer crashed: ${(err as Error).message}`,
        );
      }
    }
  }

  let c3ProducerQueue: Promise<void> = Promise.resolve();
  const enqueueC3Producers = (): void => {
    if (c3EvidencePorts === null && c3EvaluationPorts === null) return;
    c3ProducerQueue = c3ProducerQueue
      .then(() => runC3Producers())
      .catch((err: unknown) => {
        console.error(
          `[hercules] c3 producers queue: ${(err as Error).message}`,
        );
      });
  };

  const deliverC3Bridge = async (
    store: SqliteStateStore,
    authorityRevision: string,
  ): Promise<void> => {
    if (!c3ApprovalBridgeOn) return;
    try {
      // Real-commit check before privileged live bridge delivery (Codex B5).
      // Replay still re-validates via assertEnvelopeAuthorityInput.
      const git = new ControlGit(controlRepoDir);
      await git.commitMetadata(authorityRevision);
      const delivery = buildBridgeDelivery(store, authorityRevision);
      if (delivery === null) return;
      // Never lay a second bridge over an incomplete envelope (Codex round-3b):
      // the observe pass resumes it first; this bridge id's own retry is exempt.
      assertNoIncompleteEnvelopes(store, delivery.deliveryId);
      const successorCount = store.listTaskIds().filter((taskId) => {
        const state = store.readTask(taskId);
        return (
          state !== null &&
          state.retirement === null &&
          contractNeedsBridge(state.contracts)
        );
      }).length;
      deliverShadowProjection(store, delivery);
      console.error(
        `[hercules] c3 bridge delivered ${successorCount} successors at ${authorityRevision}`,
      );
    } catch (err) {
      console.error(
        `[hercules] c3 bridge delivery failed: ${(err as Error).message}`,
      );
    }
  };

  const control = shadowStore === null
    ? new GitControlPort(controlRepoDir)
    : new GitControlPort(controlRepoDir, {
        authoritativeTaskCommit: async (commit) => {
          const snapshot = await readExactM4Authority(controlRepoDir);
          let deliveryError: unknown | null = null;
          const affected = [...commit.writes.map((task) => task.id), ...commit.retiredTaskIds];
          try {
            // Never project a live commit over an incomplete envelope; the
            // observe pass resumes it first and advances Git history itself.
            assertNoIncompleteEnvelopes(shadowStore!, commit.deliveryId);
            deliverShadowProjection(shadowStore!, commit);
            shadowStore!.recordObservedAuthorityRevision(commit.revision);
            for (const taskId of affected) shadowFailures.delete(taskId);
            await deliverC3Bridge(shadowStore!, commit.revision);
          } catch (error) {
            deliveryError = error;
            for (const taskId of affected) shadowFailures.set(taskId, 'shadow_delivery_failed');
          }
          invalidateM4ObserverMemo(shadowMemo);
          const history = await buildShadowProjectionHistory(
            shadowStore!, controlRepoDir, snapshot.revision, { memo: shadowMemo },
          );
          const report = reconcileShadowSnapshot(
            shadowStore!, snapshot, shadowFailures, history, { memo: shadowMemo },
          );
          if (!report.parity) {
            console.error(`[hercules] M4 shadow parity=false revision=${snapshot.revision} divergences=${report.entries.filter((entry) => entry.kind !== 'equal').length}`);
          }
          enqueueC3Producers();
          if (deliveryError !== null) throw deliveryError;
        },
        authoritativeSnapshotObserved: async (snapshot) => {
          await observeM4AuthoritySnapshot(
            shadowStore!, controlRepoDir, snapshot, shadowFailures,
            shadowMemo,
          );
        },
      });
  if (shadowStore !== null) {
    const snapshot = await control.readVersionedTasks();
    const sweep = shadowStore.sweepV2Aggregates(snapshot.tasks);
    console.error(`[hercules] V2 aggregate sweep ${sweep.reason} materialized=${sweep.materializedCount}`);
    await observeM4AuthoritySnapshot(
      shadowStore, controlRepoDir, snapshot, shadowFailures, shadowMemo,
    );
    await deliverC3Bridge(shadowStore, snapshot.revision);
    if (c3ApprovalBridgeOn) {
      invalidateM4ObserverMemo(shadowMemo);
      await observeM4AuthoritySnapshot(
        shadowStore, controlRepoDir, snapshot, shadowFailures, shadowMemo,
      );
    }
    await runC3Producers();
  }
  const execution = buildExecution(controlRepoDir, {
    isHeavyAllowed: () => effectiveCaps.current.heavyValidationPermits > 0,
    leaseIdentity: daemonLease.identity,
  });

  // Release reconciler (staging) + promote service (production). Only when
  // real workspaces exist — NoopWorkspaces has no mirror tip / WORKFLOW.
  const workRootForRelease =
    process.env['HERCULES_WORK_DIR'] ?? join(controlRepoDir, '..', 'hercules-work');
  const releaseScreenshots = join(workRootForRelease, 'screenshots', 'releases');
  const releaseWs = execution.workspaces;
  const deployRunner =
    releaseWs !== undefined
      ? makeDeployRunner(async (input) => {
          const bin = findChromium();
          if (!bin) {
            const miss = formatChromiumMiss(scanChromium());
            return {
              plan: { steps: input.steps, source: 'workflow' },
              results: input.steps.map((step) => ({
                step,
                ok: false,
                detail: `no Chromium for staging evidence: ${miss}`,
              })),
              ok: false,
              screenshots: [],
            };
          }
          return runEvidencePlan({
            bin,
            url: input.url,
            plan: { steps: input.steps, source: 'workflow' },
            screenshotDir: input.screenshotDir,
            ...(input.authToken !== undefined
              ? { authToken: input.authToken, authStorageKey: input.authStorageKey }
              : {}),
          });
        })
      : undefined;
  // Release-ops switch — FAIL-CLOSED (security review 2026-07-18): deploying
  // staging/production is the most dangerous capability this daemon has, so
  // it requires explicit HERCULES_RELEASE_OPS=1 (production env). Any other
  // value — including the variable simply missing on a fresh instance —
  // leaves the daemon a verification target: no reconciler, no promote.
  // (Fail-open history: the staging daemon self-deploy-looped and its UI
  // Promote could execute a REAL production deploy.)
  const releaseOpsOn = process.env['HERCULES_RELEASE_OPS'] === '1';
  const releaseReconciler =
    releaseOpsOn && releaseWs !== undefined && deployRunner
      ? new ReleaseReconciler({
          control,
          workspaces: releaseWs,
          deployRunner,
          clock: () => Date.now(),
          debounceMs: config.stagingDeployDebounceMs,
          overallTimeoutMs: config.stagingVerifyTimeoutMs,
          screenshotsRoot: releaseScreenshots,
        })
      : undefined;
  const bootedBuildSha =
    build.dirty || build.gitSha === 'unknown' || build.gitSha === 'forced'
      ? null
      : build.gitSha;
  const promoteService =
    releaseOpsOn && releaseWs !== undefined && deployRunner
      ? new PromoteService({
          control,
          workspaces: releaseWs,
          deployRunner,
          clock: () => Date.now(),
          bootedBuildSha,
        })
      : undefined;

  const cargoPrune = cargoCachePruneFromEnv();
  const adapterFailoverOn = isAdapterFailoverEnabled(process.env);
  if (!adapterFailoverOn) {
    console.error('[hercules] adapter failover disabled (HERCULES_ADAPTER_FAILOVER=0)');
  }
  const pathLeaseStore = new TaskPathLeaseStore(workRootForRelease);
  const mergeOperationStore = new MergeOperationStore(workRootForRelease);
  const mergeReceiptStore = new MergeFailureReceiptStore(workRootForRelease);
  const costLedgerStore = new CostLedgerStore({ rootDir: workRootForRelease });
  const grokReviewerHealthCheck = createGrokReviewerHealthCheck();
  const guardianReadinessHolder: {
    check: ((repo: RepoConfig) => Promise<GuardianReadinessReceipt>) | null;
  } = { check: null };
  const orchestrator = new Orchestrator({
    config,
    control,
    ...execution,
    clock: () => Date.now(),
    adapterFailoverEnabled: adapterFailoverOn,
    costLedgerStore,
    pathLeaseStore,
    reviewerHealthCheck: async (provider) =>
      provider === 'grok' && await grokReviewerHealthCheck(),
    guardianReadinessCheck: async (repo) => {
      if (!guardianReadinessHolder.check) {
        throw new Error('guardian readiness preflight unavailable');
      }
      return guardianReadinessHolder.check(repo);
    },
    // Disk watermark (always on — the box filled twice in three days).
    diskReader: async () => {
      try {
        const s = await statfs(workRootForRelease);
        return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
      } catch {
        return null;
      }
    },
    cargoTargetEnv: cargoPrune.cargoTargetEnv,
    cargoCacheRetainDays: cargoPrune.cargoCacheRetainDays,
    ...(releaseReconciler ? { releaseReconciler } : {}),
    ...(promoteService ? { promoteService } : {}),
    ...(c3EvidenceStack !== null
      ? {
          verifiedEvidence: {
            // Packet screenshots are basenames under <screenshotsRoot>/<taskId>.
            stage: (input) =>
              c3EvidenceStack!.intake.stage({
                ...input,
                ...(execution.screenshotsRoot
                  ? { screenshotDir: join(execution.screenshotsRoot, input.task.id) }
                  : {}),
              }),
          },
        }
      : {}),
    ...(dynamicCapsOn
      ? {
          memReader: () => readMemAvailableBytes(),
          onEffectiveCaps: (caps) => {
            const prev = effectiveCaps.current;
            effectiveCaps.current = caps;
            if (
              prev.globalCap !== caps.globalCap ||
              prev.heavyValidationPermits !== caps.heavyValidationPermits
            ) {
              console.error(
                `[hercules] dynamic caps: global=${caps.globalCap} heavy=${caps.heavyValidationPermits}`,
              );
            }
          },
        }
      : {}),
  });
  if (cargoPrune.cargoTargetEnv) {
    console.error(
      `[hercules] cargo-cache-prune: env targets=${cargoPrune.cargoTargetEnv} ` +
        `retain=${cargoPrune.cargoCacheRetainDays}d (verify teardown + disk warn)`,
    );
  }
  console.error(
    `[hercules] agents: default=${execution.agents!.defaultKind} available=${execution.agents!.available().join(',')}`,
  );
  if (releaseReconciler) {
    console.error(
      `[hercules] release reconciler: staging debounce=${config.stagingDeployDebounceMs}ms ` +
        `(HERCULES_STAGING_DEBOUNCE_MS) verify timeout=${config.stagingVerifyTimeoutMs}ms ` +
        `(HERCULES_STAGING_VERIFY_TIMEOUT_MS)`,
    );
  }
  if (promoteService) {
    console.error('[hercules] promote service: production deploy + boot finalization enabled');
  }
  if (!releaseOpsOn) {
    console.error(
      '[hercules] release ops DISABLED (set HERCULES_RELEASE_OPS=1 to enable) — verification target mode',
    );
  }
  if (dynamicCapsOn) {
    console.error(
      '[hercules] dynamic caps: enabled (MemAvailable → global/heavy; HERCULES_DYNAMIC_CAPS=1)',
    );
  }
  if (costCaps.billingModeNote) {
    console.error(`[hercules] ${costCaps.billingModeNote}`);
  }
  if (costCaps.enabled) {
    console.error(
      `[hercules] cost caps: enabled mode=${costCaps.billingMode} task soft/hard $` +
        `${costCaps.perTask.softUsd ?? '∞'}/${costCaps.perTask.hardUsd ?? '∞'} ` +
        `tok ${costCaps.perTask.softTokens ?? '∞'}/${costCaps.perTask.hardTokens ?? '∞'}; ` +
        `day soft/hard $${costCaps.daily.softUsd ?? '∞'}/${costCaps.daily.hardUsd ?? '∞'} ` +
        `tok ${costCaps.daily.softTokens ?? '∞'}/${costCaps.daily.hardTokens ?? '∞'}`,
    );
    console.error(
      `[hercules] cost ledger: durable atomic receipts under ${workRootForRelease}`,
    );
  }
  console.error(
    `[hercules] stall: idle=${config.stallTimeoutMs}ms hard-max=${config.maxRunMs}ms` +
      ` (processAlive skips idle; HERCULES_STALL_TIMEOUT_MS / HERCULES_MAX_RUN_MS)`,
  );

  // Free Remote Control sessions — ACP (Grok agent stdio) for true multi-turn
  // chat; headless adapters remain as fallback inside SessionManager.
  const sessionWorkspaces: Workspaces =
    execution.workspaces ?? new NoopWorkspaces(controlRepoDir);
  const workRoot =
    process.env['HERCULES_WORK_DIR'] ?? join(controlRepoDir, '..', 'hercules-work');
  const isolatedL2Boot = process.env['HERCULES_L2_ISOLATED'] === '1';
  const sessionStore = new SessionStore(workRoot);
  // Circular wiring: sessions.taskBridge uses actionService.chat; delete uses
  // sessions.closeLinkedToTask. Holder is filled after both are constructed.
  const sessionHolder: { mgr: SessionManager | null } = { mgr: null };
  const readinessAbort = new AbortController();
  const autoDeleteDaysRaw = process.env['HERCULES_AUTO_DELETE_DAYS'];
  const autoDeleteDays =
    autoDeleteDaysRaw !== undefined && autoDeleteDaysRaw.trim() !== ''
      ? Number(autoDeleteDaysRaw)
      : 30;
  const autoDeleteRetentionMs =
    Number.isFinite(autoDeleteDays) && autoDeleteDays > 0
      ? Math.floor(autoDeleteDays) * 24 * 60 * 60 * 1000
      : 0;
  // Worktree / screenshot disk hygiene (terminal tasks past retention).
  // Default 7d; never deletes remote/local salvage branches or control history.
  const worktreeGcDaysRaw = process.env['HERCULES_WORKTREE_GC_DAYS'];
  const worktreeGcDays =
    worktreeGcDaysRaw !== undefined && worktreeGcDaysRaw.trim() !== ''
      ? Number(worktreeGcDaysRaw)
      : 7;
  const worktreeGcRetentionMs =
    Number.isFinite(worktreeGcDays) && worktreeGcDays > 0
      ? Math.floor(worktreeGcDays) * 24 * 60 * 60 * 1000
      : 0;
  const worktreeGcDryRun = envFlagTruthy(process.env['HERCULES_WORKTREE_GC_DRY_RUN']);
  const worktreeGcPurgeScreenshots = envFlagTruthy(
    process.env['HERCULES_WORKTREE_GC_SCREENSHOTS'],
  );
  // Phone/API actions write control out-of-band from the tick loop — refresh
  // the live snapshot after every ActionService commit (all mutations).
  // PromoteService shares the control port; wrap commits so phone SSE refreshes.
  const actionControl = withControlSnapshotRefresh(control, () =>
    orchestrator.refreshSnapshotFromControl(),
  );
  // Rebind promote service control to the refreshing wrapper when present so
  // promote/rollback commits also push snapshot to listeners.
  const actionPromoteService =
    promoteService && releaseWs && deployRunner
      ? new PromoteService({
          control: actionControl,
          workspaces: releaseWs,
          deployRunner,
          clock: () => Date.now(),
          bootedBuildSha,
        })
      : undefined;
  const mergeOperationService = new MergeOperationService({
    store: mergeOperationStore,
    mergeDeps: {
      control: actionControl,
      succession: {},
      receiptStore: mergeReceiptStore,
      workspaces: {
        preservedTipStatus: (rk, tid, sha) =>
          sessionWorkspaces.preservedTipStatus!(rk, tid, sha),
        readWorkflow: (repo) => sessionWorkspaces.readWorkflow!(repo),
        openMergeWorktree: (repo) => sessionWorkspaces.openMergeWorktree!(repo),
        managedDisposition: (repoKey, taskId) => sessionWorkspaces.managedDisposition
          ? sessionWorkspaces.managedDisposition(repoKey, taskId)
          : Promise.resolve('unknown'),
      },
    },
  });
  void mergeOperationService.reconcileInterrupted().catch((err: Error) => {
    console.error('[hercules] merge operation reconcile: ' + err.message);
  });
  const actionService = new ActionService(
    actionControl,
    new GitRepoProbe(),
    undefined,
    {
      workspaces: sessionWorkspaces,
      ...(execution.screenshotsRoot ? { screenshotsRoot: execution.screenshotsRoot } : {}),
      closeSessionsForTask: (taskId) => {
        const m = sessionHolder.mgr;
        if (!m) return Promise.resolve([]);
        return m.closeLinkedToTask(taskId);
      },
      autoDeleteRetentionMs,
      worktreeGcRetentionMs,
      worktreeGcDryRun,
      worktreeGcPurgeScreenshots,
      worktreeGcKeep: () => {
        const st = orchestrator.getState();
        return new Set([...st.running, ...st.stopping]);
      },
    },
    execution.verifier && execution.workspaces
      ? {
          workspaces: execution.workspaces,
          verifier: execution.verifier,
          pathLeaseStore,
          mergeReceiptStore,
        }
      : undefined,
    // Soft Mark-ready + hard Guardian B-022 readiness against trusted mirror.
    {
      workspaces: sessionWorkspaces,
      daemonLeaseStatus: () => {
        if (heldDaemonLease === undefined) return 'absent';
        if (heldDaemonLease !== daemonLease) return 'stale';
        return 'ours';
      },
      defaultAdapter: execution.agents?.defaultKind ?? 'grok',
      capabilities: b022Capabilities,
      verifyCliEvidence: async ({ repo, revision, plan, buildGate }) => {
        if (!sessionWorkspaces.openMergeWorktree) return 'stale';
        const handle = await sessionWorkspaces.openMergeWorktree(repo);
        try {
          return await verifyPreparedCliEvidence({
            handle,
            revision,
            plan,
            buildGate,
            executionPolicy: effectiveRepoExecutionPolicy(repo.executionPolicy ?? null),
            signal: readinessAbort.signal,
          });
        } finally {
          await handle.dispose();
        }
      },
    },
    actionPromoteService,
    // Releases panel: trusted WORKFLOW + main tip + deploy-now → reconciler.
    // Range risk / per-task area chips use mirror git only (never worktrees).
    {
      workspaces: sessionWorkspaces,
      requestStagingDeployNow: (repoKey) => {
        orchestrator.requestStagingDeployNow(repoKey);
      },
      stagingVerifyTimeoutMs: config.stagingVerifyTimeoutMs,
      releaseScreenshotsRoot: releaseScreenshots,
      resolveStagingUiToken: (authTokenEnv) => {
        // WORKFLOW names the env var; value is only returned over Bearer auth
        // (never in URLs/logs). Default STAGING_UI_TOKEN when policy omits name.
        const envName =
          authTokenEnv !== undefined && authTokenEnv.trim() !== ''
            ? authTokenEnv.trim()
            : 'STAGING_UI_TOKEN';
        const v = process.env[envName];
        if (v === undefined || v.trim() === '') return null;
        return v;
      },
    },
    mergeOperationService,
  );

  const c3DecisionEffectsOn =
    shadowStore !== null && process.env['HERCULES_V2_DECISION_EFFECTS'] === '1';
  let decisionEffectDriver: DecisionEffectDriver | null = null;
  if (c3DecisionEffectsOn && shadowStore !== null) {
    decisionEffectDriver = createDecisionEffectDriver({
      store: adaptDecisionEffectStore(shadowStore),
      actions: actionService,
      legacy: actionControl,
      listAggregateIds: () => shadowStore.listTaskIds(),
      log: c3Log,
    });
    console.error('[hercules] C3 decision-effect driver enabled');
  }

  guardianReadinessHolder.check = async (repo) =>
    (await actionService.checkRepoConfigReadiness(repo)).guardian;
  const sessions = new SessionManager({
    agents: execution.agents!,
    workspaces: sessionWorkspaces,
    getRepos: async () => {
      const snap = orchestrator.getState().snapshot;
      if (snap) return snap.repos;
      // Before first tick, read control repo directly.
      return (await control.read()).repos;
    },
    clock: () => Date.now(),
    maxConcurrent: 1,
    createAcp: (cwd, permissionMode) => {
      const model = resolveGrokCodeModel();
      return connectGrokAcp(cwd, {
        permissionMode,
        ...(model ? { model } : {}),
      });
    },
    recordUsage: (e) =>
      orchestrator.recordSessionUsage({
        scopeId: e.scopeId,
        sessionId: e.sessionId,
        turn: e.turn,
        usage: e.usage,
        atMs: e.atMs,
      }),
    store: sessionStore,
    workRoot,
    taskBridge: {
      async getTask(taskId) {
        const snap = orchestrator.getState().snapshot ?? (await control.read());
        return snap.tasks.find((t) => t.id === taskId) ?? null;
      },
      isRunning(taskId) {
        const st = orchestrator.getState();
        return st.running.includes(taskId) || st.stopping.includes(taskId);
      },
      activity(taskId) {
        return orchestrator.getState().activity[taskId] ?? [];
      },
      pendingChat(taskId) {
        return orchestrator.getState().pendingChat?.[taskId] ?? [];
      },
      async deliverMessage(taskId, message, opts) {
        const st = orchestrator.getState();
        if (st.running.includes(taskId) || st.stopping.includes(taskId)) {
          const queued = orchestrator.queueTaskChat(taskId, message, {
            clientMessageId: opts?.clientMessageId ?? null,
          });
          if (queued.mode === 'duplicate') {
            return {
              mode: 'duplicate' as const,
              note: queued.reason ?? 'already delivered',
            };
          }
          return { mode: 'queued' as const, note: `${queued.queued.length} queued` };
        }
        const result = await actionService.chat(taskId, message, {
          clientMessageId: opts?.clientMessageId ?? null,
        });
        if (result.mode === 'duplicate') {
          return {
            mode: 'duplicate' as const,
            note: result.reason ?? 'already delivered',
          };
        }
        if (result.mode === 'steer') return { mode: 'steer' as const };
        return { mode: 'pending' as const };
      },
      workspaceDir(taskId) {
        const snap = orchestrator.getState().snapshot;
        const task = snap?.tasks.find((t) => t.id === taskId);
        if (!task) return null;
        // GitWorkspaces layout: <workRoot>/<repoKey>/<taskId>
        return join(workRoot, task.repo, taskId);
      },
    },
  });
  sessionHolder.mgr = sessions;
  void sessions.hydrate().then((n) => {
    if (n > 0) console.error(`[hercules] Remote Control: restored ${n} session(s) from disk`);
  });
  console.error(
    '[hercules] Remote Control: ACP (grok agent stdio); permission modes default/acceptEdits/bypass; sessions persist under work dir',
  );
  // Weekly AI voice avatar (Grok Imagine) — one image / ISO week, cached on disk.
  // Isolated L2 must never inherit credentials and create paid external effects.
  if (!isolatedL2Boot) {
    void import('./server/voiceAvatar.js').then(({ ensureWeeklyAvatar, isoWeekKey }) => {
      void ensureWeeklyAvatar({ workRoot }).then((r) => {
        if (r.ok) {
          console.error(
            `[hercules] voice avatar ${r.meta.weekKey} (${r.meta.name}) ${r.cached ? 'cached' : 'generated'}`,
          );
        } else {
          console.error(`[hercules] voice avatar ${isoWeekKey()}: ${r.error} (SPA falls back to SVG)`);
        }
      });
    });
  } else {
    console.error('[hercules] isolated L2: external voice avatar generation disabled');
  }

  /** Merge free-session state into the orchestrator RuntimeView for SSE/API. */
  const runtime = {
    getState(): RuntimeView {
      const base = orchestrator.getState();
      return {
        ...base,
        sessions: sessions.list(),
        sessionActivity: sessions.activity(),
      };
    },
    subscribe(listener: (view: RuntimeView) => void): () => void {
      const wrap = (): void => listener(runtime.getState());
      const u1 = orchestrator.subscribe(() => wrap());
      const u2 = sessions.subscribe(wrap);
      return () => {
        u1();
        u2();
      };
    },
    forceAbort(id: string): void {
      orchestrator.forceAbort(id);
    },
    requestCancel(id: string): void {
      orchestrator.requestCancel(id);
    },
    /** Settings / API: clear durable L3 provider brake (health_check or operator). */
    recoverReviewerProvider(
      provider: AdapterKind,
      input: { readonly mode: 'health_check' | 'operator' },
    ) {
      return orchestrator.recoverReviewerProvider(provider, input);
    },
    queueTaskChat(
      id: string,
      message: string,
      opts?: { readonly clientMessageId?: string | null },
    ) {
      return orchestrator.queueTaskChat(id, message, opts);
    },
  };

  // Poll free sessions on the same cadence as the orchestrator tick.
  const sessionTimer = setInterval(() => {
    void sessions.tick().catch((err: unknown) => {
      console.error(`[hercules] session tick: ${(err as Error).message}`);
    });
  }, config.tickIntervalMs);

  // Terminal auto-delete: each done/cancelled/failed task ages alone from its
  // endedAt (30d default). Check once a minute — cheap filter, rare purges.
  const autoDeleteTimer =
    autoDeleteRetentionMs > 0
      ? setInterval(() => {
          void actionService.purgeExpiredTerminal().catch((err: unknown) => {
            console.error(`[hercules] auto-delete sweep: ${(err as Error).message}`);
          });
        }, 60_000)
      : null;
  if (autoDeleteRetentionMs > 0) {
    console.error(
      `[hercules] auto-purge Deleted trash after ${Math.round(autoDeleteRetentionMs / 86_400_000)}d (per-task soft-delete time)`,
    );
    // Run once shortly after boot so long-lived daemons don't wait a minute.
    setTimeout(() => {
      void actionService.purgeExpiredTerminal().catch((err: unknown) => {
        console.error(`[hercules] auto-delete boot: ${(err as Error).message}`);
      });
    }, 15_000);
  }

  // Worktree GC: free residual checkouts (+ optional screenshots) for terminal
  // tasks past retention. Always logs one line per sweep (dry-run or apply).
  // Never deletes remote branches or control-repo history.
  const worktreeGcTimer =
    worktreeGcRetentionMs > 0
      ? setInterval(() => {
          void actionService.runWorktreeGc().catch((err: unknown) => {
            console.error(`[hercules] worktree-gc sweep: ${(err as Error).message}`);
          });
        }, 60_000)
      : null;
  if (worktreeGcRetentionMs > 0) {
    const mode = worktreeGcDryRun ? 'dry-run' : 'apply';
    const shots = worktreeGcPurgeScreenshots ? '+screenshots' : 'worktrees-only';
    console.error(
      `[hercules] worktree-gc enabled mode=${mode} ${shots} retention=${Math.round(worktreeGcRetentionMs / 86_400_000)}d ` +
        `(HERCULES_WORKTREE_GC_DAYS; salvage branches kept)`,
    );
    setTimeout(() => {
      void actionService.runWorktreeGc().catch((err: unknown) => {
        console.error(`[hercules] worktree-gc boot: ${(err as Error).message}`);
      });
    }, 20_000);
  }

  // Settings → Pull & rebuild (git pull + pnpm build + systemctl restart).
  const selfUpdate = createSelfUpdateService();
  if (!selfUpdate.status().enabled) {
    console.error('[hercules] self-update disabled (HERCULES_SELF_UPDATE=0)');
  }

  // Reconcile pr_status=open against GitHub so "Awaiting merge" clears after
  // the human merges on the website (control repo is not notified by GitHub).
  const prSyncTimer = isolatedL2Boot
    ? null
    : setInterval(() => {
        void actionService.syncOpenPrStatuses().catch((err: unknown) => {
          console.error(`[hercules] pr status sync: ${(err as Error).message}`);
        });
      }, 60_000);
  if (!isolatedL2Boot) {
    setTimeout(() => {
      void actionService.syncOpenPrStatuses().catch((err: unknown) => {
        console.error(`[hercules] pr status sync boot: ${(err as Error).message}`);
      });
    }, 8_000);
  } else {
    console.error('[hercules] isolated L2: external pull-request reconciliation disabled');
  }

  // Auto-merge pilot: approve + merge green review tasks for repos with
  // auto_merge.enabled. Fail closed: HERCULES_AUTO_MERGE=1 is required in
  // addition to the per-repo policy (kill switch = unset the env).
  const autoMergeOn = process.env['HERCULES_AUTO_MERGE'] === '1' && !isolatedL2Boot;
  const autoMergeTimer = autoMergeOn
    ? setInterval(() => {
        void actionService.runAutoMergePilot().catch((err: unknown) => {
          console.error(`[hercules] auto-merge sweep: ${(err as Error).message}`);
        });
      }, 60_000)
    : null;
  if (autoMergeOn) {
    setTimeout(() => {
      void actionService.runAutoMergePilot().catch((err: unknown) => {
        console.error(`[hercules] auto-merge sweep: ${(err as Error).message}`);
      });
    }, 25_000);
    console.error(
      '[hercules] auto-merge pilot ENABLED (per-repo auto_merge in repos.yaml; 60s sweep)',
    );
  } else {
    console.error(
      '[hercules] auto-merge pilot disabled (set HERCULES_AUTO_MERGE=1 to enable)',
    );
  }

  // C3 producers: 60s sweep family + staggered boot kick (12s).
  const c3ProducerTimer =
    c3EvidencePorts !== null || c3EvaluationPorts !== null
      ? setInterval(() => {
          enqueueC3Producers();
        }, 60_000)
      : null;
  if (c3ProducerTimer !== null) {
    setTimeout(() => {
      enqueueC3Producers();
    }, 12_000);
  }

  // C3 decision effects: boot re-drive (10s) + 60s redriveAll + detectDivergence.
  const c3DecisionEffectsTimer =
    decisionEffectDriver !== null
      ? setInterval(() => {
          void decisionEffectDriver!
            .redriveAll()
            .then(async () => {
              const divergences = await decisionEffectDriver!.detectDivergence();
              for (const row of divergences) {
                console.error(
                  `[hercules] C3 decision divergence aggregate=${row.aggregateId} ` +
                    `v2=${row.v2Status} legacy=${row.legacyState ?? 'missing'} ` +
                    `pendingMarker=${row.pendingMarker}`,
                );
              }
            })
            .catch((err: unknown) => {
              console.error(
                `[hercules] C3 decision-effect sweep: ${(err as Error).message}`,
              );
            });
        }, 60_000)
      : null;
  if (decisionEffectDriver !== null) {
    setTimeout(() => {
      void decisionEffectDriver!.redriveAll().catch((err: unknown) => {
        console.error(
          `[hercules] C3 decision-effect boot: ${(err as Error).message}`,
        );
      });
    }, 10_000);
  }

  const bindHost = resolveBindHost(process.env);
  const isolatedReviewApiDeps = await openIsolatedM7ReviewApiDeps({
    env: process.env,
    workRoot,
  });
  const controlPlaneDeps = openControlApiV2Deps({
    store: shadowStore,
    env: process.env,
    log: (line) => console.error(line),
  });

  // Analyst stage: default on when L3 reviewer is on; HERCULES_ANALYST=0 opts out.
  // Fresh read-only grok session (same ReviewRunner) — never auto-creates tasks.
  const analystEnvOff =
    (process.env['HERCULES_ANALYST'] ?? '1').trim() === '0' ||
    (process.env['HERCULES_ANALYST'] ?? '').toLowerCase() === 'false' ||
    (process.env['HERCULES_ANALYST'] ?? '').toLowerCase() === 'off';
  const analystWs =
    !execution.reviewerDisabled && !analystEnvOff && execution.workspaces instanceof GitWorkspaces
      ? (execution.workspaces as GitWorkspaces)
      : null;
  const analystApi = analystWs
    ? await (async () => {
        const analystModel = resolveGrokCodeModel();
        // Confinement: trusted-tip snapshot + hercules-analyst (strict, deny=[])
        // under a private GROK_HOME (auth.json + agent_id only). Deny mounts for
        // ~/.grok/{continuity,…} were dropped — grok CLI ≥ 1.0.13 refuses them.
        const analystRoot = join(workRoot, '.analyst');
        const analystSnapshots = createAnalystSnapshots({
          root: analystRoot,
          defaultBranchHead: (r) => analystWs.defaultBranchHead(r),
          exportTree: (r, sha, dest) => analystWs.exportTrustedTree(r, sha, dest),
          log: (line) => console.error(line),
        });
        const privateHome = await analystSnapshots.ensurePrivateHome();
        if (privateHome === null) {
          // ensurePrivateHome already logged UNAVAILABLE — skip wiring.
          return undefined;
        }
        // Same fail-closed allowlist as the L3 reviewer child (xAI auth
        // plumbing only — never HERCULES_TOKEN / DB URLs), plus the private
        // grok home (Claude R17 N2).
        const analystEnv: NodeJS.ProcessEnv = {
          ...reviewChildEnv({ policy: null }).env,
          GROK_HOME: privateHome,
        };
        // Probe cwd next to snapshots (never inside a repo tree): profile only.
        const probeDir = join(analystRoot, '_probe');
        await mkdir(join(probeDir, '.grok'), { recursive: true });
        await writeFile(
          join(probeDir, '.grok', 'sandbox.toml'),
          renderAnalystSandboxToml(),
          'utf8',
        );
        // Not awaited: the probe only logs (ok / UNAVAILABLE + first stderr
        // line); a hung grok must not delay boot (Grok R17 N4).
        void createAnalystSandboxHealthCheck({
          cwd: probeDir,
          env: analystEnv,
          sandbox: ANALYST_SANDBOX_PROFILE,
          reasoningEffort: 'low',
          ...(analystModel ? { model: analystModel } : {}),
          log: (line) => console.error(line),
        })().catch((err: unknown) => {
          console.error(
            `[hercules] analyst: sandbox probe failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
          );
        });
        const analyst = new Analyst(
          createGrokReviewRunner({
            outputContract: 'freeform',
            reasoningEffort: 'low',
            sandbox: ANALYST_SANDBOX_PROFILE,
            rules: ANALYST_SESSION_RULES,
            env: analystEnv,
            ...(analystModel ? { model: analystModel } : {}),
          }),
        );
        console.error(
          `[hercules] analyst: grok${analystModel ? ` -m ${analystModel}` : ''} effort=low sandbox=${ANALYST_SANDBOX_PROFILE} GROK_HOME=<private> (fresh session in a trusted-tip snapshot; human approves plan)`,
        );
        return {
          draft: async (
            intent: string,
            repo: RepoConfig,
            onActivity?: AnalystActivityListener,
          ) => {
            // Context compile is the first thing the phone sees moving.
            onActivity?.({ kind: 'phase', phase: 'context' });
            const context = await compileAnalystContext(
              {
                readTrustedFile: (r, p) => analystWs.readTrustedFile(r, p),
                listTrustedFiles: (r, o) => analystWs.listTrustedFiles(r, o),
                grepTrusted: (r, pat, o) => analystWs.grepTrusted(r, pat, o),
                readWorkflow: (r) => analystWs.readWorkflow(r),
              },
              repo,
              intent,
            );
            const snapshot = await analystSnapshots.ensure(repo);
            if (snapshot.grokHome === null) {
              // Credentials disappeared since boot — reuse Analyst fallback path.
              return new Analyst(async () => {
                throw new ReviewerInfraError('missing auth.json in private GROK_HOME');
              }).draft({
                intent,
                repo,
                context,
                ...(onActivity ? { onActivity } : {}),
              });
            }
            return analyst.draft({
              intent,
              repo,
              context,
              cwd: snapshot.dir,
              env: { ...reviewChildEnv({ policy: null }).env, GROK_HOME: snapshot.grokHome },
              ...(onActivity ? { onActivity } : {}),
            });
          },
        };
      })()
    : undefined;
  if (!analystApi) {
    console.error(
      execution.reviewerDisabled || analystEnvOff
        ? '[hercules] analyst disabled (HERCULES_ANALYST=0 or L3 reviewer off)'
        : '[hercules] analyst disabled (no GitWorkspaces)',
    );
  }

  const server = startServer({
    runtime,
    actions: actionService,
    token,
    port,
    ...(bindHost ? { hostname: bindHost } : {}),
    webDir,
    sessions,
    workRoot,
    selfUpdate,
    ...isolatedReviewApiDeps,
    ...controlPlaneDeps,
    ...(decisionEffectDriver !== null
      ? { decisionEffects: decisionEffectDriver }
      : {}),
    ...(analystApi ? { analyst: analystApi } : {}),
    ...(execution.screenshotsRoot ? { screenshotsRoot: execution.screenshotsRoot } : {}),
    // Phone review file browser — trusted-mirror reads at the verified sha.
    // Repo docs browser — README / docs/** at default branch (Repos panel).
    ...(execution.workspaces instanceof GitWorkspaces
      ? {
          taskFiles: {
            list: (r: RepoConfig, s: string) =>
              (execution.workspaces as GitWorkspaces).listTaskFiles(r, s),
            read: (r: RepoConfig, s: string, p: string) =>
              (execution.workspaces as GitWorkspaces).readTaskFile(r, s, p),
          },
          repoDocs: {
            list: (r: RepoConfig) =>
              (execution.workspaces as GitWorkspaces).listRepoDocs(r),
            read: (r: RepoConfig, p: string) =>
              (execution.workspaces as GitWorkspaces).readRepoDoc(r, p),
          },
        }
      : {}),
    releaseScreenshotsRoot: releaseScreenshots,
    // Staging auto-unlock: production env sets MINT_FILE, staging env sets
    // REDEEM_FILE (same path on this box). See src/server/stagingHandoff.ts.
    ...(process.env['HERCULES_HANDOFF_MINT_FILE'] || process.env['HERCULES_HANDOFF_REDEEM_FILE']
      ? {
          stagingHandoff: {
            ...(process.env['HERCULES_HANDOFF_MINT_FILE']
              ? { mintFile: process.env['HERCULES_HANDOFF_MINT_FILE'] }
              : {}),
            ...(process.env['HERCULES_HANDOFF_REDEEM_FILE']
              ? { redeemFile: process.env['HERCULES_HANDOFF_REDEEM_FILE'] }
              : {}),
          },
        }
      : {}),
  });

  // Eager first control snapshot so /api/state is ready before the first
  // tickInterval (default 3s). Independent of any L2 fixture — production
  // phone UI and health probes should not wait on an empty lastSnapshot.
  try {
    await orchestrator.refreshSnapshotFromControl();
  } catch (err) {
    console.error(
      `[hercules] initial snapshot refresh failed: ${(err as Error).message}`,
    );
  }
  orchestrator.start();
  console.error(
    `[hercules] bind: ${bindHost ?? 'all interfaces (private network/tunnel + token guard) — set HERCULES_BIND_HOST to pin'}`,
  );
  const authHint = startupAuthHint(configuredToken, token);
  console.error(
    `[hercules] up on http://localhost:${port}  (control: ${controlRepoDir})\n${authHint}`,
  );

  const shutdown = (): void => {
    console.error('[hercules] shutting down');
    readinessAbort.abort(new Error('Hercules shutdown'));
    clearInterval(sessionTimer);
    if (autoDeleteTimer) clearInterval(autoDeleteTimer);
    if (worktreeGcTimer) clearInterval(worktreeGcTimer);
    if (prSyncTimer) clearInterval(prSyncTimer);
    if (autoMergeTimer) clearInterval(autoMergeTimer);
    if (c3ProducerTimer) clearInterval(c3ProducerTimer);
    if (c3DecisionEffectsTimer) clearInterval(c3DecisionEffectsTimer);
    orchestrator.stop();
    shadowStore?.close();
    if (c3EvidenceStack !== null) {
      void c3EvidenceStack.close().catch((err: unknown) => {
        console.error(
          `[hercules] C3 evidence archive close: ${(err as Error).message}`,
        );
      });
    }
    server.close();
    void daemonLease.release().finally(() => {
      heldDaemonLease = undefined;
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err: unknown) => {
    console.error(`[hercules] fatal: ${(err as Error).message}`);
    const code = err instanceof DaemonLeaseConflictError ? 2 : 1;
    const lease = heldDaemonLease;
    heldDaemonLease = undefined;
    if (lease) {
      void lease.release().finally(() => process.exit(code));
    } else {
      process.exit(code);
    }
  });
}
