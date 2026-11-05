import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, open, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '../../src/server/api.js';
import { createDraftJobs } from '../../src/server/draftJobs.js';
import { ActionService } from '../../src/orchestrator/actions.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { RuntimeView } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { ReposConfig } from '../../src/domain/repos.js';
import type { WorkspaceSuccessionLedger } from '../../src/domain/workspaceSuccession.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import type { RemoteSession } from '../../src/domain/session.js';
import type { SessionManager } from '../../src/sessions/manager.js';
import { GitControlPort } from '../../src/orchestrator/gitControlPort.js';
import { ControlMutationConflictError } from '../../src/orchestrator/gitControlPort.js';
import { simpleGit } from 'simple-git';
import type { AnalystDraft } from '../../src/orchestrator/analyst.js';
import type { AnalystActivityListener } from '../../src/domain/analystActivity.js';
import {
  CLI_EVIDENCE_RECEIPT_BLOCK_END,
  CLI_EVIDENCE_RECEIPT_BLOCK_START,
  CLI_EVIDENCE_PACKET_AUTHORITY,
  MAX_CLI_EVIDENCE_RECEIPT_BYTES,
  serializeCliEvidenceReceipt,
  type CliEvidenceReceipt,
} from '../../src/domain/cliEvidence.js';

const repos: ReposConfig = {
  repos: {
    app: { key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' },
  },
};

function task(id: string, state: TaskState = 'todo'): Task {
  return {
    id, title: id, repo: 'app', state, priority: 100,
    blockedBy: [], labels: [], adapter: null, agentSession: null,
    pendingSteer: null, attempts: 0, lastEventAt: null, createdAt: null, startedAt: null, endedAt: null, prUrl: null, prStatus: null, planPending: false, body: 'b',
  };
}

class FakePort implements ControlPort {
  reposConfig: ReposConfig = repos;
  succession: WorkspaceSuccessionLedger | null = null;
  rewireError: Error | null = null;
  constructor(readonly tasks: Map<string, Task>) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos: this.reposConfig, tasks: [...this.tasks.values()], problems: [] };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
  }
  async createTaskCommitted(t: Task): Promise<{ committed: boolean }> {
    this.tasks.set(t.id, t);
    return { committed: true };
  }
  async rewireDependenciesCommitted(
    changes: readonly import('../../src/domain/dependencyRewire.js').DependencyRewireChange[],
  ): Promise<{ committed: boolean; hash?: string }> {
    if (this.rewireError) throw this.rewireError;
    for (const change of changes) {
      const current = this.tasks.get(change.id)!;
      this.tasks.set(change.id, {
        ...current, blockedBy: change.blockedBy, dependencyMode: change.dependencyMode,
      });
    }
    return { committed: true, hash: 'b'.repeat(40) };
  }
  async deleteTask(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  async commit(): Promise<{ committed: boolean }> {
    return { committed: true };
  }
  async writeRepos(config: ReposConfig): Promise<void> {
    this.reposConfig = config;
  }
  async readSuccession(): Promise<WorkspaceSuccessionLedger | null> {
    return this.succession;
  }
  async writeSuccession(ledger: WorkspaceSuccessionLedger): Promise<void> {
    this.succession = ledger;
  }
}

class FakeProbe implements RepoProbe {
  constructor(private readonly branches: string[]) {}
  async probe(): Promise<{ branches: string[] }> {
    return { branches: this.branches };
  }
}

const TOKEN = 'secret';

function harness(
  tasks: Task[] = [],
  gh?: import('../../src/orchestrator/openPr.js').GhRunner,
  configurePort?: (port: FakePort) => void,
): ReturnType<typeof createApi> {
  const port = new FakePort(new Map(tasks.map((t) => [t.id, t])));
  // GitHub URL so /pr endpoints can parse the remote.
  port.reposConfig = {
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
  configurePort?.(port);
  const view: RuntimeView = {
    snapshot: { repos: port.reposConfig, tasks: [...port.tasks.values()], problems: [] },
    running: [],
    stopping: [],
    activity: {},
    pendingChat: {},
      liveRuns: {},
    lastReport: null,
    agents: { default: 'fake', available: ['fake'] },
  };
  return createApi({
    runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
    actions: new ActionService(port, new FakeProbe(['main']), gh),
    token: TOKEN,
  });
}

const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

describe('POST /api/tasks/dependencies/rewire', () => {
  it('requires auth and returns one audited batch receipt', async () => {
    const app = harness([task('A'), { ...task('B'), blockedBy: ['A'] }]);
    const body = JSON.stringify({ changes: [{
      id: 'B', expectedBlockedBy: ['A'], blockedBy: [], dependencyMode: 'completion_only',
    }] });
    expect((await app.request('/api/tasks/dependencies/rewire', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    })).status).toBe(401);
    const response = await app.request('/api/tasks/dependencies/rewire', {
      method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' }, body,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ committed: true, taskIds: ['B'] });
  });

  it('rejects extra task fields so the endpoint cannot mutate task content or lifecycle', async () => {
    const response = await harness([task('A')]).request('/api/tasks/dependencies/rewire', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [{
        id: 'A', expectedBlockedBy: [], blockedBy: [], dependencyMode: 'gate_merge',
        body: 'replace it', state: 'done', verifiedSha: 'a'.repeat(40),
      }] }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/unsupported field/i) });
  });

  it('rejects missing explicit mode and malformed identifier arrays', async () => {
    const response = await harness([task('A')]).request('/api/tasks/dependencies/rewire', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [{ id: 'A', expectedBlockedBy: [], blockedBy: [7] }] }),
    });
    expect(response.status).toBe(400);
  });

  it('returns a bounded retryable conflict receipt for a serialized race', async () => {
    const app = harness([task('A')], undefined, (port) => {
      port.rewireError = new ControlMutationConflictError('stale expected dependency set for A');
    });
    const response = await app.request('/api/tasks/dependencies/rewire', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ changes: [{
        id: 'A', expectedBlockedBy: [], blockedBy: [], dependencyMode: 'gate_merge',
      }] }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'stale expected dependency set for A', conflict: true, retryable: true,
    });
  });
});

describe('reviewer provider recovery API', () => {
  it('requires auth and invokes a bounded provider recovery mode', async () => {
    const calls: Array<{ provider: string; mode: string }> = [];
    const app = createApi({
      runtime: {
        getState: () => ({
          snapshot: null, running: [], stopping: [], activity: {}, pendingChat: {},
          liveRuns: {}, lastReport: null,
          agents: { default: 'grok', available: ['grok'] },
        }),
        subscribe: () => () => {},
        forceAbort: () => {},
        recoverReviewerProvider: async (provider, input) => {
          calls.push({ provider, mode: input.mode });
          return { recovered: 2 };
        },
      },
      actions: new ActionService(new FakePort(new Map()), new FakeProbe(['main'])),
      token: TOKEN,
    });
    expect((await app.request('/api/reviewer-health/grok/recover', { method: 'POST' })).status).toBe(401);
    const response = await app.request('/api/reviewer-health/grok/recover', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'health_check' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recovered: 2 });
    expect(calls).toEqual([{ provider: 'grok', mode: 'health_check' }]);
  });
});

function validCliReceipt(): CliEvidenceReceipt {
  return {
    version: 1, source: 'workflow', status: 'passed', ok: true, durationMs: 4,
    steps: [{
      id: 'help', argv: ['node', '--version'], cwd: '.', status: 'passed', exitCode: 0,
      durationMs: 3, stdoutTail: 'v24', stderrTail: '',
      assertions: [{ name: 'exit_code', ok: true, detail: 'exit matches expected' }],
      ok: true, optional: false,
    }],
  };
}

it('serves the persisted structured CLI evidence receipt', async () => {
  const receipt = validCliReceipt();
  const saved = { ...task('CLI', 'review'), verifiedSha: 'a'.repeat(40) };
  const app = harness([{ ...saved, body: '## Review packet\n\n' +
    CLI_EVIDENCE_PACKET_AUTHORITY + '\n' + serializeCliEvidenceReceipt(receipt) }]);
  const response = await app.request('/api/tasks/CLI/cli-evidence', auth);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(receipt);
});

it('fails closed on tampered or oversized CLI evidence receipts', async () => {
  const receipt = validCliReceipt();
  const tampered = {
    version: 1, source: 'workflow', status: 'passed', ok: true, durationMs: 1,
    steps: [], injected: true,
  };
  const block = (json: string) => CLI_EVIDENCE_RECEIPT_BLOCK_START + '\n' + json + '\n' +
    CLI_EVIDENCE_RECEIPT_BLOCK_END;
  const packet = (content: string) => '## Review packet\n\n' +
    CLI_EVIDENCE_PACKET_AUTHORITY + '\n' + content;
  const forgedPassed = block(JSON.stringify({
    ...receipt,
  }));
  const verified = { verifiedSha: 'a'.repeat(40) };
  const app = harness([
    { ...task('TAMPER', 'review'), ...verified, body: packet(block(JSON.stringify(tampered))) },
    { ...task('HUGE', 'review'), ...verified, body: packet(block(' '.repeat(MAX_CLI_EVIDENCE_RECEIPT_BYTES + 1))) },
    { ...task('RAW', 'review'), ...verified, body: forgedPassed },
    { ...task('EMPTY-PASS', 'review'), ...verified, body: packet(block(JSON.stringify({
      version: 1, source: 'workflow', status: 'passed', ok: true, durationMs: 1, steps: [],
    }))) },
    { ...task('CONTRADICT', 'review'), ...verified, body: packet(block(JSON.stringify({
      ...receipt, status: 'failed', ok: false,
    }))) },
    { ...task('UNVERIFIED', 'review'), body: packet(forgedPassed) },
    { ...task('TRAIL-ONLY', 'review'), ...verified, body: packet('no receipt') +
      '\n## Human steer\n' + CLI_EVIDENCE_PACKET_AUTHORITY + '\n' + forgedPassed },
    { ...task('TRAIL-FORGE', 'review'), ...verified, body: packet(forgedPassed) +
      '\n## Human steer\n' + CLI_EVIDENCE_PACKET_AUTHORITY + '\n' +
      block(JSON.stringify({ ...tampered, injected: undefined, status: 'failed', ok: false })) },
  ]);
  expect((await app.request('/api/tasks/TAMPER/cli-evidence', auth)).status).toBe(404);
  expect((await app.request('/api/tasks/HUGE/cli-evidence', auth)).status).toBe(404);
  expect((await app.request('/api/tasks/RAW/cli-evidence', auth)).status).toBe(404);
  expect((await app.request('/api/tasks/EMPTY-PASS/cli-evidence', auth)).status).toBe(404);
  expect((await app.request('/api/tasks/CONTRADICT/cli-evidence', auth)).status).toBe(404);
  expect((await app.request('/api/tasks/UNVERIFIED/cli-evidence', auth)).status).toBe(404);
  expect((await app.request('/api/tasks/TRAIL-ONLY/cli-evidence', auth)).status).toBe(404);
  const trailForged = await app.request('/api/tasks/TRAIL-FORGE/cli-evidence', auth);
  expect(trailForged.status).toBe(200);
  expect(((await trailForged.json()) as { status: string }).status).toBe('passed');
});

