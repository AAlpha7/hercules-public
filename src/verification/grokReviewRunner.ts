/**
 * Fresh-session L3 runner using headless Grok (SPEC §9.3).
 *
 * Spawns a one-shot `grok -p` with plain output — never resumes the implementer's
 * session. Large prompts are written to a temp file and referenced by path so we
 * never hit spawn E2BIG (ARG_MAX) when the branch diff is huge.
 */
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  isForceVerificationCancel,
  isVerificationAborted,
  VerificationAbortedError,
} from '../domain/verificationRun.js';
import { redactHostOutput } from '../domain/hostExecutor.js';
import { reviewChildEnv } from '../adapters/policyEnv.js';
import { killProcessGroup } from './processGroup.js';
import type { AnalystActivityListener } from '../domain/analystActivity.js';
import {
  hasValidVerdictLine,
  ReviewerInfraError,
  type ReviewRunner,
} from './reviewer.js';

/** Keep argv+env under typical ARG_MAX; huge prompts go via a file. */
const INLINE_PROMPT_MAX = 32_000;
const REVIEW_OUTPUT_MAX = 8 * 1024 * 1024;

export type ReviewSpawn = (
  command: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    detached: true;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => ChildProcessWithoutNullStreams;

export interface GrokReviewRunnerOptions {
  readonly grokBin?: string;
  /** Working directory for the review process (mirror default is fine). */
  readonly cwd?: string;
  /**
   * Child env override. When set (analyst: `{ ...process.env, GROK_HOME }`),
   * used as the spawn env instead of the L3 policy filter. L3 leaves this
   * unset so `reviewChildEnv` stays fail-closed.
   */
  readonly env?: NodeJS.ProcessEnv;
  /** Wall-clock timeout for one review turn (ms). Default 10 minutes. */
  readonly timeoutMs?: number;
  /** Pin `grok -m` (e.g. grok-4.5). Omit to use CLI default. */
  readonly model?: string;
  /** Process injection for cancellation tests. */
  readonly spawn?: ReviewSpawn;
  /** Process-group killer injection for cancellation tests. */
  readonly killGroup?: typeof killProcessGroup;
  /**
   * Output acceptance. `verdict` (default, L3): exactly one VERDICT line or
   * infra failure. `freeform` (analyst): any non-empty stdout on a clean exit —
   * the caller parses its own contract (e.g. a fenced JSON block).
   */
  readonly outputContract?: 'verdict' | 'freeform';
  /** Pin `grok --reasoning-effort`. Omit to use the CLI default (L3 reviewer). */
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  /** grok `--sandbox` profile. Default `read-only` (L3). The analyst uses a custom project profile. */
  readonly sandbox?: string;
  /** Extra session rules appended to grok's system prompt (`--rules`). Omitted when undefined. */
  readonly rules?: string;
}

/** Fail-closed L3 policy: inspect only, with no shell, edits, or child network. */
export function buildGrokReviewArgs(
  prompt: string,
  model?: string,
  opts?: {
    readonly reasoningEffort?: 'low' | 'medium' | 'high';
    readonly outputFormat?: 'plain' | 'streaming-json';
    readonly sandbox?: string;
    readonly rules?: string;
  },
): string[] {
  // Profile token only — reject spaces / path traversal before they reach argv.
  const sandbox = opts?.sandbox ?? 'read-only';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sandbox)) {
    throw new Error('invalid sandbox profile');
  }
  return [
    '-p',
    prompt,
    ...(model ? ['-m', model] : []),
    '--output-format',
    opts?.outputFormat ?? 'plain',
    '--permission-mode',
    'dontAsk',
    '--sandbox',
    sandbox,
    '--tools',
    'read_file,grep,list_dir',
    '--allow',
    'Read',
    '--allow',
    'Grep',
    '--disable-web-search',
    ...(opts?.rules && opts.rules.length > 0 ? ['--rules', opts.rules] : []),
    ...(opts?.reasoningEffort
      ? ['--reasoning-effort', opts.reasoningEffort]
      : []),
  ];
}

/** Policy-aware env: xAI model-auth plumbing only, never proxies/secrets/PII. */
function childEnv(
  policy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null,
): NodeJS.ProcessEnv {
  return reviewChildEnv({ policy: policy ?? null }).env;
}

