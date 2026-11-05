/**
 * Phone review file browser (SPEC §9.6 / review-not-supervise): the human
 * checking "spot-check docs quality" must be able to READ what the task
 * produced. Routes serve the files changed at the task's verified sha from
 * the trusted mirror (read-only), Bearer-authed like everything else.
 */
import { describe, it, expect } from 'vitest';
import { createApi } from '../../src/server/api.js';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import type { Task } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';

const TOKEN = 'secret';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

const repos: ReposConfig = {
  repos: {
    app: {
      key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md',
      maxConcurrent: 1, adapter: null, readiness: 'ready',
    },
  },
};

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'T-1', title: 't', repo: 'app', state: 'review', priority: 1,
    blockedBy: [], labels: [], adapter: null, agentSession: null,
    pendingSteer: null, attempts: 0, lastEventAt: null, createdAt: null,
    startedAt: null, endedAt: null, prUrl: null, prStatus: null,
    planPending: false, body: '', verifiedSha: 'a'.repeat(40),
    ...over,
  } as Task;
}

function api(t: Task) {
  const view: RuntimeView = {
    snapshot: { repos, tasks: [t], problems: [] },
    running: [], stopping: [], activity: {}, pendingChat: {}, liveRuns: {},
    lastReport: null, agents: { default: 'fake', available: ['fake'] },
  } as unknown as RuntimeView;
  return createApi({
    runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
    actions: {} as unknown as ActionService,
    token: TOKEN,
    taskFiles: {
      list: async (_repo, sha) => (sha === 'a'.repeat(40) ? ['docs/GUIDE.md', 'src/x.ts'] : []),
      read: async (_repo, sha, path) =>
        sha === 'a'.repeat(40) && path === 'docs/GUIDE.md' ? '# Guide\ncontent\n' : null,
    },
  });
}

describe('GET /api/tasks/:id/files + /file', () => {
  it('lists files changed at the verified sha', async () => {
    const res = await api(task()).request('/api/tasks/T-1/files', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sha: string; files: string[] };
    expect(body.files).toEqual(['docs/GUIDE.md', 'src/x.ts']);
    expect(body.sha).toBe('a'.repeat(40));
  });

  it('serves one file content', async () => {
    const res = await api(task()).request(
      '/api/tasks/T-1/file?path=docs%2FGUIDE.md', auth,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; path: string };
    expect(body.content).toContain('# Guide');
  });

  it('404s when the task has no verified sha (nothing trustworthy to show)', async () => {
    const res = await api(task({ verifiedSha: null })).request('/api/tasks/T-1/files', auth);
    expect(res.status).toBe(404);
  });

  it('404s on unknown file and requires auth', async () => {
    const a = api(task());
    expect((await a.request('/api/tasks/T-1/file?path=nope.md', auth)).status).toBe(404);
    expect((await a.request('/api/tasks/T-1/files')).status).toBe(401);
  });
});