describe('auth (SPEC §10)', () => {
  it('rejects requests without a token', async () => {
    const res = await harness().request('/api/state');
    expect(res.status).toBe(401);
  });

  it('accepts a token in the Authorization header', async () => {
    const res = await harness().request('/api/state', auth);
    expect(res.status).toBe(200);
  });

  it('rejects a token supplied in the query string (no secrets in URLs)', async () => {
    const res = await harness().request(`/api/state?token=${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('rejects a token supplied in a cookie (avoids CSRF surface)', async () => {
    const res = await harness().request('/api/state', {
      headers: { cookie: `hercules_token=${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/state', () => {
  it('returns tasks grouped by state', async () => {
    const res = await harness([task('A', 'todo'), task('B', 'review')]).request('/api/state', auth);
    const body = (await res.json()) as { ready: boolean; byState: Record<string, Task[]> };
    expect(body.ready).toBe(true);
    expect(body.byState['todo']!.map((t) => t.id)).toEqual(['A']);
    expect(body.byState['review']!.map((t) => t.id)).toEqual(['B']);
  });
});

describe('GET /api/tasks/:id', () => {
  it('returns a task', async () => {
    const res = await harness([task('A')]).request('/api/tasks/A', auth);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task).id).toBe('A');
  });

  it('exposes packetNonce on the task DTO (C3.28)', async () => {
    const nonce = 'a'.repeat(32);
    const res = await harness([
      { ...task('A'), packetNonce: nonce },
    ]).request('/api/tasks/A', auth);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task).packetNonce).toBe(nonce);
  });

  it('includes dispatchHoldReason from runtime holds (null when not held)', async () => {
    const res = await harness([task('A')]).request('/api/tasks/A', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task & { dispatchHoldReason: unknown };
    expect(body.dispatchHoldReason).toBeNull();
  });

  it('surfaces a concrete dispatchHoldReason when runtime holds the task', async () => {
    const port = new FakePort(new Map([['A', task('A')]]));
    port.reposConfig = {
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
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [...port.tasks.values()], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
      holds: {
        A: { code: 'repo_readiness_incomplete', repo: 'orbit' },
      },
    };
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
    });
    const res = await app.request('/api/tasks/A', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dispatchHoldReason: unknown };
    expect(body.dispatchHoldReason).toEqual({
      code: 'repo_readiness_incomplete',
      repo: 'orbit',
    });
  });

  it('nulls dispatchHoldReason for non-queued states even if holds map is stale', async () => {
    // Plan-held todo → cancel → snapshot refreshed but holds lag until next tick.
    const cancelled = task('A', 'cancelled');
    const port = new FakePort(new Map([['A', cancelled]]));
    port.reposConfig = {
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
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [cancelled], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
      holds: {
        A: { code: 'plan_pending' },
      },
    };
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
    });
    const res = await app.request('/api/tasks/A', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      dispatchHoldReason: unknown;
    };
    expect(body.state).toBe('cancelled');
    expect(body.dispatchHoldReason).toBeNull();
  });

  it('404s for an unknown task', async () => {
    const res = await harness().request('/api/tasks/NOPE', auth);
    expect(res.status).toBe(404);
  });
});

describe('provider session redaction', () => {
  it('redacts provider resume ids from task and free-session GET routes', async () => {
    const ownedTask = {
      ...task('A'),
      agentSession: 'task-provider-id',
      agentSessionAdapter: 'grok' as const,
      body:
        'Prior `agent_session`: `legacy-provider-id`\ncurrent task-provider-id\n' +
        'Session "019f9999-abcd-7890-abcd-1234567890ab" not found locally, restoring from remote...',
    };
    const session: RemoteSession = {
      id: 'rc-public-id', kind: 'free', taskId: null, repo: 'app', title: 'chat',
      status: 'idle', adapter: 'grok', agentSession: 'free-provider-id',
      permissionMode: 'default', pendingPermissions: [], pendingProposals: [{
        id: 'proposal-1', title: 'Proposal', repo: 'app', body: 'body', priority: 50,
        raw: 'title: Proposal', createdAt: new Date(0).toISOString(), sourceMessageId: null,
      }], messages: [], queued: [],
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), error: null,
      linkedTaskId: null, pinned: false, archived: false,
    };
    const port = new FakePort(new Map([['A', ownedTask]]));
    const view: RuntimeView = {
      snapshot: { repos, tasks: [ownedTask], problems: [] }, running: [], stopping: [],
      activity: {}, pendingChat: {}, liveRuns: {}, lastReport: null,
      agents: { default: 'fake', available: ['fake'] }, sessions: [session],
    };
    const sessions = {
      list: () => [session],
      get: (id: string) => id === session.id ? session : null,
      dismissProposal: (id: string, proposalId: string) => ({
        ...session,
        pendingProposals: id === session.id && proposalId === 'proposal-1'
          ? []
          : session.pendingProposals,
      }),
    } as unknown as SessionManager;
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions: new ActionService(port, new FakeProbe(['main'])), token: TOKEN, sessions,
    });

    const taskRes = await app.request('/api/tasks/A', auth);
    const taskBody = (await taskRes.json()) as Task;
    expect(taskBody.agentSession).toBeNull();
    expect(taskBody.agentSessionAdapter).toBeNull();
    expect(taskBody.body).not.toContain('task-provider-id');
    expect(taskBody.body).not.toContain('legacy-provider-id');
    expect(taskBody.body).not.toContain('019f9999-abcd-7890-abcd-1234567890ab');

    const stateRes = await app.request('/api/state', auth);
    const stateText = await stateRes.text();
    expect(stateText).not.toContain('task-provider-id');
    expect(stateText).not.toContain('free-provider-id');

    const listRes = await app.request('/api/sessions', auth);
    const listBody = (await listRes.json()) as { sessions: RemoteSession[] };
    expect(listBody.sessions[0]!.id).toBe('rc-public-id');
    expect(listBody.sessions[0]!.agentSession).toBeNull();

    const detailRes = await app.request('/api/sessions/rc-public-id', auth);
    expect(((await detailRes.json()) as RemoteSession).agentSession).toBeNull();

    const dismissRes = await app.request(
      '/api/sessions/rc-public-id/proposals/proposal-1/dismiss',
      { ...auth, method: 'POST' },
    );
    const dismissed = (await dismissRes.json()) as RemoteSession;
    expect(dismissed.pendingProposals).toEqual([]);
    expect(dismissed.agentSession).toBeNull();
  });
});

describe('GET /api/tasks/:id/pr-summary provenance', () => {
  it('returns 400 and invokes no gh command for a wrong-repository task URL', async () => {
    let ghCalled = false;
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => {
      ghCalled = true;
      return { exitCode: 1, stdout: '', stderr: 'must not run' };
    };
    const stale: Task = {
      ...task('victim', 'done'),
      prUrl: 'https://github.com/evil/other/pull/9',
      prStatus: 'open',
    };

    const res = await harness([stale], gh).request(
      '/api/tasks/victim/pr-summary',
      auth,
    );

    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringMatching(/does not match configured repo/i),
    });
    expect(ghCalled).toBe(false);
  });
});

describe('POST /api/tasks/:id/approve-host-operation', () => {
  it('approves host_operation with bounded command scope', async () => {
    const host: Task = {
      ...task('HOST-API'),
      executionClass: 'host_operation',
      body: '## Goal\nrestart\n',
    };
    const res = await harness([host]).request('/api/tasks/HOST-API/approve-host-operation', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ commandScope: ['systemctl restart hercules'] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.hostCommandScope).toEqual(['systemctl restart hercules']);
    expect(body.hostApprovedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('400s when commandScope is missing', async () => {
    const host: Task = {
      ...task('HOST-API-2'),
      executionClass: 'host_operation',
    };
    const res = await harness([host]).request('/api/tasks/HOST-API-2/approve-host-operation', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('400s rather than silently dropping non-string scope entries', async () => {
    const host: Task = {
      ...task('HOST-API-3'),
      executionClass: 'host_operation',
    };
    const res = await harness([host]).request('/api/tasks/HOST-API-3/approve-host-operation', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ commandScope: ['systemctl restart hercules', 42] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tasks/:id/path-lease/amend', () => {
  it('requires authentication, rejects patch-shaped extras, and amends a cancelled task', async () => {
    const base = '1'.repeat(40);
    const tip = '2'.repeat(40);
    const currentBase = '3'.repeat(40);
    const leased = {
      ...task('LEASE-API', 'cancelled'),
      plannedBaseRevision: base,
      affectedPaths: ['src/old.ts'],
      protectedPathsSnapshot: [],
      expectedBaseRevision: base,
      expectedRemoteTip: tip,
      verifiedSha: tip,
      lastEventAt: '2026-08-04T00:00:00.000Z',
    };
    class AtomicApiPort extends FakePort {
      async mutateCommitted(
        mutation: import('../../src/orchestrator/orchestrator.js').ControlMutation,
        message: string,
      ): Promise<{ committed: boolean }> {
        for (const write of mutation.writeTasks ?? []) {
          if (JSON.stringify(this.tasks.get(write.next.id) ?? null) !== JSON.stringify(write.expected)) {
            throw new ControlMutationConflictError(`task '${write.next.id}' changed`);
          }
        }
        for (const write of mutation.writeTasks ?? []) this.tasks.set(write.next.id, write.next);
        void message;
        return this.commit();
      }
    }
    const port = new AtomicApiPort(new Map([[leased.id, leased]]));
    const actions = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => { throw new Error('unused'); },
        preserve: async () => undefined,
        readTrustedDefaultRevisionSnapshot: async () => ({
          revision: currentBase,
          workflowContent: '---\nprotected_paths: []\n---\n',
        }),
        inspectPreservedCandidate: async () => ({
          tip,
          filesTouched: ['src/new.ts'],
          trustedDefaultRevision: currentBase,
          workflowContentAtTrustedDefault: '---\nprotected_paths: []\n---\n',
        }),
      },
      verifier: { verify: async () => { throw new Error('unused'); } } as never,
    });
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [leased], problems: [] },
      running: [], stopping: [], activity: {}, pendingChat: {}, liveRuns: {},
      lastReport: null, agents: { default: 'fake', available: ['fake'] },
    };
    const api = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions,
      token: TOKEN,
    });
    const request = {
      expected: {
        state: 'cancelled', plannedBaseRevision: base, expectedBaseRevision: base,
        affectedPaths: ['src/old.ts'],
        protectedPathsSnapshot: [], expectedRemoteTip: tip, verifiedSha: tip,
        lastEventAt: leased.lastEventAt,
      },
      replacement: {
        plannedBaseRevision: currentBase, affectedPaths: ['src/'], protectedPathsSnapshot: [],
      },
    };
    const url = `/api/tasks/${leased.id}/path-lease/amend`;
    expect((await api.request(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    })).status).toBe(401);
    const extra = await api.request(url, {
      method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, body: 'generic patch' }),
    });
    expect(extra.status).toBe(400);
    const stale = await api.request(url, {
      method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...request,
        expected: { ...request.expected, expectedBaseRevision: '9'.repeat(40) },
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ conflict: true });
    const response = await api.request(url, {
      method: 'POST', headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: 'cancelled',
      plannedBaseRevision: currentBase,
      expectedBaseRevision: currentBase,
      expectedRemoteTip: tip,
      affectedPaths: ['src/'],
    });
  });
});

