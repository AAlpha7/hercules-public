import { describe, it, expect } from 'vitest';
import { CursorCloudAdapter } from '../../src/adapters/cursorCloud.js';
import type {
  CursorCloudClient,
  CursorCloudLaunchRequest,
  CursorCloudSnapshot,
} from '../../src/domain/cursorCloud.js';
import type { AgentStartInput } from '../../src/orchestrator/adapter.js';

const PR = {
  prUrl: 'https://github.com/example-org/acme/pull/42',
  prNumber: 42,
} as const;

const input: AgentStartInput = {
  taskId: 'T-factory',
  workspace: '/ws/app/T-factory',
  prompt: 'Add the factory first ring.',
  allocation: { slug: 'T-factory', port: 4100, scratchDir: '/ws/app/T-factory/.scratch' },
  repository: 'https://github.com/example-org/acme',
  ref: 'main',
};

class ScriptedClient implements CursorCloudClient {
  readonly launches: CursorCloudLaunchRequest[] = [];
  readonly stopped: string[] = [];
  launchResult: CursorCloudSnapshot = { id: 'bc_1', status: 'creating' };
  getResult: CursorCloudSnapshot = { id: 'bc_1', status: 'running' };
  launchError: Error | null = null;

  async launch(request: CursorCloudLaunchRequest): Promise<CursorCloudSnapshot> {
    this.launches.push(request);
    if (this.launchError) throw this.launchError;
    return this.launchResult;
  }

  async get(id: string): Promise<CursorCloudSnapshot> {
    return { ...this.getResult, id };
  }

