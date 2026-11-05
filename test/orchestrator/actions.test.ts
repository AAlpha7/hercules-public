import { describe, it, expect } from 'vitest';
import { ActionService, ActionError } from '../../src/orchestrator/actions.js';
import { staticMergeBlockReason } from '../../src/domain/release.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task, TaskState } from '../../src/domain/task.js';
import type { RepoConfig, ReposConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { RepoProbeError } from '../../src/orchestrator/repoProbe.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskPathLeaseStore } from '../../src/isolation/taskPathLeaseStore.js';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';
import { WorktreeVerifier } from '../../src/orchestrator/verifier.js';
import { simpleGit } from 'simple-git';

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
    lastEventAt: null, createdAt: null, startedAt: null, endedAt: null,
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
      app: { key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' },
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
        ...current, blockedBy: change.blockedBy, dependencyMode: change.dependencyMode,
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

function svc(
  tasks: Task[] = [],
  probe: RepoProbe = new FakeProbe(['main']),
  gh?: import('../../src/orchestrator/openPr.js').GhRunner,
): { service: ActionService; port: FakePort } {
  const port = new FakePort(new Map(tasks.map((t) => [t.id, t])));
  // Point the fake repo at a GitHub URL so openPr can parse it.
  port.repos = {
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
  return { service: new ActionService(port, probe, gh), port };
}

function ghPr(
  taskId: string,
  number: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    url: `https://github.com/example-org/acme/pull/${number}`,
    baseRefName: 'main',
    headRefName: `hercules/${taskId}`,
    ...over,
  };
}

describe('ActionService.approveHostOperation', () => {
  it('records bounded command scope + approval timestamp for host_operation', async () => {
    const bare = {
      ...task('HOST-1', 'todo'),
      executionClass: 'host_operation' as const,
      body: '## Goal\nrestart unit\n',
    };
    const { service, port } = svc([bare]);
    const next = await service.approveHostOperation('HOST-1', {
      commandScope: ['systemctl restart hercules', 'curl -sf http://localhost:8787/'],
    });
    expect(next.hostCommandScope).toEqual([
      'systemctl restart hercules',
      'curl -sf http://localhost:8787/',
    ]);
    expect(next.hostApprovedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(next.body).toContain('## Host operation approval');
    expect(next.body).toContain('systemctl restart hercules');
    expect(port.commits.at(-1)).toMatch(/approve host operation HOST-1/);
  });

  it('rejects coding classes and empty scopes', async () => {
    const code = { ...task('CODE-1', 'todo'), executionClass: 'implement' as const };
    const { service } = svc([code]);
    await expect(
      service.approveHostOperation('CODE-1', { commandScope: ['systemctl restart x'] }),
    ).rejects.toBeInstanceOf(ActionError);

    const host = {
      ...task('HOST-2', 'todo'),
      executionClass: 'deploy' as const,
    };
    const { service: s2 } = svc([host]);
    await expect(s2.approveHostOperation('HOST-2', { commandScope: [] })).rejects.toThrow(
      /command scope/,
    );
  });

  it('is idempotent when re-approving the same scope', async () => {
    const approved = {
      ...task('HOST-3', 'todo'),
      executionClass: 'host_operation' as const,
      hostCommandScope: ['systemctl restart hercules'],
      hostApprovedAt: '2026-07-31T00:00:00.000Z',
      body: '## Goal\nx\n',
    };
    const { service, port } = svc([approved]);
    const next = await service.approveHostOperation('HOST-3', {
      commandScope: ['systemctl restart hercules'],
    });
    expect(next.hostApprovedAt).toBe('2026-07-31T00:00:00.000Z');
    expect(port.commits).toHaveLength(0);
  });

  it('requires a fresh approval stamp to replay the same scope after failure', async () => {
    const failed = {
      ...task('HOST-4', 'failed'),
      executionClass: 'host_operation' as const,
      hostCommandScope: ['systemctl restart hercules'],
      hostApprovedAt: '2000-01-01T00:00:00.000Z',
      body: '## Goal\nx\n',
    };
    const { service, port } = svc([failed]);
    const next = await service.approveHostOperation('HOST-4', {
      commandScope: ['systemctl restart hercules'],
    });
    expect(next.state).toBe('todo');
    expect(next.hostApprovedAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(port.commits.at(-1)).toMatch(/approve host operation HOST-4/);
  });
});

describe('ActionService.createTask execution_class', () => {
  it('defaults to implement and accepts host_operation without auto-approval', async () => {
    const { service } = svc();
    const ordinary = await service.createTask({
      title: 'Fix bug',
      repo: 'app',
      id: 'FIX-1',
      body: '## Acceptance criteria\n- [ ] (mechanical) tests pass\n',
      planPending: false,
    });
    expect(ordinary.executionClass).toBe('implement');
    expect(ordinary.hostCommandScope ?? null).toBeNull();

    const host = await service.createTask({
      title: 'Restart',
      repo: 'app',
      id: 'HOST-C',
      executionClass: 'host_operation',
      body: '## Acceptance criteria\n- [ ] (human) unit healthy\n',
      planPending: false,
    });
    expect(host.executionClass).toBe('host_operation');
    expect(host.hostApprovedAt ?? null).toBeNull();
  });
});

describe('ActionService.createTask verify-from-ref (C3.43)', () => {
  const sha = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  function verifyService(resolve: (ref: string) => Promise<string>) {
    const port = new FakePort(new Map());
    port.repos = {
      repos: {
        app: {
          key: 'app', url: 'https://github.com/example-org/acme.git', defaultBranch: 'main',
          workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready',
        },
      },
    };
    const refs: string[] = [];
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => { throw new Error('create not used during createTask'); },
        preserve: async () => undefined,
        resolveOriginRef: async (_repo, ref) => { refs.push(ref); return resolve(ref); },
      },
      verifier: { verify: async () => { throw new Error('no verify'); } } as never,
    });
    return { service, port, refs };
  }

  it('resolves the ref on origin before the control write and stamps seedFromSha with execution_class verify', async () => {
    const { service, port, refs } = verifyService(async () => sha.toUpperCase());
    const created = await service.createTask({
      title: 'Verify console affordance v2 fixed tip',
      repo: 'app',
      id: 'VER-1',
      executionClass: 'verify',
      seedFromRef: 'grok-cto/console-affordance-v2-fixed',
      body: '## Acceptance criteria\n- [ ] (mechanical) tests pass\n',
      planPending: false,
    });
    expect(refs).toEqual(['grok-cto/console-affordance-v2-fixed']);
    expect(created.executionClass).toBe('verify');
    expect(created.seedFromSha).toBe(sha);
    expect(port.tasks.get('VER-1')?.seedFromSha).toBe(sha);
    // Ordinary tasks never carry the key (task-file hash stability).
    const plain = await service.createTask({
      title: 'Plain', repo: 'app', id: 'PLAIN-1',
      body: '## Acceptance criteria\n- [ ] (mechanical) tests pass\n', planPending: false,
    });
    expect('seedFromSha' in plain).toBe(false);
  });

  it('refuses seedFromRef without execution_class verify, with an exact-candidate lease, or when the ref is unknown', async () => {
    const { service, port } = verifyService(async (ref) => {
      if (ref === 'missing') throw new Error("branch 'missing' does not exist on origin");
      return sha;
    });
    await expect(service.createTask({
      title: 'x', repo: 'app', id: 'VER-2', seedFromRef: 'grok-cto/x', planPending: false,
    })).rejects.toThrow(/requires execution_class 'verify'/);
    await expect(service.createTask({
      title: 'x', repo: 'app', id: 'VER-3', executionClass: 'verify', seedFromRef: 'missing', planPending: false,
    })).rejects.toThrow(/does not exist on origin/);
    await expect(service.createTask({
      title: 'x', repo: 'app', id: 'VER-4', executionClass: 'verify', seedFromRef: '   ', planPending: false,
    })).rejects.toThrow(/seedFromRef must be/);
    // A dependency forces gate_merge (start exactly at main) — a seeded branch
    // can never satisfy it, so it is refused here instead of burning attempts.
    await expect(service.createTask({
      title: 'x', repo: 'app', id: 'VER-5', executionClass: 'verify', seedFromRef: 'grok-cto/x',
      blockedBy: ['OTHER-1'], planPending: false,
    })).rejects.toThrow(/cannot be combined with blockedBy/);
    expect(port.tasks.size).toBe(0);
  });
});

describe('ActionService.approvePlan', () => {
  it('clears planPending and needs-plan label', async () => {
    const draft = {
      ...task('PLAN-1', 'todo'),
      planPending: true,
      labels: ['needs-plan', 'ui'],
    };
    const { service, port } = svc([draft]);
    const next = await service.approvePlan('PLAN-1');
    expect(next.planPending).toBe(false);
    expect(next.labels).toEqual(['ui']);
    expect(next.state).toBe('todo');
    expect(next.lastEventAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(port.tasks.get('PLAN-1')!.planPending).toBe(false);
    expect(port.commits.at(-1)).toMatch(/approve plan PLAN-1/);
  });

  it('is idempotent when already approved (multi-tap safe)', async () => {
    const ready = { ...task('PLAN-2', 'todo'), planPending: false };
    const { service, port } = svc([ready]);
    const next = await service.approvePlan('PLAN-2');
    expect(next.planPending).toBe(false);
    expect(next.id).toBe('PLAN-2');
    // No spurious second commit.
    expect(port.commits).toHaveLength(0);
  });

  it('is idempotent while already in_progress after approve', async () => {
    const running = { ...task('PLAN-3', 'in_progress'), planPending: false };
    const { service } = svc([running]);
    const next = await service.approvePlan('PLAN-3');
    expect(next.state).toBe('in_progress');
    expect(next.planPending).toBe(false);
  });
});

describe('ActionService.createTask', () => {
  it('creates a todo task and commits it', async () => {
    const { service, port } = svc();
    const created = await service.createTask({ title: 'Add login', repo: 'app', id: 'AUTH-1' });
    expect(created.id).toBe('AUTH-1');
    expect(created.state).toBe('todo');
    expect(port.tasks.get('AUTH-1')!.title).toBe('Add login');
    expect(port.commits[0]).toMatch(/AUTH-1/);
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp set
    expect(created.startedAt).toBeNull();
    expect(created.endedAt).toBeNull();
  });

  it('plan-gates a criteria-less task (SPEC §9.4 — server-side, not just the UI heuristic)', async () => {
    const { service } = svc();
    const created = await service.createTask({ title: 'Vague thing', repo: 'app', body: 'make it better' });
    expect(created.planPending).toBe(true);
    expect(created.labels).toContain('needs-plan');
    expect(created.body).toMatch(/Acceptance criteria|Approve plan/i);
    expect(created.planPendingReason?.en).toMatch(/acceptance criteria|Approve plan/i);
    expect(created.planPendingReason?.zh).toMatch(/验收|批准计划/);
  });

  it('does not plan-gate a task that carries checkable acceptance criteria', async () => {
    const { service } = svc();
    const created = await service.createTask({
      title: 'Crisp fix',
      repo: 'app',
      body: '## Task\nfix retry\n\n## Acceptance criteria\n- [ ] (mechanical) `pnpm test` green\n',
    });
    expect(created.planPending).toBe(false);
    expect(created.labels).not.toContain('needs-plan');
  });

  it('explicit planPending:false is a deliberate override — no auto-gate', async () => {
    const { service } = svc();
    const created = await service.createTask({
      title: 'Ops quickie', repo: 'app', body: 'restart the thing', planPending: false,
    });
    expect(created.planPending).toBe(false);
  });

  it('auto-generates a safe id from the title when none is given', async () => {
    const { service, port } = svc();
    const created = await service.createTask({ title: 'Fix the Upload!', repo: 'app' });
    expect(created.id).toBe('1-fix-the-upload');
    expect(port.tasks.has('1-fix-the-upload')).toBe(true);
  });

  it('disambiguates a generated id that collides', async () => {
    const { service } = svc([task('1-fix-bug')]);
    const created = await service.createTask({ title: 'Fix bug', repo: 'app' });
    expect(created.id).toBe('2-fix-bug');
  });

  it('numbers a generated id one past the highest existing numeric prefix', async () => {
    const { service } = svc([task('fix-old'), task('7-a'), task('12-b')]);
    const created = await service.createTask({ title: 'Ship it', repo: 'app' });
    expect(created.id).toBe('13-ship-it');
  });

  it('uses the bare number when the title has no ASCII words and no slug', async () => {
    const { service } = svc();
    const first = await service.createTask({
      title: '任务列表按最后活跃时间排序',
      repo: 'app',
    });
    expect(first.id).toBe('1');
    const second = await service.createTask({
      title: '任务列表按最后活跃时间排序',
      repo: 'app',
    });
    expect(second.id).toBe('2');
  });

  it('uses the caller-supplied slug for the generated id', async () => {
    const { service } = svc();
    const created = await service.createTask({
      title: '任务列表按最后活跃时间排序',
      repo: 'app',
      slug: 'sort-task-list',
    });
    expect(created.id).toBe('1-sort-task-list');
    const explicit = await service.createTask({
      title: '任务列表按最后活跃时间排序',
      repo: 'app',
      id: 'X-1',
      slug: 'sort-task-list',
    });
    expect(explicit.id).toBe('X-1');
  });

  it('rejects an invalid slug before touching the control repo', async () => {
    const { service, port } = svc();
    await expect(
      service.createTask({ title: 'x', repo: 'app', slug: 'Bad Slug' }),
    ).rejects.toThrow(/invalid task slug/);
    expect(port.tasks.size).toBe(0);
    expect(port.commits).toHaveLength(0);
  });

  it('rejects an unknown repo', async () => {
    const { service } = svc();
    await expect(service.createTask({ title: 'x', repo: 'ghost' })).rejects.toThrow(ActionError);
  });

  it('rejects a duplicate explicit id', async () => {
    const { service } = svc([task('DUP')]);
    await expect(
      service.createTask({ title: 'x', repo: 'app', id: 'DUP' }),
    ).rejects.toThrow(ActionError);
  });

  it('stores a per-task adapter override on create', async () => {
    const { service, port } = svc();
    const created = await service.createTask({
      title: 'With codex',
      repo: 'app',
      id: 'CX-1',
      adapter: 'codex',
    });
    expect(created.adapter).toBe('codex');
    expect(port.tasks.get('CX-1')!.adapter).toBe('codex');
  });

  it('pins host/deploy tasks to grok even when another adapter was requested', async () => {
    const { service } = svc();
    const created = await service.createTask({
      title: 'Deploy safely',
      repo: 'app',
      executionClass: 'deploy',
      adapter: 'claude',
    });
    expect(created.adapter).toBe('grok');
  });

  it('rejects an unsafe explicit id', async () => {
    const { service } = svc();
    await expect(
      service.createTask({ title: 'x', repo: 'app', id: '../evil' }),
    ).rejects.toThrow(ActionError);
  });

  it('atomically persists a canonical exact candidate lease with its path declaration', async () => {
    const { service, port } = svc();
    const base = 'A'.repeat(40);
    const tip = 'B'.repeat(40);
    const created = await service.createTask({
      title: 'Adopt reviewed candidate',
      repo: 'app',
      id: 'EXACT-1',
      expectedBaseRevision: base,
      expectedRemoteTip: tip,
      plannedBaseRevision: base,
      affectedPaths: ['src/domain/**', './src/a.ts'],
      protectedPathsSnapshot: ['WORKFLOW.md', 'WORKFLOW.md'],
    });

    expect(created.expectedBaseRevision).toBe(base.toLowerCase());
    expect(created.expectedRemoteTip).toBe(tip.toLowerCase());
    expect(port.tasks.get('EXACT-1')).toMatchObject({
      expectedBaseRevision: base.toLowerCase(),
      expectedRemoteTip: tip.toLowerCase(),
      plannedBaseRevision: base.toLowerCase(),
      affectedPaths: ['src/a.ts', 'src/domain/'],
      protectedPathsSnapshot: ['WORKFLOW.md'],
    });
  });

  it('rejects incomplete, malformed, unscoped, or base-mismatched exact candidate leases', async () => {
    const base = 'a'.repeat(40);
    const tip = 'b'.repeat(40);
    const pathLease = {
      plannedBaseRevision: base,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [] as readonly string[],
    };

    for (const input of [
      { expectedBaseRevision: base },
      { expectedRemoteTip: tip },
      { expectedBaseRevision: 'short', expectedRemoteTip: tip, ...pathLease },
      { expectedBaseRevision: base, expectedRemoteTip: 'short', ...pathLease },
      { expectedBaseRevision: base, expectedRemoteTip: tip },
      {
        expectedBaseRevision: 'c'.repeat(40),
        expectedRemoteTip: tip,
        ...pathLease,
      },
    ]) {
      const { service, port } = svc();
      await expect(service.createTask({
        title: 'Unsafe exact candidate',
        repo: 'app',
        id: 'EXACT-BAD',
        ...input,
      })).rejects.toBeInstanceOf(ActionError);
      expect(port.tasks.has('EXACT-BAD')).toBe(false);
      expect(port.commits).toHaveLength(0);
    }
  });

  it('does not expose a task when the atomic create commit returns false or throws', async () => {
    for (const failure of ['false', 'throw'] as const) {
      const { service, port } = svc();
      if (failure === 'false') port.createCommitResult = false;
      else port.createCommitError = new Error('injected create commit failure');

      await expect(service.createTask({
        title: 'Must stay invisible', repo: 'app', id: `ATOMIC-${failure}`,
      })).rejects.toThrow(/commit|durable|injected/i);
      expect(port.tasks.has(`ATOMIC-${failure}`)).toBe(false);
      expect(port.commits).toHaveLength(0);
    }
  });
});

describe('ActionService.createTask — protected-path fail-fast', () => {
  const WORKFLOW_WITH_PROTECTED = [
    '---',
    'gates:',
    '  test: pnpm test',
    'protected_paths:',
    '  - core/tests/structural_guards.rs',
    '  - test/invariants/**',
    '---',
    'body',
  ].join('\n');

  function svcWithWorkflow(
    workflow: string | null,
  ): { service: ActionService; port: FakePort } {
    const port = new FakePort(new Map());
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
        },
      },
    };
    const service = new ActionService(
      port,
      new FakeProbe(['main']),
      undefined,
      undefined,
      undefined,
      {
        workspaces: {
          readWorkflow: async () => workflow,
        },
      },
    );
    return { service, port };
  }

  it('rejects create when body names a protected path (hit)', async () => {
    const { service, port } = svcWithWorkflow(WORKFLOW_WITH_PROTECTED);
    await expect(
      service.createTask({
        title: 'Reconcile guard count',
        repo: 'app',
        id: 'GUARD-1',
        body:
          '## Task\nUpdate the constant in `core/tests/structural_guards.rs`.\n\n' +
          '## Acceptance criteria\n- [ ] (mechanical) constant updated\n',
        planPending: false,
      }),
    ).rejects.toThrow(/保护路径.*structural_guards|只能由人类完成/);
    expect(port.tasks.has('GUARD-1')).toBe(false);
    expect(port.commits).toHaveLength(0);
  });

  it('protected-path ActionError carries code, paths, and rule', async () => {
    const { service } = svcWithWorkflow(WORKFLOW_WITH_PROTECTED);
    let caught: unknown;
    try {
      await service.createTask({
        title: 'Reconcile guard count',
        repo: 'app',
        id: 'GUARD-ERR',
        body:
          '## Task\nUpdate the constant in `core/tests/structural_guards.rs`.\n\n' +
          '## Acceptance criteria\n- [ ] (mechanical) constant updated\n',
        planPending: false,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ActionError);
    const ae = caught as ActionError;
    expect(ae.code).toBe('protected_path');
    expect(ae.paths).toEqual(expect.arrayContaining(['core/tests/structural_guards.rs']));
    expect(ae.rule).toMatch(/force:true/i);
    expect(ae.rule).toMatch(/protected_paths/i);
  });

  it('allows create when body does not name a protected path (miss)', async () => {
    const { service, port } = svcWithWorkflow(WORKFLOW_WITH_PROTECTED);
    const created = await service.createTask({
      title: 'Fix actions',
      repo: 'app',
      id: 'OK-1',
      body:
        '## Task\nEdit `src/orchestrator/actions.ts`.\n\n' +
        '## Acceptance criteria\n- [ ] (mechanical) tests green\n',
      planPending: false,
    });
    expect(created.id).toBe('OK-1');
    expect(port.tasks.has('OK-1')).toBe(true);
  });

  it('allows create with force and stamps audit + label', async () => {
    const { service, port } = svcWithWorkflow(WORKFLOW_WITH_PROTECTED);
    const created = await service.createTask({
      title: 'Force protected edit',
      repo: 'app',
      id: 'FORCE-1',
      body:
        '## Task\nMust touch `core/tests/structural_guards.rs`.\n\n' +
        '## Acceptance criteria\n- [ ] (mechanical) done\n',
      planPending: false,
      force: true,
    });
    expect(created.labels).toContain('force-protected-path');
    expect(created.body).toMatch(/Operator force \(protected-path\)/);
    expect(created.body).toContain('core/tests/structural_guards.rs');
    expect(port.commits.at(-1)).toMatch(/force protected-path/);
  });

  it('skips gate when mirror has no WORKFLOW (fail-open; L5 still enforces)', async () => {
    const { service } = svcWithWorkflow(null);
    const created = await service.createTask({
      title: 'No workflow',
      repo: 'app',
      id: 'NW-1',
      body: 'Touch `core/tests/structural_guards.rs` please.',
      planPending: false,
    });
    expect(created.id).toBe('NW-1');
  });

  it(
    'createTask twice within a minute performs one mirror refresh',
    { timeout: 60_000 },
    async () => {
      const testRoot = await mkdtemp(join(tmpdir(), 'hercules-create-fresh-'));
      try {
        const remote = join(testRoot, 'remote');
        await mkdir(remote, { recursive: true });
        const remoteGit = simpleGit(remote);
        await remoteGit.init(['-b', 'main']);
        await remoteGit.addConfig('user.email', 't@h.local');
        await remoteGit.addConfig('user.name', 'T');
        await writeFile(
          join(remote, 'WORKFLOW.md'),
          [
            '---',
            'gates:',
            '  test: pnpm test',
            'protected_paths:',
            '  - test/invariants/**',
            '---',
            'body',
          ].join('\n'),
        );
        await remoteGit.add(['-A']);
        await remoteGit.commit('base');

        let now = 10_000_000;
        const repoCfg: RepoConfig = {
          key: 'app',
          url: remote,
          defaultBranch: 'main',
          workflow: 'WORKFLOW.md',
          maxConcurrent: 1,
          adapter: null,
          readiness: 'ready',
        };
        const workspaces = new GitWorkspaces({
          root: join(testRoot, 'work'),
          ports: new PortAllocator(7200, 4),
          clock: () => now,
        });

        // Warm: clone then refresh so freshness is stamped before create.
        await workspaces.readWorkflow(repoCfg, { maxStaleMs: 60_000 });
        await workspaces.readWorkflow(repoCfg, { maxStaleMs: 60_000 });
        const fetchesAfterWarm = workspaces.remoteFetchAttemptsForTest();
        expect(fetchesAfterWarm).toBeGreaterThanOrEqual(1);

        const port = new FakePort(new Map());
        port.repos = { repos: { app: repoCfg } };
        const service = new ActionService(
          port,
          new FakeProbe(['main']),
          undefined,
          undefined,
          undefined,
          { workspaces },
        );

        now += 5_000;
        await service.createTask({
          title: 'First create',
          repo: 'app',
          id: 'CREATE-FRESH-1',
          body:
            '## Task\nEdit `src/orchestrator/actions.ts`.\n\n' +
            '## Acceptance criteria\n- [ ] (mechanical) done\n',
          planPending: false,
        });
        await service.createTask({
          title: 'Second create',
          repo: 'app',
          id: 'CREATE-FRESH-2',
          body:
            '## Task\nEdit `src/isolation/worktree.ts`.\n\n' +
            '## Acceptance criteria\n- [ ] (mechanical) done\n',
          planPending: false,
        });

        // loadProtectedPaths opts into maxStaleMs: 60_000 — no extra fetch.
        expect(workspaces.remoteFetchAttemptsForTest()).toBe(fetchesAfterWarm);
        expect(port.tasks.has('CREATE-FRESH-1')).toBe(true);
        expect(port.tasks.has('CREATE-FRESH-2')).toBe(true);
      } finally {
        await rm(testRoot, { recursive: true, force: true });
      }
    },
  );
});

describe('ActionService.setTaskAdapter', () => {
  it('updates the task adapter and commits', async () => {
    const { service, port } = svc([{
      ...task('A'),
      agentSession: 'grok-session',
      agentSessionAdapter: 'grok',
      pendingSteer: 'keep this',
    }]);
    const next = await service.setTaskAdapter('A', 'claude');
    expect(next.adapter).toBe('claude');
    expect(next.agentSession).toBeNull();
    expect(next.agentSessionAdapter).toBeNull();
    expect(next.pendingSteer).toBe('keep this');
    expect(port.tasks.get('A')!.adapter).toBe('claude');
    expect(port.commits.at(-1)).toMatch(/adapter → claude/);
  });

  it('clears the override with null', async () => {
    const { service, port } = svc([task('A', 'todo')]);
    port.tasks.set('A', { ...port.tasks.get('A')!, adapter: 'grok' });
    const next = await service.setTaskAdapter('A', null);
    expect(next.adapter).toBeNull();
  });

  it('is a no-op commit-wise when unchanged', async () => {
    const { service, port } = svc([task('A')]);
    const n = port.commits.length;
    await service.setTaskAdapter('A', null);
    expect(port.commits.length).toBe(n);
  });

  it('switchNow on in_progress re-queues as retrying with session cleared', async () => {
    const { service, port } = svc([
      {
        ...task('A', 'in_progress'),
        adapter: 'grok',
        agentSession: 'sess-old',
        agentSessionAdapter: 'grok',
        pendingSteer: 'note',
      },
    ]);
    const next = await service.setTaskAdapter('A', 'codex', { switchNow: true });
    expect(next.state).toBe('retrying');
    expect(next.adapter).toBe('codex');
    expect(next.agentSession).toBeNull();
    expect(next.agentSessionAdapter).toBeNull();
    expect(next.pendingSteer).toBe('note');
    expect(next.body).toMatch(/Agent switch/);
    expect(port.commits.at(-1)).toMatch(/switch-now → codex/);
  });

  it('switchNow when not live just sets adapter', async () => {
    const { service, port } = svc([task('A', 'todo')]);
    const next = await service.setTaskAdapter('A', 'claude', { switchNow: true });
    expect(next.state).toBe('todo');
    expect(next.adapter).toBe('claude');
    expect(port.commits.at(-1)).toMatch(/adapter → claude/);
  });

  it('does not let host/deploy tasks switch away from scoped Grok execution', async () => {
    const host = {
      ...task('HOST', 'todo'),
      adapter: 'grok' as const,
      executionClass: 'host_operation' as const,
    };
    const { service } = svc([host]);
    await expect(service.setTaskAdapter('HOST', 'claude')).rejects.toThrow(/must stay pinned to grok/);
    await expect(service.setTaskAdapter('HOST', null)).rejects.toThrow(/must stay pinned to grok/);
  });
});

describe('ActionService.rewireDependencies', () => {
  it('atomically replaces multiple dependency sets without changing other fields', async () => {
    const a = task('A');
    const b = { ...task('B'), blockedBy: ['A'], dependencyMode: 'gate_merge' as const };
    const c = { ...task('C'), blockedBy: ['B'], body: 'preserve me' };
    const { service, port } = svc([a, b, c]);

    const receipt = await service.rewireDependencies({ changes: [
      { id: 'B', expectedBlockedBy: ['A'], blockedBy: [], dependencyMode: 'completion_only' },
      { id: 'C', expectedBlockedBy: ['B'], blockedBy: ['A'], dependencyMode: 'gate_merge' },
    ] });

    expect(receipt).toMatchObject({ committed: true, taskIds: ['B', 'C'] });
    expect(port.tasks.get('B')).toMatchObject({ blockedBy: [], dependencyMode: 'completion_only' });
    expect(port.tasks.get('C')).toMatchObject({ blockedBy: ['A'], body: 'preserve me' });
    expect(port.commits.at(-1)).toMatch(/dependency rewire B, C \(human\)/);
  });

  it('does not call the mutation port when validation fails', async () => {
    const { service, port } = svc([task('A'), task('B', 'in_progress')]);
    const before = [...port.tasks.entries()];
    await expect(service.rewireDependencies({ changes: [
      { id: 'A', expectedBlockedBy: [], blockedBy: ['B'], dependencyMode: 'gate_merge' },
      { id: 'B', expectedBlockedBy: [], blockedBy: [], dependencyMode: 'gate_merge' },
    ] })).rejects.toThrow(/running/);
    expect([...port.tasks.entries()]).toEqual(before);
    expect(port.commits).toEqual([]);
  });
});

describe('ActionService.approve — operator override', () => {
  it('stamps an Operator override section into the body (audit trail)', async () => {
    const t = { ...task('OV-1', 'review'), body: '## Task\nx\n' };
    const { service, port } = svc([t]);
    const next = await service.approve('OV-1', {
      humanAcknowledged: [],
      overrideNote: 'verify crashed on flaky gate; I reviewed the diff by hand',
    });
    expect(next.state).toBe('done');
    expect(next.body).toMatch(/## Operator override/);
    expect(next.body).toMatch(/flaky gate/);
    expect(port.tasks.get('OV-1')!.body).toMatch(/Operator override/);
  });

  it('normal approve (no note) does not add the section', async () => {
    const t = { ...task('OV-2', 'review'), body: '## Task\nx\n' };
    const { service } = svc([t]);
    const next = await service.approve('OV-2', { humanAcknowledged: [] });
    expect(next.body).not.toMatch(/Operator override/);
  });
});

describe('ActionService.createPipeline', () => {
  it('plan-gates a criteria-less stage (same §9.4 rule as createTask — no bypass lane)', async () => {
    const { service } = svc();
    const tasks = await service.createPipeline({
      repo: 'app',
      title: 'mixed pipeline',
      stages: [
        { title: 'vague stage', body: 'improve things' },
        { title: 'crisp stage', body: '## Acceptance criteria\n- [ ] (mechanical) pnpm test green\n' },
      ],
    });
    expect(tasks[0]!.planPending).toBe(true);
    expect(tasks[0]!.labels).toContain('needs-plan');
    expect(tasks[1]!.planPending).toBe(false);
  });

  it('creates a linear blocked_by chain with per-stage adapters', async () => {
    const { service, port } = svc();
    const tasks = await service.createPipeline({
      title: 'act1 polish',
      repo: 'app',
      stages: [
        { title: 'Implement', body: 'write code', adapter: 'grok' },
        { title: 'Review', body: 'tighten', adapter: 'codex' },
      ],
    });
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.blockedBy).toEqual([]);
    expect(tasks[1]!.blockedBy).toEqual([tasks[0]!.id]);
    expect(tasks[0]!.adapter).toBe('grok');
    expect(tasks[1]!.adapter).toBe('codex');
    expect(tasks[0]!.labels).toContain('pipeline');
    expect(tasks[0]!.title).toMatch(/\[1\/2\]/);
    expect(port.commits.at(-1)).toMatch(/create pipeline/);
    expect(port.tasks.size).toBe(2);
  });

  it('rejects fewer than 2 stages', async () => {
    const { service } = svc();
    await expect(
      service.createPipeline({
        title: 'x',
        repo: 'app',
        stages: [{ title: 'only' }],
      }),
    ).rejects.toThrow(/at least 2/);
  });
});

describe('deleteTask', () => {
  it('soft-deletes a non-running task into Deleted trash', async () => {
    const { service, port } = svc([task('A', 'review')]);
    const res = await service.deleteTask('A');
    expect(res.deleted).toBe('A');
    expect(res.cleanup).toBe(true);
    expect(res.soft).toBe(true);
    const a = (await port.read()).tasks.find((t) => t.id === 'A');
    expect(a?.state).toBe('deleted');
  });
  it('refuses to delete a running task', async () => {
    const { service } = svc([task('A', 'in_progress')]);
    await expect(service.deleteTask('A')).rejects.toThrow(/cancel the running task first/);
  });
  it('404s an unknown task', async () => {
    const { service } = svc();
    await expect(service.deleteTask('nope')).rejects.toThrow(/unknown task/);
  });
  it('soft-delete moves task to deleted; hard purge removes file', async () => {
    const { service, port } = svc([task('A', 'done')]);
    const soft = await service.deleteTask('A');
    expect(soft.soft).toBe(true);
    expect(port.tasks.get('A')!.state).toBe('deleted');
    expect(port.tasks.get('A')!.endedAt).toBeTruthy();
    const hard = await service.deleteTask('A', { hard: true });
    expect(hard.soft).toBe(false);
    expect(port.tasks.has('A')).toBe(false);
  });

  it('purgeExpiredTerminal hard-purges only old Deleted trash', async () => {
    const oldIso = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const newIso = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const port = new FakePort(
      new Map([
        ['old-del', { ...task('old-del', 'deleted'), endedAt: oldIso }],
        ['new-del', { ...task('new-del', 'deleted'), endedAt: newIso }],
        ['done', { ...task('done', 'done'), endedAt: oldIso }],
      ]),
    );
    port.repos = {
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
    const service = new ActionService(port, new FakeProbe(['main']), undefined, {
      autoDeleteRetentionMs: 30 * 86_400_000,
    });
    const res = await service.purgeExpiredTerminal({ nowMs: Date.now() });
    expect(res.purged).toContain('old-del');
    expect(res.purged).not.toContain('new-del');
    expect(res.purged).not.toContain('done');
    expect(port.tasks.has('old-del')).toBe(false);
    expect(port.tasks.has('new-del')).toBe(true);
    expect(port.tasks.has('done')).toBe(true);
  });

  it('closes Remote Control sessions bound to the task (even without cleanup)', async () => {
    const closed: string[] = [];
    const port = new FakePort(new Map([['logout', task('logout', 'review')]]));
    port.repos = {
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
    const service = new ActionService(port, new FakeProbe(['main']), undefined, {
      closeSessionsForTask: async (id) => {
        closed.push(id);
        return id === 'logout' ? ['logout', 'rc-linked'] : [];
      },
    });
    const res = await service.deleteTask('logout', { cleanup: false });
    expect(res.deleted).toBe('logout');
    expect(closed).toEqual(['logout']);
    expect(res.notes.some((n) => /sessions closed: logout, rc-linked/.test(n))).toBe(true);
  });
});

describe('ActionService transitions', () => {
  it('approve moves review → done', async () => {
    const { service, port } = svc([task('A', 'review')]);
    await service.approve('A');
    expect(port.tasks.get('A')!.state).toBe('done');
  });

  it('approve refuses when human ACs exist and are not acknowledged', async () => {
    const t: Task = {
      ...task('H', 'review'),
      body: `
## Definition of Done
- [ ] (mechanical) gates
- [ ] (human) Spot-check on device
`,
    };
    const { service, port } = svc([t]);
    await expect(service.approve('H')).rejects.toThrow(/human acceptance|unchecked/i);
    await expect(service.approve('H', { humanAcknowledged: [] })).rejects.toThrow(
      /human acceptance|unchecked/i,
    );
    expect(port.tasks.get('H')!.state).toBe('review');
  });

  it('approve succeeds when every human AC is acknowledged', async () => {
    const t: Task = {
      ...task('H', 'review'),
      body: `
## Definition of Done
- [ ] (mechanical) gates
- [ ] (human) Spot-check on device
- [ ] (human) Mark ready in Repos
`,
    };
    const { service, port } = svc([t]);
    await service.approve('H', {
      humanAcknowledged: ['Spot-check on device', 'Mark ready in Repos'],
    });
    expect(port.tasks.get('H')!.state).toBe('done');
  });

  it('approve refuses when the preserved branch tip lost the verified commit', async () => {
    // Fake-green incident 2026-07-15: review packets said green while the
    // preserved branches held other tasks' commits. Approve must assert that
    // what the human approves is what verification actually saw.
    const t: Task = { ...task('A', 'review'), verifiedSha: 'cafe1234cafe1234cafe1234cafe1234cafe1234' };
    const port = new FakePort(new Map([[t.id, t]]));
    const calls: Array<readonly [string, string, string]> = [];
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => ({ taskId: 'A', repo: 'app', dir: '/x', branch: 'hercules/A', allocation: { slug: 'A', port: 1, scratchDir: '/s' }, branchLease: { expectedBaseRevision: '0'.repeat(40), expectedRemoteTip: null } }),
        preserve: async () => undefined,
        preservedTipStatus: async (repoKey: string, taskId: string, sha: string) => {
          calls.push([repoKey, taskId, sha]);
          return { ok: false, tip: 'beef5678beef5678beef5678beef5678beef5678', reason: 'tip does not contain the verified commit' };
        },
      },
      verifier: { verify: async () => { throw new Error('unused'); } } as unknown as import('../../src/orchestrator/verifier.js').Verifier,
    });
    await expect(service.approve('A')).rejects.toThrow(/verified/i);
    expect(calls).toEqual([['app', 'A', 'cafe1234cafe1234cafe1234cafe1234cafe1234']]);
    expect(port.tasks.get('A')!.state).toBe('review'); // unchanged
  });

  it('approve passes when the preserved tip contains the verified commit', async () => {
    const t: Task = { ...task('A', 'review'), verifiedSha: 'cafe1234cafe1234cafe1234cafe1234cafe1234' };
    const port = new FakePort(new Map([[t.id, t]]));
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => ({ taskId: 'A', repo: 'app', dir: '/x', branch: 'hercules/A', allocation: { slug: 'A', port: 1, scratchDir: '/s' }, branchLease: { expectedBaseRevision: '0'.repeat(40), expectedRemoteTip: null } }),
        preserve: async () => undefined,
        preservedTipStatus: async () => ({ ok: true, tip: 'cafe1234cafe1234cafe1234cafe1234cafe1234', reason: '' }),
      },
      verifier: { verify: async () => { throw new Error('unused'); } } as unknown as import('../../src/orchestrator/verifier.js').Verifier,
    });
    await service.approve('A');
    expect(port.tasks.get('A')!.state).toBe('done');
  });

  it('approve still works for legacy tasks without a verified SHA', async () => {
    const { service, port } = svc([task('L', 'review')]);
    await service.approve('L');
    expect(port.tasks.get('L')!.state).toBe('done');
  });

  it('reject moves review → todo for rework and clears session', async () => {
    const { service, port } = svc([
      { ...task('A', 'review'), agentSession: 'sess-1', pendingSteer: 'old' },
    ]);
    await service.reject('A');
    const next = port.tasks.get('A')!;
    expect(next.state).toBe('todo');
    expect(next.agentSession).toBeNull();
    expect(next.pendingSteer).toBeNull();
  });

  it('reject clears host approval so a host mutation cannot replay without reapproval', async () => {
    const host = {
      ...task('HOST', 'review'),
      executionClass: 'host_operation' as const,
      adapter: 'grok' as const,
      hostCommandScope: ['systemctl restart hercules'],
      hostApprovedAt: '2026-07-31T06:00:00.000Z',
    };
    const { service } = svc([host]);
    const next = await service.reject('HOST');
    expect(next.state).toBe('todo');
    expect(next.hostCommandScope).toBeNull();
    expect(next.hostApprovedAt).toBeNull();
  });

  it('steer queues a follow-up, keeps session, appends audit section', async () => {
    const { service, port } = svc([
      { ...task('A', 'review'), agentSession: 'sess-1', body: 'original body' },
    ]);
    const next = await service.steer('A', 'What did loop 58 write?');
    expect(next.state).toBe('todo');
    expect(next.agentSession).toBe('sess-1');
    expect(next.pendingSteer).toBe('What did loop 58 write?');
    expect(next.body).toContain('original body');
    expect(next.body).toContain('## Human steer');
    expect(next.body).toContain('What did loop 58 write?');
    expect(port.commits.at(-1)).toMatch(/steer/);
  });

  it('steer from failed resets attempts and abandons poisoned agent_exit session', async () => {
    const body = [
      '## Task',
      'do it',
      '',
      '## Run failure',
      '',
      '**Kind:** `agent_exit`',
      '',
      'boom',
    ].join('\n');
    const { service } = svc([
      {
        ...task('F', 'failed'),
        agentSession: 'sess-poison',
        agentSessionAdapter: 'fake',
        attempts: 3,
        lastEventAt: '2026-09-09T00:00:00.000Z',
        endedAt: '2026-09-09T00:00:00.000Z',
        body,
      },
    ]);
    const next = await service.steer('F', 'continue with a fresh start');
    expect(next.state).toBe('todo');
    expect(next.attempts).toBe(0);
    expect(next.lastEventAt).toBeNull();
    expect(next.endedAt).toBeNull();
    expect(next.pendingSteer).toBe('continue with a fresh start');
    expect(next.agentSession).toBeNull();
    expect(next.agentSessionAdapter).toBeNull();
    expect(next.body).toMatch(/Session abandoned|abandoned corrupted session/i);
  });

  it('steer rejects empty comment and non-steerable states', async () => {
    const { service } = svc([task('A', 'review'), task('B', 'todo')]);
    await expect(service.steer('A', '   ')).rejects.toThrow(/required/);
    await expect(service.steer('B', 'hi')).rejects.toThrow(/review, failed, or done/);
  });

  it('steer from done re-queues todo and keeps open PR fields', async () => {
    const { service, port } = svc([
      {
        ...task('A', 'done'),
        agentSession: 'sess-1',
        prUrl: 'https://github.com/example-org/acme/pull/9',
        prStatus: 'open',
      },
    ]);
    const next = await service.steer('A', 'Fix the nav icon alignment');
    expect(next.state).toBe('todo');
    expect(next.pendingSteer).toContain('nav icon');
    expect(next.agentSession).toBe('sess-1');
    expect(next.prUrl).toContain('/pull/9');
    expect(next.prStatus).toBe('open');
    expect(port.tasks.get('A')!.state).toBe('todo');
  });

  it('steerFromPrComments pulls comments and steers', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(ghPr('A', 9)),
          stderr: '',
        };
      }
      const path = args[1] ?? '';
      if (path.includes('/issues/') && path.endsWith('/comments')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { user: { login: 'alice' }, body: 'Please rename the label', created_at: '2026-01-01T00:00:00Z' },
          ]),
          stderr: '',
        };
      }
      if (path.includes('/reviews') || (path.includes('/pulls/') && path.endsWith('/comments'))) {
        return { exitCode: 0, stdout: '[]', stderr: '' };
      }
      return { exitCode: 0, stdout: '[]', stderr: '' };
    };
    const { service, port } = svc(
      [
        {
          ...task('A', 'done'),
          prUrl: 'https://github.com/example-org/acme/pull/9',
          prStatus: 'open',
          agentSession: 's',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.steerFromPrComments('A');
    expect(res.commentCount).toBe(1);
    expect(res.draft).toContain('rename the label');
    expect(res.task.state).toBe('todo');
    expect(port.tasks.get('A')!.pendingSteer).toContain('rename the label');
  });

  it('syncOpenPrStatuses advances open → merged and leaves still-open alone', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        const n = args[2];
        if (n === '5') {
          return {
            exitCode: 0,
            stdout: JSON.stringify(ghPr('logout', 5, { state: 'MERGED' })),
            stderr: '',
          };
        }
        if (n === '6') {
          // MERGEABLE open PR — stay parked in done, no system requeue.
          return {
            exitCode: 0,
            stdout: JSON.stringify(ghPr('still', 6, {
              state: 'OPEN',
              mergeable: 'MERGEABLE',
              reviewDecision: '',
              title: 'still',
              comments: [],
              reviews: [],
              statusCheckRollup: [],
            })),
            stderr: '',
          };
        }
        if (n === '7') {
          return {
            exitCode: 0,
            stdout: JSON.stringify(ghPr('closed', 7, { state: 'CLOSED' })),
            stderr: '',
          };
        }
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('logout', 'done'),
          prUrl: 'https://github.com/example-org/acme/pull/5',
          prStatus: 'open',
        },
        {
          ...task('still', 'done'),
          prUrl: 'https://github.com/example-org/acme/pull/6',
          prStatus: 'open',
        },
        {
          ...task('closed', 'done'),
          prUrl: 'https://github.com/example-org/acme/pull/7',
          prStatus: 'open',
        },
        {
          ...task('none', 'done'),
          prUrl: null,
          prStatus: null,
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect([...res.updated].sort()).toEqual(['closed', 'logout']);
    expect(port.tasks.get('logout')!.prStatus).toBe('merged');
    expect(port.tasks.get('still')!.prStatus).toBe('open');
    expect(port.tasks.get('still')!.state).toBe('done');
    expect(port.tasks.get('closed')!.prStatus).toBe('closed');
    expect(port.tasks.get('none')!.prStatus).toBeNull();
    expect(port.commits.at(-1)).toMatch(/pr status sync/);
  });

  it('invalid PR identity cannot stamp lifecycle, provenance, or conflict requeue', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('another-task', 9, {
            state: 'MERGED',
            mergeable: 'CONFLICTING',
            mergeCommit: { oid: 'a'.repeat(40) },
          }),
        ),
        stderr: '',
      };
    };
    const original = {
      ...task('victim', 'review'),
      prUrl: 'https://github.com/example-org/acme/pull/9',
      prStatus: 'open' as const,
      verifiedSha: 'b'.repeat(40),
      mergedSha: null,
      mergedVia: null,
    };
    const { service, port } = svc([original], undefined, gh);

    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });

    expect(port.tasks.get('victim')).toEqual(original);
    expect(port.commits).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('wrong-repository PR URL never reaches gh during periodic sync', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: '{}', stderr: '' };
    };
    const original = {
      ...task('victim', 'done'),
      prUrl: 'https://github.com/evil/other/pull/9',
      prStatus: 'open' as const,
      mergedSha: null,
      mergedVia: null,
    };
    const { service, port } = svc([original], undefined, gh);

    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('victim')).toEqual(original);
    expect(port.commits).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('wrong-head OPEN+CONFLICTING payload cannot requeue or stamp', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('other-task', 6, {
            state: 'OPEN',
            mergeable: 'CONFLICTING',
            reviewDecision: '',
            title: 'x',
            comments: [],
            reviews: [],
            statusCheckRollup: [],
          }),
        ),
        stderr: '',
      };
    };
    const original = {
      ...task('settings-build', 'review'),
      prUrl: 'https://github.com/example-org/acme/pull/6',
      prStatus: 'open' as const,
      agentSession: 'sess-1',
      pendingSteer: null,
    };
    const { service, port } = svc([original], undefined, gh);

    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('settings-build')).toEqual(original);
    expect(port.commits).toEqual([]);
    // One lifecycle view only — identity fails before requeue summary.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 2)).toEqual(['pr', 'view']);
  });

  it('existing merged_sha is never overwritten by a later lifecycle fetch', async () => {
    const KEEP = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('kept', 3, {
          state: 'MERGED',
          mergeCommit: { oid: OTHER },
        }),
      ),
      stderr: '',
    });
    // Open status forces a lifecycle probe; existing SHA must stay.
    const { service, port } = svc(
      [
        {
          ...task('kept', 'done'),
          prUrl: 'https://github.com/example-org/acme/pull/3',
          prStatus: 'open',
          mergedSha: KEEP,
          mergedVia: 'operator',
        },
      ],
      undefined,
      gh,
    );

    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['kept']);
    expect(port.tasks.get('kept')!.prStatus).toBe('merged');
    expect(port.tasks.get('kept')!.mergedSha).toBe(KEEP);
    expect(port.tasks.get('kept')!.mergedVia).toBe('operator');
  });

  it('explicit prSummary returns an actionable identity error without mutation', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('victim', 9, {
          baseRefName: 'release',
          state: 'MERGED',
          mergeCommit: { oid: 'a'.repeat(40) },
        }),
      ),
      stderr: '',
    });
    const original = {
      ...task('victim', 'done'),
      prUrl: 'https://github.com/example-org/acme/pull/9',
      prStatus: 'open' as const,
      mergedSha: null,
      mergedVia: null,
    };
    const { service, port } = svc([original], undefined, gh);

    await expect(service.prSummary('victim')).rejects.toThrow(
      /base.*default branch/i,
    );
    expect(port.tasks.get('victim')).toEqual(original);
    expect(port.commits).toEqual([]);
  });

  it('wrong-repository prSummary and previewPrComments invoke no gh commands', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      return { exitCode: 0, stdout: '{}', stderr: '' };
    };
    const original = {
      ...task('victim', 'done'),
      prUrl: 'https://github.com/evil/other/pull/9',
      prStatus: 'open' as const,
    };
    const { service, port } = svc([original], undefined, gh);

    await expect(service.prSummary('victim')).rejects.toThrow(
      /does not match configured repo/i,
    );
    await expect(service.previewPrComments('victim')).rejects.toThrow(
      /does not match configured repo/i,
    );
    expect(port.tasks.get('victim')).toEqual(original);
    expect(port.commits).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('syncOpenPrStatuses stamps merged_sha + merged_via=operator on external PR merge', async () => {
    // release-verify-timeout: PR #8 merged on GitHub at a real merge commit;
    // H must not leave merged_sha empty (false Merge selected candidate).
    const MERGE_SHA = '49e8150346e532312c129a14c1a66c9afecb462b';
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(ghPr('release-verify-timeout', 8, {
            state: 'MERGED',
            mergeCommit: { oid: MERGE_SHA },
          })),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('release-verify-timeout', 'done'),
          prUrl: 'https://github.com/example-org/acme/pull/8',
          prStatus: 'open',
          verifiedSha: 'a'.repeat(40),
          mergedSha: null,
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['release-verify-timeout']);
    const t = port.tasks.get('release-verify-timeout')!;
    expect(t.prStatus).toBe('merged');
    expect(t.mergedSha).toBe(MERGE_SHA);
    expect(t.mergedVia).toBe('operator');
    expect(port.commits.filter((c) => /pr status sync/.test(c))).toHaveLength(1);
  });

  it('syncOpenPrStatuses backfills merged_sha for done+merged legacy tasks', async () => {
    const MERGE_SHA = '49e8150346e532312c129a14c1a66c9afecb462b';
    let ghCalls = 0;
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        ghCalls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify(ghPr('release-verify-timeout', 8, {
            state: 'MERGED',
            mergeCommit: { oid: MERGE_SHA },
          })),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('release-verify-timeout', 'done'),
          prUrl: 'https://github.com/example-org/acme/pull/8',
          prStatus: 'merged',
          // Historical accident: status synced, provenance missing.
          mergedSha: null,
          mergedVia: null,
          verifiedSha: 'b'.repeat(40),
        },
      ],
      undefined,
      gh,
    );
    const first = await service.syncOpenPrStatuses();
    expect(first.updated).toEqual(['release-verify-timeout']);
    const after = port.tasks.get('release-verify-timeout')!;
    expect(after.mergedSha).toBe(MERGE_SHA);
    expect(after.mergedVia).toBe('operator');
    expect(after.prStatus).toBe('merged');
    const commitsAfterFirst = port.commits.length;

    // Idempotent: second tick does not rewrite or re-commit.
    const second = await service.syncOpenPrStatuses();
    expect(second.updated).toEqual([]);
    expect(port.commits.length).toBe(commitsAfterFirst);
    expect(port.tasks.get('release-verify-timeout')!.mergedSha).toBe(MERGE_SHA);
    expect(ghCalls).toBeGreaterThanOrEqual(1);
  });

  it('syncOpenPrStatuses does not invent merged_sha when mergeCommit missing/malformed', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(ghPr('release-verify-timeout', 8, {
            state: 'MERGED',
            mergeCommit: { oid: 'short' },
          })),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('release-verify-timeout', 'done'),
          prUrl: 'https://github.com/example-org/acme/pull/8',
          prStatus: 'open',
          mergedSha: null,
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['release-verify-timeout']);
    const t = port.tasks.get('release-verify-timeout')!;
    expect(t.prStatus).toBe('merged');
    expect(t.mergedSha ?? null).toBeNull();
    expect(t.mergedVia ?? null).toBeNull();
  });

  it('syncOpenPrStatuses moves review → done when GitHub reports MERGED', async () => {
    // settings-build: human merged PR on website while task sat in review.
    const MERGE_SHA = 'c'.repeat(40);
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(ghPr('settings-build', 6, {
            state: 'MERGED',
            mergeCommit: { oid: MERGE_SHA },
          })),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('settings-build', 'review'),
          prUrl: 'https://github.com/example-org/acme/pull/6',
          prStatus: 'open',
          endedAt: '2026-07-14T21:09:53.072Z',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toContain('settings-build');
    const t = port.tasks.get('settings-build')!;
    expect(t.state).toBe('done');
    expect(t.prStatus).toBe('merged');
    expect(t.mergedSha).toBe(MERGE_SHA);
    expect(t.mergedVia).toBe('operator');
    expect(t.endedAt).toBe('2026-07-14T21:09:53.072Z');
  });

  it('syncOpenPrStatuses closes a cursor factory review when GitHub reports MERGED', async () => {
    const MERGE_SHA = 'd'.repeat(40);
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            ghPr('T-factory', 41, {
              state: 'MERGED',
              headRefName: 'cursor/cloud-T-factory-abc',
              mergeCommit: { oid: MERGE_SHA },
            }),
          ),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          verifiedSha: null,
          endedAt: '2026-08-27T12:00:00.000Z',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('done');
    expect(t.prStatus).toBe('merged');
    expect(t.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(t.mergedSha).toBe(MERGE_SHA);
    expect(t.mergedVia).toBe('operator');
    expect(t.verifiedSha ?? null).toBeNull();
    expect(t.endedAt).toBe('2026-08-27T12:00:00.000Z');
    expect(staticMergeBlockReason(t, 'app')).toMatch(/already merged externally|missing verified_sha/);
  });

  it('syncOpenPrStatuses does not treat a grok PR with a Cursor head as merged', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-local', 41, {
          state: 'MERGED',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeCommit: { oid: 'e'.repeat(40) },
        }),
      ),
      stderr: '',
    });
    const original = {
      ...task('T-local', 'review'),
      adapter: 'grok' as const,
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prStatus: 'open' as const,
      verifiedSha: 'b'.repeat(40),
    };
    const { service, port } = svc([original], undefined, gh);
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('T-local')).toEqual(original);
    expect(port.commits).toEqual([]);
  });

  it('syncOpenPrStatuses leaves a still-open factory PR in review', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeable: 'MERGEABLE',
        }),
      ),
      stderr: '',
    });
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          verifiedSha: null,
        },
      ],
      undefined,
      gh,
    );
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.prStatus).toBe('open');
    expect(t.verifiedSha ?? null).toBeNull();
  });

  it('syncOpenPrStatuses requeues a CONFLICTING factory PR onto the Cloud Agent head', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeable: 'CONFLICTING',
          reviewDecision: '',
          title: 'factory',
          comments: [],
          reviews: [],
          statusCheckRollup: [],
        }),
      ),
      stderr: '',
    });
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          agentSession: 'bc_1',
          agentSessionAdapter: 'cursor',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('todo');
    expect(t.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(t.prStatus).toBe('open');
    expect(t.pendingSteer).toMatch(/CONFLICTING/i);
    expect(t.pendingSteer).toContain('cursor/cloud-T-factory-abc');
    expect(t.pendingSteer).not.toMatch(/work \*\*only\*\* on branch `hercules\/T-factory`/i);
    expect(t.pendingSteer).toMatch(/Do \*\*not\*\* create `hercules\/T-factory`/);
    expect(t.body).toMatch(/System steer \(pr-mergeable\)/);
    expect(t.agentSession).toBeNull();
    expect(t.agentSessionAdapter ?? null).toBeNull();
    expect(t.verifiedSha ?? null).toBeNull();
  });

  it('syncOpenPrStatuses does not requeue a CONFLICTING factory PR with an unsafe head', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: '../evil',
          mergeable: 'CONFLICTING',
        }),
      ),
      stderr: '',
    });
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.pendingSteer).toBeNull();
  });

  it('syncOpenPrStatuses heals review stuck with pr_status already merged', async () => {
    // After an older sync wrote pr_status=merged without advancing state,
    // hasOpenPr is false — must still heal review → done even if gh is down
    // (no invented merge SHA when provenance cannot be fetched).
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'gh unavailable',
    });
    const { service, port } = svc(
      [
        {
          ...task('settings-build', 'review'),
          prUrl: 'https://github.com/example-org/acme/pull/6',
          prStatus: 'merged',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toContain('settings-build');
    const t = port.tasks.get('settings-build')!;
    expect(t.state).toBe('done');
    expect(t.prStatus).toBe('merged');
    expect(t.mergedSha ?? null).toBeNull();
  });

  it('syncOpenPrStatuses re-queues review when open PR is still CONFLICTING', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(ghPr('settings-build', 6, {
            state: 'OPEN',
            mergeable: 'CONFLICTING',
            reviewDecision: '',
            title: 'settings-build',
            comments: [],
            reviews: [],
            statusCheckRollup: [],
          })),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('settings-build', 'review'),
          prUrl: 'https://github.com/example-org/acme/pull/6',
          prStatus: 'open',
          agentSession: 'sess-1',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toContain('settings-build');
    const t = port.tasks.get('settings-build')!;
    expect(t.state).toBe('todo');
    expect(t.pendingSteer).toMatch(/CONFLICTING/i);
    expect(t.body).toMatch(/System steer \(pr-mergeable\)/);
    expect(t.pendingSteer).toMatch(/Single source of truth|dual-write/i);
    expect(t.agentSession).toBe('sess-1'); // resume
  });

  it('syncOpenPrStatuses thrash-brakes after PR_CONFLICT_REQUEUE_CAP steers', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(ghPr('settings-build', 6, {
            state: 'OPEN',
            mergeable: 'CONFLICTING',
            reviewDecision: '',
            title: 'settings-build',
            comments: [],
            reviews: [],
            statusCheckRollup: [],
          })),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const priorSteers = [
      '## System steer (pr-mergeable) (t1)',
      '',
      'first',
      '',
      '## System steer (pr-mergeable) (t2)',
      '',
      'second',
    ].join('\n');
    const { service, port } = svc(
      [
        {
          ...task('settings-build', 'review'),
          prUrl: 'https://github.com/example-org/acme/pull/6',
          prStatus: 'open',
          body: `## Task\nfix conflicts\n\n${priorSteers}\n`,
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toContain('settings-build');
    const t = port.tasks.get('settings-build')!;
    // Stays in review — human owns it; no further auto re-queue.
    expect(t.state).toBe('review');
    expect(t.pendingSteer).toBeNull();
    expect(t.body).toMatch(/Thrash brake \(pr-mergeable\)/);
    expect(t.body).toMatch(/dual-write/i);
  });

  it('syncOpenPrStatuses thrash-brakes a factory CONFLICTING PR without hercules/<id> rework', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeable: 'CONFLICTING',
        }),
      ),
      stderr: '',
    });
    const priorSteers = [
      '## System steer (pr-mergeable) (t1)',
      '',
      'first',
      '',
      '## System steer (pr-mergeable) (t2)',
      '',
      'second',
    ].join('\n');
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          body: `## Task\nfactory cut\n\n${priorSteers}\n`,
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toContain('T-factory');
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.pendingSteer).toBeNull();
    expect(t.body).toMatch(/Thrash brake \(pr-mergeable\)/);
    expect(t.body).toContain('cursor/cloud-T-factory-abc');
    expect(t.body).not.toMatch(/Work \*\*only\*\* on branch `hercules\/T-factory`/);
  });

  it('syncOpenPrStatuses requeues a factory PR when GitHub checks are red', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeable: 'MERGEABLE',
          reviewDecision: '',
          title: 'factory',
          comments: [],
          reviews: [],
          statusCheckRollup: [
            { name: 'CI / gates', conclusion: 'FAILURE', status: 'COMPLETED' },
          ],
        }),
      ),
      stderr: '',
    });
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          agentSession: 'bc_1',
          agentSessionAdapter: 'cursor',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('todo');
    expect(t.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(t.prStatus).toBe('open');
    expect(t.pendingSteer).toMatch(/GitHub CI is failing/i);
    expect(t.pendingSteer).toContain('CI / gates');
    expect(t.pendingSteer).toContain('cursor/cloud-T-factory-abc');
    expect(t.pendingSteer).not.toMatch(/work \*\*only\*\* on branch `hercules\/T-factory`/i);
    expect(t.pendingSteer).toMatch(/Do \*\*not\*\* create `hercules\/T-factory`/);
    expect(t.body).toMatch(/System steer \(pr-ci\)/);
    expect(t.agentSession).toBeNull();
    expect(t.agentSessionAdapter ?? null).toBeNull();
    expect(t.verifiedSha ?? null).toBeNull();
  });

  it('syncOpenPrStatuses leaves factory review when GitHub checks are still pending', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [
            { name: 'CI / gates', status: 'IN_PROGRESS' },
          ],
        }),
      ),
      stderr: '',
    });
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.pendingSteer).toBeNull();
  });

  it('syncOpenPrStatuses does not requeue a grok PR when GitHub checks are red', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-local', 41, {
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [
            { name: 'CI / gates', conclusion: 'FAILURE', status: 'COMPLETED' },
          ],
        }),
      ),
      stderr: '',
    });
    const original = {
      ...task('T-local', 'review'),
      adapter: 'grok' as const,
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prStatus: 'open' as const,
    };
    const { service, port } = svc([original], undefined, gh);
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('T-local')).toEqual(original);
    expect(port.commits).toEqual([]);
  });

  it('syncOpenPrStatuses prefers CONFLICTING over red checks on a factory PR', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeable: 'CONFLICTING',
          statusCheckRollup: [
            { name: 'CI / gates', conclusion: 'FAILURE', status: 'COMPLETED' },
          ],
        }),
      ),
      stderr: '',
    });
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('todo');
    expect(t.pendingSteer).toMatch(/CONFLICTING/i);
    expect(t.pendingSteer).not.toMatch(/GitHub CI is failing/i);
    expect(t.body).toMatch(/System steer \(pr-mergeable\)/);
    expect(t.body).not.toMatch(/System steer \(pr-ci\)/);
  });

  it('syncOpenPrStatuses does not requeue a factory CI failure with an unsafe head', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: '../evil',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [
            { name: 'CI / gates', conclusion: 'FAILURE', status: 'COMPLETED' },
          ],
        }),
      ),
      stderr: '',
    });
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.pendingSteer).toBeNull();
  });

  it('syncOpenPrStatuses thrash-brakes a factory CI loop without hercules/<id> rework', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeable: 'MERGEABLE',
          statusCheckRollup: [
            { name: 'CI / gates', conclusion: 'FAILURE', status: 'COMPLETED' },
          ],
        }),
      ),
      stderr: '',
    });
    const priorSteers = [
      '## System steer (pr-ci) (t1)',
      '',
      'first',
      '',
      '## System steer (pr-ci) (t2)',
      '',
      'second',
    ].join('\n');
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          body: `## Task\nfactory cut\n\n${priorSteers}\n`,
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toContain('T-factory');
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.pendingSteer).toBeNull();
    expect(t.body).toMatch(/Thrash brake \(pr-ci\)/);
    expect(t.body).toContain('cursor/cloud-T-factory-abc');
    expect(t.body).not.toMatch(/Work \*\*only\*\* on branch `hercules\/T-factory`/);
  });

  it('syncOpenPrStatuses rebases a BEHIND factory PR via gh without a Cloud Agent', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'rebase') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: 'cursor/cloud-T-factory-abc',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BEHIND',
            reviewDecision: '',
            title: 'factory',
            comments: [],
            reviews: [],
            statusCheckRollup: [
              { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
            ],
          }),
        ),
        stderr: '',
      };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          agentSession: 'bc_1',
          agentSessionAdapter: 'cursor',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(t.prStatus).toBe('open');
    expect(t.pendingSteer).toBeNull();
    expect(t.agentSession).toBe('bc_1');
    expect(t.body).toMatch(/Factory PR rebased via GitHub/);
    expect(t.body).toMatch(/Not a Cloud Agent relaunch/);
    expect(t.body).not.toMatch(/System steer \(pr-behind\)/);
    expect(t.verifiedSha ?? null).toBeNull();
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'rebase')).toBe(true);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false);
  });

  it('syncOpenPrStatuses requeues a BEHIND factory PR onto the Cloud Agent head when rebase fails', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'rebase') {
        return { exitCode: 1, stdout: '', stderr: 'cannot rebase: merge conflict' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: 'cursor/cloud-T-factory-abc',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BEHIND',
            reviewDecision: '',
            title: 'factory',
            comments: [],
            reviews: [],
            statusCheckRollup: [
              { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
            ],
          }),
        ),
        stderr: '',
      };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          agentSession: 'bc_1',
          agentSessionAdapter: 'cursor',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('todo');
    expect(t.prUrl).toBe('https://github.com/example-org/acme/pull/41');
    expect(t.prStatus).toBe('open');
    expect(t.pendingSteer).toMatch(/BEHIND/i);
    expect(t.pendingSteer).toContain('cursor/cloud-T-factory-abc');
    expect(t.pendingSteer).not.toMatch(/work \*\*only\*\* on branch `hercules\/T-factory`/i);
    expect(t.pendingSteer).toMatch(/Do \*\*not\*\* create `hercules\/T-factory`/);
    expect(t.body).toMatch(/System steer \(pr-behind\)/);
    expect(t.agentSession).toBeNull();
    expect(t.agentSessionAdapter ?? null).toBeNull();
    expect(t.verifiedSha ?? null).toBeNull();
  });

  it('syncOpenPrStatuses squash-merges a CLEAN green factory PR and closes review', async () => {
    const MERGE_SHA = 'e'.repeat(40);
    const calls: string[][] = [];
    let merged = false;
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'merge') {
        merged = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            ghPr('T-factory', 41, {
              state: merged ? 'MERGED' : 'OPEN',
              headRefName: 'cursor/cloud-T-factory-abc',
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'CLEAN',
              isDraft: false,
              statusCheckRollup: [
                { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
              ],
              ...(merged ? { mergeCommit: { oid: MERGE_SHA } } : {}),
            }),
          ),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('done');
    expect(t.prStatus).toBe('merged');
    expect(t.mergedSha).toBe(MERGE_SHA);
    expect(t.mergedVia).toBe('operator');
    expect(t.pendingSteer).toBeNull();
    expect(t.body).toMatch(/Factory PR merged via GitHub/);
    expect(t.body).toMatch(/Not an Approve/);
    expect(t.body).toMatch(/Not MergeService/);
    expect(t.verifiedSha ?? null).toBeNull();
    expect(merged).toBe(true);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'merge' && args.includes('--squash'))).toBe(true);
  });

  it('syncOpenPrStatuses rebases a BEHIND factory PR while checks are still pending', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'rebase') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: 'cursor/cloud-T-factory-abc',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BEHIND',
            statusCheckRollup: [
              { name: 'CI / gates', status: 'IN_PROGRESS' },
            ],
          }),
        ),
        stderr: '',
      };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    expect((await service.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.pendingSteer).toBeNull();
    expect(t.body).toMatch(/Factory PR rebased via GitHub/);
    expect(t.body).not.toMatch(/System steer \(pr-behind\)/);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'rebase')).toBe(true);
  });

  it('syncOpenPrStatuses prefers red checks over BEHIND on a factory PR', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [
            { name: 'CI / gates', conclusion: 'FAILURE', status: 'COMPLETED' },
          ],
        }),
      ),
      stderr: '',
    });
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('todo');
    expect(t.pendingSteer).toMatch(/GitHub CI is failing/i);
    expect(t.pendingSteer).not.toMatch(/Open factory PR is BEHIND/i);
    expect(t.body).toMatch(/System steer \(pr-ci\)/);
    expect(t.body).not.toMatch(/System steer \(pr-behind\)/);
  });

  it('syncOpenPrStatuses prefers CONFLICTING over BEHIND on a factory PR', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-factory', 41, {
          state: 'OPEN',
          headRefName: 'cursor/cloud-T-factory-abc',
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [
            { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
          ],
        }),
      ),
      stderr: '',
    });
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('todo');
    expect(t.pendingSteer).toMatch(/CONFLICTING/i);
    expect(t.pendingSteer).not.toMatch(/Open factory PR is BEHIND/i);
    expect(t.body).toMatch(/System steer \(pr-mergeable\)/);
    expect(t.body).not.toMatch(/System steer \(pr-behind\)/);
  });

  it('syncOpenPrStatuses does not requeue a grok PR when GitHub says BEHIND', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async () => ({
      exitCode: 0,
      stdout: JSON.stringify(
        ghPr('T-local', 41, {
          state: 'OPEN',
          mergeable: 'MERGEABLE',
          mergeStateStatus: 'BEHIND',
          statusCheckRollup: [
            { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
          ],
        }),
      ),
      stderr: '',
    });
    const original = {
      ...task('T-local', 'review'),
      adapter: 'grok' as const,
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prStatus: 'open' as const,
    };
    const { service, port } = svc([original], undefined, gh);
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('T-local')).toEqual(original);
    expect(port.commits).toEqual([]);
  });

  it('syncOpenPrStatuses rebases a BEHIND factory PR even when the head is unsafe to relaunch', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'rebase') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: '../evil',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BEHIND',
            statusCheckRollup: [
              { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
            ],
          }),
        ),
        stderr: '',
      };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    expect((await service.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.pendingSteer).toBeNull();
    expect(t.body).toMatch(/Factory PR rebased via GitHub/);
    expect(t.body).not.toMatch(/System steer \(pr-behind\)/);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'rebase')).toBe(true);
  });

  it('syncOpenPrStatuses thrash-brakes a factory BEHIND loop without hercules/<id> rework', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'rebase') {
        return { exitCode: 1, stdout: '', stderr: 'cannot rebase: merge conflict' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: 'cursor/cloud-T-factory-abc',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BEHIND',
            statusCheckRollup: [
              { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
            ],
          }),
        ),
        stderr: '',
      };
    };
    const priorSteers = [
      '## System steer (pr-behind) (t1)',
      '',
      'first',
      '',
      '## System steer (pr-behind) (t2)',
      '',
      'second',
    ].join('\n');
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          body: `## Task\nfactory cut\n\n${priorSteers}\n`,
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toContain('T-factory');
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.pendingSteer).toBeNull();
    expect(t.body).toMatch(/Thrash brake \(pr-behind\)/);
    expect(t.body).toContain('cursor/cloud-T-factory-abc');
    expect(t.body).not.toMatch(/Work \*\*only\*\* on branch `hercules\/T-factory`/);
  });

  it('syncOpenPrStatuses marks a factory draft ready and stays in review', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'ready') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            ghPr('T-factory', 41, {
              state: 'OPEN',
              headRefName: 'cursor/cloud-T-factory-abc',
              mergeable: 'MERGEABLE',
              mergeStateStatus: 'DRAFT',
              isDraft: true,
              reviewDecision: '',
              title: 'factory',
              comments: [],
              reviews: [],
              statusCheckRollup: [
                { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
              ],
            }),
          ),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          body: '## Task\nfactory cut\n',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.prStatus).toBe('open');
    expect(t.pendingSteer).toBeNull();
    expect(t.body).toMatch(/Factory PR marked ready/);
    expect(t.body).toContain('https://github.com/example-org/acme/pull/41');
    expect(t.body).toMatch(/Not an Approve/);
    expect(t.verifiedSha ?? null).toBeNull();
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'ready')).toBe(true);
  });

  it('syncOpenPrStatuses does not rematch a factory draft after the ready audit', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'ready') {
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: 'cursor/cloud-T-factory-abc',
            mergeable: 'MERGEABLE',
            isDraft: true,
          }),
        ),
        stderr: '',
      };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          body: [
            '## Task',
            'factory cut',
            '',
            '## Factory PR marked ready (t)',
            '',
            'already converted',
            '',
          ].join('\n'),
        },
      ],
      undefined,
      gh,
    );
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('T-factory')!.state).toBe('review');
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'ready')).toBe(false);
  });

  it('syncOpenPrStatuses does not mark a grok draft ready', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-local', 41, {
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            isDraft: true,
          }),
        ),
        stderr: '',
      };
    };
    const original = {
      ...task('T-local', 'review'),
      adapter: 'grok' as const,
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prStatus: 'open' as const,
    };
    const { service, port } = svc([original], undefined, gh);
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('T-local')).toEqual(original);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'ready')).toBe(false);
  });

  it('syncOpenPrStatuses does not rematch a factory PR after the merge audit', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: 'cursor/cloud-T-factory-abc',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            isDraft: false,
            statusCheckRollup: [
              { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
            ],
          }),
        ),
        stderr: '',
      };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
          body: [
            '## Task',
            'factory cut',
            '',
            '## Factory PR merged via GitHub (t)',
            '',
            'already merged',
            '',
          ].join('\n'),
        },
      ],
      undefined,
      gh,
    );
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('T-factory')!.state).toBe('review');
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false);
  });

  it('syncOpenPrStatuses withholds a factory merge that GitHub rejects and does not hammer', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'merge') {
        return { exitCode: 1, stdout: '', stderr: 'required status checks have not passed' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: 'cursor/cloud-T-factory-abc',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            isDraft: false,
            statusCheckRollup: [
              { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
            ],
          }),
        ),
        stderr: '',
      };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    expect((await service.syncOpenPrStatuses()).updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('review');
    expect(t.prStatus).toBe('open');
    expect(t.body).toMatch(/Factory PR merge withheld/);
    expect(t.body).toMatch(/required status checks/);
    expect(t.verifiedSha ?? null).toBeNull();
    const mergeCalls = calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length;
    expect(mergeCalls).toBe(1);
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(calls.filter((args) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(1);
  });

  it('syncOpenPrStatuses does not squash-merge a grok CLEAN PR', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-local', 41, {
            state: 'OPEN',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            isDraft: false,
            statusCheckRollup: [
              { name: 'CI / gates', conclusion: 'SUCCESS', status: 'COMPLETED' },
            ],
          }),
        ),
        stderr: '',
      };
    };
    const original = {
      ...task('T-local', 'review'),
      adapter: 'grok' as const,
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prStatus: 'open' as const,
    };
    const { service, port } = svc([original], undefined, gh);
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('T-local')).toEqual(original);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false);
  });

  it('syncOpenPrStatuses leaves a CLEAN factory PR in review while checks are pending', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: 'cursor/cloud-T-factory-abc',
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'CLEAN',
            isDraft: false,
            statusCheckRollup: [
              { name: 'CI / gates', conclusion: '', status: 'IN_PROGRESS' },
            ],
          }),
        ),
        stderr: '',
      };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    await expect(service.syncOpenPrStatuses()).resolves.toEqual({ updated: [] });
    expect(port.tasks.get('T-factory')!.state).toBe('review');
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'merge')).toBe(false);
  });

  it('syncOpenPrStatuses prefers CONFLICTING over marking a factory draft ready', async () => {
    const calls: string[][] = [];
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      calls.push([...args]);
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          ghPr('T-factory', 41, {
            state: 'OPEN',
            headRefName: 'cursor/cloud-T-factory-abc',
            mergeable: 'CONFLICTING',
            isDraft: true,
          }),
        ),
        stderr: '',
      };
    };
    const { service, port } = svc(
      [
        {
          ...task('T-factory', 'review'),
          adapter: 'cursor',
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    const res = await service.syncOpenPrStatuses();
    expect(res.updated).toEqual(['T-factory']);
    const t = port.tasks.get('T-factory')!;
    expect(t.state).toBe('todo');
    expect(t.pendingSteer).toMatch(/CONFLICTING/i);
    expect(t.body).not.toMatch(/Factory PR marked ready/);
    expect(calls.some((args) => args[0] === 'pr' && args[1] === 'ready')).toBe(false);
  });

  it('prSummary writes back merged pr_status + merge provenance so Awaiting merge clears', async () => {
    const MERGE_SHA = '49e8150346e532312c129a14c1a66c9afecb462b';
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          exitCode: 0,
          stdout: JSON.stringify(ghPr('logout', 5, {
            state: 'MERGED',
            mergeable: 'UNKNOWN',
            reviewDecision: '',
            title: 'logout',
            comments: [],
            reviews: [],
            statusCheckRollup: [],
            mergeCommit: { oid: MERGE_SHA },
          })),
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [
        {
          ...task('logout', 'done'),
          prUrl: 'https://github.com/example-org/acme/pull/5',
          prStatus: 'open',
        },
      ],
      undefined,
      gh,
    );
    const summary = await service.prSummary('logout');
    expect(summary.state.toUpperCase()).toBe('MERGED');
    expect(summary.mergeCommitSha).toBe(MERGE_SHA);
    const t = port.tasks.get('logout')!;
    expect(t.prStatus).toBe('merged');
    expect(t.mergedSha).toBe(MERGE_SHA);
    expect(t.mergedVia).toBe('operator');
  });

  it('openPr creates a PR for a review task with file changes', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
      if (args[1] === 'create') {
        return { exitCode: 0, stdout: 'https://github.com/example-org/acme/pull/3\n', stderr: '' };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [{ ...task('A', 'review'), body: '## Review packet\n- `src/x.ts`\n' }],
      undefined,
      gh,
    );
    const pr = await service.openPr('A');
    expect(pr.mode).toBe('created');
    expect(pr.url).toContain('/pull/3');
    const saved = port.tasks.get('A')!;
    expect(saved.prUrl).toContain('/pull/3');
    expect(saved.prStatus).toBe('open');
  });

  it('approveAndOpenPr marks done and returns a PR url', async () => {
    const gh: import('../../src/orchestrator/openPr.js').GhRunner = async (args) => {
      if (args[1] === 'list') return { exitCode: 0, stdout: '[]', stderr: '' };
      if (args[1] === 'create') {
        return {
          exitCode: 0,
          stdout: 'https://github.com/example-org/acme/pull/4\n',
          stderr: '',
        };
      }
      return { exitCode: 1, stdout: '', stderr: 'nope' };
    };
    const { service, port } = svc(
      [{ ...task('A', 'review'), body: 'files touched' }],
      undefined,
      gh,
    );
    const { task: next, pr } = await service.approveAndOpenPr('A');
    expect(next.state).toBe('done');
    expect(port.tasks.get('A')!.state).toBe('done');
    expect(pr.url).toContain('/pull/4');
    expect(next.prStatus).toBe('open');
    expect(next.prUrl).toContain('/pull/4');
  });

  it('cancel moves an active task → cancelled', async () => {
    const { service, port } = svc([task('A', 'in_progress')]);
    await service.cancel('A');
    expect(port.tasks.get('A')!.state).toBe('cancelled');
  });

  it('retry moves failed → todo and resets attempts', async () => {
    const failed = { ...task('A', 'failed'), attempts: 3 };
    const { service, port } = svc([failed]);
    await service.retry('A');
    expect(port.tasks.get('A')!.state).toBe('todo');
    expect(port.tasks.get('A')!.attempts).toBe(0);
  });

  it('salvageFork creates a new task with durable provenance from failed source', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const source = {
      ...task('FAIL-SRC', 'failed'),
      title: 'Hard problem',
      body: '## Goal\nFinish it.\n\n## Acceptance criteria\n- [ ] (mechanical) tests pass\n\n## Review packet\nnoise\n',
      attempts: 3,
    };
    const port = new FakePort(new Map([[source.id, source]]));
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
        },
      },
    };
    const resolveCalls: { source: string; target: string }[] = [];
    let createCalled = false;
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => {
          createCalled = true;
          throw new Error('create not used during salvageFork');
        },
        preserve: async () => undefined,
        resolveSalvageSourceTip: async (_repo, sourceTaskId, targetTaskId) => {
          resolveCalls.push({ source: sourceTaskId, target: targetTaskId });
          return {
            sourceSha: sha,
            sourceBranch: `hercules/${sourceTaskId}`,
            targetBranch: `hercules/${targetTaskId}`,
          };
        },
      },
      verifier: {
        verify: async () => {
          throw new Error('no verify');
        },
      } as never,
    });

    const created = await service.salvageFork('FAIL-SRC', { id: 'FAIL-TGT' });
    expect(created.id).toBe('FAIL-TGT');
    expect(created.state).toBe('todo');
    expect(created.repo).toBe('app');
    expect(created.salvageSourceTask).toBe('FAIL-SRC');
    expect(created.salvageSourceSha).toBe(sha);
    expect(created.body).toMatch(/## Clean salvage provenance/);
    expect(created.body).toMatch(sha);
    expect(created.body).toMatch(/## Goal/);
    expect(created.body).toMatch(/Finish it/);
    expect(created.body).not.toMatch(/## Review packet/);
    expect(created.labels).toContain('salvage-fork');
    expect(resolveCalls).toEqual([{ source: 'FAIL-SRC', target: 'FAIL-TGT' }]);
    expect(createCalled).toBe(false);
    expect(port.commits.some((c) => c.includes('salvage-fork'))).toBe(true);
    // Source task untouched.
    expect(port.tasks.get('FAIL-SRC')!.state).toBe('failed');
  });

  it('salvageFork creates a new task with durable provenance from cancelled source', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const source = {
      ...task('CANC-SRC', 'cancelled'),
      title: 'Cleared from board',
      body:
        '## Goal\nFinish it.\n\n## Acceptance criteria\n- [ ] (mechanical) tests pass\n\n## Review packet\nnoise\n',
      attempts: 3,
    };
    const port = new FakePort(new Map([[source.id, source]]));
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
        },
      },
    };
    const resolveCalls: { source: string; target: string }[] = [];
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => {
          throw new Error('create not used during salvageFork');
        },
        preserve: async () => undefined,
        resolveSalvageSourceTip: async (_repo, sourceTaskId, targetTaskId) => {
          resolveCalls.push({ source: sourceTaskId, target: targetTaskId });
          return {
            sourceSha: sha,
            sourceBranch: 'hercules/' + sourceTaskId,
            targetBranch: 'hercules/' + targetTaskId,
          };
        },
      },
      verifier: {
        verify: async () => {
          throw new Error('no verify');
        },
      } as never,
    });

    const created = await service.salvageFork('CANC-SRC', { id: 'CANC-TGT' });
    expect(created.id).toBe('CANC-TGT');
    expect(created.state).toBe('todo');
    expect(created.repo).toBe('app');
    expect(created.salvageSourceTask).toBe('CANC-SRC');
    expect(created.salvageSourceSha).toBe(sha);
    expect(created.body).toMatch(/## Clean salvage provenance/);
    expect(created.body).toMatch(sha);
    expect(created.labels).toContain('salvage-fork');
    expect(resolveCalls).toEqual([{ source: 'CANC-SRC', target: 'CANC-TGT' }]);
    expect(port.tasks.get('CANC-SRC')!.state).toBe('cancelled');
  });

  it('salvageFork keeps workspaces receiver (this-dependent resolve must not be unbound)', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const source = {
      ...task('BIND-SRC', 'failed'),
      body: '## Goal\nShip\n\n## Acceptance criteria\n- [ ] (mechanical) ok\n',
    };
    const port = new FakePort(new Map([[source.id, source]]));
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
        },
      },
    };

    /**
     * Class method that requires `this` — an unbound extract+call throws
     * (undefined this under class fields / strict mode).
     */
    class ThisDependentWorkspaces {
      readonly #secret = sha;
      async create(): Promise<never> {
        throw new Error('create not used');
      }
      async preserve(): Promise<void> {
        return undefined;
      }
      async resolveSalvageSourceTip(
        _repo: { key: string },
        sourceTaskId: string,
        targetTaskId: string,
      ): Promise<{
        readonly sourceSha: string;
        readonly sourceBranch: string;
        readonly targetBranch: string;
      }> {
        // Access instance field — fails if called unbound.
        const tip = this.#secret;
        if (typeof tip !== 'string' || tip.length !== 40) {
          throw new Error('resolveSalvageSourceTip lost workspaces receiver (unbound this)');
        }
        return {
          sourceSha: tip,
          sourceBranch: `hercules/${sourceTaskId}`,
          targetBranch: `hercules/${targetTaskId}`,
        };
      }
    }

    const ws = new ThisDependentWorkspaces();
    // Sanity: unbound extraction would break this method.
    const unbound = ws.resolveSalvageSourceTip;
    await expect(unbound({ key: 'app' }, 'BIND-SRC', 'BIND-TGT')).rejects.toThrow();

    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: ws,
      verifier: {
        verify: async () => {
          throw new Error('no verify');
        },
      } as never,
    });

    const created = await service.salvageFork('BIND-SRC', { id: 'BIND-TGT' });
    expect(created.salvageSourceSha).toBe(sha);
    expect(created.id).toBe('BIND-TGT');
  });

  it('salvageFork refuses non-failed, collision, and missing resolve capability', async () => {
    const review = { ...task('R', 'review') };
    const { service: s1 } = svc([review]);
    await expect(s1.salvageFork('R')).rejects.toThrow(/failed/i);

    const failed = { ...task('F', 'failed') };
    const collision = { ...task('F-2', 'todo') };
    const port = new FakePort(
      new Map([
        [failed.id, failed],
        [collision.id, collision],
      ]),
    );
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
        },
      },
    };
    const withResolve = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => {
          throw new Error('unused');
        },
        preserve: async () => undefined,
        resolveSalvageSourceTip: async () => ({
          sourceSha: '0123456789abcdef0123456789abcdef01234567',
          sourceBranch: 'hercules/F',
          targetBranch: 'hercules/F-2',
        }),
      },
      verifier: { verify: async () => {
        throw new Error('no');
      } } as never,
    });
    await expect(withResolve.salvageFork('F', { id: 'F-2' })).rejects.toThrow(/exists|collision/i);

    const { service: noResolve } = svc([failed]);
    await expect(noResolve.salvageFork('F')).rejects.toThrow(/workspace|not available|resolve/i);
  });

  it('salvageFork maps missing source branch to ActionError', async () => {
    const failed = { ...task('F', 'failed') };
    const port = new FakePort(new Map([[failed.id, failed]]));
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
        },
      },
    };
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => {
          throw new Error('unused');
        },
        preserve: async () => undefined,
        resolveSalvageSourceTip: async () => {
          throw new Error('preserved branch hercules/F is missing — cannot seed');
        },
      },
      verifier: { verify: async () => {
        throw new Error('no');
      } } as never,
    });
    await expect(service.salvageFork('F', { id: 'NEW' })).rejects.toThrow(ActionError);
    await expect(service.salvageFork('F', { id: 'NEW' })).rejects.toThrow(/missing/i);
  });

  it('salvageFork protected-path reject does not write task and never creates a branch', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const source = {
      ...task('PP-SRC', 'failed'),
      body:
        '## Goal\nUpdate `core/tests/structural_guards.rs`.\n\n' +
        '## Acceptance criteria\n- [ ] (mechanical) done\n',
    };
    const port = new FakePort(new Map([[source.id, source]]));
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
        },
      },
    };
    let createCalled = false;
    const service = new ActionService(
      port,
      new FakeProbe(['main']),
      undefined,
      undefined,
      {
        workspaces: {
          create: async () => {
            createCalled = true;
            throw new Error('create must not run');
          },
          preserve: async () => undefined,
          resolveSalvageSourceTip: async () => ({
            sourceSha: sha,
            sourceBranch: 'hercules/PP-SRC',
            targetBranch: 'hercules/PP-TGT',
          }),
          readWorkflow: async () =>
            [
              '---',
              'gates:',
              '  test: pnpm test',
              'protected_paths:',
              '  - core/tests/structural_guards.rs',
              '---',
              'body',
            ].join('\n'),
        },
        verifier: { verify: async () => {
          throw new Error('no');
        } } as never,
      },
      {
        workspaces: {
          readWorkflow: async () =>
            [
              '---',
              'gates:',
              '  test: pnpm test',
              'protected_paths:',
              '  - core/tests/structural_guards.rs',
              '---',
              'body',
            ].join('\n'),
        },
      },
    );
    await expect(service.salvageFork('PP-SRC', { id: 'PP-TGT' })).rejects.toThrow(
      /保护路径|只能由人类完成/,
    );
    expect(port.tasks.has('PP-TGT')).toBe(false);
    expect(port.commits).toHaveLength(0);
    expect(createCalled).toBe(false);
  });

  it('salvageFork control write failure leaves no target task (resolve was read-only)', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const source = {
      ...task('WR-SRC', 'failed'),
      body: '## Goal\nShip\n\n## Acceptance criteria\n- [ ] (mechanical) ok\n',
    };
    class FailingPort extends FakePort {
      override async writeTask(): Promise<void> {
        throw new Error('control write failed');
      }
    }
    const port = new FailingPort(new Map([[source.id, source]]));
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
        },
      },
    };
    let createCalled = false;
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => {
          createCalled = true;
          throw new Error('create must not run');
        },
        preserve: async () => undefined,
        resolveSalvageSourceTip: async () => ({
          sourceSha: sha,
          sourceBranch: 'hercules/WR-SRC',
          targetBranch: 'hercules/WR-TGT',
        }),
      },
      verifier: { verify: async () => {
        throw new Error('no');
      } } as never,
    });
    await expect(service.salvageFork('WR-SRC', { id: 'WR-TGT' })).rejects.toThrow(
      /control write failed/,
    );
    expect(port.tasks.has('WR-TGT')).toBe(false);
    expect(port.commits).toHaveLength(0);
    expect(createCalled).toBe(false);
  });

  it('salvageFork thrown commit failure rolls back uncommitted target (no task, no branch create)', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const source = {
      ...task('CM-SRC', 'failed'),
      body: '## Goal\nShip\n\n## Acceptance criteria\n- [ ] (mechanical) ok\n',
    };
    class CommitThrowPort extends FakePort {
      override async commit(): Promise<{ committed: boolean }> {
        throw new Error('control commit failed');
      }
    }
    const port = new CommitThrowPort(new Map([[source.id, source]]));
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
        },
      },
    };
    let createCalled = false;
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => {
          createCalled = true;
          throw new Error('create must not run');
        },
        preserve: async () => undefined,
        resolveSalvageSourceTip: async () => ({
          sourceSha: sha,
          sourceBranch: 'hercules/CM-SRC',
          targetBranch: 'hercules/CM-TGT',
        }),
      },
      verifier: { verify: async () => {
        throw new Error('no');
      } } as never,
    });
    await expect(service.salvageFork('CM-SRC', { id: 'CM-TGT' })).rejects.toThrow(
      /commit failed|rolled back/i,
    );
    // Write may have staged the file; commit failure must delete it so dispatch cannot see it.
    expect(port.tasks.has('CM-TGT')).toBe(false);
    expect(port.tasks.has('CM-SRC')).toBe(true);
    expect(port.commits).toHaveLength(0);
    expect(createCalled).toBe(false);
  });

  it('salvageFork commit returned committed:false rolls back uncommitted target', async () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const source = {
      ...task('CF-SRC', 'failed'),
      body: '## Goal\nShip\n\n## Acceptance criteria\n- [ ] (mechanical) ok\n',
    };
    class CommitFalsePort extends FakePort {
      override async commit(): Promise<{ committed: boolean }> {
        this.commits.push('(no-op commit)');
        return { committed: false };
      }
    }
    const port = new CommitFalsePort(new Map([[source.id, source]]));
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
        },
      },
    };
    let createCalled = false;
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces: {
        create: async () => {
          createCalled = true;
          throw new Error('create must not run');
        },
        preserve: async () => undefined,
        resolveSalvageSourceTip: async () => ({
          sourceSha: sha,
          sourceBranch: 'hercules/CF-SRC',
          targetBranch: 'hercules/CF-TGT',
        }),
      },
      verifier: { verify: async () => {
        throw new Error('no');
      } } as never,
    });
    await expect(service.salvageFork('CF-SRC', { id: 'CF-TGT' })).rejects.toThrow(
      /committed:false|rolled back/i,
    );
    expect(port.tasks.has('CF-TGT')).toBe(false);
    expect(port.tasks.has('CF-SRC')).toBe(true);
    expect(createCalled).toBe(false);
  });

  it('salvageFork never hardcodes sourceBranchPresent:true after resolve (no branch-presence fiction)', async () => {
    // Regression: afterResolve used to re-call validateSalvageForkRequest with a
    // hardcoded branch-presence flag. Successful resolve + full SHA is enough.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { join, dirname } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(join(here, '../../src/orchestrator/actions.ts'), 'utf8');
    const start = src.indexOf('async salvageFork(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('async retry(', start);
    const body = src.slice(start, end > start ? end : undefined);
    // Strip line comments so narrative text cannot false-positive the ban.
    const codeOnly = body
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(codeOnly).not.toMatch(/sourceBranchPresent\s*:\s*true\b/);
    expect(codeOnly).not.toMatch(/\bafterResolve\b/);
    // Evidence path remains: resolve tip + full-SHA check on the workspaces receiver.
    expect(codeOnly).toMatch(/ws\.resolveSalvageSourceTip\s*\(/);
    expect(codeOnly).not.toMatch(
      /const\s+resolve\s*=\s*.*resolveSalvageSourceTip/,
    );
    expect(codeOnly).toMatch(/\[0-9a-f\]\{40\}/);
  });

  it('retry clears host approval and requires a fresh approval before dispatch', async () => {
    const failed = {
      ...task('HOST', 'failed'),
      executionClass: 'deploy' as const,
      adapter: 'grok' as const,
      hostCommandScope: ['./scripts/deploy.sh'],
      hostApprovedAt: '2026-07-31T06:00:00.000Z',
      attempts: 1,
    };
    const { service } = svc([failed]);
    const next = await service.retry('HOST');
    expect(next.state).toBe('todo');
    expect(next.hostCommandScope).toBeNull();
    expect(next.hostApprovedAt).toBeNull();
  });

  it('retry after agent_exit abandons poisoned agent_session', async () => {
    const body = [
      '## Run failure (t)',
      '',
      '**Kind:** `agent_exit`',
      '**Attempt:** 2 / 3',
      '**Exit code:** 1',
      '',
    ].join('\n');
    const failed = {
      ...task('A', 'failed'),
      attempts: 2,
      agentSession: 'sess-poison',
      agentSessionAdapter: 'grok' as const,
      body,
    };
    const { service, port } = svc([failed]);
    await service.retry('A');
    const t = port.tasks.get('A')!;
    expect(t.state).toBe('todo');
    expect(t.attempts).toBe(0);
    expect(t.agentSession).toBeNull();
    expect(t.agentSessionAdapter).toBeNull();
    expect(t.body).toMatch(/已放弃损坏会话|abandoned corrupted session/i);
    expect(t.body).not.toMatch(/sess-poison/);
  });

  it('retry after stall keeps agent_session (not agent_exit poison path)', async () => {
    const body = [
      '## Run failure (t)',
      '',
      '**Kind:** `stall`',
      '**Attempt:** 1 / 3',
      '',
    ].join('\n');
    const failed = {
      ...task('A', 'failed'),
      attempts: 1,
      agentSession: 'sess-keep',
      body,
    };
    const { service, port } = svc([failed]);
    await service.retry('A');
    expect(port.tasks.get('A')!.agentSession).toBe('sess-keep');
    expect(port.tasks.get('A')!.body).not.toMatch(/已放弃损坏会话/);
  });

  it('retry recovers retrying and cancelled to todo with attempts/backoff reset', async () => {
    const body = [
      '## Task',
      '',
      'preserve this audit history',
      '',
      '## Run failure (t)',
      '',
      '**Kind:** `agent_exit`',
      '**Next eligible:** `2099-01-01T00:00:00.000Z`',
      '',
    ].join('\n');
    for (const state of ['retrying', 'cancelled'] as const) {
      const prior = {
        ...task('R1', state),
        attempts: 3,
        lastEventAt: '2026-08-01T00:00:00.000Z',
        agentSession: 'sess-poison',
        body,
      };
      const { service, port } = svc([prior]);
      const next = await service.retry('R1');
      expect(next.state).toBe('todo');
      expect(next.attempts).toBe(0);
      expect(next.lastEventAt).toBeNull();
      expect(next.agentSession).toBeNull();
      // Branch identity fields preserved; audit body kept (plus abandon note).
      expect(port.tasks.get('R1')!.body).toMatch(/preserve this audit history/);
      expect(port.tasks.get('R1')!.body).toMatch(/已放弃损坏会话|abandoned corrupted session/i);
    }
  });

  it('retry never resurrects deleted tasks', async () => {
    const { service } = svc([task('GONE', 'deleted')]);
    await expect(service.retry('GONE')).rejects.toThrow(/deleted|restore/i);
  });

  it('retry rejects states outside failed/retrying/cancelled', async () => {
    const { service } = svc([task('OK', 'todo')]);
    await expect(service.retry('OK')).rejects.toThrow(/Retry only from/);
  });

  it('rejects an illegal transition (approve a todo task)', async () => {
    const { service } = svc([task('A', 'todo')]);
    await expect(service.approve('A')).rejects.toThrow(ActionError);
  });

  it('rejects acting on an unknown task', async () => {
    const { service } = svc();
    await expect(service.approve('NOPE')).rejects.toThrow(ActionError);
  });
});

describe('ActionService.addRepo', () => {
  it('registers a reachable repo and commits it', async () => {
    const { service, port } = svc();
    const repo = await service.addRepo({ key: 'svc', url: '/srv/svc', defaultBranch: 'main' });
    expect(repo.key).toBe('svc');
    expect(repo.workflow).toBe('WORKFLOW.md');
    expect(repo.maxConcurrent).toBe(1);
    expect(port.repos.repos['svc']).toEqual(repo);
    expect(port.commits.at(-1)).toMatch(/add repo svc/);
  });

  it('rejects an unsafe key', async () => {
    const { service } = svc();
    await expect(service.addRepo({ key: '../evil', url: 'x', defaultBranch: 'main' }))
      .rejects.toBeInstanceOf(ActionError);
  });

  it('rejects a duplicate key', async () => {
    const { service } = svc();
    await expect(service.addRepo({ key: 'app', url: 'x', defaultBranch: 'main' }))
      .rejects.toThrow(/already exists/);
  });

  it('rejects an unreachable url', async () => {
    const { service } = svc([], new FakeProbe(new RepoProbeError('nope')));
    await expect(service.addRepo({ key: 'svc', url: 'x', defaultBranch: 'main' }))
      .rejects.toThrow(/not reachable/);
  });

  it('rejects when defaultBranch is absent from a non-empty remote', async () => {
    const { service } = svc([], new FakeProbe(['main', 'dev']));
    await expect(service.addRepo({ key: 'svc', url: 'x', defaultBranch: 'release' }))
      .rejects.toThrow(/default branch 'release'/);
  });

  it('accepts an empty remote (no heads)', async () => {
    const { service } = svc([], new FakeProbe([]));
    const repo = await service.addRepo({ key: 'svc', url: 'x', defaultBranch: 'main' });
    expect(repo.key).toBe('svc');
  });

  it('rejects an unsafe url (ext:: transport)', async () => {
    // FakeProbe that throws if called — proves we reject before probing
    const neverProbe = new FakeProbe(new Error('probe must not be called'));
    const { service } = svc([], neverProbe);
    await expect(service.addRepo({ key: 'svc', url: 'ext::sh -c whoami', defaultBranch: 'main' }))
      .rejects.toBeInstanceOf(ActionError);
  });
});

describe('ActionService.editRepo', () => {
  it('edits caps without re-probing', async () => {
    const { service, port } = svc([], new FakeProbe(new RepoProbeError('should not be called')));
    const repo = await service.editRepo('app', { maxConcurrent: 4, adapter: null, readiness: 'ready' });
    expect(repo.maxConcurrent).toBe(4);
    expect(port.repos.repos['app']!.maxConcurrent).toBe(4);
  });

  it('re-probes when url changes and rejects if unreachable', async () => {
    const { service } = svc([], new FakeProbe(new RepoProbeError('nope')));
    await expect(service.editRepo('app', { url: '/new' })).rejects.toThrow(/not reachable/);
  });

  it('rejects editing an unknown repo', async () => {
    const { service } = svc();
    await expect(service.editRepo('ghost', { maxConcurrent: 2, adapter: null, readiness: 'ready' })).rejects.toThrow(/unknown repo/);
  });

  it('rejects an unsafe url (ext:: transport) without probing', async () => {
    const neverProbe = new FakeProbe(new Error('probe must not be called'));
    const { service } = svc([], neverProbe);
    await expect(service.editRepo('app', { url: 'ext::sh -c x' }))
      .rejects.toBeInstanceOf(ActionError);
  });

  it('soft-blocks incomplete→ready when readiness probe fails (forceReady overrides)', async () => {
    const port = new FakePort(new Map());
    port.repos = {
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
    const readinessDeps = {
      workspaces: {
        async readWorkflow() {
          return null;
        },
        async readTrustedFile() {
          return null;
        },
      },
    };
    const service = new ActionService(
      port,
      new FakeProbe(['main']),
      undefined,
      undefined,
      undefined,
      readinessDeps,
    );
    await expect(service.editRepo('app', { readiness: 'ready' })).rejects.toThrow(
      /readiness soft-check failed/,
    );
    const forced = await service.editRepo('app', { readiness: 'ready', forceReady: true });
    expect(forced.readiness).toBe('ready');
  });

  it('allows incomplete→ready when soft-check passes', async () => {
    const port = new FakePort(new Map());
    port.repos = {
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
behavioral:
  base_url: http://localhost:{port}
  capture: [screenshot]
gates:
  test: pnpm test
---
# policy
`;
    const goodAgents = `# Agent map\n\nRead WORKFLOW.md. Layout under src/.\n`;
    const service = new ActionService(
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
    const repo = await service.editRepo('app', { readiness: 'ready' });
    expect(repo.readiness).toBe('ready');
  });

  it('checkRepoReadiness returns score checklist without mutating readiness', async () => {
    const port = new FakePort(new Map());
    port.repos = {
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
behavioral:
  base_url: http://localhost:{port}
  capture: [screenshot]
gates:
  test: pnpm test
---
# policy
`;
    const goodAgents = `# Agent map\n\nRead WORKFLOW.md. Layout under src/.\n`;
    const service = new ActionService(
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
    const check = await service.checkRepoReadiness('app');
    expect(check.ok).toBe(true);
    expect(check.score.total).toBe(7);
    expect(check.score.requiredPassed).toBe(check.score.requiredTotal);
    expect(check.checks.find((c) => c.id === 'workflow-boot')?.required).toBe(false);
    expect(check.checks.find((c) => c.id === 'agents-budget')?.ok).toBe(true);
    // Soft probe never flips repos.yaml.
    expect(port.repos.repos['app']!.readiness).toBe('incomplete');
  });
});

describe('ActionService.removeRepo', () => {
  it('removes a repo with no tasks', async () => {
    const { service, port } = svc();
    const res = await service.removeRepo('app');
    expect(res).toEqual({ removed: 'app' });
    expect('app' in port.repos.repos).toBe(false);
    expect(port.commits.at(-1)).toMatch(/remove repo app/);
  });

  it('refuses to remove a repo that tasks still reference', async () => {
    const { service } = svc([task('T-1')]); // task('T-1') has repo: 'app'
    await expect(service.removeRepo('app')).rejects.toThrow(/task/);
  });

  it('evicts readinessJobs entries when repos are removed', async () => {
    const { service, port } = svc();
    await service.addRepo({ key: 'alpha', url: '/srv/alpha', defaultBranch: 'main' });
    await service.addRepo({ key: 'beta', url: '/srv/beta', defaultBranch: 'main' });
    await service.addRepo({ key: 'gamma', url: '/srv/gamma', defaultBranch: 'main' });

    await service.startRepoReadinessCheck('alpha');
    await service.startRepoReadinessCheck('beta');
    await service.startRepoReadinessCheck('gamma');

    // Without readinessDeps the check finishes in-process; wait for done.
    for (const key of ['alpha', 'beta', 'gamma'] as const) {
      let status = 'running';
      for (let i = 0; i < 50 && status === 'running'; i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        status = (await service.getRepoReadinessJob(key)).status;
      }
      expect(status).toBe('done');
    }

    await service.removeRepo('alpha');
    await service.removeRepo('beta');
    await service.removeRepo('gamma');
    expect('alpha' in port.repos.repos).toBe(false);
    expect('beta' in port.repos.repos).toBe(false);
    expect('gamma' in port.repos.repos).toBe(false);

    // Re-add: prior jobs must be gone (idle), not stale done/running.
    await service.addRepo({ key: 'alpha', url: '/srv/alpha', defaultBranch: 'main' });
    await service.addRepo({ key: 'beta', url: '/srv/beta', defaultBranch: 'main' });
    await service.addRepo({ key: 'gamma', url: '/srv/gamma', defaultBranch: 'main' });
    expect((await service.getRepoReadinessJob('alpha')).status).toBe('idle');
    expect((await service.getRepoReadinessJob('beta')).status).toBe('idle');
    expect((await service.getRepoReadinessJob('gamma')).status).toBe('idle');
  });
});

describe('ActionService.editRepo autoMerge', () => {
  it('persists defaults when setting autoMerge enabled only', async () => {
    const { service, port } = svc([], new FakeProbe(new RepoProbeError('should not be called')));
    const repo = await service.editRepo('app', { autoMerge: { enabled: true } });
    expect(repo.autoMerge).toEqual({
      enabled: true,
      dwellMinutes: 30,
      maxSize: 'M',
    });
    expect(port.repos.repos['app']!.autoMerge).toEqual({
      enabled: true,
      dwellMinutes: 30,
      maxSize: 'M',
    });
  });

  it('clears autoMerge when patch sets null', async () => {
    const { service, port } = svc([], new FakeProbe(new RepoProbeError('should not be called')));
    await service.editRepo('app', { autoMerge: { enabled: true, dwellMinutes: 15, maxSize: 'S' } });
    const cleared = await service.editRepo('app', { autoMerge: null });
    expect(cleared.autoMerge).toBeUndefined();
    expect(port.repos.repos['app']!.autoMerge).toBeUndefined();
  });

  it('preserves autoMerge when the field is omitted', async () => {
    const { service, port } = svc([], new FakeProbe(new RepoProbeError('should not be called')));
    await service.editRepo('app', { autoMerge: { enabled: true, dwellMinutes: 12, maxSize: 'L' } });
    const kept = await service.editRepo('app', { maxConcurrent: 2 });
    expect(kept.autoMerge).toEqual({
      enabled: true,
      dwellMinutes: 12,
      maxSize: 'L',
    });
    expect(port.repos.repos['app']!.autoMerge).toEqual({
      enabled: true,
      dwellMinutes: 12,
      maxSize: 'L',
    });
  });

  it('rejects invalid autoMerge maxSize with ActionError', async () => {
    const { service } = svc([], new FakeProbe(new RepoProbeError('should not be called')));
    await expect(
      service.editRepo('app', {
        autoMerge: { enabled: true, maxSize: 'XL' as 'S' },
      }),
    ).rejects.toThrow(/invalid autoMerge/);
  });
});

describe('ActionService key-safety checks', () => {
  it('editRepo rejects an unsafe key (../evil) with ActionError before any lookup', async () => {
    const { service } = svc();
    await expect(service.editRepo('../evil', { maxConcurrent: 2, adapter: null, readiness: 'ready' }))
      .rejects.toBeInstanceOf(ActionError);
  });

  it('removeRepo rejects an unsafe key (../evil) with ActionError', async () => {
    const { service } = svc();
    await expect(service.removeRepo('../evil'))
      .rejects.toBeInstanceOf(ActionError);
  });
});

describe('ActionService.reverify', () => {
  it('real-git: two scope-blocked reverify allocations leave the exact remote ref unchanged', async () => {
    const testRoot = await mkdtemp(join(tmpdir(), 'reverify-scope-real-git-'));
    const remote = join(testRoot, 'remote');
    await mkdir(remote, { recursive: true });
    const remoteGit = simpleGit(remote);
    await remoteGit.init(['-b', 'main']);
    await remoteGit.addConfig('user.email', 't@h.local');
    await remoteGit.addConfig('user.name', 'T');
    await writeFile(
      join(remote, 'WORKFLOW.md'),
      '---\ngates:\n  test: "true"\nprotected_paths: []\n---\n',
    );
    await writeFile(join(remote, 'base.txt'), 'base\n');
    await remoteGit.add(['-A']);
    await remoteGit.commit('base');

    const repo = {
      key: 'app', url: remote, defaultBranch: 'main', workflow: 'WORKFLOW.md',
      maxConcurrent: 1, adapter: null, readiness: 'ready' as const,
    };
    const workspaces = new GitWorkspaces({
      root: join(testRoot, 'work'), ports: new PortAllocator(7100, 4), push: true,
    });
    const initial = await workspaces.create(repo, 'task-scope-real');
    const candidateGit = simpleGit(initial.dir);
    await writeFile(join(initial.dir, 'owned.ts'), 'owned\n');
    await writeFile(join(initial.dir, 'foreign.txt'), 'foreign\n');
    await candidateGit.add(['-A']);
    await candidateGit.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'candidate with undeclared path',
    ]);
    const candidate = (await candidateGit.revparse(['HEAD'])).trim();
    const preserved = await workspaces.preserve(
      'task-scope-real', 'hercules: task-scope-real — preserve',
    );
    expect(preserved.branchLease?.expectedRemoteTip).toBe(candidate);

    const original = {
      ...task('task-scope-real', 'review'),
      verifiedSha: candidate,
      expectedBaseRevision: initial.branchLease.expectedBaseRevision,
      expectedRemoteTip: candidate,
      plannedBaseRevision: initial.branchLease.expectedBaseRevision,
      affectedPaths: ['owned.ts'],
      protectedPathsSnapshot: [],
    };
    const port = new FakePort(new Map([[original.id, original]]));
    port.repos = { repos: { app: repo } };
    const leaseRoot = join(testRoot, 'leases');
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces,
      verifier: new WorktreeVerifier({ workspaces }),
      pathLeaseStore: new TaskPathLeaseStore(leaseRoot),
    });
    const remoteRef = 'refs/heads/hercules/task-scope-real';

    await service.reverify(original.id);
    expect((await remoteGit.revparse([remoteRef])).trim()).toBe(candidate);
    await service.reverify(original.id);
    expect((await remoteGit.revparse([remoteRef])).trim()).toBe(candidate);
    expect(port.tasks.get(original.id)).toMatchObject({
      state: 'review', expectedRemoteTip: candidate, verifiedSha: candidate,
    });
  }, 20_000);

  it('removes a scope-blocked disposable allocation without preserving or moving the candidate', async () => {
    const candidate = '2'.repeat(40);
    const original = {
      ...task('task-scope', 'review'),
      verifiedSha: candidate,
      expectedBaseRevision: '1'.repeat(40),
      expectedRemoteTip: candidate,
      plannedBaseRevision: '1'.repeat(40),
      affectedPaths: ['src/'],
      protectedPathsSnapshot: [],
    };
    const port = new FakePort(new Map([[original.id, original]]));
    const events: string[] = [];
    const workspaces = {
      readTrustedDefaultRevisionSnapshot: async () => ({
        revision: original.plannedBaseRevision,
        workflowContent: '---\nprotected_paths: []\n---\n',
      }),
      create: async () => ({
        taskId: original.id,
        repo: 'app',
        dir: '/tmp/disposable',
        branch: `hercules/${original.id}`,
        allocation: { slug: original.id, port: 1, scratchDir: '/tmp/s' },
        branchLease: {
          expectedBaseRevision: original.expectedBaseRevision,
          expectedRemoteTip: candidate,
        },
      }),
      preserve: async () => {
        events.push('preserve');
      },
      remove: async () => {
        events.push('remove');
      },
    };
    const verifier = {
      verify: async (): Promise<import('../../src/domain/verification.js').ReviewPacket> => ({
        taskId: original.id,
        branch: `hercules/${original.id}`,
        filesTouched: ['src/a.ts', 'foreign.txt'],
        diffSummary: '2 files',
        diff: '+foreign',
        gates: [{ name: 'path-lease-scope', command: 'hercules:path-lease-scope', passed: false, output: 'foreign.txt' }],
        cheatFindings: [], screenshots: [], reviewerVerdict: null,
        selfAssessment: '', finalReport: '', green: false, noChanges: false,
        autoRework: true, reportPolluted: false,
        dod: { mechanical: 'fail', reviewer: 'pending', human: 'pending', criteria: [], warnings: [] },
        activityLog: [], runKind: 'implementer', reviewerSkipReason: null,
        diffUrl: null, evidenceMatrix: [],
        verifiedSha: '3'.repeat(40), reworkPath: 'full', reworkPathReason: 'scope',
      }),
    };
    const storeRoot = await mkdtemp(join(tmpdir(), 'reverify-scope-'));
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces,
      verifier,
      pathLeaseStore: new TaskPathLeaseStore(storeRoot),
    });

    const first = await service.reverify(original.id);
    expect(events).toEqual(['remove']);
    expect(first.state).toBe('review');
    expect(first.expectedRemoteTip).toBe(candidate);
    expect(first.verifiedSha).toBe(candidate);
    expect(first.body).toContain('path-lease-scope');

    events.length = 0;
    await service.reverify(original.id);
    expect(events).toEqual(['remove']);
  });

  it('records the packet SHA when a green re-verify observes a newer branch tip', async () => {
    const priorSha = 'a'.repeat(40);
    const currentSha = 'b'.repeat(40);
    const acquiredBase = '1'.repeat(40);
    const acquiredTip = '2'.repeat(40);
    const publishedTip = '3'.repeat(40);
    const port = new FakePort(new Map([['task-green', {
      ...task('task-green', 'review'),
      verifiedSha: priorSha,
    }]]));
    port.repos = {
      repos: { app: { key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' } },
    };
    const workspaces = {
      create: async () => ({ taskId: 'task-green', repo: 'app', dir: '/tmp/wt', branch: 'hercules/task-green', allocation: { slug: 'task-green', port: 1, scratchDir: '/tmp/s' }, branchLease: { expectedBaseRevision: acquiredBase, expectedRemoteTip: acquiredTip } }),
      preserve: async () => ({
        notPropagated: false,
        events: [],
        branchLease: { expectedBaseRevision: acquiredBase, expectedRemoteTip: publishedTip },
      }),
    };
    const verifier = {
      verify: async () => {
        const durable = port.tasks.get('task-green')!;
        expect(durable.expectedBaseRevision).toBe(acquiredBase);
        expect(durable.expectedRemoteTip).toBe(acquiredTip);
        expect(port.commits.at(-1)).toContain('acquire exact task-branch lease for re-verify');
        return ({
          taskId: 'task-green', branch: 'hercules/task-green', filesTouched: ['x'], diffSummary: 'x', diff: '+x',
          gates: [], cheatFindings: [], screenshots: [], reviewerVerdict: null, selfAssessment: '', finalReport: '',
          green: true, noChanges: false, autoRework: false, reportPolluted: false,
          dod: { mechanical: 'pass', reviewer: 'pass', human: 'pending', criteria: [], warnings: [] },
          activityLog: [], runKind: 'implementer' as const, reviewerSkipReason: null, usage: null,
          evidenceRun: undefined, reportNoise: [], diffUrl: null, evidenceMatrix: [], verifiedSha: currentSha,
          reworkPath: null, reworkPathReason: null,
        }) as unknown as import('../../src/domain/verification.js').ReviewPacket;
      },
    };
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, { workspaces, verifier });
    const next = await service.reverify('task-green');
    expect(next.verifiedSha).toBe(currentSha);
    expect(port.tasks.get('task-green')!.verifiedSha).toBe(currentSha);
    expect(next.expectedRemoteTip).toBe(publishedTip);
    expect(port.tasks.get('task-green')!.expectedRemoteTip).toBe(publishedTip);
    expect(port.commits.at(-1)).toContain('advance exact task-branch lease');
  });

  it('does not run re-verify when its acquired branch lease is not durable', async () => {
    class RejectLeaseCommitPort extends FakePort {
      override async commit(message: string): Promise<{ committed: boolean }> {
        if (message.includes('acquire exact task-branch lease')) {
          return { committed: false };
        }
        return super.commit(message);
      }
    }
    const planned = '9'.repeat(40);
    const original = {
      ...task('task-lease-fail', 'review'),
      plannedBaseRevision: planned,
      affectedPaths: ['src/a.ts'],
      protectedPathsSnapshot: [],
    };
    const port = new RejectLeaseCommitPort(new Map([[original.id, original]]));
    let verifierRuns = 0;
    const workspaces = {
      readTrustedDefaultRevisionSnapshot: async () => ({
        revision: planned,
        workflowContent: '---\nprotected_paths: []\n---\n',
      }),
      create: async () => ({
        taskId: original.id,
        repo: 'app',
        dir: '/tmp/wt',
        branch: `hercules/${original.id}`,
        allocation: { slug: original.id, port: 1, scratchDir: '/tmp/s' },
        branchLease: { expectedBaseRevision: '4'.repeat(40), expectedRemoteTip: null },
      }),
      preserve: async () => {},
    };
    const verifier = {
      verify: async () => {
        verifierRuns += 1;
        throw new Error('must not run');
      },
    };
    const leaseRoot = await mkdtemp(join(tmpdir(), 'reverify-lease-fail-'));
    const pathLeaseStore = new TaskPathLeaseStore(leaseRoot);
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces,
      verifier: verifier as unknown as import('../../src/orchestrator/verifier.js').Verifier,
      pathLeaseStore,
    });

    await expect(service.reverify(original.id)).rejects.toThrow(/lease update failed/);

    expect(verifierRuns).toBe(0);
    expect(port.tasks.get(original.id)).toEqual(original);
    expect(await pathLeaseStore.list('app')).toEqual([]);
  });

  it('requeues review → todo when packet autoRework (task-5 stuck-review case)', async () => {
    const port = new FakePort(
      new Map([
        [
          'task-5',
          {
            ...task('task-5', 'review'),
            body: '## Task\nPTR\n',
            agentSession: 'sess',
          },
        ],
      ]),
    );
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
        },
      },
    };
    const workspaces = {
      create: async () => ({
        taskId: 'task-5',
        repo: 'app',
        dir: '/tmp/wt',
        branch: 'hercules/task-5',
        allocation: { slug: 'task-5', port: 1, scratchDir: '/tmp/s' },
        branchLease: { expectedBaseRevision: '0'.repeat(40), expectedRemoteTip: null },
      }),
      preserve: async () => {},
    };
    const verifier = {
      verify: async () =>
        ({
          taskId: 'task-5',
          branch: 'hercules/task-5',
          filesTouched: ['src/web/PullToRefresh.tsx'],
          diffSummary: '1 file',
          diff: '+x',
          gates: [{ name: 'test', command: 't', passed: true, output: '' }],
          cheatFindings: [],
          screenshots: [],
          reviewerVerdict: { approved: false, summary: 'layout', comments: ['fix offset'] },
          selfAssessment: 're-verify',
          finalReport: '',
          green: false,
          noChanges: false,
          autoRework: true,
          reportPolluted: false,
          dod: {
            mechanical: 'pass',
            reviewer: 'fail',
            human: 'pending',
            criteria: [],
            warnings: [],
          },
          activityLog: [],
          runKind: 'implementer' as const,
          reviewerSkipReason: null,
          usage: null,
          evidenceRun: undefined,
          reportNoise: [],
          diffUrl: null,
          evidenceMatrix: [],
        }) as unknown as import('../../src/domain/verification.js').ReviewPacket,
    };
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces,
      verifier,
    });
    const next = await service.reverify('task-5');
    expect(next.state).toBe('todo');
    expect(port.tasks.get('task-5')!.state).toBe('todo');
    expect(port.commits.at(-1)).toMatch(/todo/);
    expect(next.body).toMatch(/re-queued|auto-rework|todo/i);
  });
});

