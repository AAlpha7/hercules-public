import { describe, it, expect, vi } from 'vitest';
import { ActionService, ActionError } from '../../src/orchestrator/actions.js';
import type { GuardianHarnessCapabilities } from '../../src/domain/guardianReadiness.js';
import type { ControlPort } from '../../src/orchestrator/orchestrator.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { Task } from '../../src/domain/task.js';
import type { ReposConfig, RepoConfig } from '../../src/domain/repos.js';
import type { RepoProbe } from '../../src/orchestrator/repoProbe.js';
import { VerificationAbortedError } from '../../src/domain/verificationRun.js';

class FakePort implements ControlPort {
  readonly commits: string[] = [];
  constructor(
    public repos: ReposConfig,
    readonly tasks: Map<string, Task> = new Map(),
  ) {}
  async sync(): Promise<void> {}
  async read(): Promise<ControlSnapshot> {
    return { repos: this.repos, tasks: [...this.tasks.values()], problems: [] };
  }
  async writeTask(t: Task): Promise<void> {
    this.tasks.set(t.id, t);
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
  async probe(): Promise<{ branches: string[] }> {
    return { branches: ['main'] };
  }
}

const NL = String.fromCharCode(10);
const CAPS: GuardianHarnessCapabilities = {
  buildAttested: true,
  daemonWorkrootLease: true,
  taskBranchExactLease: true,
  taskPathLeases: true,
  protectedPathDrift: true,
  cliBehavioralEvidence: true,
};

function guardianRepo(over: Partial<RepoConfig> = {}): RepoConfig {
  return {
    key: 'guard',
    url: 'https://github.com/example/guard.git',
    defaultBranch: 'main',
    workflow: 'WORKFLOW.md',
    maxConcurrent: 1,
    adapter: 'grok',
    readiness: 'incomplete',
    executionPolicy: { profile: 'guardian' },
    ...over,
  };
}

function goodAgents(): string {
  return ['# Agent map', '', 'Read WORKFLOW.md. Layout under src/.', ''].join(NL);
}

function goodWorkflow(): string {
  return [
    '---',
    'setup:',
    '  install: [pnpm i]',
    'behavioral:',
    '  base_url: http://localhost:{port}',
    '  capture: [screenshot]',
    'gates:',
    '  test: pnpm test',
    '  build: cargo build --locked',
    'cli_evidence:',
    '  version: 1',
    '  steps:',
    '    - id: echo-ok',
    '      argv: [echo, ok]',
    '      expect:',
    '        exit_code: 0',
    '        stdout_contains: ok',
    '---',
    '# policy',
    '',
  ].join(NL);
}

describe('Guardian B-022 readiness gate', () => {
  it('domain receipt is required for guardian mark-ready path', () => {
    expect(CAPS.daemonWorkrootLease).toBe(true);
    expect(guardianRepo().executionPolicy?.profile).toBe('guardian');
  });

  it('refuses ready when lease is absent even with forceReady', async () => {
    const repo = guardianRepo();
    const port = new FakePort({ repos: { guard: repo } });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() {
          return { revision: 'a'.repeat(40), workflowContent: goodWorkflow() };
        },
        async readWorkflow() {
          return goodWorkflow();
        },
        async readTrustedFile(_r: RepoConfig, path: string) {
          return path === 'AGENTS.md' ? goodAgents() : null;
        },
      },
      daemonLeaseStatus: () => 'absent',
      capabilities: CAPS,
      defaultAdapter: 'grok',
    });
    await expect(service.editRepo('guard', { readiness: 'ready' })).rejects.toBeInstanceOf(
      ActionError,
    );
    await expect(
      service.editRepo('guard', { readiness: 'ready', forceReady: true }),
    ).rejects.toThrow(/Guardian readiness blocked|forceReady cannot bypass/);
  });

  it('fully explicit fixture passes with receipt and can mark ready', async () => {
    const repo = guardianRepo();
    const port = new FakePort({ repos: { guard: repo } });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() {
          return { revision: 'a'.repeat(40), workflowContent: goodWorkflow() };
        },
        async readWorkflow() {
          return goodWorkflow();
        },
        async readTrustedFile(_r: RepoConfig, path: string) {
          return path === 'AGENTS.md' ? goodAgents() : null;
        },
      },
      daemonLeaseStatus: () => 'ours',
      capabilities: CAPS,
      verifyCliEvidence: async () => 'verified',
      defaultAdapter: 'grok',
    });
    const check = await service.checkRepoReadiness('guard');
    expect(check.guardian.applicable).toBe(true);
    expect(check.guardian.ok).toBe(true);
    expect(check.guardian.grantsOnly).toBe('harness_readiness');
    expect(check.softOk).toBe(true);
    const marked = await service.editRepo('guard', { readiness: 'ready' });
    expect(marked.readiness).toBe('ready');
  });

  it('bounds CLI execution by provenance while rebuilding dynamic facts every check', async () => {
    let revision = 'a'.repeat(40);
    let workflow = goodWorkflow();
    let verifyCalls = 0;
    const buildCommands: string[] = [];
    let leaseCalls = 0;
    const repo = guardianRepo();
    const port = new FakePort({ repos: { guard: repo } });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() {
          return { revision, workflowContent: workflow };
        },
        async readWorkflow() { return workflow; },
        async readTrustedFile() { return goodAgents(); },
      },
      daemonLeaseStatus: () => {
        leaseCalls += 1;
        return leaseCalls === 2 ? 'absent' : 'ours';
      },
      capabilities: CAPS,
      defaultAdapter: 'grok',
      verifyCliEvidence: async ({ buildGate }) => {
        buildCommands.push(buildGate?.command ?? 'missing');
        verifyCalls += 1;
        return verifyCalls === 1 ? 'failed' : 'verified';
      },
    });

    expect((await service.checkRepoConfigReadiness(repo)).guardian.failedCodes)
      .toContain('cli_evidence_failed');
    expect((await service.checkRepoConfigReadiness(repo)).guardian.ok).toBe(false);
    expect(verifyCalls).toBe(1);
    expect(leaseCalls).toBe(2);

    expect((await service.checkRepoConfigReadiness(repo, { retryCliEvidence: true })).guardian.ok)
      .toBe(true);
    expect(verifyCalls).toBe(2);

    revision = 'b'.repeat(40);
    await service.checkRepoConfigReadiness(repo);
    workflow = workflow.replace('cargo build --locked', 'cargo build --release --locked');
    await service.checkRepoConfigReadiness(repo);
    await service.checkRepoConfigReadiness({
      ...repo,
      executionPolicy: { profile: 'guardian', envAllowlist: [] },
    });
    expect(verifyCalls).toBe(5);
    expect(buildCommands).toContain('cargo build --locked');
    expect(buildCommands).toContain('cargo build --release --locked');
    expect(leaseCalls).toBe(6);
  });

  it('does not invoke build/CLI verification when trusted WORKFLOW has no CLI plan', async () => {
    const workflow = goodWorkflow().replace(/cli_evidence:[\s\S]*?---\n# policy/, '---\n# policy');
    const verify = vi.fn(async () => 'verified' as const);
    const repo = guardianRepo();
    const port = new FakePort({ repos: { guard: repo } });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() {
          return { revision: 'a'.repeat(40), workflowContent: workflow };
        },
        async readWorkflow() { return workflow; },
        async readTrustedFile() { return goodAgents(); },
      },
      daemonLeaseStatus: () => 'ours', capabilities: CAPS, defaultAdapter: 'grok',
      verifyCliEvidence: verify,
    });

    await service.checkRepoReadiness('guard');
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not cache lifecycle cancellation as a readiness verdict', async () => {
    let verifyCalls = 0;
    const repo = guardianRepo();
    const port = new FakePort({ repos: { guard: repo } });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() {
          return { revision: 'a'.repeat(40), workflowContent: goodWorkflow() };
        },
        async readWorkflow() { return goodWorkflow(); },
        async readTrustedFile() { return goodAgents(); },
      },
      daemonLeaseStatus: () => 'ours', capabilities: CAPS, defaultAdapter: 'grok',
      verifyCliEvidence: async () => {
        verifyCalls += 1;
        if (verifyCalls === 1) throw new VerificationAbortedError('shutdown');
        return 'verified';
      },
    });

    await expect(service.checkRepoReadiness('guard')).rejects.toBeInstanceOf(
      VerificationAbortedError,
    );
    expect((await service.checkRepoReadiness('guard')).guardian.ok).toBe(true);
    expect(verifyCalls).toBe(2);
  });

  it('rejects direct ready registration before writing repos.yaml', async () => {
    const port = new FakePort({ repos: {} });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() {
          return { revision: 'a'.repeat(40), workflowContent: goodWorkflow() };
        },
        async readWorkflow() { return goodWorkflow(); },
        async readTrustedFile() { return goodAgents(); },
      },
      daemonLeaseStatus: () => 'absent',
      capabilities: CAPS,
      defaultAdapter: 'grok',
      verifyCliEvidence: async () => 'verified',
    });

    await expect(service.addRepo({
      key: 'guard', url: 'https://github.com/example/guard.git', defaultBranch: 'main',
      readiness: 'ready', adapter: 'grok', executionPolicy: { profile: 'guardian' },
    })).rejects.toThrow(/Guardian readiness blocked/i);
    expect(port.repos.repos).toEqual({});
  });

  it('rejects unknown execution policy input fields before persistence', async () => {
    const port = new FakePort({ repos: {} });
    const service = new ActionService(port, new FakeProbe());

    await expect(service.addRepo({
      key: 'guard', url: 'https://github.com/example/guard.git', defaultBranch: 'main',
      executionPolicy: { profile: 'guardian', surprise: true } as never,
    })).rejects.toThrow(/unknown executionPolicy field 'surprise'/);
    expect(port.repos.repos).toEqual({});
  });

  it('evaluates changed workflow on the projected ready config, not old evidence', async () => {
    const repo = guardianRepo({ readiness: 'ready' });
    const port = new FakePort({ repos: { guard: repo } });
    const seen: string[] = [];
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot(projected) {
          seen.push(projected.workflow);
          return {
            revision: 'a'.repeat(40),
            workflowContent: projected.workflow === 'WORKFLOW.md' ? goodWorkflow() : null,
          };
        },
        async readWorkflow() { return goodWorkflow(); },
        async readTrustedFile() { return goodAgents(); },
      },
      daemonLeaseStatus: () => 'ours', capabilities: CAPS, defaultAdapter: 'grok',
      verifyCliEvidence: async () => 'verified',
    });

    await expect(service.editRepo('guard', { workflow: 'missing.yml' }))
      .rejects.toThrow(/cli_evidence_absent|readiness blocked/i);
    expect(seen).toContain('missing.yml');
    expect(port.repos.repos['guard']!.workflow).toBe('WORKFLOW.md');
  });

  it('classifies missing trusted workflow as cli_evidence_absent not unknown', async () => {
    const repo = guardianRepo();
    const port = new FakePort({ repos: { guard: repo } });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() {
          return { revision: 'a'.repeat(40), workflowContent: null };
        },
        async readWorkflow() { return null; },
        async readTrustedFile() { return goodAgents(); },
      },
      daemonLeaseStatus: () => 'ours', capabilities: CAPS, defaultAdapter: 'grok',
      verifyCliEvidence: async () => 'verified',
    });
    const check = await service.checkRepoReadiness('guard');
    expect(check.guardian.failedCodes).toContain('cli_evidence_absent');
    expect(check.guardian.failedCodes).not.toContain('cli_evidence_unknown');
    const ctrl = check.guardian.controls.find((c) => c.id === 'cli_behavioral_evidence');
    expect(ctrl?.remediation).toMatch(/WORKFLOW|cli_evidence/i);
    expect(ctrl?.remediation).not.toMatch(/mirror is reachable/i);
  });

  it('keeps cli_evidence_unknown when trusted snapshot is unreachable', async () => {
    const repo = guardianRepo();
    const port = new FakePort({ repos: { guard: repo } });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() { return null; },
        async readWorkflow() { return null; },
        async readTrustedFile() { return null; },
      },
      daemonLeaseStatus: () => 'ours', capabilities: CAPS, defaultAdapter: 'grok',
    });
    const check = await service.checkRepoReadiness('guard');
    expect(check.guardian.failedCodes).toContain('cli_evidence_unknown');
  });

  it('soft checklist accepts cli_evidence declaration but hard gate stays unverified', async () => {
    const cliOnlyWorkflow = [
      '---',
      'gates:',
      '  test: pnpm test',
      'cli_evidence:',
      '  version: 1',
      '  steps:',
      '    - id: echo-ok',
      '      argv: [echo, ok]',
      '      expect:',
      '        exit_code: 0',
      '---',
      '# policy',
      '',
    ].join(NL);
    const repo = guardianRepo();
    const port = new FakePort({ repos: { guard: repo } });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() {
          return { revision: 'a'.repeat(40), workflowContent: cliOnlyWorkflow };
        },
        async readWorkflow() { return cliOnlyWorkflow; },
        async readTrustedFile() { return goodAgents(); },
      },
      daemonLeaseStatus: () => 'ours', capabilities: CAPS, defaultAdapter: 'grok',
    });
    const check = await service.checkRepoReadiness('guard');
    expect(check.softOk).toBe(true);
    expect(check.checks.find((c) => c.id === 'workflow-behavioral')?.ok).toBe(true);
    expect(check.guardian.ok).toBe(false);
    expect(check.guardian.failedCodes).toContain('cli_evidence_unverified');
  });

  it('rejects a ready Guardian policy regression and an unverified CLI plan', async () => {
    const repo = guardianRepo({ readiness: 'ready' });
    const port = new FakePort({ repos: { guard: repo } });
    const service = new ActionService(port, new FakeProbe(), undefined, undefined, undefined, {
      workspaces: {
        async readTrustedDefaultRevisionSnapshot() {
          return { revision: 'a'.repeat(40), workflowContent: goodWorkflow() };
        },
        async readWorkflow() { return goodWorkflow(); },
        async readTrustedFile() { return goodAgents(); },
      },
      daemonLeaseStatus: () => 'ours', capabilities: CAPS, defaultAdapter: 'grok',
      // No verifier is wired: declaration alone must remain red.
    });

    await expect(service.editRepo('guard', {
      executionPolicy: { profile: 'guardian', network: 'unrestricted' },
    })).rejects.toThrow(/cannot relax|execution_policy_relaxed/i);
    await expect(service.editRepo('guard', {
      executionPolicy: { profile: 'compatible' },
    })).rejects.toThrow(/cannot be removed while.*ready/i);
    await expect(service.editRepo('guard', { maxConcurrent: 1 }))
      .rejects.toThrow(/cli_evidence_unverified/i);
  });
});
