/**
 * Execution layer — a fake adapter for Phase 2 (SPEC §16.2).
 *
 * Drives the orchestration loop without spawning anything. Completion is decided
 * against the injected clock so the orchestrator stays fully deterministic in
 * tests: a run is `running` until its duration elapses, then `done` (success →
 * `review`) or `failed`. `hang` freezes lastEventAt to exercise stall detection.
 *
 * `stopGraceMs` models a graceful wind-down: after `stop()` (graceful), `poll`
 * reports `running` until `now - stopAt >= stopGraceMs`, then `failed`. After
 * `stop({force:true})`, `poll` reports `failed` immediately.
 *
 * L2 fault injection: when `HERCULES_FAKE_FAULT_INJECTION=1` and the start input
 * carries `fakeBehavior` (`die-immediately` | `die-mid-turn` | `succeed`), that
 * script overrides constructor defaults for the run. Real adapters never see
 * this path. Disabled outside isolation so production fake dry-run is safe.
 */
import {
  fakeBehaviorToRunKnobs,
  isFakeFaultInjectionEnabled,
  resolveFakeBehaviorScript,
  type FakeBehaviorScript,
} from '../domain/fakeBehavior.js';
import type {
  AgentAdapter,
  AgentRun,
  AgentStartInput,
  RunSnapshot,
  TokenUsage,
} from './adapter.js';

export interface FakeBehavior {
  /** ms after start at which the run completes. */
  readonly durationMs: number;
  /** Complete as a failure instead of success. */
  readonly fail?: boolean;
  /**
   * Fail this many `start()` calls for the task, then succeed (same-round
   * transient retry tests). Counts across start() invocations.
   */
  readonly failFirstStarts?: number;
  /** Never finish; freeze lastEventAt at start time (looks stalled). */
  readonly hang?: boolean;
  /**
   * Report processAlive while running (real adapters). When true with hang,
   * idle stream stall is suppressed; only maxRunMs hard-kills.
   */
  readonly processAlive?: boolean;
  /** Optional worker hint for quiet-progress tests (e.g. "cargo"). */
  readonly aliveHint?: string | null;
  /** Optional fake pid so orchestrator can exercise processPid path. */
  readonly processPid?: number;
  /** Grace window (ms) after a graceful stop before the run reports failed. Default 0. */
  readonly stopGraceMs?: number;
  /** Scripted activity lines revealed one per second from run start. */
  readonly activity?: readonly string[];
  /** Bounded stderr tail for death diagnosis tests. */
  readonly stderrTail?: string;
  /** Optional OS signal on terminal failure. */
  readonly exitSignal?: string | null;
  /** The agent's final report (a text task's deliverable), surfaced at done. */
  readonly finalMessage?: string;
  /**
   * Optional token usage reported on every poll (for cost-cap tests).
   * When set, mid-run and terminal snapshots include the same cumulative usage.
   */
  readonly usage?: TokenUsage;
}

class FakeRun implements AgentRun {
  /** ms at which stop() was first called (anchored to lastNow). null = not stopped. */
  private stopAt: number | null = null;
  private forced = false;
  /** Most recent `now` passed to poll(); used to anchor the grace clock in stop(). */
  private lastNow: number;

  constructor(
    readonly sessionId: string,
    private readonly startedAt: number,
    private readonly behavior: FakeBehavior,
    /** When true, this start() should fail (failFirstStarts accounting). */
    private readonly forceFail: boolean = false,
  ) {
    this.lastNow = startedAt;
  }

  poll(now: number): RunSnapshot {
    this.lastNow = now;
    const activitySpread = this.revealedActivity(now);
    const usageSpread = this.usageSpread();
    const deathSpread = this.deathSpread();
    if (this.forced) {
      return {
        sessionId: this.sessionId,
        status: 'failed',
        lastEventAt: this.startedAt,
        exitCode: 137,
        ...activitySpread,
        ...usageSpread,
        ...deathSpread,
      };
    }
    if (this.stopAt !== null) {
      const grace = this.behavior.stopGraceMs ?? 0;
      const exited = now - this.stopAt >= grace;
      return {
        sessionId: this.sessionId,
        status: exited ? 'failed' : 'running',
        lastEventAt: now,
        ...(exited ? { exitCode: 143 } : {}),
        ...activitySpread,
        ...usageSpread,
        ...(exited ? deathSpread : {}),
      };
    }
    if (this.behavior.hang) {
      return {
        sessionId: this.sessionId,
        status: 'running',
        lastEventAt: this.startedAt,
        ...this.aliveSpread(),
        ...activitySpread,
        ...usageSpread,
      };
    }
    const finished = now - this.startedAt >= this.behavior.durationMs;
    if (!finished) {
      return {
        sessionId: this.sessionId,
        status: 'running',
        lastEventAt: now,
        ...this.aliveSpread(),
        ...activitySpread,
        ...usageSpread,
      };
    }
    const finishedAt = this.startedAt + this.behavior.durationMs;
    const failed = this.forceFail || this.behavior.fail === true;
    return {
      sessionId: this.sessionId,
      status: failed ? 'failed' : 'done',
      lastEventAt: finishedAt,
      exitCode: failed ? 1 : 0,
      ...activitySpread,
      ...usageSpread,
      ...(failed ? deathSpread : {}),
    };
  }

