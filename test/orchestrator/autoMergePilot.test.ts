import { describe, it, expect } from 'vitest';
import { ActionService, ActionError } from '../../src/orchestrator/actions.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import type { MergeOperationService } from '../../src/orchestrator/mergeOperationService.js';
import { MergeOperationError } from '../../src/orchestrator/mergeOperationService.js';
import type { MergeOperationReceipt } from '../../src/domain/mergeOperation.js';
import type { AutoMergeDiff } from '../../src/domain/autoMerge.js';
import { AUTO_MERGE_LABEL } from '../../src/domain/autoMerge.js';
import { renderDecisionCardBlock, type DecisionCard } from '../../src/domain/decisionCard.js';

const ANCHOR = '2026-09-04T03:00:00.000Z';
const SMALL_DIFF: AutoMergeDiff = {
  files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  insertions: 30,
  deletions: 10,
};

function task(id: string, state: TaskState = 'todo'): Task {
  return {
    id,
    title: id,
    repo: 'app',
    state,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: '',
  };
}

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  createCommitResult = true;
  createCommitError: Error | null = null;
  repos: ReposConfig = {
    repos: {
      app: {
        key: 'app',
        url: 'https://github.com/example-org/acme.git',
        defaultBranch: 'main',
        workflow: 'WORKFLOW.md',
        maxConcurrent: 1,
        adapter: null,
        readiness: 'ready',
      },
    },
  };
  constructor(readonly tasks: Map<string, Task>) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos: this.repos, tasks: [...this.tasks.values()], problems: [] };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async createTaskCommitted(t: Task, message: string): Promise<{ committed: boolean }> {
    if (this.createCommitError) throw this.createCommitError;
    if (!this.createCommitResult) return { committed: false };
    this.tasks.set(t.id, t);
    this.commits.push(message);
    return { committed: true };
  }
  async rewireDependenciesCommitted(
    changes: readonly import('../../src/domain/dependencyRewire.js').DependencyRewireChange[],
    message: string,
  ): Promise<{ committed: boolean; hash?: string }> {
    for (const change of changes) {
      const current = this.tasks.get(change.id)!;
      this.tasks.set(change.id, {
        ...current,
        blockedBy: change.blockedBy,
        dependencyMode: change.dependencyMode,
      });
    }
    this.commits.push(message);
    return { committed: true, hash: 'a'.repeat(40) };
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

class FakeProbe implements RepoProbe {
  constructor(private readonly branches: string[] | Error) {}
  async probe(): Promise<{ branches: string[] }> {
    if (this.branches instanceof Error) throw this.branches;
    return { branches: this.branches };
  }
}

function decisionCard(overrides?: Partial<DecisionCard>): DecisionCard {
  const { boundaries, reviewer, ...rest } = overrides ?? {};
  return {
    v: 1,
    purpose: 'auto-merge fixture',
    areas: [{ area: 'src', count: 3 }],
    filesTouched: 3,
    reviewOnlyFlags: [],
    criteria: [
      {
        text: 'Unit suite passes',
        kind: 'mechanical',
        status: 'pass',
        why: 'ok',
      },
    ],
    gates: [{ name: 'typecheck', passed: true }],
    evidence: { ran: true, ok: true, steps: 1 },
    ...rest,
    boundaries: {
      branch: 'hercules/t1',
      protectedPathsTouched: false,
      testsEdited: false,
      crossTaskIds: [],
      crossTaskCommits: [],
      ...(boundaries ?? {}),
    },
    reviewer: {
      ran: true,
      approved: true,
      summaryZh: 'ok',
      ...(reviewer ?? {}),
    },
  };
}

function greenBody(opts?: {
  readonly timelineOk?: boolean;
  readonly omitTimeline?: boolean;
  readonly omitCard?: boolean;
  readonly card?: DecisionCard;
  readonly humanDod?: boolean;
  readonly note?: boolean;
}): string {
  const dod = opts?.humanDod
    ? '## Definition of Done\n\n- [ ] (mechanical) Unit suite passes\n- [ ] (human) Look at the UI\n'
    : '## Definition of Done\n\n- [ ] (mechanical) Unit suite passes\n';
  const timeline = opts?.omitTimeline
    ? ''
    : opts?.timelineOk === false
      ? `## Run timeline\n\n- \`${ANCHOR}\` **packet_finalize** ❌ — packet finalized — parked for human review\n`
      : `## Run timeline\n\n- \`${ANCHOR}\` **packet_finalize** ✅ — packet finalized — automated proof green\n`;
  const card = opts?.omitCard
    ? ''
    : renderDecisionCardBlock(opts?.card ?? decisionCard());
  const note = opts?.note
    ? '\n## Auto-merge (2026-09-04T04:00:00.000Z)\n\nalready tried\n'
    : '';
  return `${dod}\n${timeline}\n${card}${note}`;
}

function nowAfter(minutes: number): Date {
  return new Date(Date.parse(ANCHOR) + minutes * 60_000);
}

type StartCall = {
  readonly repoKey: string;
  readonly taskIds: readonly string[];
  readonly idempotencyKey: string | null;
};

function stubMergeOp(opts?: {
  readonly startError?: Error;
}): {
  readonly service: MergeOperationService;
  readonly starts: StartCall[];
} {
  const starts: StartCall[] = [];
  const service = {
    async start(input: {
      readonly repoKey: string;
      readonly taskIds: readonly string[];
      readonly idempotencyKey?: string | null;
    }): Promise<MergeOperationReceipt> {
      if (opts?.startError) throw opts.startError;
      starts.push({
        repoKey: input.repoKey,
        taskIds: input.taskIds,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      return {
        operationId: 'mop-1',
        repoKey: input.repoKey,
        taskIds: input.taskIds,
        idempotencyKey: input.idempotencyKey ?? null,
        status: 'accepted',
        phase: 'accepted',
        mergedSha: null,
        failures: [],
        createdAt: '2026-09-04T03:31:00.000Z',
        updatedAt: '2026-09-04T03:31:00.000Z',
        gateProgress: null,
        failureKind: null,
      };
    },
  } as unknown as MergeOperationService;
  return { service, starts };
}

function pilotSvc(
  tasks: Task[],
  opts?: {
    readonly autoMerge?: ReposConfig['repos'][string]['autoMerge'];
    readonly startError?: Error;
    readonly diff?: AutoMergeDiff | null;
  },
): {
  readonly service: ActionService;
  readonly port: FakePort;
  readonly starts: StartCall[];
} {
  const port = new FakePort(new Map(tasks.map((t) => [t.id, t])));
  port.repos = {
    repos: {
      app: {
        key: 'app',
        url: 'https://github.com/example-org/acme.git',
        defaultBranch: 'main',
        workflow: 'WORKFLOW.md',
        maxConcurrent: 1,
        adapter: null,
        readiness: 'ready',
        ...(opts?.autoMerge !== undefined ? { autoMerge: opts.autoMerge } : {}),
      },
    },
  };
  const { service: mergeOp, starts } = stubMergeOp({
    ...(opts?.startError ? { startError: opts.startError } : {}),
  });
  const diff = opts?.diff === undefined ? SMALL_DIFF : opts.diff;
  const releasePanelDeps = {
    workspaces: {
      async readWorkflow(): Promise<string | null> {
        return null;
      },
      async taskBranchDiff(): Promise<AutoMergeDiff | null> {
        return diff;
      },
    },
  };
  const service = new ActionService(
    port,
    new FakeProbe(['main']),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    releasePanelDeps,
    mergeOp,
  );
  return { service, port, starts };
}

function greenReviewTask(overrides?: Partial<Task>): Task {
  return {
    ...task('t1', 'review'),
    verifiedSha: 'abc1234',
    endedAt: ANCHOR,
    lastEventAt: ANCHOR,
    body: greenBody(),
    ...overrides,
  };
}

describe('ActionService.runAutoMergePilot', () => {
  it('auto-merge pilot approves and merges a green review task after the dwell', async () => {
    const { service, port, starts } = pilotSvc([greenReviewTask()], {
      autoMerge: { enabled: true, dwellMinutes: 30, maxSize: 'M' },
    });
    const now = nowAfter(31);
    const report = await service.runAutoMergePilot(now);
    const next = port.tasks.get('t1')!;
    expect(next.state).toBe('done');
    expect(next.labels).toContain(AUTO_MERGE_LABEL);
    expect(next.labels).toContain('auto-merged');
    expect(next.body).toContain('## Auto-merge (');
    expect(port.commits.at(-1)).toMatch(/\(auto-merge\)$/);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual({
      repoKey: 'app',
      taskIds: ['t1'],
      idempotencyKey: 'auto-merge:t1',
    });
    expect(report.approved).toEqual(['t1']);
    expect(report.merges).toEqual([{ operationId: 'mop-1', taskIds: ['t1'] }]);
  });

  it('auto-merge pilot leaves tasks alone before the dwell and reports the reason', async () => {
    const { service, port, starts } = pilotSvc([greenReviewTask()], {
      autoMerge: { enabled: true, dwellMinutes: 30, maxSize: 'M' },
    });
    const report = await service.runAutoMergePilot(nowAfter(5));
    expect(port.tasks.get('t1')!.state).toBe('review');
    expect(report.skipped[0]?.reason).toMatch(/^dwell 5\/30 min/);
    expect(starts).toHaveLength(0);
    expect(report.approved).toEqual([]);
    expect(report.merges).toEqual([]);
  });

  it('auto-merge pilot ignores repos without the policy', async () => {
    const { service, port, starts } = pilotSvc([greenReviewTask()]);
    const report = await service.runAutoMergePilot(nowAfter(31));
    expect(port.tasks.get('t1')!.state).toBe('review');
    expect(report.approved).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(starts).toHaveLength(0);
  });

  it('auto-merge pilot refuses a task with human acceptance criteria', async () => {
    const { service, port, starts } = pilotSvc(
      [greenReviewTask({ body: greenBody({ humanDod: true }) })],
      { autoMerge: { enabled: true, dwellMinutes: 30, maxSize: 'M' } },
    );
    const report = await service.runAutoMergePilot(nowAfter(31));
    expect(port.tasks.get('t1')!.state).toBe('review');
    expect(report.skipped[0]?.reason).toMatch(/^human acceptance criteria present/);
    expect(starts).toHaveLength(0);
  });

  it('auto-merge pilot never retries a task whose auto-merge already failed', async () => {
    const { service, port, starts } = pilotSvc(
      [greenReviewTask({ body: greenBody({ note: true }) })],
      { autoMerge: { enabled: true, dwellMinutes: 30, maxSize: 'M' } },
    );
    const report = await service.runAutoMergePilot(nowAfter(31));
    expect(port.tasks.get('t1')!.state).toBe('review');
    expect(report.skipped[0]?.reason).toBe(
      'auto-merge already attempted (needs a human)',
    );
    expect(starts).toHaveLength(0);
  });

  it('auto-merge pilot tolerates a merge already in flight', async () => {
    const { service, port, starts } = pilotSvc([greenReviewTask()], {
      autoMerge: { enabled: true, dwellMinutes: 30, maxSize: 'M' },
      startError: new MergeOperationError("merge already in flight for repo 'app'"),
    });
    const report = await service.runAutoMergePilot(nowAfter(31));
    const next = port.tasks.get('t1')!;
    expect(next.state).toBe('done');
    expect(next.labels).toContain(AUTO_MERGE_LABEL);
    expect(report.approved).toEqual(['t1']);
    expect(report.merges).toEqual([]);
    expect(starts).toHaveLength(0);
  });

  it('approve keeps the human commit actor by default', async () => {
    const { service, port } = pilotSvc([greenReviewTask()], {
      autoMerge: { enabled: true, dwellMinutes: 30, maxSize: 'M' },
    });
    await service.approve('t1');
    expect(port.commits.at(-1)).toMatch(/\(human\)$/);
    expect(port.tasks.get('t1')!.state).toBe('done');
    expect(port.tasks.get('t1')!.labels).not.toContain(AUTO_MERGE_LABEL);
  });
});

describe('ActionService.approve autoMerge opts', () => {
  it('rejects autoMerge combined with overrideNote', async () => {
    const { service } = pilotSvc([greenReviewTask()], {
      autoMerge: { enabled: true, dwellMinutes: 30, maxSize: 'M' },
    });
    await expect(
      service.approve('t1', {
        autoMerge: { detail: 'x' },
        overrideNote: 'because',
      }),
    ).rejects.toThrow(ActionError);
    await expect(
      service.approve('t1', {
        autoMerge: { detail: 'x' },
        overrideNote: 'because',
      }),
    ).rejects.toThrow(/autoMerge cannot carry an operator override/);
  });
});
