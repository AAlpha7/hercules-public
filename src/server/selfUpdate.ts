/**
 * Self-update: pull the daemon checkout, install, build, restart the unit.
 *
 * Used by Settings → "Pull & rebuild" so a merged PR can go live from the phone
 * without SSH. Runner/restarter are injectable for unit tests.
 *
 * Disable with HERCULES_SELF_UPDATE=0 (or false/off).
 */
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class SelfUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelfUpdateError';
  }
}

export type SelfUpdatePhase = 'idle' | 'running' | 'ok' | 'failed';

export type SelfUpdateStep = 'pull' | 'install' | 'build' | 'restart' | null;

export interface SelfUpdateStatus {
  readonly phase: SelfUpdatePhase;
  readonly enabled: boolean;
  /** Current or last step name. */
  readonly step: SelfUpdateStep;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  /** Short trailing log lines for the UI. */
  readonly log: readonly string[];
}

export interface SelfUpdateRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SelfUpdateRunner {
  run(
    cmd: string,
    args: readonly string[],
    cwd: string,
  ): Promise<SelfUpdateRunResult>;
}

export interface SelfUpdateRestart {
  restart(serviceUnit: string): Promise<void>;
}

export interface SelfUpdateOpts {
  readonly repoRoot: string;
  /** systemd unit name (default hercules). */
  readonly serviceUnit?: string;
  readonly enabled?: boolean;
  readonly runner?: SelfUpdateRunner;
  readonly restarter?: SelfUpdateRestart;
  readonly clock?: () => number;
  /** Max lines kept in status.log. */
  readonly maxLogLines?: number;
}

const DEFAULT_MAX_LOG = 40;

export function isSelfUpdateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env['HERCULES_SELF_UPDATE'] ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

/** Project checkout root (same layout idea as buildInfo: dist/src vs src). */
export function resolveRepoRootFromModule(moduleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  if (here.endsWith(`${join('dist', 'src', 'server')}`) || here.endsWith('/dist/src/server')) {
    return join(here, '..', '..', '..');
  }
  return join(here, '..', '..');
}

const defaultRunner: SelfUpdateRunner = {
  async run(cmd, args, cwd) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, [...args], {
        cwd,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        timeout: 15 * 60_000,
        env: process.env,
      });
      return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
    } catch (err) {
      const e = err as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const code = typeof e.code === 'number' ? e.code : 1;
      return {
        code,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? String(err),
      };
    }
  },
};

const defaultRestarter: SelfUpdateRestart = {
  async restart(serviceUnit: string) {
    const unit = serviceUnit.trim() || 'hercules';
    // NOPASSWD sudo is expected on the single-box deploy (docs/deploy.md).
    const result = await defaultRunner.run(
      'sudo',
      ['-n', 'systemctl', 'restart', unit],
      process.cwd(),
    );
    if (result.code !== 0) {
      throw new SelfUpdateError(
        `systemctl restart ${unit} failed: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`,
      );
    }
  },
};

export class SelfUpdateService {
  private readonly repoRoot: string;
  private readonly serviceUnit: string;
  private readonly enabled: boolean;
  private readonly runner: SelfUpdateRunner;
  private readonly restarter: SelfUpdateRestart;
  private readonly clock: () => number;
  private readonly maxLogLines: number;

  private phase: SelfUpdatePhase = 'idle';
  private step: SelfUpdateStep = null;
  private startedAt: string | null = null;
  private finishedAt: string | null = null;
  private message: string | null = null;
  private log: string[] = [];
  private inflight: Promise<void> | null = null;

  constructor(opts: SelfUpdateOpts) {
    this.repoRoot = opts.repoRoot;
    this.serviceUnit = opts.serviceUnit?.trim() || 'hercules';
    this.enabled = opts.enabled ?? isSelfUpdateEnabled();
    this.runner = opts.runner ?? defaultRunner;
    this.restarter = opts.restarter ?? defaultRestarter;
    this.clock = opts.clock ?? (() => Date.now());
    this.maxLogLines = opts.maxLogLines ?? DEFAULT_MAX_LOG;
  }

