/**
 * In-memory registry for background analyst draft jobs.
 *
 * Why: `POST /api/tasks/draft-from-intent` used to await a 60–120 s grok
 * session before answering, so the phone sat on "Analyzing…" for minutes.
 * The route now returns the keyword-heuristic draft + a jobId immediately;
 * this registry runs the analyst in the background and publishes progress
 * (phase / tool / thinking / narration tails) over SSE `event: draft`.
 * Pure process memory — no fs, no Hono, injectable clock for tests.
 */
import { randomBytes } from 'node:crypto';
import type {
  AnalystActivity,
  AnalystActivityListener,
  AnalystPhase,
} from '../domain/analystActivity.js';
import type { AnalystDraft } from '../orchestrator/analyst.js';

export type DraftJobStatus = 'running' | 'ready' | 'failed';

export interface DraftJobActivityDto {
  readonly at: string; // ISO timestamp
  readonly kind: 'phase' | 'tool';
  readonly text: string; // phase: the phase name; tool: `${tool} ${target}`.trim()
}

export interface DraftJobDto {
  readonly id: string; // 'dj-' + 12 hex chars from randomBytes
  readonly repo: string;
  readonly intent: string; // as submitted, capped at 2000 chars
  readonly status: DraftJobStatus;
  readonly phase: AnalystPhase; // starts 'context'; last phase event seen; 'done' on any terminal status
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly activity: readonly DraftJobActivityDto[]; // last 40 phase/tool events, oldest first
  readonly thinking: string; // tail (≤ 240 chars) of concatenated thought deltas
  readonly narration: string; // tail (≤ 400 chars) of concatenated text deltas
  readonly draft: AnalystDraft | null; // set when status === 'ready'
  readonly error: string | null; // set when status === 'failed' (message only, never a stack)
}

export type DraftJobEvent =
  | { readonly kind: 'job'; readonly job: DraftJobDto }
  | { readonly kind: 'removed'; readonly id: string };

export interface DraftJobsOptions {
  readonly maxRunning?: number; // default 2
  readonly maxJobs?: number; // default 32 (total retained, any status)
  readonly ttlMs?: number; // default 30 * 60_000 — finished jobs older than this are dropped
  readonly throttleMs?: number; // default 250 — min gap between 'job' emissions caused by text/thought deltas
  readonly now?: () => number; // default Date.now
}

export interface DraftJobs {
  /** null when maxRunning is reached (caller answers heuristic-only). */
  start(input: {
    readonly repo: string;
    readonly intent: string;
    readonly run: (onActivity: AnalystActivityListener) => Promise<AnalystDraft>;
  }): DraftJobDto | null;
  get(id: string): DraftJobDto | null;
  /** all retained jobs, oldest first */
  list(): readonly DraftJobDto[];
  /** operator consumed the result: remove it (emits 'removed'); false when unknown */
  ack(id: string): boolean;
  subscribe(listener: (ev: DraftJobEvent) => void): () => void;
}

const DEFAULT_MAX_RUNNING = 2;
const DEFAULT_MAX_JOBS = 32;
const DEFAULT_TTL_MS = 30 * 60_000;
const DEFAULT_THROTTLE_MS = 250;
const MAX_ACTIVITY = 40;
const MAX_THINKING = 240;
const MAX_NARRATION = 400;
const MAX_INTENT = 2000;
const MAX_ERROR = 300;

interface MutableJob {
  id: string;
  repo: string;
  intent: string;
  status: DraftJobStatus;
  phase: AnalystPhase;
  startedAtMs: number;
  startedAt: string;
  finishedAtMs: number | null;
  finishedAt: string | null;
  activity: DraftJobActivityDto[];
  thinkingBuf: string;
  narrationBuf: string;
  draft: AnalystDraft | null;
  error: string | null;
  throttleTimer: ReturnType<typeof setTimeout> | null;
}

function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

function capError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length <= MAX_ERROR ? msg : msg.slice(0, MAX_ERROR);
}

function snapshot(job: MutableJob): DraftJobDto {
  return {
    id: job.id,
    repo: job.repo,
    intent: job.intent,
    status: job.status,
    phase: job.phase,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    activity: job.activity.map((a) => ({ ...a })),
    thinking: job.thinkingBuf,
    narration: job.narrationBuf,
    draft: job.draft,
    error: job.error,
  };
}

