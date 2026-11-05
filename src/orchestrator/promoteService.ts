/**
 * Production promote / rollback / restart-safe finalization (design §3–§4).
 *
 * Human Promote is the only production *advance*. The only unattended
 * production action is rollback to a recorded known-good sha after a failed
 * health/smoke (or after a mid-promote daemon restart that cannot finalize).
 *
 * All side effects go through injected ports (fake runner + clock in tests).
 */
import {
  assertCanPromote,
  emptyRelease,
  promoteFailedBootMismatch,
  promoteFinalized,
  promoteRolledBack,
  promoteStarted,
  PromoteError,
  rollbackTarget,
  type Release,
} from '../domain/release.js';
import { isValidIdentifier } from '../domain/task.js';
import type { RepoConfig } from '../domain/repos.js';
import {
  parseWorkflow,
  type DeployProductionConfig,
  WorkflowError,
} from '../control/workflow.js';
import type { ControlPort } from './orchestrator.js';
import { mutateControl } from './controlMutation.js';
import type { DeployRunner } from './releaseReconciler.js';

export class PromoteServiceError extends Error {
  override readonly name = 'PromoteServiceError';
}

export interface PromoteResult {
  readonly repoKey: string;
  readonly outcome: 'ok' | 'rolled_back' | 'failed';
  readonly release: Release;
  readonly productionSha: string | null;
  /** Human-facing alert when rolled back (also written into the release body). */
  readonly alert: string | null;
}

/** Workspaces surface required for promote (subset of real Workspaces). */
export interface PromoteWorkspaces {
  readWorkflow(repo: RepoConfig): Promise<string | null>;
  defaultBranchHead?(repo: RepoConfig): Promise<string | null>;
  deployCwd?(repo: RepoConfig): Promise<string> | string;
}

export interface PromoteServiceDeps {
  readonly control: ControlPort;
  readonly workspaces: PromoteWorkspaces;
  readonly deployRunner: DeployRunner;
  readonly clock: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly healthTimeoutMs?: number;
  readonly healthIntervalMs?: number;
  /**
   * Daemon build sha for boot finalization (full or short). `null` /
   * omitted / non-hex → fail closed (`booted_build_unknown`). Compared to
   * `promoting_sha` by equality or short-prefix match.
   */
  readonly bootedBuildSha?: string | null;
}

/**
 * Substitute the production tip into a WORKFLOW deploy command.
 * Template form: `./scripts/deploy-production.sh <sha>`. When no placeholder
 * is present, the sha is appended so the script still receives it.
 */
export function substituteProductionSha(command: string, sha: string): string {
  if (command.includes('<sha>')) return command.replaceAll('<sha>', sha);
  if (command.includes('{sha}')) return command.replaceAll('{sha}', sha);
  return `${command.trimEnd()} ${sha}`;
}

export class PromoteService {
  constructor(private readonly deps: PromoteServiceDeps) {}

  /**
   * Process-wide per-repo single-flight for the entire release operation.
   * Static Set is shared across PromoteService instances (main.ts wires
   * separate instances for Orchestrator.finalizeInFlight vs phone/API).
   * Separate from durable promoting_sha (restart boundary).
   */
  private static readonly releaseOpsInFlight = new Set<string>();

  private async withRepoLock<T>(repoKey: string, op: () => Promise<T>): Promise<T> {
    if (PromoteService.releaseOpsInFlight.has(repoKey)) {
      throw new PromoteServiceError(
        'release operation already in flight for \'' + repoKey + '\'',
      );
    }
    PromoteService.releaseOpsInFlight.add(repoKey);
    try {
      return await op();
    } finally {
      PromoteService.releaseOpsInFlight.delete(repoKey);
    }
  }

  /**
   * Human Promote: preconditions → write `promoting_sha` first → production
   * deploy → health + smoke → finalize or automatic rollback.
   */
  async promote(repoKey: string): Promise<PromoteResult> {
    if (!isValidIdentifier(repoKey)) {
      throw new PromoteServiceError(`unsafe repo key '${repoKey}'`);
    }
    return this.withRepoLock(repoKey, () => this.promoteLocked(repoKey));
  }