function runReviewProcess(input: {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly spawn: ReviewSpawn;
  readonly killGroup: typeof killProcessGroup;
  readonly executionPolicy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null;
  readonly onStdoutChunk?: (chunk: string) => void;
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const force = isForceVerificationCancel(input.signal?.reason);
    if (input.signal?.aborted) {
      reject(new VerificationAbortedError('verification aborted before L3 reviewer', force));
      return;
    }

    const child = input.spawn(input.bin, input.args, {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: input.env ?? childEnv(input.executionPolicy ?? null),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminating = false;
    let onAbort: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const detachAbort = (): void => {
      if (onAbort && input.signal) {
        input.signal.removeEventListener('abort', onAbort);
        onAbort = null;
      }
    };
    const finish = (
      err: unknown | null,
      result?: { stdout: string; stderr: string },
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detachAbort();
      if (err !== null) reject(err);
      else resolve(result ?? { stdout, stderr });
    };
    const terminate = (err: Error, forceKill: boolean): void => {
      if (settled || terminating) return;
      terminating = true;
      const pid = child.pid;
      if (typeof pid !== 'number') {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        finish(err);
        return;
      }
      void input.killGroup(pid, {
        label: 'reviewer process-group',
        force: forceKill,
        ...(input.signal?.reason && typeof input.signal.reason === 'object'
          ? { cancelReason: input.signal.reason as { force: boolean } }
          : {}),
      }).then(
        () => finish(err),
        () => finish(err),
      );
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      const s = String(chunk);
      input.onStdoutChunk?.(s);
      stdout += s;
      if (stdout.length > REVIEW_OUTPUT_MAX) stdout = stdout.slice(-REVIEW_OUTPUT_MAX);
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > REVIEW_OUTPUT_MAX) stderr = stderr.slice(-REVIEW_OUTPUT_MAX);
    });
    child.on('error', (err) => {
      if (!terminating) finish(err);
    });
    child.on('close', (code, closeSignal) => {
      if (terminating) return;
      if (input.signal?.aborted) {
        finish(
          new VerificationAbortedError(
            'verification aborted during L3 reviewer',
            isForceVerificationCancel(input.signal.reason),
          ),
        );
        return;
      }
      if (code === 0 && closeSignal === null) {
        finish(null, { stdout, stderr });
        return;
      }
      const detail = closeSignal ? `signal ${closeSignal}` : `exit ${code ?? '?'}`;
      const err = new Error(`reviewer process failed (${detail})`) as Error & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = stdout;
      err.stderr = stderr;
      finish(err);
    });

    timer = setTimeout(() => {
      terminate(new Error(`reviewer timed out after ${input.timeoutMs}ms`), true);
    }, input.timeoutMs);
    timer.unref();

    if (input.signal) {
      onAbort = (): void => {
        terminate(
          new VerificationAbortedError(
            'verification aborted during L3 reviewer',
            isForceVerificationCancel(input.signal?.reason),
          ),
          isForceVerificationCancel(input.signal?.reason),
        );
      };
      input.signal.addEventListener('abort', onAbort, { once: true });
      if (input.signal.aborted) onAbort();
    }
  });
}

/**
 * Bounded, secret-redacted context for durable infra-error messages — the text
 * lands in the task body, so raw stderr (Bearer tokens, KEY=value, credential
 * URLs) must never pass through unredacted.
 */
const INFRA_DETAIL_MAX = 300;

function detailTail(stderr: string): string {
  const s = redactHostOutput(stderr, INFRA_DETAIL_MAX).trim();
  return s.length > 0 ? ` — stderr: ${s}` : '';
}

function safeEmit(
  onActivity: AnalystActivityListener | undefined,
  activity: Parameters<AnalystActivityListener>[0],
): void {
  if (!onActivity) return;
  try {
    onActivity(activity);
  } catch {
    /* listener errors are not the reviewer's problem */
  }
}

function toolCallTarget(rawInput: unknown): string {
  if (rawInput === null || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    return '';
  }
  const obj = rawInput as Record<string, unknown>;
  for (const key of ['target_file', 'target_directory', 'path', 'pattern', 'query'] as const) {
    const v = obj[key];
    if (typeof v === 'string') return v;
  }
  return '';
}

