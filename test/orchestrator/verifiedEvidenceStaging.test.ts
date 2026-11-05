import { describe, expect, it } from 'vitest';
import { Orchestrator, type ControlPort } from '../../src/orchestrator/orchestrator.js';
import { FakeAdapter } from '../../src/orchestrator/fakeAdapter.js';
import { makeConfig } from '../../src/config.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { ReposConfig, RepoConfig } from '../../src/domain/repos.js';
import type { ReviewPacket } from '../../src/domain/verification.js';
import type { Workspace } from '../../src/domain/allocation.js';

const VERIFIED_SHA = 'cafe1234cafe1234cafe1234cafe1234cafe1234';

const PACKET_EXTRA = {
  runKind: 'implementer' as const,
  reviewerSkipReason: null,
  diffUrl: null,
  evidenceMatrix: [] as const,
  verifiedSha: VERIFIED_SHA,
  reworkPath: null as 'steer' | 'full' | null,
  reworkPathReason: null as string | null,
};

function reposWithCaps(caps: Record<string, number>): ReposConfig {
  const entries = Object.entries(caps).map(([key, maxConcurrent]) => [
    key,
    {
      key,
      url: 'x',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent,
      adapter: null,
    },
  ]);
  return { repos: Object.fromEntries(entries) };
}

function task(id: string): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state: 'todo',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: '## Definition of Done\n- [ ] tests',
  };
}

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  constructor(
    readonly tasks: Map<string, Task>,
    private repos: ReposConfig,
  ) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return {
      repos: this.repos,
      tasks: [...this.tasks.values()],
      problems: [],
    };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async compareAndSetTaskCommitted(
    id: string,
    expected: {
      readonly state: Task['state'];
      readonly expectedBaseRevision: Task['expectedBaseRevision'] | undefined;
      readonly expectedRemoteTip: Task['expectedRemoteTip'] | undefined;
    },
    to: Task['state'],
    fields: Partial<Task>,
    message: string,
  ): Promise<{ matched: boolean; committed: boolean }> {
    const current = this.tasks.get(id);
    if (
      !current ||
      current.state !== expected.state ||
      current.expectedBaseRevision !== expected.expectedBaseRevision ||
      current.expectedRemoteTip !== expected.expectedRemoteTip
    ) {
      return { matched: false, committed: false };
    }
    this.tasks.set(id, { ...current, ...fields, state: to });
    this.commits.push(message);
    return { matched: true, committed: true };
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(message: string): Promise<{ committed: boolean }> {
    this.commits.push(message);
    return { committed: true };
  }
  async writeRepos(config: ReposConfig): Promise<void> {
    this.repos = config;
  }
}

function greenPacket(overrides: Partial<ReviewPacket> = {}): ReviewPacket {
  return {
    taskId: 'A',
    branch: 'hercules/A',
    filesTouched: ['src/x.ts'],
    diffSummary: '1 file',
    diff: '+x',
    gates: [{ name: 'test', command: 'pnpm test', passed: true, output: '' }],
    cheatFindings: [],
    screenshots: [],
    reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
    selfAssessment: 'done',
    finalReport: '',
    green: true,
    noChanges: false,
    autoRework: false,
    reportPolluted: false,
    dod: {
      mechanical: 'pass',
      reviewer: 'pass',
      human: 'pending',
      criteria: [],
      warnings: [],
    },
    activityLog: [],
    ...PACKET_EXTRA,
    ...overrides,
  };
}

describe('Orchestrator verified-evidence staging (C3.6)', () => {
  it('stages exactly once with the packet and sha on successful verify', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const staged: unknown[] = [];
    const packet = greenPacket();
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      verifier: {
        verify: async (
          _t: Task,
          _r: RepoConfig,
          _w: Workspace,
        ): Promise<ReviewPacket> => packet,
      },
      verifiedEvidence: {
        stage: async (input) => {
          staged.push(input);
          return { ok: true };
        },
      },
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    await orch.tick();

    expect(port.tasks.get('A')!.state).toBe('review');
    expect(staged).toHaveLength(1);
    const call = staged[0] as {
      task: { id: string; repo: string };
      packet: ReviewPacket;
      verifiedSha: string;
      branch: string;
      capturedAt: string;
    };
    expect(call.task).toEqual({ id: 'A', repo: 'app' });
    expect(call.packet).toBe(packet);
    expect(call.verifiedSha).toBe(VERIFIED_SHA);
    expect(call.branch).toBe('hercules/A');
    expect(call.capturedAt).toBe(new Date(100).toISOString());
  });

  it('still transitions to review when staging throws', async () => {
    const port = new FakePort(new Map([['A', task('A')]]), reposWithCaps({ app: 1 }));
    const clock = { now: 0 };
    const orch = new Orchestrator({
      config: makeConfig('/ctrl'),
      control: port,
      adapter: new FakeAdapter({ durationMs: 100 }),
      verifier: {
        verify: async (): Promise<ReviewPacket> => greenPacket(),
      },
      verifiedEvidence: {
        stage: async () => {
          throw new Error('intake disk full');
        },
      },
      clock: () => clock.now,
    });

    await orch.tick();
    clock.now = 100;
    await orch.tick();

    expect(port.tasks.get('A')!.state).toBe('review');
    expect(port.tasks.get('A')!.verifiedSha).toBe(VERIFIED_SHA);
  });
});
