import { describe, it, expect } from 'vitest';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import type { GhRunner } from '../../src/orchestrator/openPr.js';

const repos: ReposConfig = {
  repos: {
    app: {
      key: 'app',
      url: 'https://github.com/example-org/acme.git',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: null, readiness: 'ready',
    },
  },
};

function task(over: Partial<Task> = {}): Task {
  return {
    id: 't-del',
    title: 'T',
    repo: 'app',
    state: 'done',
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
    prUrl: 'https://github.com/example-org/acme/pull/99',
    prStatus: 'open',
    planPending: false,
    body: 'x',
    ...over,
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

describe('deleteTask cleanup', () => {
  it('defaults to cleanup and closes open PR + purges workspace', async () => {
    const t = task();
    const port = new FakePort(new Map([[t.id, t]]));
    const ghCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            url: 'https://github.com/example-org/acme/pull/99',
            baseRefName: 'main',
            headRefName: 'hercules/t-del',
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    let purged: string | null = null;
    const service = new ActionService(port, new Probe(), gh, {
      workspaces: {
        async remove() {},
        async purgeTask(_repo, id) {
          purged = id;
        },
      },
    });
    const res = await service.deleteTask(t.id);
    expect(res.deleted).toBe('t-del');
    expect(res.cleanup).toBe(true);
    // Soft-delete: task remains as Deleted trash (not hard-removed).
    expect(res.soft).toBe(true);
    expect(port.tasks.get('t-del')?.state).toBe('deleted');
    expect(ghCalls.some((a) => a.includes('close') && a.includes('99'))).toBe(true);
    expect(purged).toBe('t-del');
    expect(res.notes.some((n) => /PR #99 closed/i.test(n))).toBe(true);
    expect(res.notes).toContain('moved to Deleted (soft)');
  });

  it('skips PR/workspace when cleanup=false', async () => {
    const t = task();
    const port = new FakePort(new Map([[t.id, t]]));
    let ghCalled = false;
    const gh: GhRunner = async () => {
      ghCalled = true;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const service = new ActionService(port, new Probe(), gh, {
      workspaces: {
        async remove() {
          throw new Error('should not run');
        },
      },
    });
    const res = await service.deleteTask(t.id, { cleanup: false });
    expect(res.cleanup).toBe(false);
    expect(ghCalled).toBe(false);
    // Soft-delete still happens; only PR/workspace cleanup is skipped.
    expect(res.soft).toBe(true);
    expect(res.notes).toEqual(['moved to Deleted (soft)']);
    expect(port.tasks.get('t-del')?.state).toBe('deleted');
  });

  it('does not close a same-repo PR owned by another task', async () => {
    const t = task();
    const port = new FakePort(new Map([[t.id, t]]));
    const ghCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          url: 'https://github.com/example-org/acme/pull/99',
          baseRefName: 'main',
          headRefName: 'hercules/other-task',
        }),
        stderr: '',
      };
    };
    const service = new ActionService(port, new Probe(), gh);

    const res = await service.deleteTask(t.id);

    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]!.slice(0, 2)).toEqual(['pr', 'view']);
    expect(ghCalls.some((args) => args.includes('close'))).toBe(false);
    expect(res.notes.some((note) => /pr close failed.*head/i.test(note))).toBe(true);
    expect(port.tasks.get(t.id)?.state).toBe('deleted');
  });

  it('rejects a wrong-repository PR URL before any gh invocation on delete cleanup', async () => {
    const t = task({
      prUrl: 'https://github.com/evil/other/pull/99',
    });
    const port = new FakePort(new Map([[t.id, t]]));
    const ghCalls: string[][] = [];
    const gh: GhRunner = async (args) => {
      ghCalls.push([...args]);
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const service = new ActionService(port, new Probe(), gh);

    const res = await service.deleteTask(t.id);

    expect(ghCalls).toEqual([]);
    expect(res.notes.some((note) => /pr close failed.*does not match configured repo/i.test(note))).toBe(
      true,
    );
    expect(port.tasks.get(t.id)?.state).toBe('deleted');
  });
});
