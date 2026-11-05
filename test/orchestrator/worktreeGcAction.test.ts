import { describe, it, expect } from 'vitest';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import type {
  GcTerminalArtifactsOpts,
  GcTerminalArtifactsResult,
} from '../../src/isolation/worktree.js';
import { DEFAULT_WORKTREE_GC_DAYS } from '../../src/domain/worktreeGc.js';

const repos: ReposConfig = {
  repos: {
    app: {
      key: 'app',
      url: 'https://github.com/example/app.git',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: null,
      readiness: 'ready',
    },
  },
};

function task(over: Partial<Task> & Pick<Task, 'id' | 'state'>): Task {
  return {
    id: over.id,
    title: over.title ?? over.id,
    repo: over.repo ?? 'app',
    state: over.state,
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: over.lastEventAt ?? null,
    createdAt: over.createdAt ?? null,
    startedAt: null,
    endedAt: over.endedAt ?? null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: '',
  };
}

class FakePort implements ControlPort {
  constructor(public tasks: Map<string, Task>) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos, tasks: [...this.tasks.values()], problems: [] };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(): Promise<{ committed: boolean }> {
    return { committed: true };
  }
  async writeRepos(): Promise<void> {}
}

class Probe implements RepoProbe {
  async probe(): Promise<{ branches: string[] }> {
    return { branches: ['main'] };
  }
}

const DAY = 86_400_000;
const RET = DEFAULT_WORKTREE_GC_DAYS * DAY;

describe('ActionService.runWorktreeGc', () => {
  it('selects only terminal tasks past retention and forwards dry-run', async () => {
    const now = Date.parse('2026-02-15T00:00:00.000Z');
    const tasks = new Map<string, Task>([
      [
        'old-fail',
        task({
          id: 'old-fail',
          state: 'failed',
          endedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
      [
        'recent',
        task({
          id: 'recent',
          state: 'failed',
          endedAt: '2026-02-12T00:00:00.000Z',
        }),
      ],
      [
        'reviewing',
        task({
          id: 'reviewing',
          state: 'review',
          endedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    ]);
    const port = new FakePort(tasks);
    const seen: {
      targets: { taskId: string; repoKey: string }[];
      opts: GcTerminalArtifactsOpts | undefined;
    } = { targets: [], opts: undefined };
    const service = new ActionService(port, new Probe(), undefined, {
      workspaces: {
        async remove() {},
        async gcTerminalArtifacts(targets, opts): Promise<GcTerminalArtifactsResult> {
          seen.targets = [...targets];
          seen.opts = opts;
          return {
            dryRun: opts.dryRun,
            worktreesRemoved: targets.map((t) => t.taskId),
            screenshotsRemoved: [],
            skippedLive: [],
            logLine: 'test',
          };
        },
      },
      worktreeGcRetentionMs: RET,
      worktreeGcDryRun: true,
      screenshotsRoot: '/tmp/shots-test',
    });

    const result = await service.runWorktreeGc({ nowMs: now });
    expect('disabled' in result && result.disabled).toBeFalsy();
    expect(seen.targets).toEqual([{ taskId: 'old-fail', repoKey: 'app' }]);
    expect(seen.opts?.dryRun).toBe(true);
    expect(seen.opts?.screenshotsRoot).toBe('/tmp/shots-test');
    if (!('disabled' in result)) {
      expect(result.worktreesRemoved).toEqual(['old-fail']);
    }
  });

  it('calls gcTerminalArtifacts with its `this` bound (real Workspaces is a class)', async () => {
    // Real incident 2026-07-24: `const gc = deps.workspaces.gcTerminalArtifacts;
    // gc(...)` lost `this` — every production sweep threw "Cannot read
    // properties of undefined (reading 'live')" and worktree GC never ran.
    class ClassWorkspaces {
      readonly live = new Map<string, unknown>();
      async remove(): Promise<void> {}
      async gcTerminalArtifacts(
        targets: readonly { taskId: string; repoKey: string }[],
        opts: GcTerminalArtifactsOpts,
      ): Promise<GcTerminalArtifactsResult> {
        // Same shape as GitWorkspaces: touches instance state via `this`.
        for (const t of targets) this.live.has(t.taskId);
        return {
          dryRun: opts.dryRun,
          worktreesRemoved: targets.map((t) => t.taskId),
          screenshotsRemoved: [],
          skippedLive: [],
          logLine: 'class-based',
        };
      }
    }
    const now = Date.parse('2026-02-15T00:00:00.000Z') + RET + DAY;
    const tasks = new Map([
      ['old-fail', task({ id: 'old-fail', state: 'failed', endedAt: '2026-02-12T00:00:00.000Z' })],
    ]);
    const service = new ActionService(new FakePort(tasks), new Probe(), undefined, {
      workspaces: new ClassWorkspaces(),
      worktreeGcRetentionMs: RET,
      worktreeGcDryRun: true,
    });
    const result = await service.runWorktreeGc({ nowMs: now });
    if (!('disabled' in result)) {
      expect(result.worktreesRemoved).toEqual(['old-fail']);
    } else {
      throw new Error('gc unexpectedly disabled');
    }
  });

  it('retention 0 disables without calling isolation', async () => {
    const port = new FakePort(
      new Map([
        [
          'x',
          task({
            id: 'x',
            state: 'failed',
            endedAt: '2000-01-01T00:00:00.000Z',
          }),
        ],
      ]),
    );
    let called = false;
    const service = new ActionService(port, new Probe(), undefined, {
      workspaces: {
        async remove() {},
        async gcTerminalArtifacts() {
          called = true;
          return {
            dryRun: true,
            worktreesRemoved: [],
            screenshotsRemoved: [],
            skippedLive: [],
            logLine: 'nope',
          };
        },
      },
      worktreeGcRetentionMs: 0,
    });
    const result = await service.runWorktreeGc();
    expect(called).toBe(false);
    expect('disabled' in result && result.disabled).toBe(true);
  });

  it('does not hard-delete control tasks (control history untouched)', async () => {
    const now = Date.parse('2026-02-15T00:00:00.000Z');
    const t = task({
      id: 'keep-file',
      state: 'failed',
      endedAt: '2026-01-01T00:00:00.000Z',
    });
    const port = new FakePort(new Map([[t.id, t]]));
    const service = new ActionService(port, new Probe(), undefined, {
      workspaces: {
        async remove() {},
        async gcTerminalArtifacts(targets, opts) {
          return {
            dryRun: opts.dryRun,
            worktreesRemoved: targets.map((x) => x.taskId),
            screenshotsRemoved: [],
            skippedLive: [],
            logLine: 'ok',
          };
        },
      },
      worktreeGcRetentionMs: RET,
    });
    await service.runWorktreeGc({ nowMs: now, dryRun: false });
    // Task file still present — GC is isolation-only.
    expect(port.tasks.has('keep-file')).toBe(true);
    expect(port.tasks.get('keep-file')?.state).toBe('failed');
  });
});