  async stop(id: string): Promise<void> {
    this.stopped.push(id);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

describe('CursorCloudAdapter', () => {
  it('reports its stable name', () => {
    expect(new CursorCloudAdapter({ client: new ScriptedClient() }).name).toBe('cursor');
  });

  it('dispatches prompt + repository and reaches done with a PR handle', async () => {
    const client = new ScriptedClient();
    client.getResult = { id: 'bc_1', status: 'finished', pr: PR, summary: 'Opened the PR.' };
    const adapter = new CursorCloudAdapter({
      client,
      clock: () => 1_000,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const run = adapter.start(input, 1_000);
    expect(run.poll(1_000).status).toBe('running');
    await flush();
    const snap = run.poll(2_000);
    expect(client.launches).toEqual([
      {
        prompt: 'Add the factory first ring.',
        repository: 'https://github.com/example-org/acme',
        ref: 'main',
      },
    ]);
    expect(snap.status).toBe('done');
    expect(snap.prUrl).toBe(PR.prUrl);
    expect(snap.prNumber).toBe(42);
    expect(run.sessionId).toBe('bc_1');
    expect(run.finalMessage()).toContain(PR.prUrl);
    expect(run.finalMessage()).toContain('PR number: 42');
    expect(run.activityLog().some((line) => line.includes('#42'))).toBe(true);
  });

  it('keeps the tracked factory PR when rework finishes without opening another', async () => {
    const existing = {
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    };
    const client = new ScriptedClient();
    client.getResult = { id: 'bc_1', status: 'finished', summary: 'Pushed the existing head.' };
    const adapter = new CursorCloudAdapter({
      client,
      clock: () => 1_000,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const run = adapter.start({ ...input, existingFactoryPr: existing }, 1_000);
    await flush();
    const snap = run.poll(2_000);
    expect(client.launches).toEqual([
      {
        prompt: 'Add the factory first ring.',
        repository: 'https://github.com/example-org/acme',
        ref: 'main',
        existingPr: existing,
      },
    ]);
    expect(snap.status).toBe('done');
    expect(snap.prUrl).toBe(existing.prUrl);
    expect(snap.prNumber).toBe(41);
    expect(run.finalMessage()).toContain(existing.prUrl);
    expect(run.finalMessage()).toContain('PR number: 41');
  });

  it('does not replace the tracked PR when rework snapshot opens a different one', async () => {
    const existing = {
      prUrl: 'https://github.com/example-org/acme/pull/41',
      prNumber: 41,
    };
    const client = new ScriptedClient();
    client.getResult = {
      id: 'bc_1',
      status: 'finished',
      pr: { prUrl: 'https://github.com/example-org/acme/pull/99', prNumber: 99 },
    };
    const adapter = new CursorCloudAdapter({
      client,
      clock: () => 1_000,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const run = adapter.start({ ...input, existingFactoryPr: existing }, 1_000);
    await flush();
    const snap = run.poll(2_000);
    expect(snap.status).toBe('done');
    expect(snap.prUrl).toBe(existing.prUrl);
    expect(snap.prNumber).toBe(41);
    expect(run.finalMessage()).not.toContain('/pull/99');
  });

  it('keeps the observed PR on poll after the Cloud Agent fails', async () => {
    const client = new ScriptedClient();
    client.getResult = {
      id: 'bc_1',
      status: 'failed',
      pr: PR,
      summary: 'Opened the PR then died.',
    };
    const adapter = new CursorCloudAdapter({
      client,
      clock: () => 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const run = adapter.start(input, 0);
    await flush();
    const snap = run.poll(1);
    expect(snap.status).toBe('failed');
    expect(snap.prUrl).toBe(PR.prUrl);
    expect(snap.prNumber).toBe(42);
    expect(run.finalMessage()).toContain(PR.prUrl);
  });

  it('fails closed when the injected client returns finished without a PR', async () => {
    const client = new ScriptedClient();
    client.getResult = { id: 'bc_1', status: 'finished' };
    const adapter = new CursorCloudAdapter({
      client,
      clock: () => 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const run = adapter.start(input, 0);
    await flush();
    expect(run.poll(1).status).toBe('failed');
    expect(run.finalMessage()).toMatch(/without a pull request/);
    expect(run.poll(1).prUrl).toBeUndefined();
  });

  it('fails without calling launch when the task has no repository', async () => {
    const client = new ScriptedClient();
    const adapter = new CursorCloudAdapter({ client, clock: () => 0 });
    const { repository: _ignored, ...withoutRepo } = input;
    const run = adapter.start(withoutRepo, 0);
    expect(run.poll(0).status).toBe('failed');
    expect(run.finalMessage()).toMatch(/repository/);
    expect(client.launches).toEqual([]);
  });

  it('fails when launch throws (no network — injected client)', async () => {
    const client = new ScriptedClient();
    client.launchError = new Error('injected launch denied');
    const adapter = new CursorCloudAdapter({
      client,
      clock: () => 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const run = adapter.start(input, 0);
    await flush();
    expect(run.poll(1).status).toBe('failed');
    expect(run.finalMessage()).toContain('injected launch denied');
  });

  it('reattaches an existing Cloud Agent without launching another', async () => {
    const client = new ScriptedClient();
    client.getResult = { id: 'bc_live', status: 'finished', pr: PR, summary: 'Still the same run.' };
    const adapter = new CursorCloudAdapter({
      client,
      clock: () => 1_000,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const run = adapter.start({ ...input, attachFactoryAgentId: 'bc_live' }, 1_000);
    expect(run.sessionId).toBe('bc_live');
    await flush();
    const snap = run.poll(2_000);
    expect(client.launches).toEqual([]);
    expect(snap.status).toBe('done');
    expect(snap.prUrl).toBe(PR.prUrl);
    expect(run.sessionId).toBe('bc_live');
    expect(run.finalMessage()).toContain(PR.prUrl);
  });

  it('stop() asks the client to stop the remote agent', async () => {
    const client = new ScriptedClient();
    const adapter = new CursorCloudAdapter({
      client,
      clock: () => 0,
      pollIntervalMs: 0,
      sleep: async () => undefined,
    });
    const run = adapter.start(input, 0);
    await flush();
    run.stop();
    await flush();
    expect(client.stopped).toEqual(['bc_1']);
    expect(run.poll(1).status).toBe('running');
    client.getResult = { id: 'bc_1', status: 'stopped' };
    run.stop({ force: true });
    expect(run.poll(2).status).toBe('failed');
  });
});
