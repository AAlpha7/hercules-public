/**
 * Verification Layer 2 — headless browser driver (SPEC §9.2).
 *
 * Drives a real Chromium to navigate + screenshot + snapshot the DOM. Uses the
 * Playwright-bundled Chromium headless shell, which DOES have an arm64 Linux
 * build (unlike the Google Chrome channel) — so behavioral verification works
 * on the target box. Invocation uses execFile with an argument array (no shell),
 * so a URL can never inject a command.
 *
 * When {@link ScreenshotOpts.localStorage} is set (SPA auth), uses CDP so the
 * evidence shot is post-login UI — not just the token gate.
 *
 * Chromium path is resolved at each use (short TTL + existence check). Playwright
 * cache rotation (e.g. chromium-1223 → 1234) must not require a daemon restart.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cdpScreenshot, evidenceClickHints, CdpError } from './cdp.js';
import {
  isForceVerificationCancel,
  isVerificationAborted,
  VerificationAbortedError,
} from '../domain/verificationRun.js';
import type { EffectiveRepoExecutionPolicy } from '../domain/repoExecutionPolicy.js';
import { verificationChildEnv } from '../adapters/policyEnv.js';

const execFileAsync = promisify(execFile);

/** Max time a positive resolve may be reused without readdir (existence still checked). */
export const CHROMIUM_RESOLVE_TTL_MS = 60_000;

export interface ScreenshotOpts {
  readonly width?: number;
  readonly height?: number;
  /**
   * Keys written to localStorage on the page origin before capture
   * (e.g. `{ hercules_token: 'demo' }` for the phone SPA).
   */
  readonly localStorage?: Readonly<Record<string, string>>;
  /** Phone-ish viewport when capturing post-auth UI (default 390×844 when auth). */
  readonly mobile?: boolean;
  /**
   * When >1 and auth is set, capture shell then click chrome labels (Settings…)
   * for deeper evidence. Paths written as outPath with -0, -1 suffixes if multi.
   */
  readonly captures?: number;
  /** Optional smoke-flow text used to pick click labels. */
  readonly smokeFlows?: readonly string[];
  /** Human cancel closes/kills the active Chromium operation. */
  readonly signal?: AbortSignal;
  /** Repository policy for every Chromium verification child. */
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
}

export interface DomSnapshotOpts {
  readonly executionPolicy?: EffectiveRepoExecutionPolicy | null;
}

export interface BrowserDriver {
  /**
   * Navigate to url and write PNG screenshot(s).
   * Returns the list of paths written (1+ when multi-capture).
   */
  screenshot(url: string, outPath: string, opts?: ScreenshotOpts): Promise<string[]>;
  /** Navigate to url and return the rendered DOM HTML. */
  domSnapshot(url: string, opts?: DomSnapshotOpts): Promise<string>;
}

export class BrowserUnavailableError extends Error {
  override readonly name = 'BrowserUnavailableError';
}

export interface FindChromiumOptions {
  /** Override Playwright cache root (default `~/.cache/ms-playwright`). */
  readonly cacheDir?: string;
  /** Clock for TTL tests (returns epoch ms). */
  readonly now?: () => number;
}

/** One Playwright cache entry checked while resolving Chromium. */
export interface ChromiumCandidate {
  readonly entry: string;
  readonly path: string;
  readonly exists: boolean;
}

/** Full scan result — used for exact-reason errors when no binary is found. */
export interface ChromiumScan {
  readonly path: string | null;
  readonly cacheDir: string;
  readonly dirExists: boolean;
  readonly dirError?: string;
  readonly entries: readonly string[];
  readonly candidates: readonly ChromiumCandidate[];
}

interface ResolveCache {
  path: string;
  expiresAt: number;
  cacheDir: string;
}

let resolveCache: ResolveCache | null = null;

/** Clear the short-TTL resolve cache (tests / after forced reinstall). */
export function clearChromiumResolveCache(): void {
  resolveCache = null;
}

function defaultCacheDir(): string {
  return join(homedir(), '.cache', 'ms-playwright');
}

function existsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function candidateForEntry(cacheDir: string, entry: string): ChromiumCandidate | null {
  if (entry.startsWith('chromium_headless_shell-')) {
    const path = join(cacheDir, entry, 'chrome-linux', 'headless_shell');
    return { entry, path, exists: existsFile(path) };
  }
  if (entry.startsWith('chromium-')) {
    const path = join(cacheDir, entry, 'chrome-linux', 'chrome');
    return { entry, path, exists: existsFile(path) };
  }
  return null;
}

/**
 * Scan Playwright cache for a usable Chromium binary (no module TTL).
 * Prefer headless_shell entries when both are present (first match in readdir order).
 */
export function scanChromium(opts: FindChromiumOptions = {}): ChromiumScan {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const candidates: ChromiumCandidate[] = [];
  let entries: string[] = [];
  let dirExists = false;
  let dirError: string | undefined;

  try {
    entries = readdirSync(cacheDir);
    dirExists = true;
  } catch (err) {
    dirError = err instanceof Error ? err.message : String(err);
    const empty: ChromiumScan = {
      path: null,
      cacheDir,
      dirExists: false,
      entries: [],
      candidates: [],
    };
    return dirError !== undefined ? { ...empty, dirError } : empty;
  }

  let found: string | null = null;
  for (const entry of entries) {
    const cand = candidateForEntry(cacheDir, entry);
    if (!cand) continue;
    candidates.push(cand);
    if (cand.exists && found === null) found = cand.path;
  }

  return {
    path: found,
    cacheDir,
    dirExists,
    entries,
    candidates,
  };
}

/** Human-readable miss reason listing scanned dir + candidates (exact-reason). */
export function formatChromiumMiss(scan: ChromiumScan): string {
  const installHint =
    'install via `npx playwright install chromium` or set HERCULES_CHROMIUM';
  if (!scan.dirExists) {
    const why = scan.dirError ? ` (${scan.dirError})` : '';
    return (
      `no Chromium headless shell found; cache dir ${scan.cacheDir} is missing or unreadable${why}; ` +
      installHint
    );
  }
  if (scan.candidates.length === 0) {
    const listed =
      scan.entries.length > 0
        ? `entries=[${scan.entries.join(', ')}] (none match chromium-/chromium_headless_shell-)`
        : 'entries=[] (empty cache)';
    return (
      `no Chromium headless shell found under ${scan.cacheDir}; scanned ${listed}; ` + installHint
    );
  }
  const detail = scan.candidates
    .map((c) => `${c.entry} → ${c.path} (${c.exists ? 'ok' : 'missing'})`)
    .join('; ');
  return (
    `no Chromium headless shell found under ${scan.cacheDir}; ` +
    `candidates: ${detail}; ` +
    installHint
  );
}

/**
 * Locate a Chromium headless shell: env override, else the Playwright cache.
 *
 * Positive hits are cached ≤ {@link CHROMIUM_RESOLVE_TTL_MS}, but a missing file
 * always forces a rescan so Playwright revision rotation is picked up live.
 */
export function findChromium(opts: FindChromiumOptions = {}): string | null {
  const override = process.env['HERCULES_CHROMIUM'];
  if (override) return override;

  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  const now = opts.now?.() ?? Date.now();

  if (
    resolveCache !== null &&
    resolveCache.cacheDir === cacheDir &&
    resolveCache.expiresAt > now
  ) {
    if (existsFile(resolveCache.path)) return resolveCache.path;
    // Cached revision rotated away — rescan.
    resolveCache = null;
  }

  const scan = scanChromium({ cacheDir });
  if (scan.path) {
    resolveCache = {
      path: scan.path,
      expiresAt: now + CHROMIUM_RESOLVE_TTL_MS,
      cacheDir,
    };
  } else {
    resolveCache = null;
  }
  return scan.path;
}

/**
 * Resolve Chromium or throw {@link BrowserUnavailableError} with scan details.
 */
export function requireChromium(opts: FindChromiumOptions = {}): string {
  const found = findChromium(opts);
  if (found) return found;
  throw new BrowserUnavailableError(formatChromiumMiss(scanChromium(opts)));
}