describe('POST /api/tasks/:id/salvage-fork', () => {
  function salvageApi(source: Task): {
    api: ReturnType<typeof createApi>;
    sha: string;
  } {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const port = new FakePort(new Map([[source.id, source]]));
    port.reposConfig = {
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
    const actions = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => {
          throw new Error('unused');
        },
        preserve: async () => undefined,
        resolveSalvageSourceTip: async (_r, s, target) => ({
          sourceSha: sha,
          sourceBranch: `hercules/${s}`,
          targetBranch: `hercules/${target}`,
        }),
      },
      verifier: { verify: async () => {
        throw new Error('no');
      } } as never,
    });
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [...port.tasks.values()], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const api = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions,
      token: TOKEN,
    });
    return { api, sha };
  }

  it('forks a failed task into a new target with provenance', async () => {
    const source = {
      ...task('API-FAIL', 'failed'),
      title: 'API fail',
      body: '## Goal\nDo it.\n\n## Acceptance criteria\n- [ ] (mechanical) ok\n',
    };
    const { api, sha } = salvageApi(source);
    const res = await api.request('/api/tasks/API-FAIL/salvage-fork', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'API-TGT' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      salvageSourceTask: string;
      salvageSourceSha: string;
    };
    expect(body.id).toBe('API-TGT');
    expect(body.salvageSourceTask).toBe('API-FAIL');
    expect(body.salvageSourceSha).toBe(sha);
  });

  it('forks a cancelled task into a new target with provenance', async () => {
    const source = {
      ...task('API-CANC', 'cancelled'),
      title: 'API cancelled',
      body: '## Goal\nDo it.\n\n## Acceptance criteria\n- [ ] (mechanical) ok\n',
      attempts: 3,
    };
    const { api, sha } = salvageApi(source);
    const res = await api.request('/api/tasks/API-CANC/salvage-fork', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + TOKEN,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 'API-CANC-TGT' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      salvageSourceTask: string;
      salvageSourceSha: string;
    };
    expect(body.id).toBe('API-CANC-TGT');
    expect(body.salvageSourceTask).toBe('API-CANC');
    expect(body.salvageSourceSha).toBe(sha);
  });

  it('accepts empty body', async () => {
    const source = {
      ...task('API-EMPTY', 'failed'),
      title: 'Empty body ok',
      body: '## Goal\nDo it.\n\n## Acceptance criteria\n- [ ] (mechanical) ok\n',
    };
    const { api } = salvageApi(source);
    const res = await api.request('/api/tasks/API-EMPTY/salvage-fork', {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body: '',
    });
    expect(res.status).toBe(201);
  });

  it('returns 400 for malformed JSON', async () => {
    const source = { ...task('API-BAD', 'failed') };
    const { api } = salvageApi(source);
    const res = await api.request('/api/tasks/API-BAD/salvage-fork', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid JSON/i);
  });

  it('returns 400 for wrong field types and unsafe lengths', async () => {
    const source = { ...task('API-TYPE', 'failed') };
    const { api } = salvageApi(source);
    const badId = await api.request('/api/tasks/API-TYPE/salvage-fork', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 99 }),
    });
    expect(badId.status).toBe(400);

    const badTitle = await api.request('/api/tasks/API-TYPE/salvage-fork', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ title: 'x'.repeat(501) }),
    });
    expect(badTitle.status).toBe(400);

    const badLabels = await api.request('/api/tasks/API-TYPE/salvage-fork', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ labels: 'not-array' }),
    });
    expect(badLabels.status).toBe(400);

    const unsafeId = await api.request('/api/tasks/API-TYPE/salvage-fork', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: '../evil' }),
    });
    expect(unsafeId.status).toBe(400);
  });

  it('refuses non-failed source', async () => {
    const res = await harness([task('OK', 'todo')]).request('/api/tasks/OK/salvage-fork', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('POST /api/tasks', () => {
  it('creates a task', async () => {
    const res = await harness().request('/api/tasks', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'New thing', repo: 'app' }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Task).id).toBe('1-new-thing');
  });

  it('returns failure and leaves no task when the durable create commit hook rejects', async () => {
    const controlDir = await mkdtemp(join(tmpdir(), 'hercules-api-create-hook-'));
    try {
      const git = simpleGit({
        baseDir: controlDir,
        unsafe: { allowUnsafeHooksPath: true },
      });
      await git.init(['-b', 'main']);
      await git.addConfig('core.hooksPath', join(controlDir, '.git', 'no-hooks'));
      await git.addConfig('user.email', 'api@hercules.local');
      await git.addConfig('user.name', 'API Test');
      await mkdir(join(controlDir, 'tasks'), { recursive: true });
      await writeFile(join(controlDir, 'repos.yaml'), [
        'repos:',
        '  app:',
        '    url: x',
        '    default_branch: main',
        '',
      ].join('\n'));
      await git.add('.');
      await git.commit('seed');
      const hookDir = join(controlDir, '.git', 'failing-hooks');
      await mkdir(hookDir, { recursive: true });
      const hook = join(hookDir, 'pre-commit');
      await writeFile(hook, '#!/bin/sh\nexit 1\n');
      const { chmod } = await import('node:fs/promises');
      await chmod(hook, 0o755);
      await git.addConfig('core.hooksPath', hookDir);
      const control = new GitControlPort(controlDir);
      const snapshot = await control.read();
      const cleanBeforeRequest = await git.status();
      expect(cleanBeforeRequest.isClean(), JSON.stringify(cleanBeforeRequest)).toBe(true);
      const app = createApi({
        runtime: {
          getState: () => ({
            snapshot, running: [], stopping: [], activity: {}, pendingChat: {}, liveRuns: {},
            lastReport: null, agents: { default: 'fake', available: ['fake'] },
          }),
          subscribe: () => () => {},
          forceAbort: () => {},
        },
        actions: new ActionService(control, new FakeProbe(['main'])),
        token: TOKEN,
      });

      const res = await app.request('/api/tasks', {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'HOOK-API', title: 'Hook API', repo: 'app' }),
      });
      expect(res.status).toBe(500);
      expect((await control.read()).tasks.some((candidate) => candidate.id === 'HOOK-API')).toBe(false);
      expect((await git.status()).isClean()).toBe(true);
    } finally {
      await rm(controlDir, { recursive: true, force: true });
    }
  });

  it('validates and round-trips the complete canonical path-lease declaration', async () => {
    const base = 'A'.repeat(40);
    const res = await harness().request('/api/tasks', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Scoped work',
        repo: 'app',
        plannedBaseRevision: base,
        affectedPaths: ['src/domain/**', './src/a.ts'],
        protectedPathsSnapshot: ['WORKFLOW.md', 'test/invariants/**', 'WORKFLOW.md'],
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Task;
    expect(created.plannedBaseRevision).toBe(base.toLowerCase());
    expect(created.affectedPaths).toEqual(['src/a.ts', 'src/domain/']);
    expect(created.protectedPathsSnapshot).toEqual(['WORKFLOW.md', 'test/invariants/**']);
  });

  it('atomically validates and round-trips an exact candidate lease', async () => {
    const base = 'A'.repeat(40);
    const tip = 'B'.repeat(40);
    const res = await harness().request('/api/tasks', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Exact candidate',
        repo: 'app',
        expectedBaseRevision: base,
        expectedRemoteTip: tip,
        plannedBaseRevision: base,
        affectedPaths: ['src/a.ts'],
        protectedPathsSnapshot: [],
      }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as Task;
    expect(created.expectedBaseRevision).toBe(base.toLowerCase());
    expect(created.expectedRemoteTip).toBe(tip.toLowerCase());
    expect(created.plannedBaseRevision).toBe(base.toLowerCase());
    expect(created.affectedPaths).toEqual(['src/a.ts']);
    expect(created.protectedPathsSnapshot).toEqual([]);
  });

  it('rejects partial, malformed, unscoped, or base-mismatched exact candidate leases', async () => {
    const base = 'a'.repeat(40);
    const tip = 'b'.repeat(40);
    const pathLease = {
      plannedBaseRevision: base,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [] as readonly string[],
    };
    for (const body of [
      { title: 'Partial base', repo: 'app', expectedBaseRevision: base },
      { title: 'Partial tip', repo: 'app', expectedRemoteTip: tip },
      {
        title: 'Malformed', repo: 'app', expectedBaseRevision: base,
        expectedRemoteTip: 'short', ...pathLease,
      },
      {
        title: 'Unscoped', repo: 'app', expectedBaseRevision: base,
        expectedRemoteTip: tip,
      },
      {
        title: 'Mismatched', repo: 'app', expectedBaseRevision: 'c'.repeat(40),
        expectedRemoteTip: tip, ...pathLease,
      },
    ]) {
      const res = await harness().request('/api/tasks', {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('rejects partial or unsafe path-lease declarations', async () => {
    for (const body of [
      {
        title: 'Partial', repo: 'app', plannedBaseRevision: 'a'.repeat(40),
        affectedPaths: ['src/a.ts'],
      },
      {
        title: 'Unsafe', repo: 'app', plannedBaseRevision: 'a'.repeat(40),
        affectedPaths: ['src/a.ts'], protectedPathsSnapshot: ['../secret'],
      },
    ]) {
      const res = await harness().request('/api/tasks', {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('404s on an unknown repo', async () => {
    const res = await harness().request('/api/tasks', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x', repo: 'ghost' }),
    });
    expect(res.status).toBe(404);
  });

  it('includes advisory acLint on 201 when body is a non-empty string', async () => {
    const taskBody = [
      '## Acceptance criteria',
      '- [ ] (mechanical) unbound claim',
      '- [ ] (human) look',
    ].join('\n');
    const res = await harness().request('/api/tasks', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Linted create', repo: 'app', body: taskBody }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Task & {
      acLint?: { ok: boolean; findings: { code: string }[]; counts: { error: number } };
    };
    expect(created.acLint).toBeDefined();
    expect(created.acLint?.ok).toBe(false);
    expect(created.acLint?.findings.some((f) => f.code === 'unbound-mechanical')).toBe(true);
    // Stored task body is untouched (no lint mutation).
    expect(created.body).toBe(taskBody);
  });

  it('returns planPendingReason.en/.zh on criteria-less create', async () => {
    const res = await harness().request('/api/tasks', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Vague API', repo: 'app', body: 'make it better' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as Task;
    expect(created.planPending).toBe(true);
    expect(created.planPendingReason?.en).toMatch(/acceptance criteria|Approve plan/i);
    expect(created.planPendingReason?.zh).toMatch(/验收|批准计划/);
  });

  it('returns 400 with paths + rule when body names a protected path', async () => {
    const port = new FakePort(new Map());
    port.reposConfig = {
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
    const workflow = [
      '---',
      'gates:',
      '  test: pnpm test',
      'protected_paths:',
      '  - core/tests/structural_guards.rs',
      '---',
      'body',
    ].join('\n');
    const actions = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => {
          throw new Error('unused');
        },
        preserve: async () => undefined,
        readWorkflow: async () => workflow,
      },
      verifier: { verify: async () => {
        throw new Error('unused');
      } } as never,
    });
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions,
      token: TOKEN,
    });
    const res = await app.request('/api/tasks', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Touch guard',
        repo: 'app',
        id: 'PROT-API',
        body:
          '## Task\nEdit `core/tests/structural_guards.rs`.\n\n' +
          '## Acceptance criteria\n- [ ] (mechanical) done\n',
        planPending: false,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: string;
      code?: string;
      paths?: string[];
      rule?: string;
    };
    expect(body.code).toBe('protected_path');
    expect(body.paths).toEqual(expect.arrayContaining(['core/tests/structural_guards.rs']));
    expect(body.rule).toMatch(/force:true/i);
    expect(port.tasks.has('PROT-API')).toBe(false);
  });
});

describe('POST /api/tasks/lint-acceptance', () => {
  it('returns an AcLintReport for a body string', async () => {
    const res = await harness().request('/api/tasks/lint-acceptance', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        body: [
          '## Acceptance criteria',
          '- [ ] (mechanical) gates green @gate:test',
          '- [ ] (human) ok',
        ].join('\n'),
      }),
    });
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      ok: boolean;
      findings: { code: string }[];
      counts: { error: number; warn: number; info: number };
    };
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual(
      expect.objectContaining({ error: 0 }),
    );
    expect(report.findings.some((f) => f.code === 'all-gate-bound')).toBe(true);
  });

  it('400s on invalid JSON or missing body string', async () => {
    const badJson = await harness().request('/api/tasks/lint-acceptance', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: '{',
    });
    expect(badJson.status).toBe(400);

    const missing = await harness().request('/api/tasks/lint-acceptance', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 12 }),
    });
    expect(missing.status).toBe(400);
  });
});

