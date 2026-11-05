/**
 * Minimal Chrome DevTools Protocol client over WebSocket.
 * Used for multi-step browser evidence (set localStorage, reload, screenshot)
 * without pulling in Playwright as a runtime dependency.
 *
 * Prefer the global WebSocket (Node ≥22); fall back to the `ws` package if
 * present; otherwise throw BrowserUnavailableError-compatible message.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { planIdempotentCleanup } from '../domain/stagingVerify.js';
import {
  isForceVerificationCancel,
  VerificationAbortedError,
} from '../domain/verificationRun.js';
import {
  killProcessGroup as killProcessGroupGeneric,
  type KillProcessGroupOpts,
} from './processGroup.js';
import { verificationChildEnv } from '../adapters/policyEnv.js';
import type { EffectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';

/**
 * Chrome-labelled process-group kill (logs "chrome cleanup …").
 * Prefer {@link killProcessGroupGeneric} from `processGroup.js` for non-browser work.
 */
export async function killProcessGroup(
  pid: number,
  opts: KillProcessGroupOpts = {},
): Promise<void> {
  await killProcessGroupGeneric(pid, {
    ...opts,
    label: opts.label ?? 'chrome cleanup',
  });
}

const execFileAsync = promisify(execFile);

export class CdpError extends Error {
  override readonly name = 'CdpError';
}

/** Temp profile prefix — residual scans match this signature. */
export const HERCULES_CDP_PROFILE_PREFIX = 'hercules-cdp-';

/**
 * Minimum age before a non-owned hercules-cdp Chromium is treated as residual.
 * Concurrent L2 / other daemon sessions younger than this are never killed.
 */
export const DEFAULT_CDP_RESIDUAL_MIN_AGE_MS = 2 * 60 * 1000;

/** PIDs launched by this process and not yet closed — never residual-swept. */
const activeCdpPids = new Set<number>();

export function registerActiveCdpPid(pid: number): void {
  if (Number.isInteger(pid) && pid > 0) activeCdpPids.add(pid);
}

export function unregisterActiveCdpPid(pid: number): void {
  activeCdpPids.delete(pid);
}

export function getActiveCdpPids(): ReadonlySet<number> {
  return activeCdpPids;
}

/** Best-effort process age (ms). Null when unknown. */
export async function processAgeMs(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'etimes=', '-p', String(pid)], {
      maxBuffer: 64 * 1024,
      env: verificationChildEnv({}).env,
    });
    const sec = Number(stdout.trim());
    if (!Number.isFinite(sec) || sec < 0) return null;
    return Math.floor(sec * 1000);
  } catch {
    return null;
  }
}

/**
 * Find residual hercules CDP Chromium PIDs (profile dir signature in cmdline).
 *
 * Safety: never returns PIDs that are currently registered as active in this
 * process, and never returns processes younger than `minAgeMs` (defaults to
 * {@link DEFAULT_CDP_RESIDUAL_MIN_AGE_MS}). That keeps concurrent L2 / other
 * daemon CDP sessions alive; only stale leftovers after hangs/crashes match.
 */
export async function findHerculesChromeResidualPids(
  opts: {
    readonly profilePrefix?: string;
    readonly excludePids?: ReadonlySet<number>;
    readonly minAgeMs?: number;
    readonly getAgeMs?: (pid: number) => Promise<number | null>;
    /**
     * Inject candidate PIDs (unit tests). When set, skips /proc+ps scan and
     * only applies exclude/age filters — production never passes this.
     */
    readonly candidatePids?: readonly number[];
  } = {},
): Promise<number[]> {
  const prefix = opts.profilePrefix ?? HERCULES_CDP_PROFILE_PREFIX;
  const exclude = opts.excludePids ?? activeCdpPids;
  const minAgeMs = opts.minAgeMs ?? DEFAULT_CDP_RESIDUAL_MIN_AGE_MS;
  const getAge = opts.getAgeMs ?? processAgeMs;
  const found = new Set<number>();

  if (opts.candidatePids !== undefined) {
    for (const pid of opts.candidatePids) found.add(pid);
  } else {
    // Prefer /proc scan (no shell).
    try {
      const entries = await readdir('/proc');
      for (const ent of entries) {
        if (!/^\d+$/.test(ent)) continue;
        const pid = Number(ent);
        try {
          const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8');
          if (cmdline.includes(prefix)) found.add(pid);
        } catch {
          // race: process exited
        }
      }
    } catch {
      // non-Linux or no /proc
    }

    if (found.size === 0) {
      try {
        const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,args='], {
          maxBuffer: 4 * 1024 * 1024,
          env: verificationChildEnv({}).env,
        });
        for (const line of stdout.split('\n')) {
          if (!line.includes(prefix)) continue;
          const m = /^\s*(\d+)\s+/.exec(line);
          if (m?.[1]) found.add(Number(m[1]));
        }
      } catch {
        // ps unavailable
      }
    }
  }

  const residuals: number[] = [];
  for (const pid of found) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (exclude.has(pid)) continue;
    const age = await getAge(pid);
    // Unknown age: do not kill (could be a live peer session).
    if (age === null) continue;
    if (age < minAgeMs) continue;
    residuals.push(pid);
  }
  return residuals;
}