  private deathSpread(): Partial<RunSnapshot> {
    return {
      ...(this.behavior.stderrTail !== undefined && this.behavior.stderrTail.length > 0
        ? { stderrTail: this.behavior.stderrTail }
        : {}),
      ...(this.behavior.exitSignal !== undefined
        ? { exitSignal: this.behavior.exitSignal }
        : {}),
    };
  }

  private usageSpread(): { usage: TokenUsage } | Record<never, never> {
    if (this.behavior.usage === undefined) return {};
    return { usage: this.behavior.usage };
  }

  private revealedActivity(now: number): { recentActivity: readonly string[] } | Record<never, never> {
    const activity = this.behavior.activity;
    if (activity === undefined) return {};
    const revealed = activity.slice(0, Math.floor((now - this.startedAt) / 1000) + 1);
    if (revealed.length === 0) return {};
    return { recentActivity: revealed };
  }

  private aliveSpread(): Partial<RunSnapshot> {
    if (this.behavior.processAlive !== true) return {};
    return {
      processAlive: true,
      ...(this.behavior.processPid !== undefined ? { processPid: this.behavior.processPid } : {}),
      ...(this.behavior.aliveHint !== undefined ? { aliveHint: this.behavior.aliveHint } : {}),
    };
  }

  activityLog(): readonly string[] {
    // At completion the agent has "done" everything scripted — return the full log.
    return [...(this.behavior.activity ?? [])];
  }

  finalMessage(): string {
    return this.behavior.finalMessage ?? '';
  }

  stop(opts?: { force?: boolean }): void {
    if (opts?.force === true) this.forced = true;
    if (this.stopAt === null) this.stopAt = this.lastNow;
  }
}

export class FakeAdapter implements AgentAdapter {
  readonly name = 'fake';
  /** Stops recorded per call — shape `{ id, force }` — for test assertions. */
  readonly stopped: { id: string; force: boolean }[] = [];
  /** Start inputs recorded per call — for asserting the assembled prompt. */
  readonly started: {
    taskId: string;
    prompt: string;
    resumeSessionId?: string;
    fakeBehavior?: FakeBehaviorScript | null;
  }[] = [];
  private counter = 0;
  /** Per-task start counts (for failFirstStarts). */
  private readonly startCounts = new Map<string, number>();
  /**
   * Env for fault-injection guard. Defaults to `process.env`; tests inject a
   * sealed record so isolation enablement is hermetic.
   */
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(
    private readonly defaultBehavior: FakeBehavior,
    private readonly overrides: Readonly<Record<string, FakeBehavior>> = {},
    opts?: { readonly env?: Readonly<Record<string, string | undefined>> },
  ) {
    this.env = opts?.env ?? process.env;
  }

  start(input: AgentStartInput, now: number): AgentRun {
    this.started.push({
      taskId: input.taskId,
      prompt: input.prompt,
      ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
      ...(input.fakeBehavior !== undefined ? { fakeBehavior: input.fakeBehavior } : {}),
    });
    const behavior = this.resolveBehavior(input);
    const n = (this.startCounts.get(input.taskId) ?? 0) + 1;
    this.startCounts.set(input.taskId, n);
    const failFirst = behavior.failFirstStarts ?? 0;
    const forceFail = failFirst > 0 ? n <= failFirst : behavior.fail === true;
    // Resume reuses the prior session id so tests can assert multi-turn wiring.
    const sessionId =
      input.resumeSessionId && input.resumeSessionId.length > 0
        ? input.resumeSessionId
        : `fake-${input.taskId}-${++this.counter}`;
    const run = new FakeRun(sessionId, now, behavior, forceFail);
    const realStop = run.stop.bind(run);
    // Record stops by task id for test assertions.
    run.stop = (opts?: { force?: boolean }): void => {
      this.stopped.push({ id: input.taskId, force: opts?.force === true });
      realStop(opts);
    };
    return run;
  }

  /**
   * Per-task constructor overrides win for unit tests; otherwise, when
   * isolation fault injection is on, map `input.fakeBehavior` to run knobs.
   */
  private resolveBehavior(input: AgentStartInput): FakeBehavior {
    const override = this.overrides[input.taskId];
    if (override) return override;

    const script = resolveFakeBehaviorScript({
      script: input.fakeBehavior ?? null,
      faultInjectionEnabled: isFakeFaultInjectionEnabled(this.env),
    });
    if (script === null) return this.defaultBehavior;

    const knobs = fakeBehaviorToRunKnobs(script);
    return {
      durationMs: knobs.durationMs,
      fail: knobs.fail,
      ...(knobs.activity ? { activity: knobs.activity } : {}),
      ...(knobs.stderrTail ? { stderrTail: knobs.stderrTail } : {}),
    };
  }
}
