import { describe, it, expect, vi } from 'vitest';
import { withControlSnapshotRefresh } from '../../src/orchestrator/controlRefresh.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { Task } from '../../src/domain/task.js';

function fakeControl(
  commitResult: { committed: boolean } = { committed: true },
): ControlPort & { commits: string[] } {
  const commits: string[] = [];
  return {
    commits,
    async sync() {},
    async read() {
      return { repos: { repos: {} }, tasks: [], problems: [] };
    },
    async writeTask(_task: Task) {},
    async deleteTask() {},
    async writeRepos() {},
    async commit(message: string) {
      commits.push(message);
      return commitResult;
    },
  };
}

describe('withControlSnapshotRefresh', () => {
  it('refreshes after every commit (including git no-op)', async () => {
    const refresh = vi.fn(async () => {});
    const inner = fakeControl({ committed: false });
    const wrapped = withControlSnapshotRefresh(inner, refresh);

    await wrapped.commit('hercules: approve plan X');
    expect(inner.commits).toEqual(['hercules: approve plan X']);
    expect(refresh).toHaveBeenCalledTimes(1);

    await wrapped.commit('hercules: X todo → done (human)');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('refreshes after successful commits used by ActionService', async () => {
    const refresh = vi.fn(async () => {});
    const inner = fakeControl({ committed: true });
    const wrapped = withControlSnapshotRefresh(inner, refresh);
    await wrapped.commit('hercules: create T');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('forwards atomic task creation and refreshes only after it commits', async () => {
    const refresh = vi.fn(async () => {});
    const createTaskCommitted = vi.fn(async () => ({ committed: true as const, hash: 'abc' }));
    const inner = { ...fakeControl(), createTaskCommitted };
    const wrapped = withControlSnapshotRefresh(inner, refresh);
    const created = { ...({} as Task), id: 'ATOMIC' };

    await expect(wrapped.createTaskCommitted!(created, 'create ATOMIC')).resolves.toEqual({
      committed: true,
      hash: 'abc',
    });
    expect(createTaskCommitted).toHaveBeenCalledWith(created, 'create ATOMIC');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('forwards task compare-and-set and refreshes its committed result', async () => {
    const refresh = vi.fn(async () => {});
    const compareAndSetTaskCommitted = vi.fn(async () => ({
      matched: true as const,
      committed: true as const,
      hash: 'def',
    }));
    const inner = { ...fakeControl(), compareAndSetTaskCommitted };
    const wrapped = withControlSnapshotRefresh(inner, refresh);
    const expected = {
      state: 'todo' as const,
      expectedBaseRevision: 'a'.repeat(40),
      expectedRemoteTip: 'b'.repeat(40),
    };

    await expect(wrapped.compareAndSetTaskCommitted!(
      'HOST',
      expected,
      'in_progress',
      { startedAt: '2026-08-03T00:00:00.000Z' },
      'host marker',
    )).resolves.toMatchObject({ matched: true, committed: true, hash: 'def' });
    expect(compareAndSetTaskCommitted).toHaveBeenCalledWith(
      'HOST',
      expected,
      'in_progress',
      { startedAt: '2026-08-03T00:00:00.000Z' },
      'host marker',
    );
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('forwards dependency rewiring so the composed live ActionService retains the atomic API', async () => {
    const refresh = vi.fn(async () => {});
    const rewireDependenciesCommitted = vi.fn(async () => ({
      committed: true as const,
      hash: 'rewire-hash',
    }));
    const inner = { ...fakeControl(), rewireDependenciesCommitted };
    const wrapped = withControlSnapshotRefresh(inner, refresh);
    const changes = [{
      id: 'A',
      blockedBy: ['B'],
      dependencyMode: 'gate_merge' as const,
      expectedBlockedBy: [],
    }];

    await expect(wrapped.rewireDependenciesCommitted!(changes, 'rewire A'))
      .resolves.toEqual({ committed: true, hash: 'rewire-hash' });
    expect(rewireDependenciesCommitted).toHaveBeenCalledWith(changes, 'rewire A');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('optional release methods forwarding (2026-07-17 Releases panel blank)', () => {
  it('forwards readRelease / writeRelease when the inner port has them', async () => {
    const calls: string[] = [];
    const inner = {
      sync: async () => {},
      read: async () => ({ repos: { repos: {} }, tasks: [], problems: [] }),
      writeTask: async () => {},
      deleteTask: async () => {},
      writeRepos: async () => {},
      commit: async () => ({ committed: true }),
      readRelease: async (k: string) => {
        calls.push(`read:${k}`);
        return null;
      },
      writeRelease: async (r: { repoKey: string }) => {
        calls.push(`write:${r.repoKey}`);
      },
    };
    const wrapped = withControlSnapshotRefresh(inner as never, async () => {});
    const w = wrapped as unknown as {
      readRelease?: (k: string) => Promise<unknown>;
      writeRelease?: (r: { repoKey: string }) => Promise<void>;
    };
    expect(typeof w.readRelease).toBe('function');
    expect(typeof w.writeRelease).toBe('function');
    await w.readRelease!('app');
    await w.writeRelease!({ repoKey: 'app' });
    expect(calls).toEqual(['read:app', 'write:app']);
  });
});
