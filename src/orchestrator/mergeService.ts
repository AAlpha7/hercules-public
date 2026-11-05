/**
 * Safe batch Merge — human-authorized merge of approved tasks into main
 * (design §3 / SPEC §10 reworded red line).
 *
 * Flow: shared static eligibility (done + verified_sha + not merged + not
 * pr_status=merged) → preservedTipStatus recheck → merge --no-ff of the
 * **pinned accepted tip SHA** (never the moving hercules/<task> ref) into a
 * TEMP worktree of current mirror main → after the whole batch, re-run L1
 * gates ONCE → push main (never force) → stamp merged_sha. Per-repo process
 * single-flight refuses concurrent duplicates. Static ineligibility is
 * fail-closed and non-mutating; only dynamic tip mismatch / conflict / gate
 * failure returns tasks to review. Origin main is never half-pushed.
 *
 * IO is injected (ControlPort + Workspaces merge hooks + gate runner).
 */
import { parse as parseYaml } from 'yaml';
import { isValidIdentifier, type Task } from '../domain/task.js';
import { isFullCommitSha } from '../domain/taskBranchLease.js';
import type { MergeGateProgress, MergeOperationPhase, MergeProgressEvent } from '../domain/mergeOperation.js';
import { assertTransition, TransitionError } from '../domain/stateMachine.js';
import { staticMergeBlockReason } from '../domain/release.js';
import type { RepoConfig } from '../domain/repos.js';
import { effectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';
import {
  formatPathEvidenceList,
  isFirstTimeWorkflowBootstrap,
  normalizeAffectedPaths,
  normalizeConfiguredWorkflowPath,
  pathInScope,
  pathLeasePolicyFor,
  protectedPathsSnapshotsEqual,
  scopesOverlap,
  validateDiffAgainstScopes,
  verifyWorkflowBootstrapCandidate,
} from '../domain/taskPathLease.js';
import { pathLeaseDeclarationDigest } from '../control/pathLeaseDigest.js';
import { parseWorkflow, WorkflowError } from '../control/workflow.js';
import { projectStateClosurePolicyDigest } from '../control/projectStateClosureDigest.js';
import {
  evaluateProjectStateClosure,
  formatProjectStateClosureBlockReason,
  parseProjectStateClosureConfig,
  resolveProjectStateClosureContract,
  upsertProjectStateClosureReceiptBody,
  ProjectStateClosureParseError,
  type ProjectStateClosureContract,
  type ProjectStateSurfaceKind,
} from '../domain/projectStateClosure.js';
import {
  runGates,
  gatesGreen,
  execRunner,
  type CommandRunner,
} from '../verification/gates.js';
import type { ControlPort } from './orchestrator.js';
import { mutateControl } from './controlMutation.js';
import { prepareSuccessionLedger } from './successionService.js';
import type { MergeWorktreeHandle, Workspaces } from '../isolation/worktree.js';
import {
  buildMergeGateFailureReceipt,
  formatMergeFailureReceiptMarkdown,
  publicMergeFailureReceipt,
  MERGE_FAILURE_RECEIPT_HEADING,
  type MergeFailureReceipt,
} from '../domain/mergeFailureReceipt.js';
import { neutralizeUntrustedPacketText } from '../domain/packetNeutralize.js';
import {
  MergeFailureReceiptStore,
  newMergeFailureOperationId,
} from '../isolation/mergeFailureReceiptStore.js';

export class MergeError extends Error {
  override readonly name = 'MergeError';
}

/** Process-wide per-repo single-flight for the complete merge operation. */
const mergeInflightByRepo = new Set<string>();

export interface MergeFailure {
  readonly taskId: string;
  readonly reason: string;
}

export interface MergeBatchResult {
  /** True only when every requested task was merged, gated, pushed, and stamped. */
  readonly ok: boolean;
  /** Final main tip after a successful push; null when nothing was pushed. */
  readonly mergedSha: string | null;
  readonly failures: readonly MergeFailure[];
  /** Tasks written during this call (success stamps and/or review reverts). */
  readonly tasks: readonly Task[];
  /** Set when post-merge L1 gates failed (no push). */
  readonly operationStatus?: string;
  /** Bounded, redacted diagnostic for merge-gate failure (API/phone). */
  readonly mergeGateReceipt?: MergeFailureReceipt;
  /**
   * C3.57: verified sha whose L1 result the merge inherited instead of
   * re-running the gates (single task, merge-base == default tip, tip ==
   * verified sha, verified_gates_green). Null/absent when gates ran.
   */
  readonly gatesInheritedFromSha?: string | null;
}

/** Isolation surface required for merge (subset of Workspaces). */
export interface MergeWorkspaces {
  preservedTipStatus(
    repoKey: string,
    taskId: string,
    verifiedSha: string,
  ): Promise<{ ok: boolean; tip: string | null; reason: string }>;
  readWorkflow(repo: RepoConfig): Promise<string | null>;
  openMergeWorktree(repo: RepoConfig): Promise<MergeWorktreeHandle>;
  managedDisposition?(repoKey: string, taskId: string): Promise<import('../domain/workspaceSuccession.js').ManagedDisposition>;
}

export interface MergeServiceDeps {
  readonly control: ControlPort;
  readonly workspaces: MergeWorkspaces;
  /** Gate command runner; defaults to real shell exec. */
  readonly commandRunner?: CommandRunner;
  readonly onProgress?: (event: MergeProgressEvent) => void;
  /** Required in production; optional only for legacy lightweight test ports. */
  readonly succession?: { readonly clock?: () => Date };
  /** Durable redacted receipt store for post-merge gate failures. */
  readonly receiptStore?: MergeFailureReceiptStore;
  /** Clock for receipt timestamps (tests). */
  readonly now?: () => Date;
}

/**
 * Append a merge-failure section to a task body (human-readable audit).
 */
export function appendMergeFailureReason(body: string, reason: string): string {
  // Structured diagnostic receipt is already a full markdown section
  // (formatMergeFailureReceiptMarkdown neutralizes free text).
  if (reason.includes(MERGE_FAILURE_RECEIPT_HEADING)) {
    const trimmed = body.trimEnd();
    const block = reason.trim() + '\n';
    return trimmed.length === 0 ? block : trimmed + '\n\n' + block;
  }
  const block = `## Merge failure\n\n${neutralizeUntrustedPacketText(reason.trim())}\n`;
  const trimmed = body.trimEnd();
  if (trimmed.includes('## Merge failure')) {
    return `${trimmed}\n\n${block}`;
  }
  return trimmed.length === 0 ? block : `${trimmed}\n\n${block}`;
}

function defaultMergeNowIso(): string {
  return new Date().toISOString();
}

export class MergeService {
  private readonly control: ControlPort;
  private readonly workspaces: MergeWorkspaces;
  private readonly commandRunner: CommandRunner;
  private readonly onProgress: ((event: MergeProgressEvent) => void) | undefined;
  private readonly successionClock: (() => Date) | undefined;
  private readonly successionEnabled: boolean;
  private readonly receiptStore: MergeFailureReceiptStore | undefined;
  private readonly nowFn: (() => Date) | undefined;

  constructor(deps: MergeServiceDeps) {
    this.control = deps.control;
    this.workspaces = deps.workspaces;
    this.commandRunner = deps.commandRunner ?? execRunner;
    this.onProgress = deps.onProgress;
    this.successionEnabled = deps.succession !== undefined;
    this.successionClock = deps.succession?.clock;
    this.receiptStore = deps.receiptStore;
    this.nowFn = deps.now;
  }

  private report(phase: MergeOperationPhase, gateProgress?: MergeGateProgress | null): void {
    this.onProgress?.({ phase, gateProgress: gateProgress ?? null });
  }

  /**
   * Merge ordered approved (done, unmerged) tasks for one repo into main.
   * Atomic w.r.t. origin: push happens only after the full batch merges and
   * L1 gates pass. Per-repo process single-flight: a concurrent call for the
   * same repo throws {@link MergeError} without running gates or pushing.
   */
  async mergeBatch(repoKey: string, taskIds: readonly string[]): Promise<MergeBatchResult> {
    if (!isValidIdentifier(repoKey)) {
      throw new MergeError(`unsafe repo key '${repoKey}'`);
    }
    if (taskIds.length === 0) {
      throw new MergeError('taskIds must be a non-empty array');
    }
    for (const id of taskIds) {
      if (!isValidIdentifier(id)) {
        throw new MergeError(`unsafe task id '${id}'`);
      }
    }
    if (mergeInflightByRepo.has(repoKey)) {
      throw new MergeError(`merge already in flight for repo '${repoKey}'`);
    }
    mergeInflightByRepo.add(repoKey);
    try {
      return await this.mergeBatchUnlocked(repoKey, taskIds);
    } finally {
      mergeInflightByRepo.delete(repoKey);
    }
  }

  private async mergeBatchUnlocked(
    repoKey: string,
    taskIds: readonly string[],
  ): Promise<MergeBatchResult> {
    // Dedupe while preserving order.
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of taskIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }

    const snapshot = await this.control.read();
    const repo = snapshot.repos.repos[repoKey];
    if (!repo) throw new MergeError(`unknown repo '${repoKey}'`);

    const tasksById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    const selected: Task[] = [];
    for (const id of ordered) {
      const t = tasksById.get(id);
      if (!t) throw new MergeError(`unknown task '${id}'`);
      if (t.repo !== repoKey) {
        throw new MergeError(`task '${id}' belongs to repo '${t.repo}', not '${repoKey}'`);
      }
      selected.push(t);
    }

    this.report('precheck');
    // ── Pre-checks (no git mutation of main yet) ────────────────────────
    // Static contract shared with selectMergeableTasks; then pin tip SHA.
    // Static ineligibility is fail-closed and non-mutating (no returnToReview).
    // Only dynamic tip mismatch / later conflict / gate failures audit to review.
    const staticFailures: MergeFailure[] = [];
    const dynamicFailures: MergeFailure[] = [];
    const eligible: {
      task: Task;
      verifiedSha: string;
      tipSha: string;
      /** Exact remote-tip lease proven at precheck (C3.55); task record stays as on disk. */
      remoteTipLease: string | null;
    }[] = [];
    const pathLeasePolicy = pathLeasePolicyFor(
      effectiveRepoExecutionPolicy(repo.executionPolicy ?? null),
    );
    for (const t of selected) {
      const block = staticMergeBlockReason(t, repoKey);
      if (block) {
        staticFailures.push({ taskId: t.id, reason: block });
        continue;
      }
      const declarationCount = [
        t.plannedBaseRevision,
        t.affectedPaths,
        t.protectedPathsSnapshot,
      ].filter((value) => value !== undefined).length;
      if (
        (pathLeasePolicy.requireDeclarations && declarationCount !== 3) ||
        (declarationCount !== 0 && declarationCount !== 3)
      ) {
        staticFailures.push({
          taskId: t.id,
          reason:
            'merge refused: incomplete path-lease declaration; planned base, affected paths, ' +
            'and protected-path snapshot must be reviewed together',
        });
        continue;
      }
      if (
        declarationCount === 3 &&
        pathLeaseDeclarationDigest(t) !== t.verifiedPathLeaseDigest
      ) {
        staticFailures.push({
          taskId: t.id,
          reason:
            'merge refused: path-lease declaration changed after verification; re-verify the exact plan',
        });
        continue;
      }
      // verifiedSha is non-empty after static eligibility.
      const verifiedSha = t.verifiedSha;
      if (!verifiedSha) {
        // Defense in depth — static contract already requires verified_sha.
        staticFailures.push({
          taskId: t.id,
          reason:
            'merge refused: missing verified_sha — cannot prove branch tip matches verification',
        });
        continue;
      }
      if (this.mergeDepsSuccessionEnabled() && (
        !isFullCommitSha(verifiedSha) ||
        !t.expectedBaseRevision || !isFullCommitSha(t.expectedBaseRevision)
      )) {
        staticFailures.push({
          taskId: t.id,
          reason:
            'merge refused: succession receipt requires full exact verified and base SHAs ' +
            `(verified_sha=${verifiedSha}, expected_base_revision=${String(t.expectedBaseRevision)})`,
        });
        continue;
      }
      const status = await this.workspaces.preservedTipStatus(t.repo, t.id, verifiedSha);
      if (!status.ok || !status.tip) {
        dynamicFailures.push({
          taskId: t.id,
          reason: `verified-SHA mismatch: ${status.reason || 'accepted tip missing'}`,
        });
        continue;
      }
      // Exact remote-tip lease. A run that pushed nothing (verify-only task
      // whose tip IS the seed, or a lease advance lost to a restart) leaves the
      // branch-creation lease null although origin holds the verified tip; the
      // preserved-tip proof above establishes exactly what the lease would
      // (origin hercules/<task> == verified_sha), so heal the lease from it
      // instead of refusing with a redacted "precheck failed" (C3.55,
      // a downstream project task 23, 2026-09-12).
      let remoteTipLease: string | null = t.expectedRemoteTip ?? null;
      if (this.mergeDepsSuccessionEnabled()) {
        if (remoteTipLease === null && status.tip.toLowerCase() === verifiedSha.toLowerCase()) {
          remoteTipLease = status.tip.toLowerCase();
        }
        if (remoteTipLease === null || !isFullCommitSha(remoteTipLease)) {
          staticFailures.push({
            taskId: t.id,
            reason:
              'merge refused: succession receipt requires an exact remote-tip lease and the ' +
              `preserved tip ${status.tip.slice(0, 12)} differs from verified_sha ${verifiedSha.slice(0, 12)}`,
          });
          continue;
        }
        if (status.tip.toLowerCase() !== remoteTipLease.toLowerCase()) {
          dynamicFailures.push({
            taskId: t.id,
            reason: 'verified-SHA mismatch: preserved tip does not equal the exact remote-tip lease',
          });
          continue;
        }
      }
      // Pin the exact accepted SHA — never re-resolve hercules/<task> later.
      // `task` stays the on-disk record: the stamp write uses it as its CAS
      // expectation; the healed lease travels separately.
      eligible.push({ task: t, verifiedSha, tipSha: status.tip, remoteTipLease });
    }

    const preFailures = [...staticFailures, ...dynamicFailures];
    if (preFailures.length > 0) {
      // Dynamic tip failures may return to review for re-verify. Static
      // ineligibility (missing verified_sha / merged_sha / pr_status=merged /
      // wrong state) must not rewrite task state or provenance.
      const written = await this.returnToReview(
        dynamicFailures
          .map((f) => {
            const t = tasksById.get(f.taskId);
            if (!t || t.state !== 'done') return null;
            return { task: t, reason: f.reason };
          })
          .filter((x): x is { task: Task; reason: string } => x !== null),
        'pre-check',
      );
      return {
        ok: false,
        mergedSha: null,
        failures: preFailures,
        tasks: written,
      };
    }

    this.report('merging');
    // ── Merge into temp worktree ────────────────────────────────────────
    let handle: MergeWorktreeHandle | null = null;
    try {
      handle = await this.workspaces.openMergeWorktree(repo);
      const currentMainTip = await handle.headSha();
      const batchScopes: { readonly taskId: string; readonly scopes: ReturnType<typeof normalizeAffectedPaths> }[] = [];
      let pureBootstrapBatch = eligible.length > 0;
      for (const { task: t, tipSha } of eligible) {
        let bootstrapMerge = false;
        if (t.affectedPaths !== undefined) {
          const declared = normalizeAffectedPaths(t.affectedPaths);
          if (
            !declared.ok ||
            !t.plannedBaseRevision ||
            !handle.filesChangedBetween ||
            !handle.isAncestor ||
            !handle.mergeBase ||
            !handle.readFileAt
          ) {
            const reason = !declared.ok
              ? `merge path-scope declaration invalid: ${declared.reason}`
              : 'merge path-scope proof unavailable for declared task';
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          }
          const batchConflict = batchScopes.find(
            (other) =>
              other.scopes.ok &&
              other.scopes.scopes.some((a) =>
                declared.scopes.some((b) => scopesOverlap(a, b)),
              ),
          );
          if (batchConflict) {
            const reason =
              `merge refused: selected tasks ${batchConflict.taskId} and ${t.id} ` +
              'declare overlapping writer scopes';
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          }
          batchScopes.push({ taskId: t.id, scopes: declared });
          const plannedIsAncestor = await handle.isAncestor(
            t.plannedBaseRevision,
            currentMainTip,
          );
          if (!plannedIsAncestor) {
            const reason =
              'merge refused: planned base is not an ancestor of current trusted main';
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          }
          const workflowAtMain = await handle.readFileAt(currentMainTip, repo.workflow);
          bootstrapMerge = isFirstTimeWorkflowBootstrap({
            trustedRevision: currentMainTip,
            workflowContent: workflowAtMain,
            repoReadiness: repo.readiness,
            labels: t.labels,
            plannedBaseRevision: t.plannedBaseRevision,
            affectedPaths: t.affectedPaths,
            protectedPathsSnapshot: t.protectedPathsSnapshot,
            configuredWorkflowPath: repo.workflow,
          });
          if (t.protectedPathsSnapshot === undefined) {
            const reason = 'merge refused: trusted protected-path snapshot unavailable';
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          }
          let currentProtectedPaths: readonly string[];
          if (bootstrapMerge) {
            // First-time WORKFLOW bootstrap: trusted tip has no workflow; empty
            // protected snapshot is the only legal baseline.
            currentProtectedPaths = [];
          } else if (!workflowAtMain) {
            const reason = 'merge refused: trusted protected-path snapshot unavailable';
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          } else {
            try {
              currentProtectedPaths = parseWorkflow(workflowAtMain).protectedPaths;
            } catch (err) {
              const reason = `merge refused: trusted WORKFLOW invalid: ${(err as Error).message}`;
              const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
              return {
                ok: false,
                mergedSha: null,
                failures: [{ taskId: t.id, reason }],
                tasks: written,
              };
            }
          }
          if (
            !protectedPathsSnapshotsEqual(
              t.protectedPathsSnapshot,
              currentProtectedPaths,
            )
          ) {
            const reason =
              'merge refused: protected_paths changed after planning; re-plan and re-verify';
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          }
          const interveningFiles = await handle.filesChangedBetween(
            t.plannedBaseRevision,
            currentMainTip,
          );
          const overlappingDrift = interveningFiles.filter((file) =>
            declared.scopes.some((scope) => pathInScope(file, scope)),
          );
          if (overlappingDrift.length > 0) {
            const reason =
              'merge refused: current main changed leased paths after planning: ' +
              formatPathEvidenceList(overlappingDrift);
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          }
          const candidateBase = await handle.mergeBase(currentMainTip, tipSha);
          if (!candidateBase) {
            const reason = 'merge refused: accepted tip has no trusted merge-base with current main';
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          }
          let filesTouched: readonly string[];
          try {
            filesTouched = await handle.filesChangedBetween(candidateBase, tipSha);
          } catch (err) {
            const reason = `merge path-scope diff failed: ${(err as Error).message}`;
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          }
          const scope = validateDiffAgainstScopes(filesTouched, declared.scopes);
          if (!scope.ok) {
            const reason =
              `merge refused: accepted tip changes files outside affected_paths: ` +
              formatPathEvidenceList(scope.outOfScope);
            const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
            return {
              ok: false,
              mergedSha: null,
              failures: [{ taskId: t.id, reason }],
              tasks: written,
            };
          }
          if (bootstrapMerge) {
            // Narrow bootstrap only: prove exact workflow path + candidate parses
            // at the accepted tip. Never execute untrusted candidate commands.
            let candidateContent: string | null = null;
            const workflowPath = normalizeConfiguredWorkflowPath(repo.workflow);
            if (handle.readFileAt) {
              try {
                candidateContent =
                  workflowPath === null
                    ? null
                    : await handle.readFileAt(tipSha, workflowPath);
              } catch {
                candidateContent = null;
              }
            }
            const bootstrapVerdict = verifyWorkflowBootstrapCandidate({
              eligible: true,
              configuredWorkflowPath: workflowPath ?? repo.workflow,
              filesTouched,
              candidateContent,
              parseCandidate: (content) => {
                try {
                  parseWorkflow(content);
                  return null;
                } catch (err) {
                  return err instanceof Error ? err.message : String(err);
                }
              },
            });
            if (!bootstrapVerdict.ok) {
              const reason = `merge refused: bootstrap contract failed — ${bootstrapVerdict.detail}`;
              const written = await this.returnToReview([{ task: t, reason }], 'path-scope');
              return {
                ok: false,
                mergedSha: null,
                failures: [{ taskId: t.id, reason }],
                tasks: written,
              };
            }
          }
        }
        if (!bootstrapMerge) pureBootstrapBatch = false;
        // Merge the immutable accepted SHA, not the symbolic branch ref.
        const result = await handle.mergeNoFf(
          tipSha,
          `hercules: merge ${t.id} — ${t.title}`.slice(0, 200),
        );
        if (!result.ok) {
          const failure: MergeFailure = { taskId: t.id, reason: result.reason };
          const written = await this.returnToReview(
            [{ task: t, reason: result.reason }],
            'conflict',
          );
          return {
            ok: false,
            mergedSha: null,
            failures: [failure],
            tasks: written,
          };
        }
      }

      // ── L1 gates once on merged result ────────────────────────────────
      // Pure first-time bootstrap batch: every task is a verified one-file
      // WORKFLOW add. Parse the merged workflow before push, but do not execute
      // its untrusted-until-canonical commands — the next baseline task runs them.
      // The flag comes from each task's proof against the actual pre-merge tip;
      // task shape alone must never suppress normal trusted gates.
      let gates: { name: string; command: string }[] = [];
      if (pureBootstrapBatch) {
        // Read the just-merged WORKFLOW from the merge worktree tip (mirror
        // default still lacks the file until push).
        const mergedTipForWorkflow = await handle.headSha();
        let mergedWorkflow: string | null = null;
        const workflowPath = normalizeConfiguredWorkflowPath(repo.workflow);
        if (handle.readFileAt) {
          try {
            mergedWorkflow =
              workflowPath === null
                ? null
                : await handle.readFileAt(mergedTipForWorkflow, workflowPath);
          } catch {
            mergedWorkflow = null;
          }
        }
        if (!mergedWorkflow || mergedWorkflow.trim().length === 0) {
          const reason = 'merge refused: merged result is missing WORKFLOW after bootstrap';
          const written = await this.returnToReview(
            eligible.map(({ task: t }) => ({ task: t, reason })),
            'workflow',
          );
          return {
            ok: false,
            mergedSha: null,
            failures: eligible.map(({ task: t }) => ({ taskId: t.id, reason })),
            tasks: written,
          };
        }
        try {
          parseWorkflow(mergedWorkflow);
        } catch (err) {
          if (err instanceof WorkflowError) {
            const reason = `WORKFLOW parse failed on merge result: ${err.message}`;
            const written = await this.returnToReview(
              eligible.map(({ task: t }) => ({ task: t, reason })),
              'workflow',
            );
            return {
              ok: false,
              mergedSha: null,
              failures: eligible.map(({ task: t }) => ({ taskId: t.id, reason })),
              tasks: written,
            };
          }
          throw err;
        }
        // Parse-only success; leave gates empty so candidate commands are not run.
        gates = [];
      } else {
        // Ordinary merges: trusted mirror default WORKFLOW (pre-push), unchanged.
        const workflowContent = await this.workspaces.readWorkflow(repo);
        if (workflowContent) {
          try {
            const wf = parseWorkflow(workflowContent);
            // setup.install first — the merge workspace is fresh (no deps), so
            // gates like typecheck fail vacuously without it (2026-07-24).
            gates = [
              ...wf.setup.install.map((command) => ({ name: 'setup', command })),
              ...wf.gates,
            ];
          } catch (err) {
            if (err instanceof WorkflowError) {
              const reason = `WORKFLOW parse failed on merge result: ${err.message}`;
              const written = await this.returnToReview(
                eligible.map(({ task: t }) => ({ task: t, reason })),
                'workflow',
              );
              return {
                ok: false,
                mergedSha: null,
                failures: eligible.map(({ task: t }) => ({ taskId: t.id, reason })),
                tasks: written,
              };
            }
            throw err;
          }
        }
      }

      // ── C3.57: inherit L1 when the merged tree IS the verified tree ─────
      // A single task whose merge-base is the current default tip merges as a
      // no-ff commit of an ancestor chain: the merge commit's tree is
      // byte-identical to the verified tip's tree, and that tree already ran
      // these gates green at L1 (verified_gates_green). Re-running them can
      // only reproduce the same result on the same bytes, so skip and record
      // the provenance. Any other shape (batch > 1, main moved, tip moved, L1
      // not green, bootstrap) re-runs the trusted gates as before.
      let gatesInheritedFromSha: string | null = null;
      if (gates.length > 0 && !pureBootstrapBatch && eligible.length === 1 && handle.mergeBase) {
        const only = eligible[0]!;
        const sameTip = only.tipSha.toLowerCase() === only.verifiedSha.toLowerCase();
        const l1Green = only.task.verifiedGatesGreen === true;
        if (sameTip && l1Green) {
          const base = await handle.mergeBase(currentMainTip, only.tipSha);
          if (base !== null && base.toLowerCase() === currentMainTip.toLowerCase()) {
            gatesInheritedFromSha = only.verifiedSha.toLowerCase();
            console.error(
              `[hercules] merge ${repoKey}: L1 gates inherited from verification at ` +
                `${gatesInheritedFromSha.slice(0, 12)} (single task, merge-base == default tip, ` +
                `tip == verified_sha, verified_gates_green) — not re-run`,
            );
            this.report('gating', { completed: gates.length, total: gates.length, currentGate: null });
            gates = [];
          }
        }
      }
      if (gates.length > 0) {
        const results = await runGates(gates, handle.dir, this.commandRunner, {
          executionPolicy: effectiveRepoExecutionPolicy(repo.executionPolicy ?? null),
          onProgress: ({ stage }) => {
            const idx = gates.findIndex((g) => g.name === stage);
            this.report('gating', {
              completed: Math.max(0, idx),
              total: gates.length,
              currentGate: stage,
            });
          },
        });
        if (!gatesGreen(gates, results)) {
          const failed = results.filter((r) => !r.passed);
          const detail = failed
            .map((r) => `${r.name}: ${(r.output || 'failed').slice(0, 300)}`)
            .join('; ');
          const firstFailed = failed[0];
          const failedGateName = firstFailed ? firstFailed.name : 'unknown';
          const failedGateOutput =
            firstFailed && firstFailed.output ? firstFailed.output : detail;
          const failedExit =
            firstFailed && typeof firstFailed.exitCode === 'number'
              ? firstFailed.exitCode
              : 1;
          const receipt = buildMergeGateFailureReceipt({
            operationId: newMergeFailureOperationId(Date.now()),
            createdAt: this.nowFn ? this.nowFn().toISOString() : defaultMergeNowIso(),
            repoKey,
            taskIds: eligible.map(({ task: t }) => t.id),
            failedGate: failedGateName,
            exitStatus: failedExit,
            rawOutput: failedGateOutput,
          });
          if (this.receiptStore) {
            await this.receiptStore.persist(receipt).catch((err: unknown) => {
              console.error(
                '[hercules] merge-receipt persist: ' + (err as Error).message,
              );
            });
          }
          const reason = formatMergeFailureReceiptMarkdown(receipt);
          const shortReason =
            'post-merge L1 gates failed — origin main not pushed. gate=' +
            receipt.failedGate +
            ' exit=' +
            String(receipt.exitStatus ?? 'unknown');
          const written = await this.returnToReview(
            eligible.map(({ task: t }) => ({ task: t, reason })),
            'gates',
          );
          return {
            ok: false,
            mergedSha: null,
            failures: eligible.map(({ task: t }) => ({
              taskId: t.id,
              reason: shortReason,
            })),
            tasks: written,
            operationStatus: 'merge_gate_failed',
            mergeGateReceipt: publicMergeFailureReceipt(receipt),
          };
        }
      }

      // ── Project-state closure (opt-in, before push) ───────────────────
      // Code verification (L1) and gate-merge eligibility already passed.
      // Closure is a separate lane: declared surfaces on the merge tree must
      // not still assert a superseded project state. No auto-edits; fail closed.
      const mergeTreeSha = await handle.headSha();
      const baseSha = currentMainTip;
      let closureContract: ProjectStateClosureContract | null = null;
      try {
        closureContract = await this.resolveClosureContract(
          repo,
          handle,
          baseSha,
          pureBootstrapBatch,
        );
      } catch (err) {
        const detail =
          err instanceof ProjectStateClosureParseError || err instanceof WorkflowError
            ? err.message
            : (err as Error).message;
        const reason =
          `project-state closure blocked before push: invalid trusted contract — ${detail}`;
        const written = await this.returnToReview(
          eligible.map(({ task: t }) => ({ task: t, reason })),
          'project-state-closure',
        );
        return {
          ok: false,
          mergedSha: null,
          failures: eligible.map(({ task: t }) => ({ taskId: t.id, reason })),
          tasks: written,
        };
      }

      const closureByTask = new Map<
        string,
        {
          status: NonNullable<Task['projectStateClosureStatus']>;
          digest: string | null;
          body: string;
        }
      >();

      if (closureContract) {
        const policyDigest = projectStateClosurePolicyDigest(closureContract);
        // Read each declared surface once from the merge tree (not task body).
        const surfaceContents = new Map<ProjectStateSurfaceKind, string | null>();
        for (const surf of closureContract.surfaces) {
          let content: string | null = null;
          if (handle.readFileAt) {
            try {
              content = await handle.readFileAt(mergeTreeSha, surf.path);
            } catch {
              content = null;
            }
          }
          surfaceContents.set(surf.kind, content);
        }

        const closureFailures: { task: Task; reason: string; body: string }[] = [];
        for (const { task: t, tipSha } of eligible) {
          const receipt = evaluateProjectStateClosure({
            contract: closureContract,
            task: { id: t.id, labels: t.labels },
            surfaceContents,
            provenance: {
              baseSha,
              candidateSha: tipSha,
              mergeTreeSha,
              policyDigest,
            },
          });
          const body = upsertProjectStateClosureReceiptBody(t.body, receipt);
          closureByTask.set(t.id, {
            status: receipt.status,
            digest: policyDigest,
            body,
          });
          if (!receipt.ok) {
            closureFailures.push({
              task: t,
              reason: formatProjectStateClosureBlockReason(receipt),
              body,
            });
          }
        }

        if (closureFailures.length > 0) {
          // Fail closed before push; stamp durable receipt on each failed task.
          const written: Task[] = [];
          for (const { task, reason, body } of closureFailures) {
            try {
              assertTransition(task.state, 'review');
            } catch (err) {
              if (err instanceof TransitionError) {
                throw new MergeError(err.message);
              }
              throw err;
            }
            const next: Task = {
              ...task,
              state: 'review',
              body: appendMergeFailureReason(body, reason),
              projectStateClosureStatus: 'failed',
              projectStateClosureDigest: projectStateClosurePolicyDigest(closureContract),
            };
            written.push(next);
          }
          // Also record N/A or pending on non-failed eligible tasks that were
          // evaluated (so UI lanes stay honest without claiming merge).
          for (const { task: t } of eligible) {
            if (closureFailures.some((f) => f.task.id === t.id)) continue;
            const stamp = closureByTask.get(t.id);
            if (!stamp) continue;
            const next: Task = {
              ...t,
              body: stamp.body,
              projectStateClosureStatus: stamp.status,
              projectStateClosureDigest: stamp.digest,
            };
            written.push(next);
          }
          await mutateControl(this.control, { writeTasks: written.map((next) => ({
            expected: eligible.find(({ task }) => task.id === next.id)!.task,
            next,
          })) },
            `hercules: merge project-state-closure failed → review (${closureFailures
              .map((f) => f.task.id)
              .join(', ')})`,
          );
          return {
            ok: false,
            mergedSha: null,
            failures: closureFailures.map((f) => ({
              taskId: f.task.id,
              reason: f.reason,
            })),
            tasks: written,
          };
        }
      }

      // ── Single non-force push ─────────────────────────────────────────
      this.report('pushing');
      const tip = mergeTreeSha;
      try {
        await handle.pushDefaultBranch(repo);
      } catch {
        throw new MergeError('non-force push failed');
      }
      this.report('pushed');

      this.report('stamping');
      const stamped: Task[] = [];
      for (const { task: t, remoteTipLease } of eligible) {
        // Stamp gate path so promote trust-chain can distinguish machine Merge
        // from operator/backfill merged_sha (release-8).
        const closure = closureByTask.get(t.id);
        const next: Task = {
          ...t,
          mergedSha: tip,
          mergedVia: 'gate',
          // Record the lease the merge actually proved (C3.55 heal) so the
          // merged record carries the exact remote tip.
          ...(remoteTipLease !== null && t.expectedRemoteTip !== remoteTipLease
            ? { expectedRemoteTip: remoteTipLease }
            : {}),
          ...(closure
            ? {
                body: closure.body,
                projectStateClosureStatus: closure.status,
                projectStateClosureDigest: closure.digest,
              }
            : {}),
        };
        stamped.push(next);
      }
      let successionMutation: Awaited<ReturnType<typeof prepareSuccessionLedger>> | null = null;
      if (this.mergeDepsSuccessionEnabled()) {
        const canonical = await handle.canonicalDefaultHead?.(repo);
        if (!canonical) {
          throw new MergeError('canonical remote default could not be verified after push');
        }
        successionMutation = await prepareSuccessionLedger({
          control: this.control,
          repo,
          priorDefaultRevision: currentMainTip,
          gateMergeSha: tip,
          canonicalDefaultRevision: canonical,
          candidates: eligible,
          managedDisposition: (taskId) => this.workspaces.managedDisposition
            ? this.workspaces.managedDisposition(repo.key, taskId)
            : Promise.resolve('unknown'),
          createdAt: (this.successionClock?.() ?? new Date()).toISOString(),
        });
      }
      try {
        await mutateControl(this.control, {
          writeTasks: stamped.map((next) => ({
            expected: eligible.find(({ task }) => task.id === next.id)!.task,
            next,
          })),
          ...(successionMutation ? { writeSuccessions: [successionMutation] } : {}),
        },
          `hercules: merge ${repoKey} [${eligible.map(({ task: t }) => t.id).join(', ')}] → ${tip.slice(0, 12)}`,
        );
      } catch {
        throw new MergeError('provenance stamp failed after push');
      }
      this.report('stamped');

      return {
        ok: true,
        mergedSha: tip,
        failures: [],
        tasks: stamped,
        gatesInheritedFromSha,
      };
    } finally {
      if (handle) {
        try {
          await handle.dispose();
        } catch (err) {
          console.error(
            `[hercules] merge worktree dispose ${repoKey}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  private mergeDepsSuccessionEnabled(): boolean {
    return this.successionEnabled;
  }

  /**
   * Load opt-in project-state closure from trusted default-branch WORKFLOW
   * (or an explicitly referenced policy file on that tip). Never from the
   * agent worktree or task body. Returns null when the repo has no contract.
   */
  private async resolveClosureContract(
    repo: RepoConfig,
    handle: MergeWorktreeHandle,
    trustedTip: string,
    pureBootstrapBatch: boolean,
  ): Promise<ProjectStateClosureContract | null> {
    // Bootstrap batch: candidate just introduced WORKFLOW; prefer merge-tree
    // tip so a first-time contract can apply once the file exists. Ordinary
    // merges read trusted pre-merge tip (agent cannot rewrite gates/policy).
    let workflowContent: string | null = null;
    if (pureBootstrapBatch && handle.readFileAt) {
      const workflowPath = normalizeConfiguredWorkflowPath(repo.workflow);
      if (workflowPath) {
        try {
          const mergeTip = await handle.headSha();
          workflowContent = await handle.readFileAt(mergeTip, workflowPath);
        } catch {
          workflowContent = null;
        }
      }
    }
    if (!workflowContent) {
      workflowContent = await this.workspaces.readWorkflow(repo);
    }
    if (!workflowContent) return null;

    const wf = parseWorkflow(workflowContent);
    const workflowContract = wf.projectStateClosure ?? null;
    if (!workflowContract) return null;

    // Inline surfaces+rules are complete — do not require a side policy file.
    if (workflowContract.surfaces.length > 0 && workflowContract.rules.length > 0) {
      return workflowContract;
    }

    let policyFileContract: ProjectStateClosureContract | null = null;
    if (workflowContract.policyPath && handle.readFileAt) {
      let policyText: string | null = null;
      try {
        policyText = await handle.readFileAt(trustedTip, workflowContract.policyPath);
      } catch {
        policyText = null;
      }
      // Bootstrap may place the policy file only on the merge tip.
      if (!policyText && pureBootstrapBatch) {
        try {
          const mergeTip = await handle.headSha();
          policyText = await handle.readFileAt(mergeTip, workflowContract.policyPath);
        } catch {
          policyText = null;
        }
      }
      if (!policyText) {
        throw new ProjectStateClosureParseError(
          `trusted policy file missing at ${workflowContract.policyPath}`,
        );
      }
      // Policy files are YAML mappings (optionally under project_state_closure:).
      let raw: unknown;
      try {
        raw = parseYaml(policyText);
      } catch (err) {
        throw new ProjectStateClosureParseError(
          `trusted policy file is not valid YAML: ${(err as Error).message}`,
        );
      }
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const obj = raw as Record<string, unknown>;
        if ('project_state_closure' in obj) {
          policyFileContract = parseProjectStateClosureConfig(obj['project_state_closure']);
        } else {
          policyFileContract = parseProjectStateClosureConfig(obj);
        }
      } else {
        throw new ProjectStateClosureParseError('trusted policy file must be a YAML mapping');
      }
    }

    return resolveProjectStateClosureContract({
      workflowContract,
      policyFileContract,
    });
  }

  private async returnToReview(
    items: readonly { task: Task; reason: string }[],
    kind: string,
  ): Promise<Task[]> {
    if (items.length === 0) return [];
    const written: Task[] = [];
    for (const { task, reason } of items) {
      try {
        assertTransition(task.state, 'review');
      } catch (err) {
        if (err instanceof TransitionError) {
          throw new MergeError(err.message);
        }
        throw err;
      }
      const next: Task = {
        ...task,
        state: 'review',
        body: appendMergeFailureReason(task.body, reason),
      };
      written.push(next);
    }
    const ids = items.map((i) => i.task.id).join(', ');
    await mutateControl(this.control, { writeTasks: written.map((next) => ({
      expected: items.find(({ task }) => task.id === next.id)!.task,
      next,
    })) }, `hercules: merge ${kind} failed → review (${ids})`);
    return written;
  }
}

/** Build MergeWorkspaces from a full Workspaces implementation when capable. */
export function mergeWorkspacesFrom(ws: Workspaces): MergeWorkspaces {
  if (!ws.preservedTipStatus) {
    throw new MergeError('workspaces lack preservedTipStatus — cannot merge safely');
  }
  if (!ws.openMergeWorktree) {
    throw new MergeError('workspaces lack openMergeWorktree — cannot merge safely');
  }
  const preservedTipStatus = ws.preservedTipStatus.bind(ws);
  const openMergeWorktree = ws.openMergeWorktree.bind(ws);
  return {
    preservedTipStatus,
    readWorkflow: (repo) => ws.readWorkflow(repo),
    openMergeWorktree,
    managedDisposition: ws.managedDisposition
      ? ws.managedDisposition.bind(ws)
      : async () => 'unknown',
  };
}