export function createDraftJobs(opts?: DraftJobsOptions): DraftJobs {
  const maxRunning = opts?.maxRunning ?? DEFAULT_MAX_RUNNING;
  const maxJobs = opts?.maxJobs ?? DEFAULT_MAX_JOBS;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const throttleMs = opts?.throttleMs ?? DEFAULT_THROTTLE_MS;
  const now = opts?.now ?? Date.now;

  /** Insertion order = oldest first. */
  const jobs = new Map<string, MutableJob>();
  const listeners = new Set<(ev: DraftJobEvent) => void>();

  const emit = (ev: DraftJobEvent): void => {
    for (const listener of listeners) {
      try {
        listener(ev);
      } catch {
        // Subscriber exceptions must not break emission to others.
      }
    }
  };

  const emitJob = (job: MutableJob): void => {
    emit({ kind: 'job', job: snapshot(job) });
  };

  const clearThrottle = (job: MutableJob): void => {
    if (job.throttleTimer !== null) {
      clearTimeout(job.throttleTimer);
      job.throttleTimer = null;
    }
  };

  const removeJob = (id: string): void => {
    const job = jobs.get(id);
    if (!job) return;
    clearThrottle(job);
    jobs.delete(id);
    emit({ kind: 'removed', id });
  };

  const isFinished = (job: MutableJob): boolean =>
    job.status === 'ready' || job.status === 'failed';

  const sweepExpired = (): void => {
    const t = now();
    for (const [id, job] of jobs) {
      if (!isFinished(job) || job.finishedAtMs === null) continue;
      if (t - job.finishedAtMs >= ttlMs) {
        removeJob(id);
      }
    }
  };

  const runningCount = (): number => {
    let n = 0;
    for (const job of jobs.values()) {
      if (job.status === 'running') n += 1;
    }
    return n;
  };

  const evictFinishedToMakeRoom = (): boolean => {
    while (jobs.size >= maxJobs) {
      let oldestFinishedId: string | null = null;
      for (const [id, job] of jobs) {
        if (isFinished(job)) {
          oldestFinishedId = id;
          break;
        }
      }
      if (oldestFinishedId === null) return false;
      removeJob(oldestFinishedId);
    }
    return true;
  };

  const scheduleThrottleEmit = (job: MutableJob): void => {
    if (job.status !== 'running') return;
    // Trailing timer: coalesce text/thought bursts; last delta always flushes.
    if (job.throttleTimer !== null) return;
    const timer = setTimeout(() => {
      job.throttleTimer = null;
      if (job.status !== 'running') return;
      emitJob(job);
    }, throttleMs);
    timer.unref();
    job.throttleTimer = timer;
  };

  const onActivity = (job: MutableJob, activity: AnalystActivity): void => {
    if (job.status !== 'running') return;
    const at = new Date(now()).toISOString();
    if (activity.kind === 'phase') {
      job.phase = activity.phase;
      job.activity.push({ at, kind: 'phase', text: activity.phase });
      if (job.activity.length > MAX_ACTIVITY) {
        job.activity.splice(0, job.activity.length - MAX_ACTIVITY);
      }
      clearThrottle(job);
      emitJob(job);
      return;
    }
    if (activity.kind === 'tool') {
      job.activity.push({
        at,
        kind: 'tool',
        text: `${activity.tool} ${activity.target}`.trim(),
      });
      if (job.activity.length > MAX_ACTIVITY) {
        job.activity.splice(0, job.activity.length - MAX_ACTIVITY);
      }
      clearThrottle(job);
      emitJob(job);
      return;
    }
    if (activity.kind === 'text') {
      job.narrationBuf = tail(job.narrationBuf + activity.delta, MAX_NARRATION);
      scheduleThrottleEmit(job);
      return;
    }
    if (activity.kind === 'thought') {
      job.thinkingBuf = tail(job.thinkingBuf + activity.delta, MAX_THINKING);
      scheduleThrottleEmit(job);
    }
  };

  const finishReady = (job: MutableJob, draft: AnalystDraft): void => {
    if (job.status !== 'running') return;
    clearThrottle(job);
    const t = now();
    job.status = 'ready';
    job.draft = draft;
    job.phase = 'done';
    job.finishedAtMs = t;
    job.finishedAt = new Date(t).toISOString();
    emitJob(job);
  };

  const finishFailed = (job: MutableJob, err: unknown): void => {
    if (job.status !== 'running') return;
    clearThrottle(job);
    const t = now();
    job.status = 'failed';
    job.error = capError(err);
    job.phase = 'done';
    job.finishedAtMs = t;
    job.finishedAt = new Date(t).toISOString();
    emitJob(job);
  };

  return {
    start(input) {
      sweepExpired();
      if (runningCount() >= maxRunning) return null;
      if (!evictFinishedToMakeRoom()) return null;

      const t = now();
      const id = `dj-${randomBytes(6).toString('hex')}`;
      const intent =
        input.intent.length <= MAX_INTENT
          ? input.intent
          : input.intent.slice(0, MAX_INTENT);
      const job: MutableJob = {
        id,
        repo: input.repo,
        intent,
        status: 'running',
        phase: 'context',
        startedAtMs: t,
        startedAt: new Date(t).toISOString(),
        finishedAtMs: null,
        finishedAt: null,
        activity: [],
        thinkingBuf: '',
        narrationBuf: '',
        draft: null,
        error: null,
        throttleTimer: null,
      };
      jobs.set(id, job);
      emitJob(job);

      const listener: AnalystActivityListener = (activity) => {
        // Job may have been acked while still running.
        if (!jobs.has(id)) return;
        onActivity(job, activity);
      };

      let started: Promise<AnalystDraft>;
      try {
        started = Promise.resolve(input.run(listener));
      } catch (err) {
        finishFailed(job, err);
        return snapshot(job);
      }

      void started.then(
        (draft) => {
          if (!jobs.has(id)) return;
          finishReady(job, draft);
        },
        (err: unknown) => {
          if (!jobs.has(id)) return;
          finishFailed(job, err);
        },
      );

      return snapshot(job);
    },

    get(id) {
      const job = jobs.get(id);
      return job ? snapshot(job) : null;
    },

    list() {
      return [...jobs.values()].map(snapshot);
    },

    ack(id) {
      if (!jobs.has(id)) return false;
      removeJob(id);
      return true;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