describe('POST /api/tasks/draft-from-intent', () => {
  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
  } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function appView(port: FakePort): RuntimeView {
    return {
      snapshot: { repos: port.reposConfig, tasks: [...port.tasks.values()], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
  }

  function analystApp(opts: {
    analyst?: {
      draft: (
        intent: string,
        repo: unknown,
        onActivity?: AnalystActivityListener,
      ) => Promise<AnalystDraft>;
    };
    draftJobs?: ReturnType<typeof createDraftJobs>;
  }): ReturnType<typeof createApi> {
    const port = new FakePort(new Map());
    port.reposConfig = {
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
    const view = appView(port);
    return createApi({
      runtime: {
        getState: () => view,
        subscribe: () => () => {},
        forceAbort: () => {},
      },
      actions: new ActionService(port, new FakeProbe([])),
      token: TOKEN,
      ...(opts.analyst ? { analyst: opts.analyst } : {}),
      ...(opts.draftJobs ? { draftJobs: opts.draftJobs } : {}),
    });
  }

  it('includes lint of the drafted body and heuristic source when no analyst', async () => {
    const res = await harness().request('/api/tasks/draft-from-intent', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: 'Fix flaky upload retry bug in the orchestrator drain path',
        repo: 'app',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draft: {
        body: string;
        source: string;
        notes: string[];
        repairRounds: number;
        questions: { slot: string; text: string }[];
        filled: string[];
        vague: boolean;
        warnings: string[];
        lint: { ok: boolean; findings: { code: string }[]; counts: { error: number } };
      };
      jobId: string | null;
    };
    expect(body.jobId).toBeNull();
    expect(body.draft.body).toMatch(/Definition of Done|Acceptance/i);
    expect(body.draft.source).toBe('heuristic');
    expect(body.draft.notes).toEqual([]);
    expect(body.draft.repairRounds).toBe(0);
    expect(body.draft.lint).toBeDefined();
    expect(body.draft.lint.ok).toBe(true);
    expect(body.draft.lint.counts.error).toBe(0);
    expect(Array.isArray(body.draft.questions)).toBe(true);
    expect(Array.isArray(body.draft.filled)).toBe(true);
    expect(body.draft.filled.some((f) => /已补验收标准/.test(f))).toBe(true);
    expect(body.draft.warnings.join('\n')).not.toMatch(/Intent looks vague/);
  });

  it('vague heuristic intent returns questions + filled DTO fields', async () => {
    const res = await harness().request('/api/tasks/draft-from-intent', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: '做一下', repo: 'app' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draft: {
        vague: boolean;
        questions: { slot: string; text: string; options?: string[] }[];
        filled: string[];
        warnings: string[];
      };
    };
    expect(body.draft.vague).toBe(true);
    expect(body.draft.questions.length).toBeGreaterThan(0);
    expect(body.draft.questions.every((q) => typeof q.text === 'string')).toBe(true);
    expect(body.draft.filled.length).toBeGreaterThan(0);
    expect(body.draft.warnings.join('\n')).not.toMatch(/Intent looks vague/);
  });

  it('404s for an unknown repo key', async () => {
    const res = await harness().request('/api/tasks/draft-from-intent', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        intent: 'Fix something in a repo that does not exist here',
        repo: 'missing-repo',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('returns heuristic draft + jobId immediately; analyst fills job in background', async () => {
    const d = deferred<AnalystDraft>();
    let thirdArg: unknown;
    const analystDraft: AnalystDraft = {
      title: 'From analyst',
      body: '## Acceptance criteria\n- [ ] (mechanical) x @gate:test\n- [ ] (human) ok',
      priority: 2,
      labels: ['needs-plan'],
      vague: false,
      warnings: [],
      questions: [],
      filled: [],
      source: 'analyst',
      lint: { ok: true, findings: [], counts: { error: 0, warn: 0, info: 0 } },
      notes: ['wired'],
      repairRounds: 0,
    };
    const api = analystApp({
      analyst: {
        draft: (_intent, _repo, onActivity) => {
          thirdArg = onActivity;
          return d.promise;
        },
      },
    });
    const resPromise = api.request('/api/tasks/draft-from-intent', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'Wire analyst into draft-from-intent endpoint', repo: 'app' }),
    });
    const res = await resPromise;
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draft: { source: string; title: string };
      jobId: string | null;
    };
    // Response arrived while analyst is still pending
    expect(d.promise).toBeInstanceOf(Promise);
    expect(body.draft.source).toBe('heuristic');
    expect(body.jobId).toMatch(/^dj-[0-9a-f]{12}$/);
    expect(typeof thirdArg).toBe('function');

    const pending = await api.request(`/api/draft-jobs/${body.jobId}`, auth);
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { job: { status: string } }).job.status).toBe('running');

    d.resolve(analystDraft);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const ready = await api.request(`/api/draft-jobs/${body.jobId}`, auth);
    expect(ready.status).toBe(200);
    const job = ((await ready.json()) as { job: { status: string; draft: { source: string; title: string } } }).job;
    expect(job.status).toBe('ready');
    expect(job.draft.source).toBe('analyst');
    expect(job.draft.title).toBe('From analyst');
  });

  it('without analyst: jobId null and heuristic draft', async () => {
    const res = await analystApp({}).request('/api/tasks/draft-from-intent', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'Fix the retry path in orchestrator drain', repo: 'app' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { draft: { source: string }; jobId: string | null };
    expect(body.jobId).toBeNull();
    expect(body.draft.source).toBe('heuristic');
  });

  it('analyst busy (maxRunning 0) → jobId null and busy warning', async () => {
    const draftJobs = createDraftJobs({ maxRunning: 0 });
    const api = analystApp({
      draftJobs,
      analyst: {
        draft: async () => ({
          title: 'unused',
          body: 'b',
          priority: 2,
          labels: [],
          vague: false,
          warnings: [],
          questions: [],
          filled: [],
          source: 'analyst',
          lint: { ok: true, findings: [], counts: { error: 0, warn: 0, info: 0 } },
          notes: [],
          repairRounds: 0,
        }),
      },
    });
    const res = await api.request('/api/tasks/draft-from-intent', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'Something while analyst is busy on another draft', repo: 'app' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      draft: { source: string; warnings: string[] };
      jobId: string | null;
    };
    expect(body.jobId).toBeNull();
    expect(body.draft.source).toBe('heuristic');
    expect(body.draft.warnings).toContain('analyst busy — heuristic draft only');
  });

  it('draft-jobs get/ack require auth; 404 unknown; ack then 404', async () => {
    const draftJobs = createDraftJobs();
    const d = deferred<AnalystDraft>();
    const started = draftJobs.start({
      repo: 'app',
      intent: 'seed',
      run: () => d.promise,
    })!;
    const api = analystApp({ draftJobs });

    expect((await api.request(`/api/draft-jobs/${started.id}`)).status).toBe(401);
    expect((await api.request(`/api/draft-jobs/${started.id}/ack`, { method: 'POST' })).status).toBe(401);

    const unknown = await api.request('/api/draft-jobs/dj-deadbeef0000', auth);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe('unknown draft job');

    const ack = await api.request(`/api/draft-jobs/${started.id}/ack`, {
      method: 'POST',
      ...auth,
    });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ ok: true });

    const again = await api.request(`/api/draft-jobs/${started.id}/ack`, {
      method: 'POST',
      ...auth,
    });
    expect(again.status).toBe(404);
    d.resolve({
      title: 'x',
      body: 'b',
      priority: 1,
      labels: [],
      vague: false,
      warnings: [],
      questions: [],
      filled: [],
      source: 'analyst',
      lint: { ok: true, findings: [], counts: { error: 0, warn: 0, info: 0 } },
      notes: [],
      repairRounds: 0,
    });
  });

  it('SSE streams draft frames for live jobs, ready, and removed', async () => {
    const draftJobs = createDraftJobs();
    const d = deferred<AnalystDraft>();
    const started = draftJobs.start({
      repo: 'app',
      intent: 'sse job',
      run: () => d.promise,
    })!;
    const api = analystApp({ draftJobs });

    const res = await api.request('/api/events', auth);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const readMore = async (): Promise<void> => {
      const { value, done } = await reader.read();
      if (done || !value) return;
      buf += decoder.decode(value, { stream: true });
    };

    const firstDeadline = Date.now() + 2_000;
    while ((!buf.includes('event: state') || !buf.includes('event: draft')) && Date.now() < firstDeadline) {
      await readMore();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(buf).toContain('event: state');
    expect(buf).toContain('event: draft');
    const draftMatch = buf.match(/event: draft\ndata: ({.*})\n/);
    expect(draftMatch).not.toBeNull();
    const first = JSON.parse(draftMatch![1]!) as { job: { id: string; status: string } };
    expect(first.job.id).toBe(started.id);

    d.resolve({
      title: 'SSE ready',
      body: '## Acceptance criteria\n- [ ] (mechanical) x @gate:test\n- [ ] (human) ok',
      priority: 2,
      labels: [],
      vague: false,
      warnings: [],
      questions: [],
      filled: [],
      source: 'analyst',
      lint: { ok: true, findings: [], counts: { error: 0, warn: 0, info: 0 } },
      notes: [],
      repairRounds: 0,
    });
    await Promise.resolve();
    await Promise.resolve();

    // Poll until ready frame arrives (pump is async)
    const deadline = Date.now() + 2_000;
    while (!buf.includes('"status":"ready"') && Date.now() < deadline) {
      await readMore();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(buf).toContain('"status":"ready"');

    const ackRes = await api.request(`/api/draft-jobs/${started.id}/ack`, {
      method: 'POST',
      ...auth,
    });
    expect(ackRes.status).toBe(200);

    const removeDeadline = Date.now() + 2_000;
    while (!buf.includes(`"removed":"${started.id}"`) && Date.now() < removeDeadline) {
      await readMore();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(buf).toContain(`"removed":"${started.id}"`);
    await reader.cancel();
  });
});

describe('POST /api/tasks/:id/steer', () => {
  it('steers a review task with a comment', async () => {
    const api = harness([{ ...task('A', 'review'), agentSession: 'sess-9' }]);
    const res = await api.request('/api/tasks/A/steer', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ comment: 'Detail loop 58' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Task;
    expect(body.state).toBe('todo');
    expect(body.pendingSteer).toBe('Detail loop 58');
    expect(body.agentSession).toBeNull();
  });

  it('400s when comment is missing', async () => {
    const res = await harness([task('A', 'review')]).request('/api/tasks/A/steer', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tasks/:id/pr and approve-pr', () => {
  const ghOk: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
    if (args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
    return {
      exitCode: 0,
      stdout: 'https://github.com/example-org/acme/pull/99\n',
      stderr: '',
    };
  };

  it('opens a PR for a review task', async () => {
    const api = harness([{ ...task('A', 'review'), body: 'changed files' }], ghOk);
    const res = await api.request('/api/tasks/A/pr', { method: 'POST', ...auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; mode: string };
    expect(body.mode).toBe('created');
    expect(body.url).toContain('/pull/99');
  });

  it('approve-pr marks done and returns the PR', async () => {
    const api = harness([{ ...task('A', 'review'), body: 'changed' }], ghOk);
    const res = await api.request('/api/tasks/A/approve-pr', { method: 'POST', ...auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: Task; pr: { url: string } };
    expect(body.task.state).toBe('done');
    expect(body.pr.url).toContain('/pull/99');
  });
});

describe('POST /api/tasks/:id/:action', () => {
  it('approves a task in review', async () => {
    const api = harness([task('A', 'review')]);
    const res = await api.request('/api/tasks/A/approve', { method: 'POST', ...auth });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task).state).toBe('done');
  });

  it('400s approve when human ACs are present but not acknowledged', async () => {
    const api = harness([
      {
        ...task('H', 'review'),
        body: `
## Definition of Done
- [ ] (human) Device check ok
`,
      },
    ]);
    const res = await api.request('/api/tasks/H/approve', { method: 'POST', ...auth });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/human acceptance|unchecked/i);
  });

  it('approves when humanAcknowledged covers every human AC', async () => {
    const api = harness([
      {
        ...task('H', 'review'),
        body: `
## Definition of Done
- [ ] (human) Device check ok
`,
      },
    ]);
    const res = await api.request('/api/tasks/H/approve', {
      method: 'POST',
      ...auth,
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ humanAcknowledged: ['Device check ok'] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Task).state).toBe('done');
  });

  it('400s on an illegal transition', async () => {
    const api = harness([task('A', 'todo')]);
    const res = await api.request('/api/tasks/A/approve', { method: 'POST', ...auth });
    expect(res.status).toBe(400);
  });

  it('404s on an unknown task', async () => {
    const res = await harness().request('/api/tasks/NOPE/cancel', { method: 'POST', ...auth });
    expect(res.status).toBe(404);
  });

  it('404s on an unknown action', async () => {
    const res = await harness([task('A', 'review')]).request('/api/tasks/A/frobnicate', {
      method: 'POST',
      ...auth,
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/tasks/:id/screenshots/:name', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hercules-api-shots-'));
    await mkdir(join(root, 'T-1'), { recursive: true });
    await writeFile(join(root, 'T-1', 'evidence-0.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, 'T-1', 'shot.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(join(root, 'T-1', 'tile.webp'), Buffer.from('RIFFWEBP'));
    await writeFile(
      join(root, 'T-1', 'cli-web-console-flow-clip.webm'),
      Buffer.from('0123456789abcdefghij'),
    );
    await writeFile(join(root, 'T-1', 'clip.mp4'), Buffer.from('ftypisommp4'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function api() {
    const port = new FakePort(new Map());
    return createApi({
      runtime: { getState: () => ({ snapshot: null, running: [], stopping: [], activity: {}, pendingChat: {},
      liveRuns: {}, lastReport: null, agents: { default: 'fake', available: ['fake'] } }), subscribe: () => () => {}, forceAbort: () => {} },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
      screenshotsRoot: root,
    });
  }

  it('serves an existing screenshot as image/png', async () => {
    const res = await api().request('/api/tasks/T-1/screenshots/evidence-0.png', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
  });

  it('serves jpeg/webp/webm/mp4 with correct content types', async () => {
    const cases: Array<[string, string]> = [
      ['shot.jpg', 'image/jpeg'],
      ['tile.webp', 'image/webp'],
      ['cli-web-console-flow-clip.webm', 'video/webm'],
      ['clip.mp4', 'video/mp4'],
    ];
    for (const [name, type] of cases) {
      const res = await api().request('/api/tasks/T-1/screenshots/' + name, auth);
      expect(res.status, name).toBe(200);
      expect(res.headers.get('content-type')).toContain(type);
    }
  });

  it('honours a single bytes range on a .webm with 206', async () => {
    const res = await api().request('/api/tasks/T-1/screenshots/cli-web-console-flow-clip.webm', {
      ...auth,
      headers: { ...auth.headers, range: 'bytes=2-8' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-type')).toContain('video/webm');
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(res.headers.get('content-range')).toBe('bytes 2-8/20');
    expect(Buffer.from(await res.arrayBuffer()).toString('utf8')).toBe('2345678');
  });

  it('treats bytes=-N as a suffix range and rejects unsatisfiable ranges with 416', async () => {
    const url = '/api/tasks/T-1/screenshots/cli-web-console-flow-clip.webm';
    const tail = await api().request(url, {
      ...auth,
      headers: { ...auth.headers, range: 'bytes=-5' },
    });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe('bytes 15-19/20');
    expect(Buffer.from(await tail.arrayBuffer()).toString('utf8')).toBe('fghij');
    for (const range of ['bytes=-', 'bytes=20-', 'bytes=5-3', 'bytes=-0']) {
      const bad = await api().request(url, {
        ...auth,
        headers: { ...auth.headers, range },
      });
      expect(bad.status, range).toBe(416);
      expect(bad.headers.get('content-range')).toBe('bytes */20');
    }
  });

  it('requires auth', async () => {
    const res = await api().request('/api/tasks/T-1/screenshots/evidence-0.png');
    expect(res.status).toBe(401);
  });

  it('404s an unknown screenshot', async () => {
    const res = await api().request('/api/tasks/T-1/screenshots/missing.png', auth);
    expect(res.status).toBe(404);
  });

  it('rejects a traversal/disallowed name', async () => {
    const res = await api().request('/api/tasks/T-1/screenshots/..%2f..%2fetc', auth);
    expect(res.status).toBe(404);
    const txt = await api().request('/api/tasks/T-1/screenshots/notes.txt', auth);
    expect(txt.status).toBe(404);
  });

  it('404s a file symlink that points outside the screenshots root (N1)', async () => {
    const outside = join(root, '..', 'outside-escape.mp4');
    await writeFile(outside, Buffer.from('escaped-bytes'));
    await symlink(outside, join(root, 'T-1', 'outside.mp4'));
    const res = await api().request('/api/tasks/T-1/screenshots/outside.mp4', auth);
    expect(res.status).toBe(404);
  });

  it('404s when the task directory itself is a symlink outside the root (N1)', async () => {
    const outsideTask = join(root, '..', 'outside-task-dir');
    await mkdir(outsideTask, { recursive: true });
    await writeFile(join(outsideTask, 'shot.png'), Buffer.from([0x89, 0x50]));
    await symlink(outsideTask, join(root, 'T2'));
    const res = await api().request('/api/tasks/T2/screenshots/shot.png', auth);
    expect(res.status).toBe(404);
  });

  it('caps a bytes=0- range of a 20 MiB file at 8 MiB with 206 (N2)', async () => {
    const size = 20 * 1024 * 1024;
    const big = Buffer.alloc(size, 0x61);
    await writeFile(join(root, 'T-1', 'big.webm'), big);
    const res = await api().request('/api/tasks/T-1/screenshots/big.webm', {
      ...auth,
      headers: { ...auth.headers, range: 'bytes=0-' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-8388607/20971520');
    expect(res.headers.get('content-length')).toBe(String(8 * 1024 * 1024));
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.byteLength).toBe(8 * 1024 * 1024);
  });

  it('serves a plain GET of a 20 MiB file complete with 200 (R11 B1)', async () => {
    const size = 20 * 1024 * 1024;
    await writeFile(join(root, 'T-1', 'whole.webm'), Buffer.alloc(size, 0x62));
    const res = await api().request('/api/tasks/T-1/screenshots/whole.webm', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(size));
    expect(res.headers.get('content-range')).toBeNull();
    expect(Buffer.from(await res.arrayBuffer()).byteLength).toBe(size);
  });

  it('refuses a plain GET above 64 MiB with 413 instead of a partial body (R11 B1)', async () => {
    const fh = await open(join(root, 'T-1', 'huge.mp4'), 'w');
    await fh.truncate(64 * 1024 * 1024 + 1);
    await fh.close();
    const res = await api().request('/api/tasks/T-1/screenshots/huge.mp4', auth);
    expect(res.status).toBe(413);
  });

  it('404s a FIFO in the task directory without blocking (R11 B3)', async () => {
    execFileSync('mkfifo', [join(root, 'T-1', 'pipe.png')]);
    const started = Date.now();
    const res = await api().request('/api/tasks/T-1/screenshots/pipe.png', auth);
    expect(res.status).toBe(404);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('DELETE /api/tasks/:id', () => {
  it('deletes a non-running task', async () => {
    const res = await harness([task('A', 'review')]).request('/api/tasks/A', { method: 'DELETE', ...auth });
    expect(res.status).toBe(200);
    expect((await res.json() as { deleted: string }).deleted).toBe('A');
  });
  it('400s a running task', async () => {
    const res = await harness([task('A', 'in_progress')]).request('/api/tasks/A', { method: 'DELETE', ...auth });
    expect(res.status).toBe(400);
  });
  it('404s an unknown task', async () => {
    const res = await harness().request('/api/tasks/nope', { method: 'DELETE', ...auth });
    expect(res.status).toBe(404);
  });
  it('requires auth', async () => {
    const res = await harness([task('A', 'review')]).request('/api/tasks/A', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/tasks/:id/force-abort', () => {
  it('calls runtime.forceAbort and returns 200 with aborting id', async () => {
    const calls: string[] = [];
    const port = new FakePort(new Map());
    const view: RuntimeView = { snapshot: { repos, tasks: [], problems: [] }, running: [], stopping: [], activity: {}, pendingChat: {},
      liveRuns: {}, lastReport: null, agents: { default: 'fake', available: ['fake'] } };
    const api = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: (id) => calls.push(id) },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
    });
    const res = await api.request('/api/tasks/A/force-abort', { method: 'POST', ...auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ aborting: 'A' });
    expect(calls).toEqual(['A']);
  });

  it('requires auth', async () => {
    const res = await harness([task('A')]).request('/api/tasks/A/force-abort', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('200 no-op for a non-running id (forceAbort is idempotent)', async () => {
    const res = await harness([task('A')]).request('/api/tasks/A/force-abort', { method: 'POST', ...auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ aborting: 'A' });
  });

  it('404s for an invalid identifier', async () => {
    const res = await harness().request('/api/tasks/../evil/force-abort', { method: 'POST', ...auth });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/tasks/:id/chat (Remote Control)', () => {
  it('steers from review', async () => {
    const t = task('R', 'review');
    const app = harness([{ ...t, agentSession: 'sess-1' }]);
    const res = await app.request('/api/tasks/R/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: 'What did you change?' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; task: Task };
    expect(body.mode).toBe('steer');
    expect(body.task.state).toBe('todo');
    expect(body.task.pendingSteer).toBe('What did you change?');
    expect(body.task.agentSession).toBeNull();
  });

  it('steers from failed with attempt reset', async () => {
    const t = { ...task('F', 'failed'), agentSession: 's', attempts: 3 };
    const app = harness([t]);
    const res = await app.request('/api/tasks/F/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: 'try again with X' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; task: Task };
    expect(body.mode).toBe('steer');
    expect(body.task.state).toBe('todo');
    expect(body.task.attempts).toBe(0);
  });

  it('queues while in_progress via runtime.queueTaskChat', async () => {
    const t = task('L', 'in_progress');
    const queued: string[] = [];
    const port = new FakePort(new Map([['L', t]]));
    port.reposConfig = {
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
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [t], problems: [] },
      running: ['L'],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: {
        getState: () => view,
        subscribe: () => () => {},
        forceAbort: () => {},
        queueTaskChat: (id, msg) => {
          queued.push(`${id}:${msg}`);
          return { mode: 'queued' as const, queued: [...queued] };
        },
      },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
    });
    const res = await app.request('/api/tasks/L/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ message: 'mid-run note' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; queued: string[] };
    expect(body.mode).toBe('queued');
    expect(queued).toEqual(['L:mid-run note']);
  });

  it('rejects malformed clientMessageId / idempotencyKey with 400', async () => {
    const t = task('L', 'in_progress');
    const port = new FakePort(new Map([['L', t]]));
    port.reposConfig = {
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
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [t], problems: [] },
      running: ['L'],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: {
        getState: () => view,
        subscribe: () => () => {},
        forceAbort: () => {},
        queueTaskChat: () => ({ mode: 'queued' as const, queued: [] }),
      },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    };
    const badId = await app.request('/api/tasks/L/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'hi', clientMessageId: '../nope' }),
    });
    expect(badId.status).toBe(400);
    expect(((await badId.json()) as { error: string }).error).toMatch(/clientMessageId/i);

    const badKey = await app.request('/api/tasks/L/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'hi', idempotencyKey: '' }),
    });
    expect(badKey.status).toBe(400);
  });

  it('same clientMessageId while todo returns mode=duplicate priorMode=pending', async () => {
    const app = harness([task('T', 'todo')]);
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    };
    const first = await app.request('/api/tasks/T/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: 'hold for next dispatch',
        clientMessageId: 'todo-idem-1',
      }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { mode: string }).mode).toBe('pending');

    const second = await app.request('/api/tasks/T/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: 'hold for next dispatch',
        clientMessageId: 'todo-idem-1',
      }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as {
      mode: string;
      priorMode?: string;
      reason?: string;
    };
    expect(body.mode).toBe('duplicate');
    expect(body.priorMode).toBe('pending');
    expect(body.reason).toMatch(/pending for next dispatch/i);

    // Deliberate new id with identical text must not be misclassified as pending dup.
    const third = await app.request('/api/tasks/T/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: 'hold for next dispatch',
        clientMessageId: 'todo-idem-2',
      }),
    });
    expect(third.status).toBe(200);
    expect(((await third.json()) as { mode: string }).mode).toBe('pending');
  });

  it('same clientMessageId while in_progress returns mode=duplicate', async () => {
    const t = task('L', 'in_progress');
    const port = new FakePort(new Map([['L', t]]));
    port.reposConfig = {
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
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [t], problems: [] },
      running: ['L'],
      stopping: [],
      activity: {},
      pendingChat: { L: ['mid-run note'] },
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    let calls = 0;
    const app = createApi({
      runtime: {
        getState: () => view,
        subscribe: () => () => {},
        forceAbort: () => {},
        queueTaskChat: (_id, _msg, opts) => {
          calls += 1;
          if (calls === 1) {
            return { mode: 'queued' as const, queued: ['mid-run note'] };
          }
          expect(opts?.clientMessageId).toBe('idem-1');
          return {
            mode: 'duplicate' as const,
            queued: ['mid-run note'],
            reason: 'client message id already in live queue',
            priorMode: 'queued',
          };
        },
      },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    };
    const first = await app.request('/api/tasks/L/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'mid-run note', clientMessageId: 'idem-1' }),
    });
    expect(first.status).toBe(200);
    expect(((await first.json()) as { mode: string }).mode).toBe('queued');

    const second = await app.request('/api/tasks/L/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ message: 'mid-run note', idempotencyKey: 'idem-1' }),
    });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { mode: string; reason?: string };
    expect(body.mode).toBe('duplicate');
    expect(body.reason).toMatch(/already/i);
  });
});

describe('GET /api/events (SSE)', () => {
  it('requires auth', async () => {
    const res = await harness().request('/api/events');
    expect(res.status).toBe(401);
  });

  it('streams an event-stream content type with an initial snapshot (Bearer header)', async () => {
    const res = await harness([task('A')]).request('/api/events', auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('data:');
    await reader.cancel();
  });
});

describe('repo routes', () => {
  it('POST /api/repos registers a repo', async () => {
    const app = harness();
    const res = await app.request('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ key: 'svc', url: '/srv/svc', defaultBranch: 'main' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json() as { key: string }).key).toBe('svc');
  });

  it('POST /api/repos surfaces a duplicate-key error', async () => {
    const app = harness();
    const res = await app.request('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ key: 'app', url: 'x', defaultBranch: 'main' }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/repos/:key edits a repo', async () => {
    const app = harness();
    const res = await app.request('/api/repos/app', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ maxConcurrent: 3, adapter: null, readiness: 'ready' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { maxConcurrent: number }).maxConcurrent).toBe(3);
  });

  it('preserves private owner checkouts on unrelated edit and redacts every repo payload', async () => {
    const privatePath = '/home/operator/Guardian';
    let configuredPort: FakePort | null = null;
    const app = harness([], undefined, (port) => {
      port.reposConfig = {
        repos: {
          ...port.reposConfig.repos,
          app: {
            ...port.reposConfig.repos['app']!,
            ownerCheckouts: [{ id: 'owner-main', path: privatePath }],
          },
        },
      };
      configuredPort = port;
    });
    const response = await app.request('/api/repos/app', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ maxConcurrent: 3 }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(privatePath);
    const state = await app.request('/api/state', auth);
    expect(await state.text()).not.toContain(privatePath);
    const events = await app.request('/api/events', auth);
    const reader = events.body!.getReader();
    const first = await reader.read();
    await reader.cancel();
    expect(new TextDecoder().decode(first.value)).not.toContain(privatePath);
    expect(configuredPort!.reposConfig.repos['app']?.ownerCheckouts).toEqual([
      { id: 'owner-main', path: privatePath },
    ]);
  });

  it('rejects owner checkout mutation instead of accepting unvalidated paths', async () => {
    const response = await harness().request('/api/repos/app', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ownerCheckouts: [{ id: 'owner-main', path: '/home/operator/app' }] }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('/home/operator/app');

    const create = await harness().request('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        key: 'private', url: '/srv/private', defaultBranch: 'main',
        owner_checkouts: [{ id: 'owner-main', path: '/home/operator/private' }],
      }),
    });
    expect(create.status).toBe(400);
    expect(await create.text()).not.toContain('/home/operator/private');
  });

  it('DELETE /api/repos/:key removes a repo', async () => {
    const app = harness();
    const res = await app.request('/api/repos/app', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ removed: 'app' });
  });

  it('DELETE /api/repos/:key rejects an unsafe key with 404', async () => {
    const app = harness();
    const res = await app.request('/api/repos/..%2Fevil', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('PATCH /api/repos/:key 404s for a valid-but-nonexistent key', async () => {
    const app = harness();
    const res = await app.request('/api/repos/nonexistent', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ maxConcurrent: 2, adapter: null, readiness: 'ready' }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/repos/:key 404s for a valid-but-nonexistent key', async () => {
    const app = harness();
    const res = await app.request('/api/repos/nonexistent', {
      method: 'DELETE',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('POST /api/repos requires auth', async () => {
    const res = await harness().request('/api/repos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'svc', url: '/srv/svc', defaultBranch: 'main' }),
    });
    expect(res.status).toBe(401);
  });

  it('PATCH /api/repos/:key requires auth', async () => {
    const res = await harness().request('/api/repos/app', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrent: 2, adapter: null, readiness: 'ready' }),
    });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/repos/:key requires auth', async () => {
    const res = await harness().request('/api/repos/app', { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('GET /api/repos/:key/readiness-check is idle before any POST', async () => {
    const app = harness();
    const res = await app.request('/api/repos/app/readiness-check', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: 'app', status: 'idle' });
  });

  it('POST /api/repos/:key/readiness-check starts → running (dedupe) → done with result', async () => {
    const port = new FakePort(new Map());
    port.reposConfig = {
      repos: {
        app: {
          key: 'app',
          url: 'https://github.com/example-org/acme.git',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'incomplete',
        },
      },
    };
    let releaseCheck: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseCheck = resolve;
    });
    const actions = new ActionService(
      port,
      new FakeProbe(['main']),
      undefined,
      undefined,
      undefined,
      {
        workspaces: {
          async readWorkflow() {
            await gate;
            return null;
          },
          async readTrustedFile() {
            await gate;
            return null;
          },
        },
      },
    );
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions,
      token: TOKEN,
    });
    const auth = { authorization: `Bearer ${TOKEN}` };

    const idle = await app.request('/api/repos/app/readiness-check', { headers: auth });
    expect(idle.status).toBe(200);
    expect((await idle.json() as { status: string }).status).toBe('idle');

    const start = await app.request('/api/repos/app/readiness-check', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(202);
    const started = (await start.json()) as {
      key: string;
      status: string;
      startedAt: string;
    };
    expect(started).toMatchObject({ key: 'app', status: 'running' });
    expect(typeof started.startedAt).toBe('string');

    const again = await app.request('/api/repos/app/readiness-check', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ retryCliEvidence: true }),
    });
    expect(again.status).toBe(202);
    const deduped = (await again.json()) as { startedAt: string; status: string };
    expect(deduped.status).toBe('running');
    expect(deduped.startedAt).toBe(started.startedAt);
    (releaseCheck as (() => void) | null)?.();

    type JobPoll = {
      key: string;
      status: string;
      startedAt?: string;
      finishedAt?: string;
      result?: {
        ok: boolean;
        summary: string;
        score: {
          passed: number;
          total: number;
          requiredPassed: number;
          requiredTotal: number;
        };
        checks: readonly {
          id: string;
          ok: boolean;
          label: string;
          detail: string;
          required: boolean;
        }[];
        readiness?: string;
      };
      error?: string;
    };
    let body: JobPoll | null = null;
    for (let i = 0; i < 50; i += 1) {
      const poll = await app.request('/api/repos/app/readiness-check', { headers: auth });
      expect(poll.status).toBe(200);
      body = (await poll.json()) as JobPoll;
      if (body.status === 'done' || body.status === 'error') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(body).not.toBeNull();
    const done = body as JobPoll;
    expect(done.status).toBe('done');
    expect(done.result).toMatchObject({
      ok: expect.any(Boolean),
      summary: expect.any(String),
      score: {
        passed: expect.any(Number),
        total: expect.any(Number),
        requiredPassed: expect.any(Number),
        requiredTotal: expect.any(Number),
      },
    });
    expect(done.result!.score.total).toBeGreaterThanOrEqual(5);
    expect(Array.isArray(done.result!.checks)).toBe(true);
    expect(done.result!.checks.length).toBe(done.result!.score.total);
    for (const c of done.result!.checks) {
      expect(c).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          ok: expect.any(Boolean),
          label: expect.any(String),
          detail: expect.any(String),
          required: expect.any(Boolean),
        }),
      );
    }
    const ids = done.result!.checks.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'workflow-present',
        'workflow-parse',
        'workflow-gates',
        'workflow-boot',
        'agents-map',
        'agents-budget',
      ]),
    );
    expect(done.result).not.toHaveProperty('readiness');
    expect(typeof done.finishedAt).toBe('string');
  });

  it('POST/GET readiness-check 404s unknown repo and requires auth', async () => {
    const app = harness();
    const missingGet = await app.request('/api/repos/ghost/readiness-check', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missingGet.status).toBe(404);

    const missingPost = await app.request('/api/repos/ghost/readiness-check', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(missingPost.status).toBe(404);

    const unauthGet = await harness().request('/api/repos/app/readiness-check');
    expect(unauthGet.status).toBe(401);
    const unauthPost = await harness().request('/api/repos/app/readiness-check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(unauthPost.status).toBe(401);
  });

  it('readiness-check job captures thrown errors as status:error (not 500)', async () => {
    const port = new FakePort(new Map());
    port.reposConfig = {
      repos: {
        app: {
          key: 'app',
          url: 'https://github.com/example-org/acme.git',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'incomplete',
        },
      },
    };
    const actions = new ActionService(
      port,
      new FakeProbe(['main']),
      undefined,
      undefined,
      undefined,
      {
        workspaces: {
          async readWorkflow() {
            throw new Error('mirror boom ' + 'x'.repeat(400));
          },
        },
      },
    );
    // Force checkRepoReadiness to throw after job start by stubbing the method.
    const original = actions.checkRepoReadiness.bind(actions);
    actions.checkRepoReadiness = async () => {
      void original;
      throw new Error('mirror boom ' + 'x'.repeat(400));
    };
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions,
      token: TOKEN,
    });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const start = await app.request('/api/repos/app/readiness-check', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(202);

    type ErrPoll = { status: string; error?: string };
    let body: ErrPoll | null = null;
    for (let i = 0; i < 50; i += 1) {
      const poll = await app.request('/api/repos/app/readiness-check', { headers: auth });
      expect(poll.status).toBe(200);
      body = (await poll.json()) as ErrPoll;
      if (body.status === 'error') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(body).not.toBeNull();
    const errBody = body as ErrPoll;
    expect(errBody.status).toBe('error');
    expect(typeof errBody.error).toBe('string');
    expect(errBody.error!.length).toBeLessThanOrEqual(300);
    expect(errBody.error!.startsWith('mirror boom')).toBe(true);
  });

  it('POST then GET readiness-check surfaces mirror probe facts when wired', async () => {
    const port = new FakePort(new Map());
    port.reposConfig = {
      repos: {
        app: {
          key: 'app',
          url: 'https://github.com/example-org/acme.git',
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'incomplete',
        },
      },
    };
    const goodWf = `---
setup:
  install: [pnpm i]
  boot: [pnpm start]
behavioral:
  base_url: http://localhost:{port}
  capture: [screenshot]
gates:
  test: pnpm test
---
# policy
`;
    const goodAgents = `# Agent map\n\nRead WORKFLOW.md. Layout under src/.\n`;
    const actions = new ActionService(
      port,
      new FakeProbe(['main']),
      undefined,
      undefined,
      undefined,
      {
        workspaces: {
          async readWorkflow() {
            return goodWf;
          },
          async readTrustedFile(_repo, path) {
            return path === 'AGENTS.md' ? goodAgents : null;
          },
        },
      },
    );
    const view: RuntimeView = {
      snapshot: { repos: port.reposConfig, tasks: [], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions,
      token: TOKEN,
    });
    const auth = { authorization: `Bearer ${TOKEN}` };
    const start = await app.request('/api/repos/app/readiness-check', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(202);

    type MirrorPoll = {
      status: string;
      result?: {
        ok: boolean;
        score: { passed: number; total: number };
        checks: readonly { id: string; ok: boolean; required: boolean }[];
      };
    };
    let body: MirrorPoll | null = null;
    for (let i = 0; i < 50; i += 1) {
      const poll = await app.request('/api/repos/app/readiness-check', { headers: auth });
      expect(poll.status).toBe(200);
      body = (await poll.json()) as MirrorPoll;
      if (body.status === 'done' || body.status === 'error') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(body).not.toBeNull();
    const mirror = body as MirrorPoll;
    expect(mirror.status).toBe('done');
    expect(mirror.result!.ok).toBe(true);
    expect(mirror.result!.score.passed).toBe(mirror.result!.score.total);
    expect(mirror.result!.checks.find((c) => c.id === 'workflow-gates')?.ok).toBe(true);
    expect(mirror.result!.checks.find((c) => c.id === 'workflow-boot')?.ok).toBe(true);
    // Human still owns readiness: repo remains incomplete in control plane.
    expect(port.reposConfig.repos['app']!.readiness).toBe('incomplete');
  });
});

describe('POST /api/system/update (self-update)', () => {
  function updateHarness(selfUpdate?: import('../../src/server/selfUpdate.js').SelfUpdateService) {
    const port = new FakePort(new Map());
    const view: RuntimeView = {
      snapshot: { repos, tasks: [], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    return createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
      ...(selfUpdate ? { selfUpdate } : {}),
    });
  }

  it('404s when self-update is not wired', async () => {
    const res = await updateHarness().request('/api/system/update', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(404);
  });

  it('requires confirm:true', async () => {
    const { SelfUpdateService } = await import('../../src/server/selfUpdate.js');
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      runner: { async run() { return { code: 0, stdout: '', stderr: '' }; } },
      restarter: { async restart() {} },
    });
    const res = await updateHarness(svc).request('/api/system/update', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/confirm/i);
  });

  it('rejects confirm string/truthy non-boolean (strict confirm gate)', async () => {
    const { SelfUpdateService } = await import('../../src/server/selfUpdate.js');
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      runner: { async run() { return { code: 0, stdout: '', stderr: '' }; } },
      restarter: { async restart() {} },
    });
    for (const confirm of ['true', 1, 'yes'] as const) {
      const res = await updateHarness(svc).request('/api/system/update', {
        method: 'POST',
        headers: { ...auth.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ confirm }),
      });
      expect(res.status, `confirm=${JSON.stringify(confirm)}`).toBe(400);
    }
    expect(svc.status().phase).toBe('idle');
  });

  it('returns 202 and starts the pipeline when confirmed', async () => {
    const { SelfUpdateService } = await import('../../src/server/selfUpdate.js');
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      runner: { async run() { return { code: 0, stdout: '', stderr: '' }; } },
      restarter: { async restart() {} },
    });
    const res = await updateHarness(svc).request('/api/system/update', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { phase: string };
    expect(body.phase).toBe('running');
    await svc.waitForIdle();
  });

  it('GET returns status', async () => {
    const { SelfUpdateService } = await import('../../src/server/selfUpdate.js');
    const svc = new SelfUpdateService({
      repoRoot: '/repo',
      enabled: false,
      runner: { async run() { return { code: 0, stdout: '', stderr: '' }; } },
      restarter: { async restart() {} },
    });
    const res = await updateHarness(svc).request('/api/system/update', auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { phase: string; enabled: boolean };
    expect(body.phase).toBe('idle');
    expect(body.enabled).toBe(false);
  });

  it('requires auth', async () => {
    const res = await updateHarness().request('/api/system/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/system/worktree-gc', () => {
  it('returns a dry-run digest and never deletes control tasks', async () => {
    const port = new FakePort(
      new Map([
        [
          'old',
          {
            id: 'old',
            title: 'old',
            repo: 'app',
            state: 'failed' as const,
            priority: 100,
            blockedBy: [],
            labels: [],
            adapter: null,
            agentSession: null,
            pendingSteer: null,
            attempts: 1,
            lastEventAt: null,
            createdAt: null,
            startedAt: null,
            endedAt: '2000-01-01T00:00:00.000Z',
            prUrl: null,
            prStatus: null,
            planPending: false,
            body: '',
          },
        ],
      ]),
    );
    const view: RuntimeView = {
      snapshot: { repos, tasks: [...port.tasks.values()], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions: new ActionService(port, new FakeProbe(['main']), undefined, {
        worktreeGcRetentionMs: 7 * 86_400_000,
        worktreeGcDryRun: true,
      }),
      token: TOKEN,
    });
    const res = await app.request('/api/system/worktree-gc', {
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dryRun?: boolean;
      logLine?: string;
      disabled?: boolean;
    };
    expect(body.logLine).toMatch(/worktree-gc/);
    // Control-repo task file still present.
    expect(port.tasks.has('old')).toBe(true);
  });

  it('requires auth', async () => {
    const port = new FakePort(new Map());
    const view: RuntimeView = {
      snapshot: { repos, tasks: [], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
    });
    const res = await app.request('/api/system/worktree-gc', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('staging handoff routes (auto-unlock, 2026-07-17)', () => {
  async function handoffHarness(opts: { mintFile?: string; redeemFile?: string }) {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'handoff-api-'));
    const file = join(dir, 'code.json');
    const port = new FakePort(new Map());
    const view: RuntimeView = {
      snapshot: { repos: { repos: {} }, tasks: [], problems: [] },
      running: [],
      stopping: [],
      activity: {},
      pendingChat: {},
      liveRuns: {},
      lastReport: null,
      agents: { default: 'fake', available: ['fake'] },
    };
    const app = createApi({
      runtime: { getState: () => view, subscribe: () => () => {}, forceAbort: () => {} },
      actions: new ActionService(port, new FakeProbe(['main'])),
      token: TOKEN,
      stagingHandoff: {
        ...(opts.mintFile !== undefined ? { mintFile: file } : {}),
        ...(opts.redeemFile !== undefined ? { redeemFile: file } : {}),
      },
    });
    return { app, file };
  }

  it('mint requires auth and returns a one-time code', async () => {
    const { app } = await handoffHarness({ mintFile: 'x' });
    const noAuth = await app.request('/api/staging-handoff/mint', { method: 'POST' });
    expect(noAuth.status).toBe(401);
    const res = await app.request('/api/staging-handoff/mint', { method: 'POST', ...auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string };
    expect(body.code).toMatch(/^[a-f0-9]{64}$/);
  });

  it('mint is absent when not configured', async () => {
    const { app } = await handoffHarness({});
    const res = await app.request('/api/staging-handoff/mint', { method: 'POST', ...auth });
    expect(res.status).toBe(404);
  });

  it('redeem is unauthenticated, single-use, and returns the daemon token', async () => {
    const { app } = await handoffHarness({ mintFile: 'x', redeemFile: 'x' });
    const mint = await app.request('/api/staging-handoff/mint', { method: 'POST', ...auth });
    const { code } = (await mint.json()) as { code: string };
    const redeem = await app.request('/api/staging-handoff/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(redeem.status).toBe(200);
    expect(((await redeem.json()) as { token: string }).token).toBe(TOKEN);
    // Replay fails.
    const again = await app.request('/api/staging-handoff/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(again.status).toBe(403);
  });

  it('redeem is absent on a mint-only (production) daemon', async () => {
    const { app } = await handoffHarness({ mintFile: 'x' });
    const res = await app.request('/api/staging-handoff/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'a'.repeat(64) }),
    });
    expect(res.status).toBe(404);
  });

  it('redeem rejects malformed codes without touching the file', async () => {
    const { app } = await handoffHarness({ redeemFile: 'x' });
    const res = await app.request('/api/staging-handoff/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '../../etc/passwd' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/repos/:key/succession', () => {
  it('requires authentication and returns only redacted non-destructive facts', async () => {
    const app = harness([], undefined, (port) => {
      port.succession = {
        version: 2,
        repoKey: 'app',
        receipts: [{
          id: `succ-app-${'3'.repeat(40)}`,
          repoKey: 'app',
          createdAt: '2026-08-04T12:00:00.000Z',
          priorDefaultRevision: '1'.repeat(40),
          gateMergeSha: '3'.repeat(40),
          canonicalDefaultRevision: '3'.repeat(40),
          candidates: [{ taskId: 'task-1', verifiedSha: '2'.repeat(40), lease: {
            branch: 'hercules/task-1',
            expectedBaseRevision: '1'.repeat(40),
            expectedRemoteTip: '2'.repeat(40),
          } }],
          managed: [{ taskId: 'task-1', disposition: 'preserved' }],
          external: [{
            registrationId: 'owner-main',
            classification: 'clean-behind',
            headSha: '1'.repeat(40),
            dirty: false,
            ahead: 0,
            behind: 1,
            concurrentChange: false,
            guidance: [{ code: 'fast_forward_optional', text: 'Fast-forward manually if wanted.', destructive: false }],
          }],
          supersedesReceiptId: null,
        }],
      };
    });
    expect((await app.request('/api/repos/app/succession')).status).toBe(401);
    const response = await app.request('/api/repos/app/succession', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('canonicalDefaultRevision');
    expect(text).toContain('clean-behind');
    expect(text).toContain('fast_forward_optional');
    expect(text).not.toContain('/home/');
    expect(text).not.toContain('/srv/');
    expect(text).not.toContain('headSha');
    expect(text).toContain('"offersDestructiveAction":false');
  });
});