  private async promoteLocked(repoKey: string): Promise<PromoteResult> {
    if (!isValidIdentifier(repoKey)) {
      throw new PromoteServiceError(`unsafe repo key '${repoKey}'`);
    }
    const { control } = this.deps;
    if (!control.readRelease || !control.writeRelease) {
      throw new PromoteServiceError('release control port not configured');
    }

    const snapshot = await control.read();
    const repo = snapshot.repos.repos[repoKey];
    if (!repo) throw new PromoteServiceError(`unknown repo '${repoKey}'`);

    const production = await this.loadProductionConfig(repo);
    const mainSha = await this.resolveMainSha(repo);
    if (!mainSha) {
      throw new PromoteServiceError(
        `promote blocked: could not resolve mirror main tip for '${repoKey}'`,
      );
    }

    const existing = (await control.readRelease(repoKey)) ?? emptyRelease(repoKey);
    const release: Release = { ...existing, repoKey };

    if (release.promotingSha !== null && release.promotingSha !== '') {
      throw new PromoteServiceError(
        `promote blocked: promote already in flight for ${shortSha(release.promotingSha)} — wait for boot finalization or rollback`,
      );
    }

    try {
      assertCanPromote(release, mainSha);
    } catch (err) {
      if (err instanceof PromoteError) {
        // Drift: reconciler will re-verify; surface that so the phone is honest.
        if (/drifts from main/.test(err.message)) {
          throw new PromoteServiceError(
            `${err.message}; re-verify is running (staging must match main before promote)`,
          );
        }
        throw new PromoteServiceError(err.message);
      }
      throw err;
    }

    // 1. Persist promoting_sha BEFORE deploy (restart-safe self-promote).
    let next = promoteStarted(release);
    await mutateControl(control, { writeReleases: [next] },
      `release: ${repoKey} promoting ${shortSha(next.promotingSha ?? mainSha)}`,
    );

    const cwd = await this.resolveDeployCwd(repo);
    const sha = next.promotingSha ?? mainSha;

    // 2. Production deploy
    const deployCmd = substituteProductionSha(production.command, sha);
    const deployResult = await this.deps.deployRunner.run(deployCmd, cwd);
    if (deployResult.exitCode !== 0) {
      return this.rollbackAfterFailure({
        repo,
        release: next,
        production,
        cwd,
        reason: `production deploy failed (exit ${deployResult.exitCode}): ${trimOut(deployResult.output)}`,
        kind: 'auto',
      });
    }

    // 3. Health + smoke
    const check = await this.runHealthAndSmoke(production, cwd);
    if (!check.ok) {
      return this.rollbackAfterFailure({
        repo,
        release: next,
        production,
        cwd,
        reason: check.reason,
        kind: 'auto',
      });
    }

    // 4. Success
    const at = new Date(this.deps.clock()).toISOString();
    next = promoteFinalized(next, at);
    await mutateControl(control, { writeReleases: [next] },
      `release: ${repoKey} promote ok ${shortSha(next.productionSha ?? sha)}`,
    );
    return {
      repoKey,
      outcome: 'ok',
      release: next,
      productionSha: next.productionSha,
      alert: null,
    };
  }

  /**
   * Manual "roll back to previous known-good". Marks current production as the
   * abandoned tip (`promoting_sha`), then deploys {@link rollbackTarget}.
   */
  async rollbackProduction(repoKey: string): Promise<PromoteResult> {
    if (!isValidIdentifier(repoKey)) {
      throw new PromoteServiceError(`unsafe repo key '${repoKey}'`);
    }
    return this.withRepoLock(repoKey, () => this.rollbackProductionLocked(repoKey));
  }

