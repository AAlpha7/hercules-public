/**
 * Execution layer — Cursor Cloud Agent adapter (factory ring 1).
 *
 * Implements the existing {@link AgentAdapter} contract. `start` dispatches a
 * remote Cloud Agent via an injected {@link CursorCloudClient}, or reattaches
 * an existing id after a coordinator restart; `poll` observes the cached
 * snapshot; done requires a GitHub PR URL/number. No local CLI spawn.
 */
import { appendActivity, ACTIVITY_TAIL } from './activity.js';
import {
  formatCursorCloudFinalMessage,
  isCursorCloudSuccess,
  isCursorCloudTerminal,
  resolveFactoryCloudPr,
  type CursorCloudClient,
  type CursorCloudSnapshot,
  type FactoryPrArtifact,
} from '../domain/cursorCloud.js';
import type {
  AgentAdapter,
  AgentRun,
  AgentStartInput,
  RunSnapshot,
  RunStatus,
} from '../orchestrator/adapter.js';

export interface CursorCloudAdapterOptions {
  readonly client: CursorCloudClient;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Status poll cadence while the remote agent is running. Default 5s. */
  readonly pollIntervalMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class CursorCloudAdapter implements AgentAdapter {
  readonly name = 'cursor';

  constructor(private readonly opts: CursorCloudAdapterOptions) {}

  start(input: AgentStartInput, now: number): AgentRun {
    return new CursorCloudRun(input, now, this.opts);
  }
}

class CursorCloudRun implements AgentRun {
  sessionId = '';
  private status: RunStatus = 'running';
  private lastEventAt: number;
  private readonly activity: string[] = [];
  private finalText = '';
  private prUrl: string | undefined;
  private prNumber: number | undefined;
  private stopped = false;
  private agentId: string | null = null;
  private readonly taskId: string;
  private readonly existingPr: FactoryPrArtifact | undefined;
  private readonly client: CursorCloudClient;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(
    input: AgentStartInput,
    now: number,
    opts: CursorCloudAdapterOptions,
  ) {
    this.lastEventAt = now;
    this.taskId = input.taskId;
    this.existingPr = input.existingFactoryPr;
    this.client = opts.client;
    this.clock = opts.clock ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    const repository = input.repository?.trim() ?? '';
    if (repository.length === 0) {
      this.status = 'failed';
      this.finalText = 'Cursor Cloud dispatch requires a target repository URL';
      appendActivity(this.activity, this.finalText);
      return;
    }
    const attachId = input.attachFactoryAgentId?.trim() ?? '';
    if (attachId.length > 0) {
      this.agentId = attachId;
      this.sessionId = attachId;
      appendActivity(this.activity, `reattach ${input.taskId} → ${attachId}`);
      void this.loop();
      return;
    }
    appendActivity(this.activity, `dispatch ${input.taskId} → ${repository}`);
    void this.boot({
      prompt: input.prompt,
      repository,
      ...(input.ref !== undefined && input.ref.trim() !== '' ? { ref: input.ref } : {}),
      ...(this.existingPr ? { existingPr: this.existingPr } : {}),
    });
  }

  private async boot(request: {
    readonly prompt: string;
    readonly repository: string;
    readonly ref?: string;
    readonly existingPr?: FactoryPrArtifact;
  }): Promise<void> {
    try {
      const launched = await this.client.launch(request);
      if (this.stopped) return;
      this.agentId = launched.id;
      this.sessionId = launched.id;
      this.apply(launched);
      if (this.status === 'running') await this.loop();
    } catch (err) {
      if (this.stopped && this.status !== 'running') return;
      this.fail((err as Error).message);
    }
  }

  private async waitForNextPoll(): Promise<void> {
    await this.sleep(this.pollIntervalMs);
    if (this.pollIntervalMs === 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped && this.status === 'running' && this.agentId) {
      await this.waitForNextPoll();
      if (this.stopped || this.status !== 'running' || !this.agentId) return;
      try {
        const snap = await this.client.get(this.agentId);
        this.apply(snap);
      } catch (err) {
        this.fail((err as Error).message);
        return;
      }
    }
  }

  private apply(snap: CursorCloudSnapshot): void {
    this.lastEventAt = this.clock();
    const pr = resolveFactoryCloudPr(snap, this.existingPr);
    if (pr) {
      this.prUrl = pr.prUrl;
      this.prNumber = pr.prNumber;
      appendActivity(this.activity, `PR #${pr.prNumber} ${pr.prUrl}`);
    } else {
      appendActivity(this.activity, `cursor ${snap.status} (${snap.id})`);
    }
    if (isCursorCloudSuccess(snap, this.existingPr) && pr) {
      this.status = 'done';
      this.finalText = formatCursorCloudFinalMessage(
        { ...snap, pr },
        { taskId: this.taskId },
      );
      return;
    }
    if (isCursorCloudTerminal(snap.status)) {
      this.fail(formatCursorCloudFinalMessage(snap, { taskId: this.taskId }));
    }
  }

  private fail(message: string): void {
    this.status = 'failed';
    this.finalText = message;
    this.lastEventAt = this.clock();
    appendActivity(this.activity, message);
  }

  poll(_now: number): RunSnapshot {
    return {
      sessionId: this.sessionId,
      status: this.status,
      lastEventAt: this.lastEventAt,
      recentActivity: this.activity.slice(-ACTIVITY_TAIL),
      ...(this.prUrl !== undefined && this.prNumber !== undefined
        ? { prUrl: this.prUrl, prNumber: this.prNumber }
        : {}),
    };
  }

  activityLog(): readonly string[] {
    return this.activity;
  }

  finalMessage(): string {
    return this.finalText;
  }

  stop(opts?: { force?: boolean }): void {
    if (!this.stopped) {
      this.stopped = true;
      const id = this.agentId;
      if (id) {
        void this.client.stop(id).then(
          () => undefined,
          (err: unknown) => {
            appendActivity(this.activity, `stop failed: ${(err as Error).message}`);
          },
        );
      }
    }
    if (opts?.force && this.status === 'running') {
      this.fail('Cursor Cloud Agent stopped');
    }
  }
}