describe('ActionService.amendPathLease', () => {
  const base = '1'.repeat(40);
  const tip = '2'.repeat(40);
  const currentBase = '3'.repeat(40);
  const original = {
    ...task('LEASE-AMEND', 'review'),
    plannedBaseRevision: base,
    affectedPaths: ['src/old.ts'],
    protectedPathsSnapshot: ['test/invariants/**'],
    expectedBaseRevision: base,
    expectedRemoteTip: tip,
    verifiedSha: tip,
    lastEventAt: '2026-08-04T00:00:00.000Z',
    body: 'keep body exact',
  };
  const input = {
    expected: {
      state: 'review' as const,
      plannedBaseRevision: base,
      expectedBaseRevision: base,
      affectedPaths: ['src/old.ts'],
      protectedPathsSnapshot: ['test/invariants/**'],
      expectedRemoteTip: tip,
      verifiedSha: tip,
      lastEventAt: original.lastEventAt,
    },
    replacement: {
      plannedBaseRevision: currentBase,
      affectedPaths: ['src/'],
      protectedPathsSnapshot: ['test/invariants/**'],
    },
  };

  class AtomicPort extends FakePort {
    beforeMutation: (() => void) | null = null;
    async mutateCommitted(
      mutation: import('../../src/orchestrator/orchestrator.js').ControlMutation,
      message: string,
    ): Promise<{ committed: boolean }> {
      this.beforeMutation?.();
      this.beforeMutation = null;
      for (const write of mutation.writeTasks ?? []) {
        const current = this.tasks.get(write.next.id) ?? null;
        if (JSON.stringify(current) !== JSON.stringify(write.expected)) {
          throw new Error(`task '${write.next.id}' changed before atomic mutation`);
        }
      }
      for (const write of mutation.writeTasks ?? []) this.tasks.set(write.next.id, write.next);
      this.commits.push(message);
      return { committed: true };
    }
  }

  function amendmentService(overrides: {
    task?: Task;
    files?: readonly string[];
    tip?: string;
    workflow?: string | null;
    trustedTip?: string;
    inspectError?: Error;
    port?: AtomicPort;
    inspectedBases?: string[];
  } = {}) {
    const selected = overrides.task ?? original;
    const port = overrides.port ?? new AtomicPort(new Map([[selected.id, selected]]));
    const workspaces = {
      create: async () => { throw new Error('unused'); },
      preserve: async () => {},
      inspectPreservedCandidate: async (
        _repo: RepoConfig,
        _taskId: string,
        _expectedTip: string,
        inspectedBase: string,
      ) => {
        overrides.inspectedBases?.push(inspectedBase);
        if (overrides.inspectError) throw overrides.inspectError;
        return {
          tip: overrides.tip ?? tip,
          filesTouched: overrides.files ?? ['src/new.ts'],
          trustedDefaultRevision: overrides.trustedTip ?? currentBase,
          workflowContentAtTrustedDefault: overrides.workflow === undefined
            ? '---\nprotected_paths:\n  - test/invariants/**\n---\n'
            : overrides.workflow,
        };
      },
    };
    const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
      workspaces,
      verifier: { verify: async () => { throw new Error('unused'); } },
    });
    return { service, port };
  }

  it('changes only the normalized complete declaration in one audited exact-CAS commit', async () => {
    const inspectedBases: string[] = [];
    const { service, port } = amendmentService({ inspectedBases });
    const next = await service.amendPathLease(original.id, input);
    expect(next).toEqual({
      ...original,
      plannedBaseRevision: currentBase,
      expectedBaseRevision: currentBase,
      affectedPaths: ['src/'],
      protectedPathsSnapshot: ['test/invariants/**'],
    });
    expect(inspectedBases).toEqual([base]);
    expect(port.commits).toEqual([`hercules: amend path lease ${original.id}`]);
  });

  it('allows a cancelled task and retains its exact older base after trusted main advances', async () => {
    const cancelled = { ...original, state: 'cancelled' as const };
    const request = {
      ...input,
      expected: { ...input.expected, state: 'cancelled' as const },
    };
    const { service, port } = amendmentService({
      task: cancelled,
      trustedTip: currentBase,
    });
    await expect(service.amendPathLease(cancelled.id, request)).resolves.toMatchObject({
      state: 'cancelled',
      plannedBaseRevision: currentBase,
      expectedBaseRevision: currentBase,
      expectedRemoteTip: tip,
      affectedPaths: ['src/'],
    });
    expect(port.commits).toEqual([`hercules: amend path lease ${cancelled.id}`]);
  });

  it('rejects active, stale, invalid, narrow, moved, missing, and policy-drift cases without a write', async () => {
    const cases: Array<{ service: ActionService; request: typeof input; pattern: RegExp; port: AtomicPort }> = [];
    {
      const made = amendmentService({ task: { ...original, state: 'in_progress' } });
      cases.push({ ...made, request: input, pattern: /inactive/ });
    }
    {
      const made = amendmentService();
      cases.push({
        ...made,
        request: {
          ...input,
          replacement: { ...input.replacement, plannedBaseRevision: '4'.repeat(40) },
        },
        pattern: /trusted default/,
      });
    }
    {
      const made = amendmentService();
      cases.push({ ...made, request: { ...input, expected: { ...input.expected, lastEventAt: 'stale' } }, pattern: /stale/ });
    }
    {
      const made = amendmentService();
      cases.push({ ...made, request: { ...input, replacement: { ...input.replacement, affectedPaths: ['src/', 'src/a.ts'] } }, pattern: /overlap/ });
    }
    {
      const made = amendmentService();
      cases.push({ ...made, request: { ...input, replacement: { ...input.replacement, affectedPaths: ['../secret'] } }, pattern: /invalid|traversal/ });
    }
    {
      const made = amendmentService({ files: ['foreign.txt'] });
      cases.push({ ...made, request: input, pattern: /not contained/ });
    }
    {
      const made = amendmentService({ tip: '3'.repeat(40) });
      cases.push({ ...made, request: input, pattern: /moved/ });
    }
    {
      const made = amendmentService({ inspectError: new Error('candidate missing') });
      cases.push({ ...made, request: input, pattern: /missing/ });
    }
    {
      const made = amendmentService({ workflow: '---\nprotected_paths: []\n---\n' });
      cases.push({ ...made, request: input, pattern: /drifted/ });
    }
    for (const testCase of cases) {
      await expect(serviceCall(testCase.service, testCase.request)).rejects.toThrow(testCase.pattern);
      expect(testCase.port.tasks.get(original.id)).toMatchObject({
        plannedBaseRevision: base,
        affectedPaths: ['src/old.ts'],
        protectedPathsSnapshot: ['test/invariants/**'],
      });
      expect(testCase.port.commits).toEqual([]);
    }
  });

  it('fails a post-proof task race with no partial lease write', async () => {
    const port = new AtomicPort(new Map([[original.id, original]]));
    const { service } = amendmentService({ port });
    const concurrent = { ...original, body: 'concurrent owner edit' };
    port.beforeMutation = () => port.tasks.set(original.id, concurrent);
    await expect(service.amendPathLease(original.id, input)).rejects.toThrow(/changed/);
    expect(port.tasks.get(original.id)).toEqual(concurrent);
    expect(port.commits).toEqual([]);
  });

  it('real-git: migrates an old-base candidate, retries, and recovers it onto current without amendment ref mutation', { timeout: 30_000 }, async () => {
    const temp = await mkdtemp(join(tmpdir(), 'hercules-amend-current-'));
    try {
      const remote = join(temp, 'remote');
      const workRoot = join(temp, 'work');
      await mkdir(remote, { recursive: true });
      const remoteGit = simpleGit(remote);
      await remoteGit.init(['-b', 'main']);
      await remoteGit.addConfig('user.email', 'owner@h.local');
      await remoteGit.addConfig('user.name', 'Owner');
      await writeFile(join(remote, 'WORKFLOW.md'), '---\nprotected_paths: []\n---\n');
      await writeFile(join(remote, 'README.md'), 'base\n');
      await remoteGit.add('.');
      await remoteGit.commit('old base');
      const oldBase = (await remoteGit.revparse(['HEAD'])).trim();
      const repo = {
        key: 'app', url: remote, defaultBranch: 'main', workflow: 'WORKFLOW.md',
        maxConcurrent: 1, adapter: null, readiness: 'ready' as const,
      };
      const workspaces = new GitWorkspaces({
        root: workRoot, ports: new PortAllocator(4600, 8), push: true,
      });
      const workspace = await workspaces.create(repo, 'LEASE-RECOVERY');
      await mkdir(join(workspace.dir, 'src'), { recursive: true });
      await writeFile(join(workspace.dir, 'src', 'candidate.ts'), 'candidate\n');
      const candidateGit = simpleGit(workspace.dir);
      await candidateGit.add('.');
      await candidateGit.raw([
        '-c', 'user.email=agent@h.local', '-c', 'user.name=Agent',
        'commit', '-m', 'candidate work',
      ]);
      const candidate = (await candidateGit.revparse(['HEAD'])).trim();
      await workspaces.preserve('LEASE-RECOVERY', 'preserve candidate');

      await writeFile(join(remote, 'dependency.txt'), 'main advanced\n');
      await remoteGit.add('dependency.txt');
      await remoteGit.commit('advance main');
      const currentBase = (await remoteGit.revparse(['HEAD'])).trim();
      await expect(remoteGit.raw(['merge-base', '--is-ancestor', oldBase, candidate])).resolves.toBe('');
      await expect(remoteGit.raw(['merge-base', '--is-ancestor', oldBase, currentBase])).resolves.toBe('');
      expect((await remoteGit.raw(['merge-base', currentBase, candidate])).trim()).toBe(oldBase);
      const remoteRefBefore = (
        await remoteGit.revparse(['refs/heads/hercules/LEASE-RECOVERY'])
      ).trim();
      expect(remoteRefBefore).toBe(candidate);

      const preserved: Task = {
        ...task('LEASE-RECOVERY', 'cancelled'),
        startedAt: '2026-08-03T00:00:00.000Z',
        plannedBaseRevision: oldBase,
        expectedBaseRevision: oldBase,
        expectedRemoteTip: candidate,
        affectedPaths: ['src/candidate.ts'],
        protectedPathsSnapshot: [],
        verifiedSha: candidate,
        lastEventAt: '2026-08-04T00:00:00.000Z',
      };
      const port = new AtomicPort(new Map([[preserved.id, preserved]]));
      port.repos = { repos: { app: repo } };
      const service = new ActionService(port, new FakeProbe(['main']), undefined, undefined, {
        workspaces,
        verifier: { verify: async () => { throw new Error('unused'); } },
      });
      const amended = await service.amendPathLease(preserved.id, {
        expected: {
          state: 'cancelled', plannedBaseRevision: oldBase, expectedBaseRevision: oldBase,
          expectedRemoteTip: candidate, affectedPaths: ['src/candidate.ts'],
          protectedPathsSnapshot: [], verifiedSha: candidate,
          lastEventAt: preserved.lastEventAt,
        },
        replacement: {
          plannedBaseRevision: currentBase,
          affectedPaths: ['src/'],
          protectedPathsSnapshot: [],
        },
      });
      expect(amended).toMatchObject({
        plannedBaseRevision: currentBase,
        expectedBaseRevision: currentBase,
        expectedRemoteTip: candidate,
      });
      expect((await remoteGit.revparse(['refs/heads/hercules/LEASE-RECOVERY'])).trim()).toBe(candidate);

      const retried = await service.retry(preserved.id);
      expect(retried.state).toBe('todo');
      await expect(workspaces.exactCandidateContainsBase(
        repo, preserved.id, candidate, currentBase,
      )).resolves.toBe(false);
      const recovered = await workspaces.recoverStaleTaskBranch(
        repo,
        preserved.id,
        currentBase,
        { expectedBaseRevision: currentBase, expectedRemoteTip: candidate },
      );
      expect(recovered.kind).toBe('recovered');
      if (recovered.kind !== 'recovered') throw new Error(recovered.detail);
      expect(recovered.lease.expectedBaseRevision).toBe(currentBase);
      expect(recovered.lease.expectedRemoteTip).not.toBe(candidate);
      await expect(workspaces.exactCandidateContainsBase(
        repo, preserved.id, recovered.lease.expectedRemoteTip!, currentBase,
      )).resolves.toBe(true);
      const dispatched = await workspaces.create(repo, preserved.id, {
        hadPriorWork: true,
        expectedBaseTip: currentBase,
        expectedBaseRevision: currentBase,
        expectedRemoteTip: recovered.lease.expectedRemoteTip,
      });
      expect((await simpleGit(dispatched.dir).revparse(['HEAD'])).trim()).toBe(
        recovered.lease.expectedRemoteTip,
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  function serviceCall(service: ActionService, request: typeof input): Promise<Task> {
    return service.amendPathLease(original.id, request);
  }
});