/**
 * TERM→KILL residual hercules-cdp Chromium left by a prior hung evidence run.
 * Idempotent. Never targets {@link getActiveCdpPids} or young processes.
 */
export async function cleanupHerculesChromeResiduals(
  opts: {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly kill?: (pid: number, signal: NodeJS.Signals) => void;
    readonly isAlive?: (pid: number) => boolean;
    readonly findPids?: () => Promise<number[]>;
    readonly log?: (line: string) => void;
    readonly minAgeMs?: number;
    readonly getAgeMs?: (pid: number) => Promise<number | null>;
  } = {},
): Promise<{ readonly cleaned: readonly number[]; readonly logLines: readonly string[] }> {
  const log = opts.log ?? ((line: string) => console.error(`[hercules] ${line}`));
  const find =
    opts.findPids ??
    (() =>
      findHerculesChromeResidualPids({
        excludePids: activeCdpPids,
        ...(opts.minAgeMs !== undefined ? { minAgeMs: opts.minAgeMs } : {}),
        ...(opts.getAgeMs !== undefined ? { getAgeMs: opts.getAgeMs } : {}),
      }));
  const pids = await find();
  if (pids.length === 0) {
    const line = 'chrome residual cleanup: none found';
    log(line);
    return { cleaned: [], logLines: [line] };
  }

  const isAlive =
    opts.isAlive ??
    ((target: number) => {
      try {
        process.kill(target, 0);
        return true;
      } catch {
        return false;
      }
    });

  const alive = new Map<number, boolean>();
  for (const pid of pids) alive.set(pid, isAlive(pid));

  const plan = planIdempotentCleanup({
    pids,
    alive,
    alreadyTermed: new Set(),
    alreadyKilled: new Set(),
  });
  const logLines = [...plan.logLines];
  for (const line of logLines) log(line);

  const cleaned: number[] = [];
  for (const action of plan.actions) {
    // killProcessGroup runs the full TERM→KILL ladder for one pid.
    await killProcessGroup(action.pid, {
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.kill ? { kill: opts.kill } : {}),
      ...(opts.isAlive ? { isAlive: opts.isAlive } : {}),
      log,
    });
    cleaned.push(action.pid);
  }

  // Second pass: already-dead / already-killed → noop (idempotent).
  const again = await find();
  const alive2 = new Map<number, boolean>();
  for (const pid of again) alive2.set(pid, isAlive(pid));
  const plan2 = planIdempotentCleanup({
    pids: again,
    alive: alive2,
    alreadyTermed: new Set(cleaned),
    alreadyKilled: new Set(cleaned),
  });
  for (const line of plan2.logLines) {
    log(line);
    logLines.push(line);
  }

  return { cleaned, logLines };
}

type WsCtor = new (url: string) => {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
};

function resolveWebSocket(): WsCtor {
  const g = globalThis as { WebSocket?: WsCtor };
  if (typeof g.WebSocket === 'function') return g.WebSocket;
  try {
    const req = createRequire(import.meta.url);
    // DevDependency `ws` — used when global WebSocket is absent (Node 20).
    const mod = req('ws') as { default?: WsCtor } & WsCtor;
    return (mod.default ?? mod) as WsCtor;
  } catch {
    throw new CdpError(
      'WebSocket unavailable — use Node ≥22 or install devDependency `ws` for CDP screenshots',
    );
  }
}

export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