function createStreamingNdjsonHandler(onActivity: AnalystActivityListener): {
  readonly onChunk: (chunk: string) => void;
  readonly flush: () => void;
  readonly textOut: () => string;
} {
  let carry = '';
  let textOut = '';

  const handleLine = (line: string): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const obj = parsed as Record<string, unknown>;
    const type = obj['type'];
    if (type === 'text') {
      const data = obj['data'];
      if (typeof data !== 'string') return;
      textOut += data;
      if (textOut.length > REVIEW_OUTPUT_MAX) textOut = textOut.slice(-REVIEW_OUTPUT_MAX);
      safeEmit(onActivity, { kind: 'text', delta: data });
      return;
    }
    if (type === 'thought') {
      const data = obj['data'];
      if (typeof data !== 'string') return;
      safeEmit(onActivity, { kind: 'thought', delta: data });
      return;
    }
    if (type === 'tool_call') {
      const toolName = obj['toolName'];
      const title = obj['title'];
      const tool =
        typeof toolName === 'string'
          ? toolName
          : typeof title === 'string'
            ? title
            : 'tool';
      safeEmit(onActivity, {
        kind: 'tool',
        tool,
        target: toolCallTarget(obj['rawInput']),
      });
    }
  };

  return {
    onChunk: (chunk: string): void => {
      carry += chunk;
      let nl: number;
      while ((nl = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, nl);
        carry = carry.slice(nl + 1);
        handleLine(line);
      }
    },
    flush: (): void => {
      if (carry.length > 0) {
        handleLine(carry);
        carry = '';
      }
    },
    textOut: (): string => textOut,
  };
}