  status(): SelfUpdateStatus {
    return {
      phase: this.phase,
      enabled: this.enabled,
      step: this.step,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      message: this.message,
      log: [...this.log],
    };
  }

  /**
   * Kick off update asynchronously. Returns immediately with phase=running.
   * Throws SelfUpdateError when disabled or already in progress.
   */
  start(): SelfUpdateStatus {
    if (!this.enabled) {
      throw new SelfUpdateError('self-update is disabled (HERCULES_SELF_UPDATE=0)');
    }
    if (this.phase === 'running' || this.inflight) {
      throw new SelfUpdateError('self-update already in progress');
    }
    this.phase = 'running';
    this.step = 'pull';
    this.startedAt = new Date(this.clock()).toISOString();
    this.finishedAt = null;
    this.message = 'Starting pull…';
    this.log = [];
    this.appendLog('self-update started');

    this.inflight = this.runPipeline()
      .catch((err: unknown) => {
        // runPipeline already records failures; this is a last-resort guard.
        const msg = err instanceof Error ? err.message : String(err);
        this.phase = 'failed';
        this.message = msg;
        this.finishedAt = new Date(this.clock()).toISOString();
        this.appendLog(`error: ${msg}`);
      })
      .finally(() => {
        this.inflight = null;
      });

    return this.status();
  }

  /** Test helper: await the in-flight pipeline (or resolve immediately). */
  async waitForIdle(): Promise<SelfUpdateStatus> {
    if (this.inflight) await this.inflight;
    return this.status();
  }

  private appendLog(line: string): void {
    const cleaned = line.replace(/\s+$/u, '');
    if (!cleaned) return;
    for (const part of cleaned.split('\n')) {
      const t = part.trimEnd();
      if (!t) continue;
      this.log.push(t);
    }
    if (this.log.length > this.maxLogLines) {
      this.log = this.log.slice(-this.maxLogLines);
    }
  }

  private async runStep(
    step: Exclude<SelfUpdateStep, null>,
    cmd: string,
    args: readonly string[],
  ): Promise<void> {
    this.step = step;
    this.message = `${step}…`;
    this.appendLog(`$ ${cmd} ${args.join(' ')}`);
    const result = await this.runner.run(cmd, args, this.repoRoot);
    if (result.stdout.trim()) this.appendLog(result.stdout.trim().slice(-2000));
    if (result.stderr.trim()) this.appendLog(result.stderr.trim().slice(-2000));
    if (result.code !== 0) {
      const detail =
        (result.stderr || result.stdout).trim().slice(-500) || `exit ${result.code}`;
      throw new SelfUpdateError(`${step} failed: ${detail}`);
    }
  }

  private async runPipeline(): Promise<void> {
    try {
      await this.runStep('pull', 'git', ['pull', '--ff-only']);
      await this.runStep('install', 'pnpm', ['install', '--frozen-lockfile']);
      await this.runStep('build', 'pnpm', ['build']);
      this.step = 'restart';
      this.message = 'restarting service…';
      this.appendLog(`restart ${this.serviceUnit}`);
      await this.restarter.restart(this.serviceUnit);
      // If restart is a real systemctl, this process may die before we get here.
      this.phase = 'ok';
      this.message = 'Restart issued — reconnect when the daemon is back.';
      this.finishedAt = new Date(this.clock()).toISOString();
      this.appendLog('restart issued');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.phase = 'failed';
      this.message = msg;
      this.finishedAt = new Date(this.clock()).toISOString();
      this.appendLog(`failed: ${msg}`);
    }
  }
}

/** Factory using env + module location (production wiring). */
export function createSelfUpdateService(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<SelfUpdateOpts> = {},
): SelfUpdateService {
  const unit = env['HERCULES_SERVICE']?.trim() || 'hercules';
  return new SelfUpdateService({
    repoRoot: overrides.repoRoot ?? resolveRepoRootFromModule(),
    serviceUnit: overrides.serviceUnit ?? unit,
    enabled: overrides.enabled ?? isSelfUpdateEnabled(env),
    ...(overrides.runner ? { runner: overrides.runner } : {}),
    ...(overrides.restarter ? { restarter: overrides.restarter } : {}),
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });
}