export interface ChromiumDriverOptions {
  /** Fixed binary path (tests / explicit pin). Skips resolve-at-use. */
  readonly binPath?: string;
  /** Playwright cache root for resolve-at-use (tests). */
  readonly cacheDir?: string;
}

const COMMON_ARGS = ['--headless', '--no-sandbox', '--disable-gpu'];

export class ChromiumDriver implements BrowserDriver {
  private readonly fixedBin: string | undefined;
  private readonly cacheDir: string | undefined;

  /**
   * @param binPathOrOpts Fixed path string (legacy) or options. Prefer options;
   *   omit binPath so each screenshot/domSnapshot re-resolves via findChromium.
   */
  constructor(binPathOrOpts?: string | ChromiumDriverOptions) {
    if (typeof binPathOrOpts === 'string') {
      this.fixedBin = binPathOrOpts;
      this.cacheDir = undefined;
    } else {
      this.fixedBin = binPathOrOpts?.binPath;
      this.cacheDir = binPathOrOpts?.cacheDir;
    }
  }

  /** Resolve binary at call time (unless a fixed binPath was provided). */
  private resolveBin(): string {
    if (this.fixedBin !== undefined) return this.fixedBin;
    const opts: FindChromiumOptions =
      this.cacheDir !== undefined ? { cacheDir: this.cacheDir } : {};
    return requireChromium(opts);
  }

  async screenshot(url: string, outPath: string, opts: ScreenshotOpts = {}): Promise<string[]> {
    const bin = this.resolveBin();
    const needsAuth =
      opts.localStorage !== undefined && Object.keys(opts.localStorage).length > 0;
    const maxCaptures = Math.max(1, opts.captures ?? 1);
    if (needsAuth) {
      const width = opts.width ?? (opts.mobile === false ? 1024 : 390);
      const height = opts.height ?? (opts.mobile === false ? 768 : 844);
      try {
        const clicks =
          maxCaptures > 1 ? evidenceClickHints(opts.smokeFlows ?? []) : [];
        const raw = await cdpScreenshot({
          bin,
          url,
          width,
          height,
          localStorage: opts.localStorage,
          maxCaptures,
          ...(clicks.length > 0 ? { clicks } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(opts.executionPolicy !== undefined
            ? { executionPolicy: opts.executionPolicy }
            : {}),
        });
        const bufs = Array.isArray(raw) ? raw : [raw];
        const paths: string[] = [];
        for (let i = 0; i < bufs.length; i += 1) {
          const p =
            bufs.length === 1 ? outPath : outPath.replace(/\.png$/i, `-${i}.png`);
          writeFileSync(p, bufs[i]!);
          paths.push(p);
        }
        return paths;
      } catch (err) {
        if (isVerificationAborted(err) || opts.signal?.aborted) {
          throw err instanceof VerificationAbortedError
            ? err
            : new VerificationAbortedError(
                'verification aborted during browser screenshot',
                isForceVerificationCancel(opts.signal?.reason),
              );
        }
        // Fall back to plain screenshot so L2 still yields *something*.
        const msg = err instanceof CdpError ? err.message : (err as Error).message;
        console.error(`[hercules] CDP auth screenshot failed (${msg}); falling back to shell shot`);
      }
    }
    const width = opts.width ?? 1024;
    const height = opts.height ?? 768;
    await execFileAsync(
      bin,
      [...COMMON_ARGS, `--screenshot=${outPath}`, `--window-size=${width},${height}`, url],
      {
        timeout: 30_000,
        env: verificationChildEnv({ policy: opts.executionPolicy ?? null }).env,
        ...(opts.signal
          ? {
              signal: opts.signal,
              killSignal: 'SIGKILL' as const,
            }
          : {}),
      },
    );
    return [outPath];
  }

  async domSnapshot(url: string, opts: DomSnapshotOpts = {}): Promise<string> {
    const bin = this.resolveBin();
    const { stdout } = await execFileAsync(bin, [...COMMON_ARGS, '--dump-dom', url], {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
      env: verificationChildEnv({ policy: opts.executionPolicy ?? null }).env,
    });
    return stdout;
  }
}