export function createGrokReviewRunner(opts: GrokReviewRunnerOptions = {}): ReviewRunner {
  const bin = opts.grokBin ?? 'grok';
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const spawn = opts.spawn ?? (nodeSpawn as ReviewSpawn);
  const killGroup = opts.killGroup ?? killProcessGroup;
  const freeform = opts.outputContract === 'freeform';
  return async (
    prompt: string,
    runOpts?: {
      readonly signal?: AbortSignal;
      readonly executionPolicy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null;
      readonly onActivity?: AnalystActivityListener;
      readonly cwd?: string;
      /** Per-run env override (e.g. refreshed GROK_HOME). Falls back to runner opts.env. */
      readonly env?: NodeJS.ProcessEnv;
    },
  ): Promise<string> => {
    let promptFile: string | null = null;
    try {
      let reviewPrompt = prompt;
      if (prompt.length > INLINE_PROMPT_MAX) {
        promptFile = join(tmpdir(), `hercules-l3-${randomBytes(8).toString('hex')}.md`);
        await writeFile(promptFile, prompt, 'utf8');
        // Short argv: point Grok at the file instead of stuffing megabytes into -p.
        reviewPrompt = freeform
          ? `Open and follow the brief at ${promptFile}. ` +
            'Respond exactly as its "Output contract" section instructs.'
          : `Open and follow the review brief at ${promptFile}. ` +
            'Produce VERDICT/SUMMARY as that file instructs.';
      }
      const streaming = freeform && runOpts?.onActivity !== undefined;
      const argOpts: {
        readonly reasoningEffort?: 'low' | 'medium' | 'high';
        readonly outputFormat?: 'plain' | 'streaming-json';
        readonly sandbox?: string;
        readonly rules?: string;
      } = {
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
        ...(streaming ? { outputFormat: 'streaming-json' as const } : {}),
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        ...(opts.rules ? { rules: opts.rules } : {}),
      };
      const args = buildGrokReviewArgs(
        reviewPrompt,
        opts.model,
        Object.keys(argOpts).length > 0 ? argOpts : undefined,
      );

      const streamHandler = streaming
        ? createStreamingNdjsonHandler(runOpts.onActivity!)
        : null;

      const effectiveCwd = runOpts?.cwd ?? opts.cwd;
      const effectiveEnv = runOpts?.env ?? opts.env;
      const { stdout, stderr } = await runReviewProcess({
        bin,
        args,
        timeoutMs: timeout,
        spawn,
        killGroup,
        ...(runOpts?.signal ? { signal: runOpts.signal } : {}),
        ...(runOpts?.executionPolicy !== undefined
          ? { executionPolicy: runOpts.executionPolicy }
          : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(effectiveEnv ? { env: effectiveEnv } : {}),
        ...(streamHandler ? { onStdoutChunk: streamHandler.onChunk } : {}),
      });
      if (streamHandler) streamHandler.flush();

      // Only a successful exit with an exact verdict line may become L3
      // evidence. A clean exit with empty (or verdict-less) output is an
      // infrastructure failure, not "changes_requested" — stderr is never a review.
      // Streaming freeform uses concatenated text deltas (byte-equal to plain).
      const text = streaming
        ? streamHandler!.textOut().trim()
        : String(stdout ?? '').trim();
      if (freeform ? text.length > 0 : hasValidVerdictLine(text)) return text;
      throw new ReviewerInfraError(
        text.length === 0
          ? `L3 reviewer produced no output${detailTail(stderr)}`
          : `L3 reviewer output has no single valid VERDICT line${detailTail(stderr)}`,
      );
    } catch (err) {
      // Human cancel must not become a soft L3 "changes_requested" verdict —
      // complete() needs VerificationAbortedError so cancel teardown runs.
      if (isVerificationAborted(err) || runOpts?.signal?.aborted) {
        throw err instanceof VerificationAbortedError
          ? err
          : new VerificationAbortedError('verification aborted during L3 reviewer');
      }
      if (err instanceof ReviewerInfraError) throw err;
      // Launch/exit/timeout/credential failures are verification infrastructure,
      // never a product verdict (orchestrator verify_infra retry path). A dirty
      // exit is NOT salvaged even when stdout contains verdict-like text — the
      // child did not complete its review contract.
      const e = err as { stderr?: string; message?: string };
      const cause =
        [String(e.stderr ?? '').trim(), String(e.message ?? '').trim()].find(
          (s) => s.length > 0,
        ) ?? 'reviewer failed';
      throw new ReviewerInfraError(
        `L3 reviewer infrastructure failed: ${redactHostOutput(cause, INFRA_DETAIL_MAX).trim()}`,
      );
    } finally {
      if (promptFile) {
        await rm(promptFile, { force: true }).catch(() => undefined);
      }
    }
  };
}

/** Read-only provider preflight. Success clears a durable reviewer health brake. */
export function createGrokReviewerHealthCheck(
  opts: GrokReviewRunnerOptions = {},
): () => Promise<boolean> {
  const bin = opts.grokBin ?? 'grok';
  const timeout = Math.min(opts.timeoutMs ?? 30_000, 60_000);
  const spawn = opts.spawn ?? (nodeSpawn as ReviewSpawn);
  const killGroup = opts.killGroup ?? killProcessGroup;
  return async (): Promise<boolean> => {
    try {
      await runReviewProcess({
        bin,
        args: ['models'],
        timeoutMs: timeout,
        spawn,
        killGroup,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      });
      return true;
    } catch {
      return false;
    }
  };
}

const ANALYST_HEALTH_DETAIL_MAX = 200;

/** First non-empty stderr line, redacted and bounded — safe for logs / draft warnings. */
export function firstStderrLine(stderr: string, max = ANALYST_HEALTH_DETAIL_MAX): string {
  const redacted = redactHostOutput(stderr, max * 2).trim();
  const line =
    redacted
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Boot probe for the analyst sandbox: one-shot `grok -p "PONG"` under the
 * `hercules-analyst` profile with a private GROK_HOME. Logs
 * `[hercules] analyst: sandbox ok (grok <version>)` or
 * `[hercules] analyst: UNAVAILABLE — <first stderr line>`.
 */
export function createAnalystSandboxHealthCheck(
  opts: GrokReviewRunnerOptions & {
    readonly log?: (line: string) => void;
  } = {},
): () => Promise<boolean> {
  const bin = opts.grokBin ?? 'grok';
  const timeout = Math.min(opts.timeoutMs ?? 60_000, 120_000);
  const spawn = opts.spawn ?? (nodeSpawn as ReviewSpawn);
  const killGroup = opts.killGroup ?? killProcessGroup;
  const log = opts.log ?? ((line: string): void => {
    console.error(line);
  });
  const sandbox = opts.sandbox ?? 'hercules-analyst';

  return async (): Promise<boolean> => {
    let version = 'unknown';
    try {
      const ver = await runReviewProcess({
        bin,
        args: ['--version'],
        timeoutMs: Math.min(timeout, 15_000),
        spawn,
        killGroup,
        ...(opts.env ? { env: opts.env } : {}),
      });
      const line = (ver.stdout || ver.stderr).trim().split('\n')[0] ?? '';
      const m = /\bgrok\s+(\S+)/i.exec(line) ?? /^(\d+\.\d+\.\d+\S*)/.exec(line);
      if (m?.[1]) version = m[1];
      else if (line.length > 0) version = line.slice(0, 40);
    } catch {
      // version probe is best-effort; the PONG probe below is authoritative
    }

    try {
      const args = buildGrokReviewArgs('PONG', opts.model, {
        sandbox,
        ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
      });
      const { stdout } = await runReviewProcess({
        bin,
        args,
        timeoutMs: timeout,
        spawn,
        killGroup,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.env ? { env: opts.env } : {}),
      });
      if (stdout.trim().length === 0) {
        log('[hercules] analyst: UNAVAILABLE — empty PONG response');
        return false;
      }
      log(`[hercules] analyst: sandbox ok (grok ${version})`);
      return true;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail =
        firstStderrLine(String(e.stderr ?? '')) ||
        firstStderrLine(String(e.message ?? '')) ||
        'runner error';
      log(`[hercules] analyst: UNAVAILABLE — ${detail}`);
      return false;
    }
  };
}