export async function openCdpSession(wsUrl: string): Promise<CdpSession> {
  const WS = resolveWebSocket();
  return new Promise((resolve, reject) => {
    const ws = new WS(wsUrl);
    let id = 0;
    const pending = new Map<
      number,
      { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
    >();
    const timer = setTimeout(() => {
      reject(new CdpError('CDP WebSocket open timeout'));
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }, 15_000);

    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        send(method, params = {}) {
          const mid = ++id;
          return new Promise((res, rej) => {
            pending.set(mid, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          });
        },
        close: () => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        },
      });
    };
    ws.onmessage = (ev) => {
      let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
      try {
        msg = JSON.parse(String(ev.data)) as typeof msg;
      } catch {
        return;
      }
      if (msg.id === undefined || !pending.has(msg.id)) return;
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? {});
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new CdpError('CDP WebSocket error'));
    };
  });
}

export interface HeadlessChrome {
  readonly port: number;
  readonly proc: ChildProcess;
  readonly userDataDir: string;
  listTargets(): Promise<Array<{ type: string; url: string; webSocketDebuggerUrl?: string }>>;
  close(): Promise<void>;
}

export interface LaunchHeadlessChromeOptions {
  /** Repository policy for this verification child. */
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
  /** Source env injection for boundary tests; production uses process.env. */
  readonly sourceEnv?: NodeJS.ProcessEnv;
}

/** Chromium is a verification child and must never inherit the daemon env. */
export function chromiumChildEnv(
  policy?: EffectiveRepoExecutionPolicy | null,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return verificationChildEnv({ policy: policy ?? null, source }).env;
}

