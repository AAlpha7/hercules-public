/**
 * Repo docs browser API: phone Repos panel lists/reads documentation from the
 * trusted mirror default branch (Bearer-authed, path-confined).
 */
import { describe, it, expect } from 'vitest';
import { createApi } from '../../src/server/api.js';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import type { ReposConfig } from '../../src/domain/repos.js';

const TOKEN = 'secret';
const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

const repos: ReposConfig = {
  repos: {
    app: {
      key: 'app',
      url: 'x',
      defaultBranch: 'main',
      workflow: 'WORKFLOW.md',
      maxConcurrent: 1,
      adapter: null,
      readiness: 'ready',
    },
  },
};

function api() {
  const view: RuntimeView = {
    snapshot: { repos, tasks: [], problems: [] },
    running: [],
    stopping: [],
    activity: {},
    pendingChat: {},
    liveRuns: {},
    lastReport: null,
    agents: { default: 'fake', available: ['fake'] },
  } as unknown as RuntimeView;
  return createApi({
    runtime: {
      getState: () => view,
      subscribe: () => () => {},
      forceAbort: () => {},
    },
    actions: {} as unknown as ActionService,
    token: TOKEN,
    repoDocs: {
      list: async (repo) =>
        repo.key === 'app' ? ['README.md', 'docs/guide.md'] : [],
      read: async (repo, path) =>
        repo.key === 'app' && path === 'docs/guide.md' ? '# Guide\nbody\n' : null,
    },
  });
}

describe('GET /api/repos/:key/docs + /doc', () => {
  it('lists documentation paths for a known repo', async () => {
    const res = await api().request('/api/repos/app/docs', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: string[]; branch: string };
    expect(body.files).toEqual(['README.md', 'docs/guide.md']);
    expect(body.branch).toBe('main');
  });

  it('serves one doc content', async () => {
    const res = await api().request(
      '/api/repos/app/doc?path=docs%2Fguide.md',
      auth,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; path: string };
    expect(body.content).toContain('# Guide');
    expect(body.path).toBe('docs/guide.md');
  });

  it('404s on unknown repo / missing file and requires auth', async () => {
    const a = api();
    expect((await a.request('/api/repos/nope/docs', auth)).status).toBe(404);
    expect(
      (await a.request('/api/repos/app/doc?path=nope.md', auth)).status,
    ).toBe(404);
    expect((await a.request('/api/repos/app/docs')).status).toBe(401);
  });
});