  private async rollbackProductionLocked(repoKey: string): Promise<PromoteResult> {
    if (!isValidIdentifier(repoKey)) {
      throw new PromoteServiceError(`unsafe repo key '${repoKey}'`);
    }
    const { control } = this.deps;
    if (!control.readRelease || !control.writeRelease) {
      throw new PromoteServiceError('release control port not configured');
    }

    const snapshot = await control.read();
    const repo = snapshot.repos.repos[repoKey];
    if (!repo) throw new PromoteServiceError(`unknown repo '${repoKey}'`);

    const production = await this.loadProductionConfig(repo);
    const existing = (await control.readRelease(repoKey)) ?? emptyRelease(repoKey);
    let release: Release = { ...existing, repoKey };

    if (release.promotingSha !== null && release.promotingSha !== '') {
      // Mid-promote — complete via the same rollback path (abandon promoting tip).
      const cwd = await this.resolveDeployCwd(repo);
      return this.rollbackAfterFailure({
        repo,
        release,
        production,
        cwd,
        reason: 'manual rollback of in-flight promote',
        kind: 'manual',
      });
    }

    const abandoning = release.productionSha;
    if (abandoning === null || abandoning === '') {
      throw new PromoteServiceError(
        `rollback blocked: no production_sha to roll back for '${repoKey}'`,
      );
    }

    // Mark current production as the tip being abandoned so rollbackTarget
    // selects the previous known-good.
    release = { ...release, promotingSha: abandoning };
    const target = rollbackTarget(release);
    if (target === null || target === '' || target === abandoning) {
      throw new PromoteServiceError(
        `rollback blocked: no earlier known-good sha for '${repoKey}'`,
      );
    }

    await mutateControl(control, { writeReleases: [release] },
      `release: ${repoKey} manual rollback of ${shortSha(abandoning)} → ${shortSha(target)}`,
    );

    const cwd = await this.resolveDeployCwd(repo);
    return this.rollbackAfterFailure({
      repo,
      release,
      production,
      cwd,
      reason: `manual rollback from ${shortSha(abandoning)} to ${shortSha(target)}`,
      kind: 'manual',
    });
  }

