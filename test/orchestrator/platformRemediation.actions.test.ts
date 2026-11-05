/**
 * ActionService.requestPlatformRemediation — durable open_chain path.
 *
 * FakePort mirrors production GitControlPort: bare writeTask/commit reject.
 * Only mutateCommitted applies writes. Tests fail if the product path uses
 * legacy writeTask + commit (which production refuses).
 */
import { describe, it, expect } from 'vitest';
import { ActionService, ActionError } from '../../src/orchestrator/actions.js';
import type {
  ControlMutation,
  ControlPort,
} from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { parseTaskFile, serializeTask } from '../../src/control/taskFile.js';

function task(id: string, state: TaskState = 'failed'): Task {
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
    attempts: 2,
    lastEventAt: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: '## Goal\nblocked on platform\n',
  };
}

/** Production-shaped port: bare writeTask/commit fail closed. */
class ProductionLikePort implements ControlPort {
  readonly commits: string[] = [];
  readonly bareWriteTaskCalls: string[] = [];
  readonly bareCommitCalls: string[] = [];
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
      hercules: {
        key: 'hercules',
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
    this.bareWriteTaskCalls.push(t.id);
    throw new Error(
      'GitControlPort task writes require mutateCommitted or compare-and-set ownership',
    );
  }
  async deleteTask(_id: string): Promise<void> {
    throw new Error('GitControlPort task deletion requires mutateCommitted ownership');
  }
  async commit(message: string): Promise<{ committed: boolean }> {
    this.bareCommitCalls.push(message);
    throw new Error('GitControlPort commits require mutateCommitted ownership');
  }
  async writeRepos(_config: ReposConfig): Promise<void> {
    throw new Error('GitControlPort repository writes require mutateCommitted ownership');
  }
  async mutateCommitted(
    mutation: ControlMutation,
    message: string,
  ): Promise<{ committed: boolean; hash?: string }> {
    for (const write of mutation.writeTasks ?? []) {
      const current = this.tasks.get(write.next.id) ?? null;
      if (write.expected === null) {
        if (current !== null) {
          throw new Error(`task '${write.next.id}' must be absent before create`);
        }
      } else if (JSON.stringify(current) !== JSON.stringify(write.expected)) {
        throw new Error(`task '${write.next.id}' changed before atomic mutation`);
      }
    }
    for (const write of mutation.writeTasks ?? []) {
      this.tasks.set(write.next.id, write.next);
    }
    for (const id of mutation.deleteTaskIds ?? []) {
      this.tasks.delete(id);
    }
    this.commits.push(message);
    return { committed: true, hash: 'a'.repeat(40) };
  }
}

class FakeProbe implements RepoProbe {
  async probe(): Promise<{ branches: string[] }> {
    return { branches: ['main'] };
  }
}

describe('ActionService.requestPlatformRemediation', () => {
  it('opens a durable chain via mutateCommitted (not bare writeTask)', async () => {
    const port = new ProductionLikePort(new Map([['ORIG-1', task('ORIG-1', 'failed')]]));
    const service = new ActionService(port, new FakeProbe());
    const result = await service.requestPlatformRemediation('ORIG-1', {
      kind: 'bug',
      id: 'FIX-1',
    });
    expect(result.mode).toBe('open_chain');
    expect(result.original.platformRemediationTask).toBe('FIX-1');
    expect(result.original.platformRemediationKind).toBe('bug');
    expect(result.original.platformRemediationResumedOutcome).toBe('pending');
    expect(result.remediation?.platformRemediationOf).toBe('ORIG-1');
    expect(result.remediation?.platformRemediationKind).toBe('bug');
    expect(result.remediation?.state).toBe('todo');
    expect(result.remediation?.blockedBy).toEqual([]);
    expect(port.tasks.get('ORIG-1')!.platformRemediationTask).toBe('FIX-1');
    expect(port.tasks.get('FIX-1')!.platformRemediationOf).toBe('ORIG-1');
    expect(port.commits.some((m) => /platform-remediation/.test(m))).toBe(true);
    // Production-shaped: product must not touch legacy writeTask/commit.
    expect(port.bareWriteTaskCalls).toEqual([]);
    expect(port.bareCommitCalls).toEqual([]);

    const origDisk = serializeTask(port.tasks.get('ORIG-1')!);
    const fixDisk = serializeTask(port.tasks.get('FIX-1')!);
    expect(origDisk).toContain('platform_remediation_task: FIX-1');
    expect(origDisk).toContain('platform_remediation_kind: bug');
    expect(fixDisk).toContain('platform_remediation_of: ORIG-1');
    const origRound = parseTaskFile(origDisk, 'ORIG-1');
    const fixRound = parseTaskFile(fixDisk, 'FIX-1');
    expect(origRound.platformRemediationTask).toBe('FIX-1');
    expect(origRound.platformRemediationResumedOutcome).toBe('pending');
    expect(fixRound.platformRemediationOf).toBe('ORIG-1');
    expect(fixRound.platformRemediationKind).toBe('bug');
  });

  it('refuses ordinary review state (not platform remediation)', async () => {
    const port = new ProductionLikePort(new Map([['T-REV', task('T-REV', 'review')]]));
    const service = new ActionService(port, new FakeProbe());
    await expect(
      service.requestPlatformRemediation('T-REV', { kind: 'bug' }),
    ).rejects.toBeInstanceOf(ActionError);
    expect(port.bareWriteTaskCalls).toEqual([]);
    expect(port.bareCommitCalls).toEqual([]);
  });

  it('syncPlatformRemediationOutcome stamps remediation_done via mutateCommitted', async () => {
    const orig: Task = {
      ...task('ORIG-2', 'failed'),
      platformRemediationKind: 'bug',
      platformRemediationTask: 'FIX-2',
      platformRemediationResumedOutcome: 'pending',
      platformRemediationRecordedAt: '2026-08-03T00:00:00.000Z',
    };
    const rem: Task = {
      ...task('FIX-2', 'done'),
      platformRemediationKind: 'bug',
      platformRemediationOf: 'ORIG-2',
    };
    const port = new ProductionLikePort(
      new Map<string, Task>([
        ['ORIG-2', orig],
        ['FIX-2', rem],
      ]),
    );
    const service = new ActionService(port, new FakeProbe());
    const next = await service.syncPlatformRemediationOutcome('FIX-2');
    expect(next?.platformRemediationResumedOutcome).toBe('remediation_done');
    expect(port.tasks.get('ORIG-2')!.platformRemediationResumedOutcome).toBe(
      'remediation_done',
    );
    expect(port.commits.some((m) => /platform-remediation → remediation_done/.test(m))).toBe(
      true,
    );
    expect(port.bareWriteTaskCalls).toEqual([]);
    expect(port.bareCommitCalls).toEqual([]);
  });
});
