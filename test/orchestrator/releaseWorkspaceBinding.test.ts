/**
 * Regression: workspace helper methods must be invoked WITH their receiver.
 *
 * Live incident 2026-07-17: the reconciler/promote/actions extracted
 * `workspaces.defaultBranchHead` into a local and called it unbound; the
 * TypeError inside was swallowed by the method's own catch → null → every
 * caller silently concluded "no main sha" and the first automated staging
 * cycle never fired. Class-based fakes (this-dependent) catch this; the
 * original arrow-function fakes could not.
 */
import { describe, it, expect } from 'vitest';
import { ReleaseReconciler } from '../../src/orchestrator/releaseReconciler.js';
import { PromoteService } from '../../src/orchestrator/promoteService.js';
import type { Release } from '../../src/domain/release.js';
import { emptyRelease } from '../../src/domain/release.js';
import type { ControlSnapshot } from '../../src/control/snapshot.js';
import type { RepoConfig } from '../../src/domain/repos.js';

const WORKFLOW = `---
deploy:
  staging:
    command: ./deploy-staging.sh
    health: curl -sf http://localhost:9/
  production:
    command: ./deploy-production.sh <sha>
    health: curl -sf http://localhost:9/
---
body`;

/** this-dependent fake: unbound calls return garbage instead of the sha. */
class ClassyWorkspaces {
  private readonly head = 'feedbeeffeedbeeffeedbeeffeedbeeffeedbeef';
  private readonly cwd = '/deploy/cwd';
  async readWorkflow(): Promise<string> {
    return WORKFLOW;
  }
  async defaultBranchHead(_repo: RepoConfig): Promise<string | null> {
    try {
      return this.head;
    } catch {
      return null;
    }
  }
  async deployCwd(_repo: RepoConfig): Promise<string> {
    return this.cwd;
  }
}

function makeControl(release: Release | null): {
  written: Release[];
  control: {
    readRelease: (k: string) => Promise<Release | null>;
    writeRelease: (r: Release) => Promise<void>;
    commit: (m: string) => Promise<{ committed: boolean }>;
    read: () => Promise<ControlSnapshot>;
  };
} {
  const written: Release[] = [];
  return {
    written,
    control: {
      readRelease: async () => release,
      writeRelease: async (r) => {
        written.push(r);
      },
      commit: async () => ({ committed: true }),
      read: async () => snapshot(),
    },
  };
}

const repo: RepoConfig = {
  key: 'app',
  url: 'x',
  defaultBranch: 'main',
  workflow: 'WORKFLOW.md',
  maxConcurrent: 1,
  adapter: null,
  readiness: 'ready',
};

function snapshot(): ControlSnapshot {
  return { repos: { repos: { app: repo } }, tasks: [], problems: [] };
}

function report(): Parameters<ReleaseReconciler['reconcile']>[1] {
  return {
    dispatched: [],
    completed: [],
    retried: [],
    failed: [],
    stalled: [],
    tornDown: [],
    recovered: [],
    running: [],
    thrashParked: [],
    provisionDiscarded: [],
    quietLong: [],
    stagingReconciled: [],
    sessionMetrics: { thrashParks: 0, quietLongSightings: 0 },
  } as unknown as Parameters<ReleaseReconciler['reconcile']>[1];
}

describe('workspace method receiver binding (2026-07-17 silent-null incident)', () => {
  it('reconciler resolves main sha through a this-dependent workspaces impl', async () => {
    const { control } = makeControl(null);
    const runs: string[] = [];
    const rec = new ReleaseReconciler({
      control: control as never,
      workspaces: new ClassyWorkspaces() as never,
      deployRunner: {
        run: async (cmd: string) => {
          runs.push(cmd);
          // Block after the deploy command — reaching it proves mainSha resolved.
          return { exitCode: 1, output: 'stop here' };
        },
      } as never,
      clock: () => 1_000_000,
      debounceMs: 300_000,
      screenshotsRoot: '/tmp/x',
    });
    rec.requestDeployNow('app');
    await rec.reconcile(snapshot(), report());
    expect(runs).toEqual(['./deploy-staging.sh']);
  });

  it('promote service resolves main sha through a this-dependent workspaces impl', async () => {
    const ready: Release = {
      ...emptyRelease('app'),
      stagingSha: 'feedbeeffeedbeeffeedbeeffeedbeeffeedbeef',
      stagingStatus: 'ready',
    };
    const { control } = makeControl(ready);
    const runs: string[] = [];
    const svc = new PromoteService({
      control: control as never,
      workspaces: new ClassyWorkspaces() as never,
      deployRunner: {
        run: async (cmd: string) => {
          runs.push(cmd);
          return { exitCode: 1, output: 'stop here' };
        },
      } as never,
      clock: () => 1_000_000,
    });
    // Precondition needs staging_sha == main sha; a silent-null main sha would
    // reject the promote before any deploy run.
    await svc.promote('app').catch(() => undefined);
    expect(runs.length).toBeGreaterThan(0);
  });
});