  /**
   * Boot / first-tick finalization: for every release with `promoting_sha` set,
   * verify the running daemon *is* that tip, then run health+smoke only
   * (deploy already ran before restart). Record ok or automatic rollback.
   * A build-sha mismatch / unknown build fails closed without deploying
   * (operator may already have restored the tree).
   */
  async finalizeInFlight(): Promise<PromoteResult[]> {
    const { control } = this.deps;
    // Optional-method guard, then receiver-preserving wrappers (unbound
    // extraction loses `this` and FakePort/real ports throw on
    // `this.releases` / git state — same pattern as controlRefresh).
    if (!control.readRelease || !control.writeRelease) return [];
    const readRelease = (repoKey: string): Promise<Release | null> =>
      control.readRelease!(repoKey);
    const snapshot = await control.read();
    const results: PromoteResult[] = [];

    for (const repo of Object.values(snapshot.repos.repos)) {
      if (!isValidIdentifier(repo.key)) continue;
      try {
        const one = await this.withRepoLock(repo.key, async (): Promise<PromoteResult | null> => {
          const existing = await readRelease(repo.key);
          if (!existing) return null;
          if (existing.promotingSha === null || existing.promotingSha === '') return null;

          const release: Release = { ...existing, repoKey: repo.key };
          const promotingSha = release.promotingSha!;
          const match = matchBootedBuildToPromoting(
            this.deps.bootedBuildSha,
            promotingSha,
          );
          if (match !== 'match') {
            const at = new Date(this.deps.clock()).toISOString();
            const reason =
              match === 'unknown' ? 'booted_build_unknown' : 'booted_build_mismatch';
            const bootedSha =
              match === 'unknown' ? null : normalizeBootedSha(this.deps.bootedBuildSha);
            const next = promoteFailedBootMismatch(release, {
              sha: promotingSha,
              bootedSha,
              reason,
              at,
            });
            await mutateControl(control, { writeReleases: [next] },
              `release: ${repo.key} promote failed (boot) ${reason}`,
            );
            const bootedShort = bootedSha !== null ? shortSha(bootedSha) : 'unknown';
            console.error(
              `[hercules] promote finalize ${repo.key}: FAILED booted ${bootedShort} != promoting ${shortSha(promotingSha)} — record preserved`,
            );
            const failed: PromoteResult = {
              repoKey: repo.key,
              outcome: 'failed',
              release: next,
              productionSha: next.productionSha,
              alert:
                `promote finalize ${repo.key}: FAILED booted ${bootedShort} != promoting ${shortSha(promotingSha)} — record preserved`,
            };
            return failed;
          }

          let production: DeployProductionConfig;
          try {
            production = await this.loadProductionConfig(repo);
          } catch (err) {
            console.error(
              `[hercules] promote finalize ${repo.key}: ${(err as Error).message}`,
            );
            return null;
          }

          const cwd = await this.resolveDeployCwd(repo);
          const check = await this.runHealthAndSmoke(production, cwd);
          if (check.ok) {
            const at = new Date(this.deps.clock()).toISOString();
            const next = promoteFinalized(release, at);
            await mutateControl(control, { writeReleases: [next] },
              `release: ${repo.key} promote finalized (boot) ${shortSha(next.productionSha ?? release.promotingSha ?? '')}`,
            );
            const okResult: PromoteResult = {
              repoKey: repo.key,
              outcome: 'ok',
              release: next,
              productionSha: next.productionSha,
              alert: null,
            };
            return okResult;
          }
          return await this.rollbackAfterFailure({
            repo,
            release,
            production,
            cwd,
            reason: `boot finalization failed: ${check.reason}`,
            kind: 'auto',
          });
        });
        if (one !== null) results.push(one);
      } catch (err) {
        console.error(
          `[hercules] promote finalize ${repo.key}: ${(err as Error).message}`,
        );
      }
    }

    return results;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async rollbackAfterFailure(input: {
    repo: RepoConfig;
    release: Release;
    production: DeployProductionConfig;
    cwd: string;
    reason: string;
    kind: 'auto' | 'manual';
  }): Promise<PromoteResult> {
    const { control } = this.deps;
    const target = rollbackTarget(input.release);
    const abandoning = input.release.promotingSha;
    let deployNote = '';

    if (target !== null && target !== '') {
      const deployCmd = substituteProductionSha(input.production.command, target);
      const deployResult = await this.deps.deployRunner.run(deployCmd, input.cwd);
      if (deployResult.exitCode !== 0) {
        deployNote = ` rollback deploy of ${shortSha(target)} also failed (exit ${deployResult.exitCode}): ${trimOut(deployResult.output)}`;
      } else {
        const health = await this.pollHealth(input.production.health, input.cwd);
        if (!health.ok) {
          deployNote = ` rollback deploy of ${shortSha(target)} health failed: ${trimOut(health.output)}`;
        } else {
          deployNote = ` rolled back to ${shortSha(target)}`;
        }
      }
    } else {
      deployNote = ' no known-good sha available for rollback deploy';
    }

    const at = new Date(this.deps.clock()).toISOString();
    const alert =
      `ALERT: production ${input.kind === 'manual' ? 'manual rollback' : 'auto-rollback'}` +
      (abandoning ? ` of ${shortSha(abandoning)}` : '') +
      ` — ${input.reason}.${deployNote}`;

    let next = promoteRolledBack(input.release, at);
    next = {
      ...next,
      body: appendAlert(next.body, alert, at),
    };
    await mutateControl(control, { writeReleases: [next] },
      `release: ${input.repo.key} rolled_back` +
        (abandoning ? ` ${shortSha(abandoning)}` : '') +
        (target ? ` → ${shortSha(target)}` : ''),
    );

    return {
      repoKey: input.repo.key,
      outcome: 'rolled_back',
      release: next,
      productionSha: next.productionSha,
      alert,
    };
  }

  private async runHealthAndSmoke(
    production: DeployProductionConfig,
    cwd: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const health = await this.pollHealth(production.health, cwd);
    if (!health.ok) {
      return {
        ok: false,
        reason: `production health check failed: ${trimOut(health.output)}`,
      };
    }
    if (production.smoke !== undefined && production.smoke.trim() !== '') {
      const smoke = await this.deps.deployRunner.run(production.smoke, cwd);
      if (smoke.exitCode !== 0) {
        return {
          ok: false,
          reason: `production smoke failed (exit ${smoke.exitCode}): ${trimOut(smoke.output)}`,
        };
      }
    }
    return { ok: true };
  }

  private async pollHealth(
    command: string,
    cwd: string,
  ): Promise<{ ok: boolean; output: string }> {
    const timeout = this.deps.healthTimeoutMs ?? 60_000;
    const interval = this.deps.healthIntervalMs ?? 1_000;
    const sleep =
      this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const clock = this.deps.clock;
    const deadline = clock() + timeout;
    let lastOutput = '';

    for (;;) {
      const result = await this.deps.deployRunner.run(command, cwd);
      lastOutput = result.output;
      if (result.exitCode === 0) return { ok: true, output: lastOutput };
      if (clock() >= deadline) return { ok: false, output: lastOutput };
      await sleep(interval);
      if (clock() >= deadline) return { ok: false, output: lastOutput };
    }
  }

  private async loadProductionConfig(repo: RepoConfig): Promise<DeployProductionConfig> {
    const content = await this.deps.workspaces.readWorkflow(repo);
    if (!content) {
      throw new PromoteServiceError(
        `promote blocked: no trusted WORKFLOW for '${repo.key}'`,
      );
    }
    let production: DeployProductionConfig | undefined;
    try {
      const wf = parseWorkflow(content);
      production = wf.deploy?.production;
    } catch (err) {
      const msg = err instanceof WorkflowError ? err.message : (err as Error).message;
      throw new PromoteServiceError(`promote blocked: invalid WORKFLOW: ${msg}`);
    }
    if (!production) {
      throw new PromoteServiceError(
        `promote blocked: WORKFLOW has no deploy.production for '${repo.key}'`,
      );
    }
    return production;
  }

  private async resolveMainSha(repo: RepoConfig): Promise<string | null> {
    const ws = this.deps.workspaces;
    if (!ws.defaultBranchHead) return null;
    try {
      // Receiver-bound call — an extracted unbound method loses `this` and the
      // impl's own catch turns the TypeError into a silent null (2026-07-17).
      return await ws.defaultBranchHead(repo);
    } catch (err) {
      console.error(
        `[hercules] promote: defaultBranchHead ${repo.key}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async resolveDeployCwd(repo: RepoConfig): Promise<string> {
    const ws = this.deps.workspaces;
    if (!ws.deployCwd) return '.';
    return ws.deployCwd(repo); // receiver-bound (see resolveMainSha)
  }
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

function trimOut(output: string): string {
  const t = output.trim().replace(/\s+/g, ' ');
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

function appendAlert(body: string, alert: string, at: string): string {
  const section = `## ALERT (${at})\n\n${alert}\n`;
  const trimmed = body.trim();
  return trimmed === '' ? section : `${trimmed}\n\n${section}`;
}

/** Hex git sha (full or short). Rejects `unknown` / `forced` / dirty placeholders. */
function normalizeBootedSha(sha: string | null | undefined): string | null {
  if (sha === undefined || sha === null) return null;
  const t = sha.trim().toLowerCase();
  if (t === '' || t === 'unknown' || t === 'forced') return null;
  if (!/^[0-9a-f]{4,40}$/.test(t)) return null;
  return t;
}

/**
 * Compare daemon build sha to `promoting_sha`: full equality when both are
 * full-length, otherwise short-prefix match. Unknown/undetectable → `unknown`.
 */
export function matchBootedBuildToPromoting(
  bootedBuildSha: string | null | undefined,
  promotingSha: string,
): 'match' | 'mismatch' | 'unknown' {
  const booted = normalizeBootedSha(bootedBuildSha);
  if (booted === null) return 'unknown';
  const promoting = promotingSha.trim().toLowerCase();
  if (promoting === '') return 'unknown';
  if (booted === promoting) return 'match';
  if (promoting.startsWith(booted) || booted.startsWith(promoting)) return 'match';
  return 'mismatch';
}