/** Launch headless Chromium with remote debugging for multi-step drives. */
export async function launchHeadlessChrome(
  bin: string,
  opts: LaunchHeadlessChromeOptions = {},
): Promise<HeadlessChrome> {
  // Only stale/unowned residuals — never active concurrent CDP sessions.
  await cleanupHerculesChromeResiduals();

  const userDataDir = await mkdtemp(join(tmpdir(), HERCULES_CDP_PROFILE_PREFIX));
  const port = 9200 + Math.floor(Math.random() * 500);
  // Detached process group so close() can kill the whole tree (zygote/children).
  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: chromiumChildEnv(opts.executionPolicy ?? null, opts.sourceEnv ?? process.env),
    },
  );
  if (typeof proc.pid === 'number') {
    registerActiveCdpPid(proc.pid);
  }
  // Wait until CDP HTTP is up
  const deadline = Date.now() + 15_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) break;
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  if (Date.now() >= deadline) {
    if (typeof proc.pid === 'number') {
      unregisterActiveCdpPid(proc.pid);
      await killProcessGroup(proc.pid);
    } else {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await rm(userDataDir, { recursive: true, force: true });
    throw new CdpError(`Chromium CDP did not start: ${String(lastErr)}`);
  }

  let closed = false;
  return {
    port,
    proc,
    userDataDir,
    async listTargets() {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      return (await res.json()) as Array<{
        type: string;
        url: string;
        webSocketDebuggerUrl?: string;
      }>;
    },
    async close() {
      if (closed) return;
      closed = true;
      const pid = proc.pid;
      if (typeof pid === 'number') {
        unregisterActiveCdpPid(pid);
        await killProcessGroup(pid);
      } else {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        await sleep(300);
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
      await sleep(200);
      // Chrome may still flush profile files — retry cleanup.
      for (let i = 0; i < 5; i += 1) {
        try {
          await rm(userDataDir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(150);
        }
      }
    },
  };
}

/**
 * Navigate, optionally set localStorage keys, reload, then capture PNG bytes.
 * When {@link cdpScreenshot.clicks} is set, captures one PNG per step:
 *   0 = shell after auth, 1+ = after each successful click (label match).
 */
export async function cdpScreenshot(input: {
  readonly bin: string;
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
  /** Set on the page origin before reload (e.g. SPA auth token). */
  readonly localStorage?: Readonly<Record<string, string>>;
  /** Extra settle time after load (ms). */
  readonly settleMs?: number;
  /**
   * Optional UI labels to click after auth (case-insensitive substring on
   * button/tab text). Used for deeper L2 evidence (e.g. open Settings sheet).
   */
  readonly clicks?: readonly string[];
  /** Max captures including the initial shell (default 1). */
  readonly maxCaptures?: number;
  /** Human cancel closes the active Chromium process group. */
  readonly signal?: AbortSignal;
  /** Repository policy for the Chromium verification child. */
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
}): Promise<Buffer | Buffer[]> {
  const chrome = await launchHeadlessChrome(input.bin, {
    ...(input.executionPolicy !== undefined
      ? { executionPolicy: input.executionPolicy }
      : {}),
  });
  let onAbort: (() => void) | null = null;
  const detachAbort = (): void => {
    if (onAbort && input.signal) {
      input.signal.removeEventListener('abort', onAbort);
      onAbort = null;
    }
  };
  if (input.signal) {
    onAbort = (): void => {
      void chrome.close();
    };
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const targets = await chrome.listTargets();
    const page = targets.find((t) => t.type === 'page') ?? targets[0];
    if (!page?.webSocketDebuggerUrl) throw new CdpError('no CDP page target');
    const s = await openCdpSession(page.webSocketDebuggerUrl);
    try {
      await s.send('Page.enable');
      await s.send('Runtime.enable');
      const w = input.width ?? 390;
      const h = input.height ?? 844;
      await s.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await s.send('Page.navigate', { url: input.url });
      await sleep(input.settleMs ?? 1200);
      if (input.localStorage && Object.keys(input.localStorage).length > 0) {
        const pairs = Object.entries(input.localStorage)
          .map(
            ([k, v]) =>
              `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`,
          )
          .join('');
        await s.send('Runtime.evaluate', {
          expression: `${pairs} location.reload();`,
        });
        await sleep(input.settleMs ?? 2000);
      }

      const max = Math.max(1, input.maxCaptures ?? 1);
      const shots: Buffer[] = [];
      const capture = async (): Promise<Buffer> => {
        const shot = await s.send('Page.captureScreenshot', { format: 'png' });
        const data = shot['data'];
        if (typeof data !== 'string') throw new CdpError('screenshot missing data');
        return Buffer.from(data, 'base64');
      };

      shots.push(await capture());

      const clicks = input.clicks ?? [];
      for (const label of clicks) {
        if (shots.length >= max) break;
        const clicked = await s.send('Runtime.evaluate', {
          expression: `(() => {
            const re = ${JSON.stringify(label)};
            const nodes = [...document.querySelectorAll(
              'button, a, [role="button"], [role="tab"], .bottom-nav-item, .nav-item'
            )];
            const el = nodes.find((n) => {
              const t = (n.textContent || '').replace(/\\s+/g, ' ').trim();
              return t.length > 0 && t.length < 40 && new RegExp(re, 'i').test(t);
            });
            if (!el) return false;
            el.click();
            return true;
          })()`,
          returnByValue: true,
        });
        const ok = clicked['result'] && (clicked['result'] as { value?: boolean }).value === true;
        if (!ok) continue;
        await sleep(input.settleMs ?? 900);
        shots.push(await capture());
      }

      // Backward compatible: single buffer when only one shot requested.
      if (input.signal?.aborted) {
        throw new VerificationAbortedError(
          'verification aborted during CDP screenshot',
          isForceVerificationCancel(input.signal.reason),
        );
      }
      if (max === 1 && shots.length === 1) return shots[0]!;
      return shots;
    } finally {
      s.close();
    }
  } catch (err) {
    if (input.signal?.aborted) {
      throw err instanceof VerificationAbortedError
        ? err
        : new VerificationAbortedError(
            'verification aborted during CDP screenshot',
            isForceVerificationCancel(input.signal.reason),
          );
    }
    throw err;
  } finally {
    detachAbort();
    await chrome.close();
  }
}

/**
 * Labels to try after unlock when WORKFLOW smoke_flows mention them.
 * Always includes Settings/设置 so UI-chrome tasks get sheet evidence.
 */
export function evidenceClickHints(smokeFlows: readonly string[] = []): string[] {
  const blob = smokeFlows.join('\n').toLowerCase();
  const hints: string[] = [];
  const add = (en: string, zh: string): void => {
    if (hints.includes(en)) return;
    if (
      smokeFlows.length === 0 ||
      blob.includes(en.toLowerCase()) ||
      blob.includes(zh) ||
      /settings|设置|nav|chrome|shell|bottom/.test(blob)
    ) {
      hints.push(en, zh);
    }
  };
  // Prefer Settings for SPA chrome tasks (logout→settings case study).
  add('Settings', '设置');
  if (/repos|仓库/.test(blob)) add('Repos', '仓库');
  if (/chat|对话|会话/.test(blob)) add('Chat', '对话');
  return hints;
}
