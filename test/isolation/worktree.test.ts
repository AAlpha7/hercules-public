import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';
import type { RepoConfig } from '../../src/domain/repos.js';
import { RepoUrlError } from '../../src/control/reposConfig.js';
import { pushTaskBranchWithExactLease } from '../../src/isolation/exactLeasePush.js';
import { ensureLinkedWorktreeUsable } from '../../src/isolation/providerPushBoundary.js';

let tmp: string;
let root: string;
let targetUrl: string;
let repo: RepoConfig;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'hercules-wt-'));
  root = join(tmp, 'root');
  await mkdir(root, { recursive: true });

  // A "remote" target repo with one commit on main.
  targetUrl = join(tmp, 'target');
  await mkdir(targetUrl, { recursive: true });
  const g = simpleGit(targetUrl);
  await g.init(['-b', 'main']);
  await g.addConfig('user.email', 't@h.local');
  await g.addConfig('user.name', 'T');
  await writeFile(join(targetUrl, 'README.md'), '# target\n');
  await writeFile(join(targetUrl, 'WORKFLOW.md'), '---\ngates:\n  test: pnpm test\n---\nbe careful\n');
  await g.add('.');
  await g.commit('initial');

  repo = { key: 'app', url: targetUrl, defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' };
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeWorkspaces(): GitWorkspaces {
  return new GitWorkspaces({ root, ports: new PortAllocator(4000, 4) });
}

describe('GitWorkspaces.create', { timeout: 20_000 }, () => {
  it('creates a bare mirror and a per-task worktree on its own branch', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'T-1');

    expect(w.dir).toBe(join(root, 'app', 'T-1'));
    expect(w.branch).toBe('hercules/T-1');
    expect(w.allocation.slug).toBe('T-1');
    expect(w.allocation.port).toBe(4000);

    // worktree exists, has the repo's files, on the right branch
    expect(await exists(join(w.dir, 'README.md'))).toBe(true);
    expect(await exists(w.allocation.scratchDir)).toBe(true);
    const branch = (await simpleGit(w.dir).revparse(['--abbrev-ref', 'HEAD'])).trim();
    expect(branch).toBe('hercules/T-1');

    // the bare mirror was created under .mirrors
    expect(await exists(join(root, '.mirrors', 'app.git'))).toBe(true);
  });

  it('shares the mirror across tasks but isolates worktree, branch, and port', async () => {
    const ws = makeWorkspaces();
    const a = await ws.create(repo, 'T-1');
    const b = await ws.create(repo, 'T-2');

    expect(a.dir).not.toBe(b.dir);
    expect(a.branch).not.toBe(b.branch);
    expect(a.allocation.port).not.toBe(b.allocation.port);
    // same mirror, not re-cloned
    expect(b.dir).toBe(join(root, 'app', 'T-2'));
  });

  it('confines the worktree path to the root and rejects unsafe ids', async () => {
    const ws = makeWorkspaces();
    await expect(ws.create(repo, '../escape')).rejects.toThrow();
  });

  it('rejects an unsafe repo URL (ext:: transport) with RepoUrlError before any git call', async () => {
    const ws = makeWorkspaces();
    const evil: RepoConfig = { ...repo, url: 'ext::sh -c whoami' };
    await expect(ws.create(evil, 'T-evil')).rejects.toBeInstanceOf(RepoUrlError);
    // No mirror should be created
    const mirrorExists = await exists(join(root, '.mirrors', 'app.git'));
    expect(mirrorExists).toBe(false);
  });
});

describe('GitWorkspaces readiness cleanliness', { timeout: 20_000 }, () => {
  it('allows ignored build artifacts but rejects tracked and ordinary untracked mutations', async () => {
    const source = simpleGit(targetUrl);
    await writeFile(join(targetUrl, '.gitignore'), 'target/\n');
    await source.add('.gitignore');
    await source.commit('ignore build output');

    const handle = await makeWorkspaces().openMergeWorktree(repo);
    try {
      await mkdir(join(handle.dir, 'target'), { recursive: true });
      await writeFile(join(handle.dir, 'target', 'guardian'), 'binary');
      await expect(handle.isClean?.()).resolves.toBe(false);
      await expect(handle.isTrackedAndUntrackedClean?.()).resolves.toBe(true);

      await writeFile(join(handle.dir, 'scratch.txt'), 'ordinary untracked');
      await expect(handle.isTrackedAndUntrackedClean?.()).resolves.toBe(false);
      await rm(join(handle.dir, 'scratch.txt'));

      await writeFile(join(handle.dir, 'README.md'), 'tracked mutation');
      await expect(handle.isTrackedAndUntrackedClean?.()).resolves.toBe(false);
    } finally {
      await handle.dispose();
    }
  });
});

describe('GitWorkspaces.readWorkflow', { timeout: 20_000 }, () => {
  it('reads WORKFLOW.md from the trusted mirror default branch', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'T-1'); // ensures the mirror exists
    const content = await ws.readWorkflow(repo);
    expect(content).toContain('be careful');
    expect(content).toContain('gates:');
  });

  it('returns null when the repo has no WORKFLOW.md', async () => {
    const ws = makeWorkspaces();
    await ws.create({ ...repo, workflow: 'NOPE.md' }, 'T-2');
    expect(await ws.readWorkflow({ ...repo, workflow: 'NOPE.md' })).toBeNull();
  });

  it('does not return a stale trusted snapshot when the required refresh fails', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'T-STALE');
    await rm(targetUrl, { recursive: true, force: true });

    await expect(ws.readTrustedDefaultRevisionSnapshot(repo)).resolves.toBeNull();
  });
});

describe('GitWorkspaces mirror freshness window', { timeout: 60_000 }, () => {
  it('two readWorkflow calls within maxStaleMs spawn one remote fetch', async () => {
    let now = 1_000_000;
    const ws = new GitWorkspaces({
      root,
      ports: new PortAllocator(4000, 4),
      clock: () => now,
    });
    // First call clones (window never applies to initial clone) — no fetch stamp.
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
    expect(ws.mirrorRefreshedAtForTest(repo.key)).toBeUndefined();
    const afterClone = ws.remoteFetchAttemptsForTest();

    // Second call refreshes and stamps.
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
    expect(ws.remoteFetchAttemptsForTest()).toBe(afterClone + 1);
    const stamped = ws.mirrorRefreshedAtForTest(repo.key);
    expect(stamped).toBe(now);

    // Third call within the window reuses the stamp — no fetch.
    now += 30_000;
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
    expect(ws.remoteFetchAttemptsForTest()).toBe(afterClone + 1);
    expect(ws.mirrorRefreshedAtForTest(repo.key)).toBe(stamped);
  });

  it('fetches again after the freshness window elapses', async () => {
    let now = 2_000_000;
    const ws = new GitWorkspaces({
      root,
      ports: new PortAllocator(4000, 4),
      clock: () => now,
    });
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 }); // clone
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 }); // fetch + stamp
    const afterWarm = ws.remoteFetchAttemptsForTest();

    now += 60_001;
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
    expect(ws.remoteFetchAttemptsForTest()).toBe(afterWarm + 1);
    expect(ws.mirrorRefreshedAtForTest(repo.key)).toBe(now);
  });

  it('requireFreshDefault still fetches inside the window', async () => {
    let now = 3_000_000;
    const ws = new GitWorkspaces({
      root,
      ports: new PortAllocator(4000, 4),
      clock: () => now,
    });
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
    const afterWarm = ws.remoteFetchAttemptsForTest();

    now += 1_000;
    await ws.readTrustedDefaultRevisionSnapshot(repo); // requireFreshDefault: true
    expect(ws.remoteFetchAttemptsForTest()).toBe(afterWarm + 1);
  });

  it('changed repo.url inside the window still fetches', async () => {
    let now = 4_000_000;
    const ws = new GitWorkspaces({
      root,
      ports: new PortAllocator(4000, 4),
      clock: () => now,
    });
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
    const afterWarm = ws.remoteFetchAttemptsForTest();

    // Second local remote with the same history so fetch succeeds.
    const otherUrl = join(tmp, 'target-other');
    await simpleGit(tmp).clone(targetUrl, otherUrl, ['--bare']);
    now += 1_000;
    await ws.readWorkflow({ ...repo, url: otherUrl }, { maxStaleMs: 60_000 });
    expect(ws.remoteFetchAttemptsForTest()).toBe(afterWarm + 1);
  });

  it('failed fetch does not record refreshedAt', async () => {
    let now = 5_000_000;
    const ws = new GitWorkspaces({
      root,
      ports: new PortAllocator(4000, 4),
      clock: () => now,
    });
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 }); // clone
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 }); // stamp
    const stampedAt = ws.mirrorRefreshedAtForTest(repo.key);
    expect(stampedAt).toBe(now);

    // Destroy origin and advance past the window so ensureMirror must fetch.
    await rm(targetUrl, { recursive: true, force: true });
    now += 60_001;
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 });
    // Fetch fails (logged); refreshedAt must stay at the prior successful stamp.
    expect(ws.mirrorRefreshedAtForTest(repo.key)).toBe(stampedAt);
  });

  it('measures cold vs within-window readWorkflow latency on a local mirror', async () => {
    let now = 6_000_000;
    const ws = new GitWorkspaces({
      root,
      ports: new PortAllocator(4000, 4),
      clock: () => now,
    });
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 }); // clone
    const coldStart = performance.now();
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 }); // cold refresh
    const coldMs = performance.now() - coldStart;

    now += 10;
    const warmStart = performance.now();
    await ws.readWorkflow(repo, { maxStaleMs: 60_000 }); // within window
    const warmMs = performance.now() - warmStart;

    // Local file:// mirrors are fast; warm path must still skip the fetch.
    expect(ws.remoteFetchAttemptsForTest()).toBe(1);
    expect(warmMs).toBeLessThan(coldMs + 500);
    // Surface measured numbers for the task report.
    console.info(
      `[mirror-freshness] cold readWorkflow=${coldMs.toFixed(1)}ms ` +
        `within-window=${warmMs.toFixed(1)}ms`,
    );
    expect(coldMs).toBeGreaterThanOrEqual(0);
    expect(warmMs).toBeGreaterThanOrEqual(0);
  });
});

describe('GitWorkspaces.preserve', { timeout: 20_000 }, () => {
  it('commits the agent work to the branch, removes the worktree, KEEPS the branch', async () => {
    const pool = new PortAllocator(4000, 4);
    const ws = new GitWorkspaces({ root, ports: pool });
    const w = await ws.create(repo, 'T-1');
    await writeFile(join(w.dir, 'NEW.md'), 'agent output\n');

    await ws.preserve('T-1', 'hercules: T-1 — did the thing');

    // worktree + scratch gone, port freed
    expect(await exists(w.dir)).toBe(false);
    expect(pool.available).toBe(4);

    // branch still exists in the mirror, with the agent's commit
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const branches = await mirror.branch();
    expect(branches.all).toContain('hercules/T-1');
    const files = await mirror.raw(['show', '--name-only', '--format=', 'hercules/T-1']);
    expect(files).toContain('NEW.md');
    const msg = await mirror.raw(['log', '-1', '--format=%s', 'hercules/T-1']);
    expect(msg.trim()).toBe('hercules: T-1 — did the thing');
  });

  it('preserves the branch even when the agent made no changes', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'T-2');
    await ws.preserve('T-2', 'hercules: T-2 — noop');
    const branches = await simpleGit(join(root, '.mirrors', 'app.git')).branch();
    expect(branches.all).toContain('hercules/T-2');
  });
});

describe('GitWorkspaces.preserve with push', { timeout: 20_000 }, () => {
  it('pushes the preserved branch to origin', async () => {
    // A bare "remote" seeded with main, used as the repo url so the mirror's
    // origin is pushable.
    const bare = join(tmp, 'remote.git');
    const seed = join(tmp, 'seed');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const pushRepo: RepoConfig = { ...repo, url: bare };
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(pushRepo, 'T-9');
    await writeFile(join(w.dir, 'OUT.md'), 'work\n');
    await ws.preserve('T-9', 'hercules: T-9 — work');

    const remoteBranches = await simpleGit(bare).branch();
    expect(remoteBranches.all).toContain('hercules/T-9');
  });

  it('refuses to force-push a tip that rewinds origin (settings-build tip loss)', async () => {
    // Origin has a newer tip; local recover attached an older ancestor. Push
    // must not clobber origin with the older SHA.
    const bare = join(tmp, 'remote-norewind.git');
    const seed = join(tmp, 'seed-norewind');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const pushRepo: RepoConfig = { ...repo, url: bare };
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(pushRepo, 'NR-1');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');

    // Older commit on the task branch.
    await writeFile(join(w.dir, 'old.txt'), 'old\n');
    await git.add(['-A']);
    await git.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'old tip']);
    const older = (await git.raw(['rev-parse', 'HEAD'])).trim();

    // Newer tip (feat) — push this to origin first.
    await writeFile(join(w.dir, 'new.txt'), 'new\n');
    await git.add(['-A']);
    await git.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'feat newer tip']);
    const newer = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('NR-1', 'hercules: NR-1 — newer');

    const bareGit = simpleGit(bare);
    expect((await bareGit.raw(['rev-parse', 'hercules/NR-1'])).trim()).toBe(newer);

    // Simulate bad recover: local branch rewound to older tip, worktree gone,
    // preserve still force-pushes from mirror.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', '-f', 'hercules/NR-1', older]);

    // Re-attach live with missing dir so preserve takes the recover/push path.
    const ws2 = new GitWorkspaces({ root, ports: new PortAllocator(4010, 4), push: true });
    // create will reuse branch at older tip
    const w2 = await ws2.create(pushRepo, 'NR-1');
    await rm(w2.dir, { recursive: true, force: true });
    await ws2.preserve('NR-1', 'hercules: NR-1 — bad recover');

    // Origin must still be the newer tip — refuse rewind.
    expect((await bareGit.raw(['rev-parse', 'hercules/NR-1'])).trim()).toBe(newer);
  });

  it(
    'upgrades an existing weak tip to a better task-related tip still in the object store',
    async () => {
    // Origin rewound to older tip; feat tip remains reachable (pull/*/head style).
    const bare = join(tmp, 'remote-upgrade.git');
    const seed = join(tmp, 'seed-upgrade');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const pushRepo: RepoConfig = { ...repo, url: bare };
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(pushRepo, 'settings-build');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');

    // Weak tip first.
    await writeFile(join(w.dir, 'weak.txt'), 'weak\n');
    await git.add(['-A']);
    await git.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'fix(web): weak settings tip',
    ]);
    const weak = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('settings-build', 'hercules: settings-build — weak');

    // Strong tip (more commits ahead) published, then branch+origin rewound.
    const again = await ws.create(pushRepo, 'settings-build');
    const g2 = simpleGit(again.dir);
    await g2.addConfig('user.email', 'a@h.local');
    await g2.addConfig('user.name', 'Agent');
    await writeFile(join(again.dir, 'selfUpdate.ts'), 'export const x = 1\n');
    await writeFile(join(again.dir, 'more.txt'), 'more work\n');
    await g2.add(['-A']);
    await g2.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'feat(settings): pull, build, and restart daemon from phone UI',
    ]);
    const strong = (await g2.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('settings-build', 'hercules: settings-build — strong');

    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const bareGit = simpleGit(bare);
    // Keep strong reachable after rewind (like leftover pull/6/head).
    await mirror.raw(['update-ref', 'refs/pull/6/head', strong]);
    // Rewind local + origin to weak (bad force-push scenario).
    await mirror.raw(['branch', '-f', 'hercules/settings-build', weak]);
    await bareGit.raw(['update-ref', 'refs/heads/hercules/settings-build', weak]);

    // create should upgrade weak → strong via preferBestKnownTaskTip.
    const fixed = await ws.create(pushRepo, 'settings-build');
    expect(await exists(join(fixed.dir, 'selfUpdate.ts'))).toBe(true);
    const tip = (await mirror.raw(['rev-parse', 'hercules/settings-build'])).trim();
    expect(tip).toBe(strong);
  },
  // 40s: many real-git ops; the box often runs an agent + gates concurrently.
  40_000,
  );

  it('recovers missing local branch from origin tip before dangling heuristics', async () => {
    const bare = join(tmp, 'remote-from-origin.git');
    const seed = join(tmp, 'seed-from-origin');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const pushRepo: RepoConfig = { ...repo, url: bare };
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(pushRepo, 'ORIG-1');
    await writeFile(join(w.dir, 'only-on-origin.txt'), 'feat\n');
    await ws.preserve('ORIG-1', 'hercules: ORIG-1 — published');

    const bareGit = simpleGit(bare);
    const originTip = (await bareGit.raw(['rev-parse', 'hercules/ORIG-1'])).trim();

    // Drop local branch (reclaim used to do this); origin still has the tip.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', '-D', 'hercules/ORIG-1']);

    const again = await ws.create(pushRepo, 'ORIG-1');
    expect(await exists(join(again.dir, 'only-on-origin.txt'))).toBe(true);
    const reattached = (await mirror.raw(['rev-parse', 'hercules/ORIG-1'])).trim();
    expect(reattached).toBe(originTip);
  });
});
describe('GitWorkspaces.inspect', { timeout: 20_000 }, () => {
  it('inspect reports uncommitted changes, local commits, and remote-branch absence', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'INSP-1');
    // worktree starts clean, branch has no commits ahead, not pushed
    let impact = await ws.inspect('INSP-1');
    expect(impact).toEqual({ changedFiles: 0, localCommits: 0, pushedRemote: false });

    // make an uncommitted change
    await writeFile(join(w.dir, 'new.txt'), 'x');
    impact = await ws.inspect('INSP-1');
    expect(impact!.changedFiles).toBeGreaterThan(0);
  });

  it('inspect returns null for an unknown task', async () => {
    const ws = makeWorkspaces();
    expect(await ws.inspect('nope')).toBeNull();
  });

  it('inspect reports localCommits === 1 after a commit in the worktree', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'INSP-2');

    // Commit a new file on the task branch using an explicit author identity.
    await writeFile(join(w.dir, 'work.txt'), 'agent output\n');
    const git = simpleGit(w.dir);
    await git.add('work.txt');
    await git.raw([
      '-c', 'user.email=t@t',
      '-c', 'user.name=t',
      'commit', '-m', 'work',
    ]);

    const impact = await ws.inspect('INSP-2');
    expect(impact).not.toBeNull();
    expect(impact!.localCommits).toBe(1);
    // The change is committed, so changedFiles should be back to 0.
    expect(impact!.changedFiles).toBe(0);
  });

  it('inspect reports pushedRemote === true after pushing the task branch', async () => {
    // Set up a bare pushable remote (same pattern as the "preserve with push" test).
    const bare = join(tmp, 'remote-insp.git');
    const seed = join(tmp, 'seed-insp');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const pushRepo: RepoConfig = { ...repo, url: bare };
    // push:true so that preserve() will push, making pushedRemote visible via ls-remote.
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(pushRepo, 'INSP-3');

    // Make a commit so preserve() has something to push.
    await writeFile(join(w.dir, 'pushed.txt'), 'pushed\n');
    const git = simpleGit(w.dir);
    await git.add('pushed.txt');
    await git.raw([
      '-c', 'user.email=t@t',
      '-c', 'user.name=t',
      'commit', '-m', 'pushed work',
    ]);

    // inspect BEFORE preserve — branch exists locally (localCommits === 1) but
    // has not been pushed to origin yet.
    const beforePush = await ws.inspect('INSP-3');
    expect(beforePush!.localCommits).toBe(1);
    expect(beforePush!.pushedRemote).toBe(false);

    // Provider worktrees deny ordinary push — publish via Hercules exact-CAS
    // from the bare mirror so inspect can observe the remote tip via ls-remote.
    const localTip = (await git.revparse(['HEAD'])).trim().toLowerCase();
    const mirror = join(root, '.mirrors', 'app.git');
    const base = (await simpleGit(mirror).revparse(['main'])).trim().toLowerCase();
    await pushTaskBranchWithExactLease({
      git: simpleGit(mirror),
      originUrl: bare,
      branch: 'hercules/INSP-3',
      localTip,
      lease: { expectedBaseRevision: base, expectedRemoteTip: null },
      allowOwnedReset: false,
    });

    const afterPush = await ws.inspect('INSP-3');
    expect(afterPush!.pushedRemote).toBe(true);
  });
});

describe('GitWorkspaces.reclaimOrphans', { timeout: 20_000 }, () => {
  it('removes an on-disk worktree not in the keep set and returns its id', async () => {
    // Create the workspace in one instance (simulating previous daemon run).
    const ws1 = makeWorkspaces();
    await ws1.create(repo, 'ORPH-1');

    // A fresh instance over the same root — its `live` map is empty, so
    // ORPH-1 on disk looks like an orphan from a crashed instance.
    const ws2 = makeWorkspaces();
    const reclaimed = await ws2.reclaimOrphans(new Set());

    expect(reclaimed).toContain('ORPH-1');
    expect(await exists(join(root, 'app', 'ORPH-1'))).toBe(false);
  });

  it('keeps a worktree whose id is in the keep set', async () => {
    const ws1 = makeWorkspaces();
    await ws1.create(repo, 'LIVE-1');

    const ws2 = makeWorkspaces();
    const reclaimed = await ws2.reclaimOrphans(new Set(['LIVE-1']));

    expect(reclaimed).toEqual([]);
    expect(await exists(join(root, 'app', 'LIVE-1'))).toBe(true);
  });

  it('does NOT reclaim a worktree still live on the SAME instance (this.live guard)', async () => {
    // Use a single workspaces instance: LIVE-2 is in this.live, so reclaimOrphans
    // must skip it even when keep is empty — exercising the `|| this.live.has(taskId)` branch.
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'LIVE-2');

    const reclaimed = await ws.reclaimOrphans(new Set());

    expect(reclaimed).not.toContain('LIVE-2');
    expect(await exists(w.dir)).toBe(true);
  });

  it('skips .mirrors and .scratch dirs when scanning the root', async () => {
    const ws1 = makeWorkspaces();
    await ws1.create(repo, 'ORPH-2');

    // Ensure .mirrors and .scratch are present (they are created by create()).
    expect(await exists(join(root, '.mirrors'))).toBe(true);
    expect(await exists(join(root, '.scratch'))).toBe(true);

    const ws2 = makeWorkspaces();
    // Should not throw even though .mirrors/<repoKey>.git and .scratch exist.
    const reclaimed = await ws2.reclaimOrphans(new Set());
    expect(reclaimed).toContain('ORPH-2');
  });

  it('never deletes a non-worktree directory under the root (e.g. screenshots/)', async () => {
    // The screenshots evidence store shares the work root: <root>/screenshots/<id>.
    // It has no `.git`, so reclaimOrphans must NOT treat it as an orphan worktree
    // and delete it (the bug that wiped all behavioral screenshots on restart).
    const shotDir = join(root, 'screenshots', 'task-2');
    await mkdir(shotDir, { recursive: true });
    await writeFile(join(shotDir, 'evidence-0.png'), 'PNG');

    const ws = makeWorkspaces();
    const reclaimed = await ws.reclaimOrphans(new Set());

    expect(reclaimed).not.toContain('task-2');
    expect(await exists(join(shotDir, 'evidence-0.png'))).toBe(true);
  });

  it('create returns the same live workspace without wiping (no double-clean)', async () => {
    const ws = makeWorkspaces();
    const first = await ws.create(repo, 'DBL-1');
    await writeFile(join(first.dir, 'wip.txt'), 'uncommitted\n');
    const second = await ws.create(repo, 'DBL-1');
    expect(second.dir).toBe(first.dir);
    expect(await exists(join(first.dir, 'wip.txt'))).toBe(true);
  });

  it('create reattaches an on-disk worktree instead of cleanWorktree wipe', async () => {
    // Simulate crash: instance A had a worktree with uncommitted edits; instance B
    // must reattach (orchestrator keep set prevents reclaim) without losing WIP.
    const ws1 = makeWorkspaces();
    const w = await ws1.create(repo, 'REATT-1');
    await writeFile(join(w.dir, 'wip-reattach.txt'), 'keep me across restart\n');
    // Drop live map by using a fresh instance over the same root (dir still there).
    const ws2 = makeWorkspaces();
    const again = await ws2.create(repo, 'REATT-1');
    expect(again.dir).toBe(w.dir);
    expect(await exists(join(again.dir, 'wip-reattach.txt'))).toBe(true);
  });

  it('reclaimOrphans removes checkout but keeps hercules/<id> branch tip', async () => {
    // Case study settings-build: daemon restart reclaim used deleteBranch:true,
    // wiped the task branch, then recover+force-push rewound origin to an older tip.
    // Simulate a crashed daemon: worktree left on disk with commits, not in live map.
    const ws1 = makeWorkspaces();
    const w = await ws1.create(repo, 'KEEP-BR');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');
    await writeFile(join(w.dir, 'feat.txt'), 'keep me\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'feat: keep tip across reclaim',
    ]);
    const tipBefore = (await git.raw(['rev-parse', 'HEAD'])).trim();

    // Fresh instance (empty live map) — worktree looks orphaned.
    const ws2 = makeWorkspaces();
    const reclaimed = await ws2.reclaimOrphans(new Set());
    expect(reclaimed).toContain('KEEP-BR');
    expect(await exists(join(root, 'app', 'KEEP-BR'))).toBe(false);

    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const branches = await mirror.branch();
    expect(branches.all).toContain('hercules/KEEP-BR');
    const tipAfter = (await mirror.raw(['rev-parse', 'hercules/KEEP-BR'])).trim();
    expect(tipAfter).toBe(tipBefore);
  });
});

describe('GitWorkspaces fresh-task provisioning (branch ownership)', { timeout: 20_000 }, () => {
  /** Leave a foreign dangling commit in the mirror (another task's lost work). */
  async function plantForeignDangling(ws: GitWorkspaces, subject: string): Promise<string> {
    const donor = await ws.create(repo, 'donor-task');
    const git = simpleGit(donor.dir);
    await writeFile(join(donor.dir, 'foreign.txt'), 'someone elses work\n');
    await git.add(['-A']);
    await git.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', subject]);
    const tip = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('donor-task', subject);
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', '-D', 'hercules/donor-task']);
    return tip;
  }

  it('a fresh task (no prior work) never adopts foreign dangling commits', async () => {
    // Live incident 2026-07-15: brand-new tasks (ops-cost-caps, onboard-rel-1, …)
    // had their branches "recovered" from other tasks' dangling commits at
    // create() time, then went through review green on foreign diffs.
    const ws = makeWorkspaces();
    await plantForeignDangling(ws, 'feat(web): replace Logout nav with Settings');

    const w = await ws.create(repo, 'ops-cost-caps', { hadPriorWork: false });
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const ahead = (
      await mirror.raw(['rev-list', '--count', 'main..hercules/ops-cost-caps'])
    ).trim();
    expect(ahead).toBe('0');
    expect(await exists(join(w.dir, 'foreign.txt'))).toBe(false);
  });

  it('a fresh task resets a pre-existing branch pointing at unrelated work', async () => {
    const ws = makeWorkspaces();
    const foreignTip = await plantForeignDangling(ws, 'feat(web): replace Logout nav with Settings');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    // Simulate the polluted state the incident left behind.
    await mirror.raw(['branch', 'hercules/fresh-2', foreignTip]);

    const w = await ws.create(repo, 'fresh-2', { hadPriorWork: false });
    const tip = (await mirror.raw(['rev-parse', 'hercules/fresh-2'])).trim();
    const mainTip = (await mirror.raw(['rev-parse', 'main'])).trim();
    expect(tip).toBe(mainTip);
    expect(await exists(join(w.dir, 'foreign.txt'))).toBe(false);
  });

  it('a fresh task keeps a pre-existing branch whose commits mention the task', async () => {
    const ws = makeWorkspaces();
    const prep = await ws.create(repo, 'fresh-3');
    const git = simpleGit(prep.dir);
    await writeFile(join(prep.dir, 'prep.txt'), 'human prep\n');
    await git.add(['-A']);
    await git.raw(['-c', 'user.email=h@h.local', '-c', 'user.name=Human', 'commit', '-m', 'hercules: fresh-3 — prep work']);
    const prepTip = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('fresh-3', 'hercules: fresh-3 — prep work');

    const again = await ws.create(repo, 'fresh-3', { hadPriorWork: false });
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    expect((await mirror.raw(['rev-parse', 'hercules/fresh-3'])).trim()).toBe(prepTip);
    expect(await exists(join(again.dir, 'prep.txt'))).toBe(true);
  });

  it('log-all recovery no longer steals sibling-task commits via token overlap', async () => {
    // Live incident: verify-l3-rework-policy grabbed onboard-verify-1's commit
    // because the token "verify" matched "feat(verify): enforce held-out smoke".
    const ws = makeWorkspaces();
    const donor = await ws.create(repo, 'onboard-verify-1');
    const git = simpleGit(donor.dir);
    await writeFile(join(donor.dir, 'held-out.txt'), 'sibling work\n');
    await git.add(['-A']);
    await git.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'feat(verify): enforce held-out smoke + hard-fail protected paths',
    ]);
    await ws.preserve('onboard-verify-1', 'feat(verify): enforce held-out smoke');

    // Prior-work mode (worst case) with a missing branch: recovery may look,
    // but must not adopt the sibling's reachable commit on a token match.
    const w = await ws.create(repo, 'verify-l3-rework-policy');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const ahead = (
      await mirror.raw(['rev-list', '--count', 'main..hercules/verify-l3-rework-policy'])
    ).trim();
    expect(ahead).toBe('0');
    expect(await exists(join(w.dir, 'held-out.txt'))).toBe(false);
  });

  it('fresh reset may force-push over a polluted origin tip', async () => {
    // Once a fresh task resets its polluted branch to default, preserve must be
    // able to publish the (smaller but correct) new tip — the no-rewind guard
    // compares "commits ahead of main" and would otherwise keep the pollution.
    const bare = join(tmp, 'remote-freshreset.git');
    const seed = join(tmp, 'seed-freshreset');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const pushRepo: RepoConfig = { ...repo, url: bare };
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });

    // Donor publishes two foreign commits onto FR-1's branch name (pollution).
    const donor = await ws.create(pushRepo, 'donor-task');
    const dgit = simpleGit(donor.dir);
    await dgit.addConfig('user.email', 'a@h.local');
    await dgit.addConfig('user.name', 'Agent');
    await writeFile(join(donor.dir, 'p1.txt'), '1\n');
    await dgit.add(['-A']);
    await dgit.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'feat(web): settings one']);
    await writeFile(join(donor.dir, 'p2.txt'), '2\n');
    await dgit.add(['-A']);
    await dgit.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'feat(web): settings two']);
    const polluted = (await dgit.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('donor-task', 'feat(web): settings');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', 'hercules/FR-1', polluted]);
    await simpleGit(bare).raw(['update-ref', 'refs/heads/hercules/FR-1', polluted]);

    const w = await ws.create(pushRepo, 'FR-1', { hadPriorWork: false });
    await writeFile(join(w.dir, 'real.txt'), 'the actual task work\n');
    await ws.preserve('FR-1', 'hercules: FR-1 — real work');

    const originTip = (await simpleGit(bare).raw(['rev-parse', 'hercules/FR-1'])).trim();
    const tree = await simpleGit(bare).raw(['ls-tree', '-r', '--name-only', originTip]);
    expect(tree).toContain('real.txt');
    // Pollution history must be gone from the published tip, not layered under it.
    expect(tree).not.toContain('p1.txt');
    const ahead = (await simpleGit(bare).raw(['rev-list', '--count', `main..${originTip}`])).trim();
    expect(ahead).toBe('1');
  });
});

describe('GitWorkspaces.reclaimOrphans ownership lock', { timeout: 20_000 }, () => {
  it('skips reclaim entirely when another LIVE daemon owns the work root', async () => {
    // 2026-07-17 incident: an instance-under-test (L2 boot / agent experiment)
    // pointed at the production work root reclaimOrphans'd every live worktree.
    const ws1 = makeWorkspaces();
    await ws1.create(repo, 'OWNED-1');
    // Another live process owns the root (pid 1 is always alive, never us).
    await writeFile(join(root, '.hercules-owner.lock'), '1\n');

    const ws2 = makeWorkspaces();
    const reclaimed = await ws2.reclaimOrphans(new Set());
    expect(reclaimed).toEqual([]);
    expect(await exists(join(root, 'app', 'OWNED-1'))).toBe(true);
  });

  it('reclaims when the lock is stale (dead pid) and claims the root', async () => {
    const ws1 = makeWorkspaces();
    await ws1.create(repo, 'STALE-1');
    // A pid that cannot be alive (kernel pid_max default is far below this on
    // this box, and spawn cycles make reuse of a just-dead pid unlikely).
    await writeFile(join(root, '.hercules-owner.lock'), '999999999\n');

    const ws2 = makeWorkspaces();
    const reclaimed = await ws2.reclaimOrphans(new Set());
    expect(reclaimed).toContain('STALE-1');
    // Composition-root lease is authoritative; reclaim no longer rewrites the
    // legacy pid lock; stale content must remain unchanged.
    const lock = await readFile(join(root, '.hercules-owner.lock'), 'utf8');
    expect(lock).toBe('999999999\n');
  });

  it('claims the root on first reclaim when no lock exists', async () => {
    const ws1 = makeWorkspaces();
    await ws1.create(repo, 'CLAIM-1');
    const ws2 = makeWorkspaces();
    const reclaimed = await ws2.reclaimOrphans(new Set());
    expect(reclaimed).toContain('CLAIM-1');
    // Composition lease owns the root; reclaim must not plant a legacy lock.
    expect(await exists(join(root, '.hercules-owner.lock'))).toBe(false);
  });
});

describe('GitWorkspaces prior-work tip upgrade stays within own history', { timeout: 20_000 }, () => {
  it('does not upgrade an existing branch to a foreign dangling tip on rework rounds', async () => {
    // Live incident 2026-07-17: rework dispatch (hadPriorWork=true) of
    // onboard-rel-1 "upgraded" its branch from main to the quarantined foreign
    // Settings commit because the dangling scan only ranks by commits-ahead.
    const ws = makeWorkspaces();
    // Foreign dangling work (another task's lost commits, ahead of main).
    const donor = await ws.create(repo, 'donor-task');
    const dgit = simpleGit(donor.dir);
    await writeFile(join(donor.dir, 'foreign.txt'), 'foreign\n');
    await dgit.add(['-A']);
    await dgit.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'fix(web): add L2 data-evidence hooks on Settings']);
    await ws.preserve('donor-task', 'fix(web): settings');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', '-D', 'hercules/donor-task']);

    // Rework task: branch EXISTS at main (fresh reset happened last round).
    await mirror.raw(['branch', 'hercules/rework-1', 'main']);
    const mainTip = (await mirror.raw(['rev-parse', 'main'])).trim();

    const w = await ws.create(repo, 'rework-1'); // prior-work mode (no opts)
    const tip = (await mirror.raw(['rev-parse', 'hercules/rework-1'])).trim();
    expect(tip).toBe(mainTip);
    expect(await exists(join(w.dir, 'foreign.txt'))).toBe(false);
  });
});

describe('GitWorkspaces origin tips obey the adoption rule', { timeout: 20_000 }, () => {
  it('does not upgrade a history-less branch to an unrelated origin tip', async () => {
    // Live incident 2026-07-17 (verify-l3-rework-policy): after a fresh reset,
    // a restart-recovery dispatch re-adopted the STALE polluted origin ref —
    // same branch name is not ownership proof when its commits are foreign.
    const bare = join(tmp, 'remote-oadopt.git');
    const seed = join(tmp, 'seed-oadopt');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const pushRepo: RepoConfig = { ...repo, url: bare };
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });

    // Foreign commits published under this task's branch name (pre-incident).
    const donor = await ws.create(pushRepo, 'donor-task');
    const dgit = simpleGit(donor.dir);
    await dgit.addConfig('user.email', 'a@h.local');
    await dgit.addConfig('user.name', 'Agent');
    await writeFile(join(donor.dir, 'foreign.txt'), 'foreign\n');
    await dgit.add(['-A']);
    await dgit.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'feat(verify): enforce held-out smoke']);
    const polluted = (await dgit.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('donor-task', 'feat(verify): held-out');
    await simpleGit(bare).raw(['update-ref', 'refs/heads/hercules/oadopt-1', polluted]);

    // The task's local branch sits at main (fresh reset happened); a recovery
    // dispatch (prior-work mode) must keep it there, not adopt the origin tip.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', 'hercules/oadopt-1', 'main']);
    const mainTip = (await mirror.raw(['rev-parse', 'main'])).trim();

    const w = await ws.create(pushRepo, 'oadopt-1');
    const tip = (await mirror.raw(['rev-parse', 'hercules/oadopt-1'])).trim();
    expect(tip).toBe(mainTip);
    expect(await exists(join(w.dir, 'foreign.txt'))).toBe(false);
  });
});

describe('GitWorkspaces clean-salvage fork', { timeout: 30_000 }, () => {
  it('resolve is read-only; first provision seeds target after source worktree reclaimed', async () => {
    const ws = makeWorkspaces();
    const source = await ws.create(repo, 'FAIL-SRC');
    const git = simpleGit(source.dir);
    await writeFile(join(source.dir, 'partial.txt'), 'salvage me\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: FAIL-SRC — partial work',
    ]);
    const sourceSha = (await git.raw(['rev-parse', 'HEAD'])).trim();
    // preserve removes the worktree but keeps the salvage branch (reclaimed state).
    await ws.preserve('FAIL-SRC', 'hercules: FAIL-SRC — preserve');
    expect(await exists(join(root, 'app', 'FAIL-SRC'))).toBe(false);

    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const sourceTipBefore = (await mirror.raw(['rev-parse', 'hercules/FAIL-SRC'])).trim();
    expect(sourceTipBefore).toBe(sourceSha);

    // Fresh process — resolve is read-only (no target branch yet).
    const ws2 = makeWorkspaces();
    const resolved = await ws2.resolveSalvageSourceTip(repo, 'FAIL-SRC', 'FAIL-TGT');
    expect(resolved.sourceSha).toBe(sourceSha);
    expect(resolved.targetBranch).toBe('hercules/FAIL-TGT');
    const branches = await mirror.branch();
    expect(branches.all.includes('hercules/FAIL-TGT')).toBe(false);

    // Source branch immutable.
    expect((await mirror.raw(['rev-parse', 'hercules/FAIL-SRC'])).trim()).toBe(sourceSha);

    // First provision creates target from stamped SHA.
    const target = await ws2.create(repo, 'FAIL-TGT', {
      hadPriorWork: false,
      seedFromSha: sourceSha,
    });
    expect(await exists(join(target.dir, 'partial.txt'))).toBe(true);
    expect((await simpleGit(target.dir).raw(['rev-parse', 'HEAD'])).trim()).toBe(sourceSha);
    expect(target.branch).toBe('hercules/FAIL-TGT');
  });

  it('verify-from-ref (C3.43): resolveOriginRef names an origin branch or SHA read-only and first provision seeds from it', async () => {
    // A non-task branch on origin with a fully finished change.
    const origin = simpleGit(targetUrl);
    await origin.checkout(['-b', 'grok-cto/console-fixed']);
    await writeFile(join(targetUrl, 'fixed.txt'), 'verified elsewhere\n');
    await origin.add('.');
    await origin.commit('fixed tip');
    const firstSha = (await origin.raw(['rev-parse', 'HEAD'])).trim();
    await writeFile(join(targetUrl, 'fixed2.txt'), 'second commit\n');
    await origin.add('.');
    await origin.commit('fixed tip 2');
    const fixedSha = (await origin.raw(['rev-parse', 'HEAD'])).trim();
    await origin.checkout(['main']);

    const ws = makeWorkspaces();
    expect(await ws.resolveOriginRef(repo, 'grok-cto/console-fixed')).toBe(fixedSha);
    // A bare SHA must be a CURRENT origin head (presence proven by ls-remote,
    // never by the mirror's object store — round 21 N4).
    expect(await ws.resolveOriginRef(repo, fixedSha.toUpperCase())).toBe(fixedSha);
    await expect(ws.resolveOriginRef(repo, firstSha)).rejects.toThrow(/not the tip of any branch on origin/);
    await expect(ws.resolveOriginRef(repo, 'grok-cto/nope')).rejects.toThrow(/does not exist on origin/);
    await expect(ws.resolveOriginRef(repo, '0'.repeat(40))).rejects.toThrow(/not the tip of any branch on origin/);
    for (const bad of ['../x', 'refs/heads/main', '-flag', 'a b', 'x..y', '']) {
      await expect(ws.resolveOriginRef(repo, bad)).rejects.toThrow(/not a branch name or a full commit SHA/);
    }
    // Read-only: no branch was created on the mirror.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    expect((await mirror.branch()).all.some((b) => b.includes('VER-1'))).toBe(false);

    const target = await ws.create(repo, 'VER-1', { hadPriorWork: false, seedFromSha: fixedSha });
    expect(await exists(join(target.dir, 'fixed.txt'))).toBe(true);
    expect((await simpleGit(target.dir).raw(['rev-parse', 'HEAD'])).trim()).toBe(fixedSha);
    expect(target.branch).toBe('hercules/VER-1');
    // Origin branch untouched.
    expect((await origin.raw(['rev-parse', 'grok-cto/console-fixed'])).trim()).toBe(fixedSha);
  });

  it('re-provision keeps seed-descendant progress; source tip unchanged', async () => {
    const ws = makeWorkspaces();
    const source = await ws.create(repo, 'IDEM-SRC');
    const sgit = simpleGit(source.dir);
    await writeFile(join(source.dir, 'base.txt'), 'base\n');
    await sgit.add(['-A']);
    await sgit.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: IDEM-SRC — base',
    ]);
    const sourceSha = (await sgit.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('IDEM-SRC', 'hercules: IDEM-SRC — preserve');

    await ws.resolveSalvageSourceTip(repo, 'IDEM-SRC', 'IDEM-TGT');
    const first = await ws.create(repo, 'IDEM-TGT', {
      seedFromSha: sourceSha,
      hadPriorWork: false,
    });
    const tgit = simpleGit(first.dir);
    await writeFile(join(first.dir, 'more.txt'), 'progress\n');
    await tgit.add(['-A']);
    await tgit.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: IDEM-TGT — progress',
    ]);
    const progressed = (await tgit.raw(['rev-parse', 'HEAD'])).trim();
    expect(progressed).not.toBe(sourceSha);
    await ws.preserve('IDEM-TGT', 'hercules: IDEM-TGT — preserve');

    // Resolve refuses once target branch exists (read-only target-absence).
    await expect(ws.resolveSalvageSourceTip(repo, 'IDEM-SRC', 'IDEM-TGT')).rejects.toThrow(
      /already exists|collision/i,
    );

    // Re-provision with hadPriorWork keeps progressed descendant tip (no rewind).
    const again = await ws.create(repo, 'IDEM-TGT', {
      seedFromSha: sourceSha,
      hadPriorWork: true,
    });
    expect((await simpleGit(again.dir).raw(['rev-parse', 'HEAD'])).trim()).toBe(progressed);
    expect(await exists(join(again.dir, 'more.txt'))).toBe(true);

    // Source still at original tip.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    expect((await mirror.raw(['rev-parse', 'hercules/IDEM-SRC'])).trim()).toBe(sourceSha);
  });

  it('recreates missing target branch from stamped seed SHA', async () => {
    const ws = makeWorkspaces();
    const source = await ws.create(repo, 'REC-SRC');
    const sgit = simpleGit(source.dir);
    await writeFile(join(source.dir, 'keep.txt'), 'keep\n');
    await sgit.add(['-A']);
    await sgit.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: REC-SRC — keep',
    ]);
    const sourceSha = (await sgit.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('REC-SRC', 'hercules: REC-SRC — preserve');
    await ws.resolveSalvageSourceTip(repo, 'REC-SRC', 'REC-TGT');

    // First provision creates the branch; then delete it to simulate reclaim race.
    const first = await ws.create(repo, 'REC-TGT', {
      seedFromSha: sourceSha,
      hadPriorWork: false,
    });
    await ws.preserve('REC-TGT', 'hercules: REC-TGT — preserve');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', '-D', 'hercules/REC-TGT']);

    const again = await ws.create(repo, 'REC-TGT', {
      seedFromSha: sourceSha,
      hadPriorWork: true,
    });
    expect((await simpleGit(again.dir).raw(['rev-parse', 'HEAD'])).trim()).toBe(sourceSha);
    expect(await exists(join(again.dir, 'keep.txt'))).toBe(true);
    expect(first.branch).toBe('hercules/REC-TGT');
  });

  it('first dispatch rejects existing target branch at unrelated tip', async () => {
    const ws = makeWorkspaces();
    const source = await ws.create(repo, 'RACE-SRC');
    const sgit = simpleGit(source.dir);
    await writeFile(join(source.dir, 'seed.txt'), 'seed\n');
    await sgit.add(['-A']);
    await sgit.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: RACE-SRC — seed',
    ]);
    const sourceSha = (await sgit.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('RACE-SRC', 'hercules: RACE-SRC — preserve');

    // Plant a foreign tip under the target branch name (race / pollution).
    const foreign = await ws.create(repo, 'RACE-FOREIGN');
    const fgit = simpleGit(foreign.dir);
    await writeFile(join(foreign.dir, 'foreign.txt'), 'nope\n');
    await fgit.add(['-A']);
    await fgit.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: RACE-FOREIGN — pollution',
    ]);
    const foreignSha = (await fgit.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('RACE-FOREIGN', 'hercules: RACE-FOREIGN — preserve');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', 'hercules/RACE-TGT', foreignSha]);
    expect(foreignSha).not.toBe(sourceSha);

    await expect(
      ws.create(repo, 'RACE-TGT', { seedFromSha: sourceSha, hadPriorWork: false }),
    ).rejects.toThrow(/unrelated tip|first dispatch|exact seed/i);

    // Source and foreign tips unchanged.
    expect((await mirror.raw(['rev-parse', 'hercules/RACE-SRC'])).trim()).toBe(sourceSha);
    expect((await mirror.raw(['rev-parse', 'hercules/RACE-TGT'])).trim()).toBe(foreignSha);
  });

  it('re-provision rejects unrelated tip even when hadPriorWork is true', async () => {
    const ws = makeWorkspaces();
    const source = await ws.create(repo, 'REJ-SRC');
    const sgit = simpleGit(source.dir);
    await writeFile(join(source.dir, 'seed.txt'), 'seed\n');
    await sgit.add(['-A']);
    await sgit.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: REJ-SRC — seed',
    ]);
    const sourceSha = (await sgit.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('REJ-SRC', 'hercules: REJ-SRC — preserve');

    const foreign = await ws.create(repo, 'REJ-FOREIGN');
    const fgit = simpleGit(foreign.dir);
    await writeFile(join(foreign.dir, 'other.txt'), 'other\n');
    await fgit.add(['-A']);
    await fgit.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: REJ-FOREIGN — other',
    ]);
    const foreignSha = (await fgit.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('REJ-FOREIGN', 'hercules: REJ-FOREIGN — preserve');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', 'hercules/REJ-TGT', foreignSha]);

    await expect(
      ws.create(repo, 'REJ-TGT', { seedFromSha: sourceSha, hadPriorWork: true }),
    ).rejects.toThrow(/unrelated tip|not a seed descendant/i);
  });

  it('refuses missing source branch and unsafe ids on resolve', async () => {
    const ws = makeWorkspaces();
    await expect(ws.resolveSalvageSourceTip(repo, 'NO-BRANCH', 'T')).rejects.toThrow(
      /missing on mirror and origin/i,
    );
    await expect(ws.resolveSalvageSourceTip(repo, '../evil', 'T')).rejects.toThrow(
      /safe identifier/i,
    );
    await expect(ws.resolveSalvageSourceTip(repo, 'S', 'bad/id')).rejects.toThrow(
      /safe identifier/i,
    );
  });

  it('recovers missing local branch from origin tip for resolveSalvageSourceTip', async () => {
    const bare = join(tmp, 'remote-salvage-origin.git');
    const seed = join(tmp, 'seed-salvage-origin');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const pushRepo: RepoConfig = { ...repo, url: bare };
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const source = await ws.create(pushRepo, 'SALV-ORIG');
    await writeFile(join(source.dir, 'only-on-origin.txt'), 'feat\n');
    const sgit = simpleGit(source.dir);
    await sgit.add(['-A']);
    await sgit.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: SALV-ORIG — published',
    ]);
    await ws.preserve('SALV-ORIG', 'hercules: SALV-ORIG — published');

    const bareGit = simpleGit(bare);
    const originTip = (await bareGit.raw(['rev-parse', 'hercules/SALV-ORIG'])).trim();

    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', '-D', 'hercules/SALV-ORIG']);

    const resolved = await ws.resolveSalvageSourceTip(pushRepo, 'SALV-ORIG', 'SALV-TGT');
    expect(resolved.sourceSha).toBe(originTip);
    expect(resolved.sourceBranch).toBe('hercules/SALV-ORIG');
    const reattached = (await mirror.raw(['rev-parse', 'hercules/SALV-ORIG'])).trim();
    expect(reattached).toBe(originTip);
  });

  it('names mirror and origin when salvage source tip is missing on both', async () => {
    const ws = makeWorkspaces();
    await expect(ws.resolveSalvageSourceTip(repo, 'GONE-BOTH', 'T')).rejects.toThrow(
      /mirror/i,
    );
    await expect(ws.resolveSalvageSourceTip(repo, 'GONE-BOTH', 'T')).rejects.toThrow(
      /origin/i,
    );
  });

  it('ordinary fresh tasks still never adopt foreign salvage tips', async () => {
    const ws = makeWorkspaces();
    const source = await ws.create(repo, 'POLLUTE-SRC');
    const sgit = simpleGit(source.dir);
    await writeFile(join(source.dir, 'foreign-salvage.txt'), 'nope\n');
    await sgit.add(['-A']);
    await sgit.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: POLLUTE-SRC — work',
    ]);
    const sourceSha = (await sgit.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('POLLUTE-SRC', 'hercules: POLLUTE-SRC — preserve');

    // Plant a polluted branch name for a brand-new ordinary task.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', 'hercules/ordinary-new', sourceSha]);

    const ordinary = await ws.create(repo, 'ordinary-new', { hadPriorWork: false });
    expect(await exists(join(ordinary.dir, 'foreign-salvage.txt'))).toBe(false);
    const mainTip = (await mirror.raw(['rev-parse', 'main'])).trim();
    expect((await mirror.raw(['rev-parse', 'hercules/ordinary-new'])).trim()).toBe(mainTip);
  });
});

describe('GitWorkspaces.preservedTipStatus (verified-SHA invariant)', { timeout: 20_000 }, () => {
  it('resolves one exact preserved candidate and its base-to-tip paths without moving refs', async () => {
    const ws = new GitWorkspaces({
      root, ports: new PortAllocator(4000, 4), push: true,
    });
    const w = await ws.create(repo, 'LEASE-PROOF');
    const git = simpleGit(w.dir);
    await writeFile(join(w.dir, 'owned.txt'), 'owned\n');
    await writeFile(join(w.dir, 'second.txt'), 'second\n');
    await git.add(['-A']);
    await git.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'hercules: LEASE-PROOF — candidate',
    ]);
    const tip = (await git.revparse(['HEAD'])).trim();
    await ws.preserve('LEASE-PROOF', 'hercules: LEASE-PROOF — preserve');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw([
      'update-ref', 'refs/heads/hercules/LEASE-PROOF',
      w.branchLease.expectedBaseRevision, tip,
    ]);

    await expect(
      ws.inspectPreservedCandidate(repo, 'LEASE-PROOF', tip, w.branchLease.expectedBaseRevision),
    ).resolves.toMatchObject({
      tip,
      filesTouched: ['owned.txt', 'second.txt'],
      trustedDefaultRevision: w.branchLease.expectedBaseRevision,
      workflowContentAtTrustedDefault: expect.stringContaining('pnpm test'),
    });
    await expect(
      ws.inspectPreservedCandidate(repo, 'LEASE-PROOF', '3'.repeat(40), w.branchLease.expectedBaseRevision),
    ).rejects.toThrow(/moved/);
    expect((await mirror.revparse([
      'refs/heads/hercules/LEASE-PROOF',
    ])).trim()).toBe(w.branchLease.expectedBaseRevision);
  });

  it('binds policy to the older candidate base after main advances and preserves hostile path bytes', async () => {
    const ws = new GitWorkspaces({
      root, ports: new PortAllocator(4000, 4), push: true,
    });
    const w = await ws.create(repo, 'LEASE-OLD-BASE');
    const git = simpleGit(w.dir);
    await mkdir(join(w.dir, 'src'), { recursive: true });
    await writeFile(join(w.dir, 'src', 'allowed.ts'), 'normal\n');
    await writeFile(join(w.dir, 'src', 'allowed.ts '), 'trailing space\n');
    await writeFile(join(w.dir, 'src', 'allowed.ts\n'), 'trailing newline\n');
    await git.add(['-A']);
    await git.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'hercules: LEASE-OLD-BASE — candidate',
    ]);
    const tip = (await git.revparse(['HEAD'])).trim();
    await ws.preserve('LEASE-OLD-BASE', 'hercules: LEASE-OLD-BASE — preserve');

    const target = simpleGit(targetUrl);
    await writeFile(
      join(targetUrl, 'WORKFLOW.md'),
      '---\nprotected_paths:\n  - newly-protected/**\n---\nnew policy\n',
    );
    await target.add('WORKFLOW.md');
    await target.commit('advance trusted main policy');
    const advancedMain = (await target.revparse(['HEAD'])).trim();

    const proof = await ws.inspectPreservedCandidate(
      repo,
      'LEASE-OLD-BASE',
      tip,
      w.branchLease.expectedBaseRevision,
    );
    expect(proof.trustedDefaultRevision).toBe(advancedMain);
    expect(proof.workflowContentAtTrustedDefault).toContain('newly-protected');
    expect(proof.workflowContentAtTrustedDefault).not.toContain('pnpm test');
    expect(proof.filesTouched).toContain('src/allowed.ts');
    expect(proof.filesTouched).toContain('src/allowed.ts ');
    expect(proof.filesTouched).toContain('src/allowed.ts\n');
    await expect(ws.inspectPreservedCandidate(
      repo, 'LEASE-OLD-BASE', tip, advancedMain,
    )).rejects.toThrow(/does not contain the trusted base/);
    await expect(ws.inspectPreservedCandidate(
      repo, 'LEASE-OLD-BASE', tip, tip,
    )).rejects.toThrow(/not an ancestor of the trusted default/);
    expect((await target.revparse(['refs/heads/hercules/LEASE-OLD-BASE'])).trim()).toBe(tip);
  });

  it('rejects when the exact remote task ref moves during immutable proof', async () => {
    const setup = new GitWorkspaces({
      root, ports: new PortAllocator(4000, 4), push: true,
    });
    const w = await setup.create(repo, 'LEASE-RACE');
    const git = simpleGit(w.dir);
    await writeFile(join(w.dir, 'owned.txt'), 'owned\n');
    await git.add(['-A']);
    await git.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'hercules: LEASE-RACE — candidate',
    ]);
    const tip = (await git.revparse(['HEAD'])).trim();
    await setup.preserve('LEASE-RACE', 'hercules: LEASE-RACE — preserve');

    const remote = simpleGit(targetUrl);
    const tree = (await remote.raw(['rev-parse', `${tip}^{tree}`])).trim();
    const moved = (await remote.raw([
      '-c', 'user.email=race@h.local', '-c', 'user.name=Race',
      'commit-tree', tree, '-p', tip, '-m', 'concurrent remote move',
    ])).trim();
    const proof = new GitWorkspaces({
      root,
      ports: new PortAllocator(5000, 4),
      beforeExactCandidateReturnVerify: async () => {
        await remote.raw([
          'update-ref', 'refs/heads/hercules/LEASE-RACE', moved, tip,
        ]);
      },
    });

    await expect(proof.inspectPreservedCandidate(
      repo, 'LEASE-RACE', tip, w.branchLease.expectedBaseRevision,
    )).rejects.toThrow(/moved/);
    expect((await remote.revparse(['refs/heads/hercules/LEASE-RACE'])).trim()).toBe(moved);
    const proofRefs = await simpleGit(join(root, '.mirrors', 'app.git')).raw([
      'for-each-ref', '--format=%(refname)', 'refs/hercules-fetch/LEASE-RACE-',
    ]);
    expect(proofRefs.trim()).toBe('');
  });

  it('rejects when the trusted default moves during immutable proof', async () => {
    const setup = new GitWorkspaces({
      root, ports: new PortAllocator(4000, 4), push: true,
    });
    const w = await setup.create(repo, 'LEASE-DEFAULT-RACE');
    const git = simpleGit(w.dir);
    await writeFile(join(w.dir, 'owned.txt'), 'owned\n');
    await git.add(['-A']);
    await git.raw([
      '-c', 'user.email=a@h.local', '-c', 'user.name=Agent',
      'commit', '-m', 'hercules: LEASE-DEFAULT-RACE — candidate',
    ]);
    const tip = (await git.revparse(['HEAD'])).trim();
    await setup.preserve('LEASE-DEFAULT-RACE', 'hercules: LEASE-DEFAULT-RACE — preserve');

    const proof = new GitWorkspaces({
      root,
      ports: new PortAllocator(5000, 4),
      beforeExactCandidateReturnVerify: async () => {
        const remote = simpleGit(targetUrl);
        await writeFile(join(targetUrl, 'concurrent.txt'), 'advance\n');
        await remote.add('concurrent.txt');
        await remote.commit('concurrent default move');
      },
    });

    await expect(proof.inspectPreservedCandidate(
      repo, 'LEASE-DEFAULT-RACE', tip, w.branchLease.expectedBaseRevision,
    )).rejects.toThrow(/default.*moved/);
    expect((await simpleGit(targetUrl).revparse(['refs/heads/hercules/LEASE-DEFAULT-RACE'])).trim()).toBe(tip);
  });

  it('accepts tip == verified SHA exactly', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'VS-0');
    const git = simpleGit(w.dir);
    await writeFile(join(w.dir, 'work.txt'), 'verified work\n');
    await git.add(['-A']);
    await git.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'feat: verified work']);
    const verified = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('VS-0', 'hercules: VS-0 — preserve');

    const status = await ws.preservedTipStatus('app', 'VS-0', verified);
    expect(status.ok).toBe(true);
    expect(status.tip).toBe(verified);
  });

  it('accepts exactly one tree-identical (empty) preserve commit on top of verified', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'VS-1');
    const git = simpleGit(w.dir);
    await writeFile(join(w.dir, 'work.txt'), 'verified work\n');
    await git.add(['-A']);
    await git.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'feat: verified work']);
    const verified = (await git.raw(['rev-parse', 'HEAD'])).trim();
    // Empty commit while worktree is still live (preserve disposes the dir).
    // Same tree as verified — tolerate the single preserve auto-commit.
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '--allow-empty',
      '-m',
      'hercules: empty preserve',
    ]);
    await ws.preserve('VS-1', 'hercules: VS-1 — empty preserve pin');

    const status = await ws.preservedTipStatus('app', 'VS-1', verified);
    expect(status.ok).toBe(true);
    expect(status.tip).not.toBeNull();
    expect(status.tip).not.toBe(verified);
  });

  it('rejects a content-changing commit after verification', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'VS-1b');
    const git = simpleGit(w.dir);
    await writeFile(join(w.dir, 'work.txt'), 'verified work\n');
    await git.add(['-A']);
    await git.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'feat: verified work']);
    const verified = (await git.raw(['rev-parse', 'HEAD'])).trim();
    // Content-changing commit after verify must NOT be tolerated.
    await writeFile(join(w.dir, 'leftover.txt'), 'uncommitted at verify time\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'content-changing leftover',
    ]);
    await ws.preserve('VS-1b', 'hercules: VS-1b — preserve');

    const status = await ws.preservedTipStatus('app', 'VS-1b', verified);
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/content-changing|tree-identical/i);
  });

  it('rejects a tip that does not contain the verified SHA (lost/replaced work)', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'VS-2');
    const git = simpleGit(w.dir);
    await writeFile(join(w.dir, 'real.txt'), 'the verified work\n');
    await git.add(['-A']);
    await git.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=Agent', 'commit', '-m', 'feat: real work']);
    const verified = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('VS-2', 'hercules: VS-2 — preserve');

    // Simulate the incident: branch force-moved to an unrelated commit.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', '-f', 'hercules/VS-2', 'main']);
    const status = await ws.preservedTipStatus('app', 'VS-2', verified);
    expect(status.ok).toBe(false);
    expect(status.reason).toMatch(/verified/i);
  });

  it('rejects when the branch is missing entirely', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'VS-3');
    await ws.remove('VS-3');
    const status = await ws.preservedTipStatus('app', 'VS-3', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(status.ok).toBe(false);
    expect(status.tip).toBeNull();
  });
});

describe('GitWorkspaces ensureMirror origin reconciliation', { timeout: 20_000 }, () => {
  it(
    're-points an existing mirror origin when repo.url changes',
    async () => {
    // Two real source repos A and B, each with a commit on main.
    const repoA = join(tmp, 'source-alpha');
    const repoB = join(tmp, 'source-beta');

    for (const [path, name] of [[repoA, 'alpha'] as const, [repoB, 'beta'] as const]) {
      await mkdir(path, { recursive: true });
      const g = simpleGit(path);
      await g.init(['-b', 'main']);
      await g.addConfig('user.email', 't@h.local');
      await g.addConfig('user.name', 'T');
      await writeFile(join(path, `${name}.txt`), `${name} content\n`);
      await g.add('.');
      await g.commit(`initial ${name}`);
    }

    const ws = makeWorkspaces();

    // 1. Create mirror from repoA, then remove the workspace.
    const repoConfigA: RepoConfig = { key: 'rchg', url: repoA, defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' };
    await ws.create(repoConfigA, 'chg-1');
    await ws.remove('chg-1');

    // 2. Create mirror again but with repoB url — ensureMirror must update origin.
    const repoConfigB: RepoConfig = { key: 'rchg', url: repoB, defaultBranch: 'main', workflow: 'WORKFLOW.md', maxConcurrent: 1, adapter: null, readiness: 'ready' };
    await ws.create(repoConfigB, 'chg-2');
    await ws.remove('chg-2');

    // 3. Verify the mirror's origin now points at repoB, not repoA.
    const mirror = join(root, '.mirrors', 'rchg.git');
    const originUrl = (await simpleGit(mirror).raw(['remote', 'get-url', 'origin'])).trim();
    expect(originUrl).toBe(repoB);
  },
  15_000,
  );
});

describe('GitWorkspaces ensureMirror self-heal (stray worktree pins default branch)', { timeout: 20_000 }, () => {
  it('detaches a stray mirror worktree holding main so the fetch still lands', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'sh-1');
    await ws.remove('sh-1');

    // An agent left a disposable review worktree with `main` checked out
    // (live incident 2026-07-16: /tmp/hercules-l3-rework-review) — git then
    // refuses `+refs/heads/main:refs/heads/main` into the mirror forever.
    const mirror = join(root, '.mirrors', 'app.git');
    const stray = join(tmp, 'stray-review');
    await simpleGit(mirror).raw(['worktree', 'add', stray, 'main']);

    // Upstream advances.
    const g = simpleGit(targetUrl);
    await writeFile(join(targetUrl, 'new.txt'), 'newer\n');
    await g.add('.');
    await g.commit('advance main');
    const upstreamTip = (await g.revparse(['main'])).trim();

    // Next provision must self-heal: detach the stray worktree, retry fetch.
    await ws.create(repo, 'sh-2');
    const mirrorTip = (await simpleGit(mirror).revparse(['main'])).trim();
    expect(mirrorTip).toBe(upstreamTip);

    // Stray worktree keeps its files but no longer pins the branch.
    expect(await exists(join(stray, 'README.md'))).toBe(true);
    const strayHead = (await readFile(join(mirror, 'worktrees', 'stray-review', 'HEAD'), 'utf8')).trim();
    expect(strayHead).not.toContain('refs/heads/main');
  });

  it('prunes a stray worktree whose directory is already gone', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'sh-3');
    await ws.remove('sh-3');
    const mirror = join(root, '.mirrors', 'app.git');
    const stray = join(tmp, 'stray-gone');
    await simpleGit(mirror).raw(['worktree', 'add', stray, 'main']);
    await rm(stray, { recursive: true, force: true });

    const g = simpleGit(targetUrl);
    await writeFile(join(targetUrl, 'new2.txt'), 'newer2\n');
    await g.add('.');
    await g.commit('advance again');
    const upstreamTip = (await g.revparse(['main'])).trim();

    await ws.create(repo, 'sh-4');
    expect((await simpleGit(mirror).revparse(['main'])).trim()).toBe(upstreamTip);
  });
});

describe('GitWorkspaces.remove', { timeout: 20_000 }, () => {
  it('removes the worktree, deletes the branch, frees the port and scratch', async () => {
    const pool = new PortAllocator(4000, 4);
    const ws = new GitWorkspaces({ root, ports: pool });
    const w = await ws.create(repo, 'T-1');
    expect(pool.available).toBe(3);

    await ws.remove('T-1');

    expect(await exists(w.dir)).toBe(false);
    expect(await exists(w.allocation.scratchDir)).toBe(false);
    expect(pool.available).toBe(4);
    // branch gone from the mirror
    const branches = await simpleGit(join(root, '.mirrors', 'app.git')).branch();
    expect(branches.all).not.toContain('hercules/T-1');
  });

  it('is a no-op for an unknown task', async () => {
    const ws = makeWorkspaces();
    await expect(ws.remove('never-created')).resolves.toBeUndefined();
  });

  it('allows re-creating a task after removal (clean branch + dir)', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'T-1');
    await ws.remove('T-1');
    const again = await ws.create(repo, 'T-1');
    expect(again.branch).toBe('hercules/T-1');
    expect(await exists(join(again.dir, 'README.md'))).toBe(true);
  });

  it('reuses a preserved task branch on re-create (L3 auto-rework continuity)', async () => {
    const pool = new PortAllocator(4000, 4);
    const ws = new GitWorkspaces({ root, ports: pool });
    const w = await ws.create(repo, 'REWORK-1');
    await writeFile(join(w.dir, 'note.txt'), 'from first pass\n');
    await ws.preserve('REWORK-1', 'hercules: REWORK-1 first pass');

    // Prove the mirror still has the commit before re-create.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const branches = await mirror.branch();
    expect(branches.all).toContain('hercules/REWORK-1');
    const files = await mirror.raw(['show', '--name-only', '--format=', 'hercules/REWORK-1']);
    expect(files).toContain('note.txt');

    const again = await ws.create(repo, 'REWORK-1');
    expect(await exists(join(again.dir, 'note.txt'))).toBe(true);
    const text = await readFile(join(again.dir, 'note.txt'), 'utf8');
    expect(text).toContain('from first pass');
  });

  it('preserve survives missing worktree dir (does not throw; keeps branch when possible)', async () => {
    const pool = new PortAllocator(4000, 4);
    const ws = new GitWorkspaces({ root, ports: pool });
    const w = await ws.create(repo, 'MISS-1');
    await writeFile(join(w.dir, 'keep.txt'), 'x\n');
    // Commit via normal path first so branch has a tip.
    await ws.preserve('MISS-1', 'hercules: MISS-1 first');
    // Re-create live entry then delete dir to simulate the logout teardown race.
    const w2 = await ws.create(repo, 'MISS-1');
    await rm(w2.dir, { recursive: true, force: true });
    await expect(ws.preserve('MISS-1', 'hercules: MISS-1 after missing dir')).resolves.toEqual({
      notPropagated: false,
      events: [],
    });
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const branches = await mirror.branch();
    expect(branches.all).toContain('hercules/MISS-1');
  });

  it('recovers hercules/<id> from orphan commits after branch delete', async () => {
    // Case study logout: empty-diff review deleted the branch but left objects.
    const pool = new PortAllocator(4000, 4);
    const ws = new GitWorkspaces({ root, ports: pool });
    const w = await ws.create(repo, 'ORPHAN-1');
    await writeFile(join(w.dir, 'settings.txt'), 'recovered work\n');
    await ws.preserve('ORPHAN-1', 'hercules: ORPHAN-1 — Settings panel');

    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const tip = (await mirror.raw(['rev-parse', 'hercules/ORPHAN-1'])).trim();
    // Simulate the old bug: delete branch but keep the commit object.
    await mirror.raw(['branch', '-D', 'hercules/ORPHAN-1']);
    const branches = await mirror.branch();
    expect(branches.all).not.toContain('hercules/ORPHAN-1');
    // Commit still reachable by sha.
    expect((await mirror.raw(['cat-file', '-t', tip])).trim()).toBe('commit');

    const again = await ws.create(repo, 'ORPHAN-1');
    expect(await exists(join(again.dir, 'settings.txt'))).toBe(true);
    const text = await readFile(join(again.dir, 'settings.txt'), 'utf8');
    expect(text).toContain('recovered work');
    const reattached = await mirror.branch();
    expect(reattached.all).toContain('hercules/ORPHAN-1');
  });

  it('pins hercules/<id> to detached HEAD after agent rebase (logout tip loss)', async () => {
    // Agent rebased onto detached HEAD and committed; named branch stayed put.
    const pool = new PortAllocator(4000, 4);
    const ws = new GitWorkspaces({ root, ports: pool });
    const w = await ws.create(repo, 'DETACH-1');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');
    // Detach, then commit feature work (mimics rebase leave-behind).
    const mainSha = (await git.raw(['rev-parse', 'main'])).trim();
    await git.checkout([mainSha]);
    await writeFile(join(w.dir, 'settings-hooks.txt'), 'data-evidence\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'feat(web): L2 data-evidence on Settings',
    ]);
    const head = (await git.raw(['rev-parse', 'HEAD'])).trim();
    const detached = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    expect(detached).toBe('HEAD'); // detached

    await ws.preserve('DETACH-1', 'hercules: DETACH-1 — pin');

    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const branches = await mirror.branch();
    expect(branches.all).toContain('hercules/DETACH-1');
    const tip = (await mirror.raw(['rev-parse', 'hercules/DETACH-1'])).trim();
    expect(tip).toBe(head);
    const files = await mirror.raw(['show', '--name-only', '--format=', 'hercules/DETACH-1']);
    expect(files).toContain('settings-hooks.txt');
  });

  it('recovers agent-authored dangling tip without hercules: id subject', async () => {
    const pool = new PortAllocator(4000, 4);
    const ws = new GitWorkspaces({ root, ports: pool });
    const w = await ws.create(repo, 'logout');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');
    await writeFile(join(w.dir, 'SettingsPanel.tsx'), 'export const x = 1\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'feat(web): L2 data-evidence on Settings + rebase onto main',
    ]);
    const tip = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('logout', 'hercules: logout — first pin');

    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    // Drop branch ref but keep the agent commit object (force-delete after pin).
    await mirror.raw(['branch', '-D', 'hercules/logout']);
    // Make the tip unreachable (no reflog hit preferred) by not having other refs.
    expect((await mirror.raw(['cat-file', '-t', tip])).trim()).toBe('commit');

    const again = await ws.create(repo, 'logout');
    expect(await exists(join(again.dir, 'SettingsPanel.tsx'))).toBe(true);
    const reattached = (await mirror.raw(['rev-parse', 'hercules/logout'])).trim();
    expect(reattached).toBe(tip);
  });
});

/**
 * Provision race: worktree still checked out while mirror refresh targets the
 * same hercules/<id> branch (orbit-repo-readiness-onboarding, 2026-07).
 * Control fatal is full-heads fetch; create() must reattach / rebuild without it.
 */
describe('GitWorkspaces provision race (checked-out hercules branch)', { timeout: 20_000 }, () => {
  it('retry provision with worktree still present does not fatal-fetch into branch', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'RACE-LIVE');
    await writeFile(join(w.dir, 'live.txt'), 'still here\n');

    const mirrorPath = join(root, '.mirrors', 'app.git');
    const mirror = simpleGit(mirrorPath);
    // Control: writing into the checked-out hercules tip fatals (pre-fix hole
    // from full-heads / remote update). create() must never take this path.
    let controlFatal = '';
    try {
      await mirror.raw([
        'fetch',
        'origin',
        '+refs/heads/main:refs/heads/hercules/RACE-LIVE',
      ]);
    } catch (err) {
      controlFatal = (err as Error).message;
    }
    expect(controlFatal).toMatch(/refusing to fetch into branch|checked out/i);

    // Simulate crash: drop live map but leave worktree on disk (no preserve).
    (ws as unknown as { live: Map<string, unknown> }).live.clear();

    // create() must succeed: reattach path; ensureMirror only refreshes main.
    const again = await ws.create(repo, 'RACE-LIVE');
    expect(again.dir).toBe(w.dir);
    expect(again.branch).toBe('hercules/RACE-LIVE');
    expect(await exists(join(again.dir, 'live.txt'))).toBe(true);
  });

  it('preserve then re-create reuses origin task branch without fetch fatal', async () => {
    const seed = join(tmp, 'seed-race');
    const bare = join(tmp, 'bare-race.git');
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 't@h.local');
    await sg.addConfig('user.name', 'T');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);

    const remoteRepo: RepoConfig = { ...repo, url: bare };
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(remoteRepo, 'RACE-PRESERVE');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');
    await writeFile(join(w.dir, 'salvage.txt'), 'work\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: RACE-PRESERVE — salvage',
    ]);
    await ws.preserve('RACE-PRESERVE', 'hercules: RACE-PRESERVE — pin');

    // Branch exists on origin; worktree gone; re-provision for rework.
    const again = await ws.create(remoteRepo, 'RACE-PRESERVE');
    expect(again.dir).toBe(join(root, 'app', 'RACE-PRESERVE'));
    expect(again.branch).toBe('hercules/RACE-PRESERVE');
    expect(await exists(join(again.dir, 'salvage.txt'))).toBe(true);
  });

  it('stray pin outside task path is freed and rebuild succeeds', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'RACE-STRAY');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');
    await writeFile(join(w.dir, 'stray-work.txt'), 'agent\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: RACE-STRAY — work',
    ]);
    const tip = (await git.raw(['rev-parse', 'HEAD'])).trim();

    // Move checkout off the expected path: remove registered worktree metadata
    // carefully then re-add at an outside path pinning the same branch.
    const mirrorPath = join(root, '.mirrors', 'app.git');
    const mirror = simpleGit(mirrorPath);
    await mirror.raw(['worktree', 'remove', '--force', w.dir]);
    (ws as unknown as { live: Map<string, unknown> }).live.clear();

    const outside = join(tmp, 'outside-review-tree');
    await mirror.raw(['worktree', 'add', outside, 'hercules/RACE-STRAY']);
    expect((await simpleGit(outside).revparse(['--abbrev-ref', 'HEAD'])).trim()).toBe(
      'hercules/RACE-STRAY',
    );

    const again = await ws.create(repo, 'RACE-STRAY');
    expect(again.dir).toBe(join(root, 'app', 'RACE-STRAY'));
    expect(again.branch).toBe('hercules/RACE-STRAY');
    expect(await exists(join(again.dir, 'stray-work.txt'))).toBe(true);
    const reTip = (await simpleGit(again.dir).raw(['rev-parse', 'HEAD'])).trim();
    expect(reTip).toBe(tip);
    // Outside pin should be detached (not deleted — files kept).
    const outsideBr = (await simpleGit(outside).revparse(['--abbrev-ref', 'HEAD'])).trim();
    expect(outsideBr).toBe('HEAD');
  });

  it('junk non-worktree dir at task path is cleaned and re-provisioned', async () => {
    const ws = makeWorkspaces();
    // Seed mirror + branch once.
    await ws.create(repo, 'RACE-JUNK');
    await ws.preserve('RACE-JUNK', 'hercules: RACE-JUNK — pin');

    // Leave a plain directory (not a git worktree) where create expects the path.
    const junk = join(root, 'app', 'RACE-JUNK');
    await mkdir(junk, { recursive: true });
    await writeFile(join(junk, 'junk.txt'), 'not a worktree\n');
    expect(await exists(join(junk, '.git'))).toBe(false);

    const again = await ws.create(repo, 'RACE-JUNK');
    expect(again.dir).toBe(junk);
    expect(await exists(join(again.dir, 'README.md'))).toBe(true);
    expect(await exists(join(again.dir, 'junk.txt'))).toBe(false);
    const br = (await simpleGit(again.dir).revparse(['--abbrev-ref', 'HEAD'])).trim();
    expect(br).toBe('hercules/RACE-JUNK');
  });

  it('two tasks never share one worktree path after retry/reattach', async () => {
    const ws = makeWorkspaces();
    const a = await ws.create(repo, 'RACE-A');
    const b = await ws.create(repo, 'RACE-B');
    await writeFile(join(a.dir, 'a-only.txt'), 'A\n');
    await writeFile(join(b.dir, 'b-only.txt'), 'B\n');

    // Preserve both (branch kept, worktree removed) then re-create — paths must stay distinct.
    await ws.preserve('RACE-A', 'hercules: RACE-A — pin');
    await ws.preserve('RACE-B', 'hercules: RACE-B — pin');

    const a2 = await ws.create(repo, 'RACE-A');
    const b2 = await ws.create(repo, 'RACE-B');

    expect(a2.dir).toBe(join(root, 'app', 'RACE-A'));
    expect(b2.dir).toBe(join(root, 'app', 'RACE-B'));
    expect(a2.dir).not.toBe(b2.dir);
    expect(a2.branch).toBe('hercules/RACE-A');
    expect(b2.branch).toBe('hercules/RACE-B');
    expect(a2.branch).not.toBe(b2.branch);
    expect(await exists(join(a2.dir, 'a-only.txt'))).toBe(true);
    expect(await exists(join(b2.dir, 'b-only.txt'))).toBe(true);
    expect(await exists(join(a2.dir, 'b-only.txt'))).toBe(false);
    expect(await exists(join(b2.dir, 'a-only.txt'))).toBe(false);
  });
});

describe('GitWorkspaces.gcTerminalArtifacts', { timeout: 20_000 }, () => {
  it('removes worktree + scratch but keeps local salvage branch (apply mode)', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'GC-KEEP-BR');
    const git = simpleGit(w.dir);
    await writeFile(join(w.dir, 'feat.txt'), 'salvage me\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: GC-KEEP-BR — salvage tip',
    ]);
    const tip = (await git.raw(['rev-parse', 'HEAD'])).trim();
    // Drop live tracking so GC can free the checkout (simulates terminal task residue).
    await ws.preserve('GC-KEEP-BR', 'hercules: GC-KEEP-BR preserve');
    // Re-create worktree residue without live map: fresh instance + leftover dir.
    const ws2 = makeWorkspaces();
    await ws2.create(repo, 'GC-KEEP-BR');
    // Clear live by using a third instance for GC (daemon after restart).
    const ws3 = makeWorkspaces();
    const result = await ws3.gcTerminalArtifacts([{ taskId: 'GC-KEEP-BR', repoKey: 'app' }], {
      dryRun: false,
    });

    expect(result.dryRun).toBe(false);
    expect(result.worktreesRemoved).toContain('GC-KEEP-BR');
    expect(await exists(join(root, 'app', 'GC-KEEP-BR'))).toBe(false);
    expect(await exists(join(root, '.scratch', 'app', 'GC-KEEP-BR'))).toBe(false);

    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const branches = await mirror.branch();
    expect(branches.all).toContain('hercules/GC-KEEP-BR');
    const tipAfter = (await mirror.raw(['rev-parse', 'hercules/GC-KEEP-BR'])).trim();
    expect(tipAfter).toBe(tip);
  });

  it('dry-run reports worktree candidates without deleting', async () => {
    const ws1 = makeWorkspaces();
    await ws1.create(repo, 'GC-DRY');
    const ws2 = makeWorkspaces();
    const result = await ws2.gcTerminalArtifacts([{ taskId: 'GC-DRY', repoKey: 'app' }], {
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.worktreesRemoved).toContain('GC-DRY');
    expect(await exists(join(root, 'app', 'GC-DRY'))).toBe(true);
    expect(result.logLine).toContain('dry-run');
  });

  it('skips live map entries even when listed as targets', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'GC-LIVE');
    const result = await ws.gcTerminalArtifacts([{ taskId: 'GC-LIVE', repoKey: 'app' }], {
      dryRun: false,
    });
    expect(result.skippedLive).toContain('GC-LIVE');
    expect(result.worktreesRemoved).not.toContain('GC-LIVE');
    expect(await exists(join(root, 'app', 'GC-LIVE'))).toBe(true);
  });

  it('optional screenshot purge removes only the task shot dir', async () => {
    const shots = join(root, 'screenshots');
    await mkdir(join(shots, 'GC-SHOT'), { recursive: true });
    await writeFile(join(shots, 'GC-SHOT', 'evidence-0.png'), 'PNG');
    await mkdir(join(shots, 'OTHER'), { recursive: true });
    await writeFile(join(shots, 'OTHER', 'evidence-0.png'), 'PNG');

    // No worktree — still may purge screenshots when asked.
    const ws = makeWorkspaces();
    const result = await ws.gcTerminalArtifacts([{ taskId: 'GC-SHOT', repoKey: 'app' }], {
      dryRun: false,
      purgeScreenshots: true,
      screenshotsRoot: shots,
    });

    expect(result.screenshotsRemoved).toContain('GC-SHOT');
    expect(await exists(join(shots, 'GC-SHOT'))).toBe(false);
    expect(await exists(join(shots, 'OTHER', 'evidence-0.png'))).toBe(true);
  });

  it('never deletes remote branches (no push --delete)', async () => {
    // Publish hercules/GC-REMOTE to the fake origin; GC must leave it on origin.
    const ws1 = makeWorkspaces();
    const w = await ws1.create(repo, 'GC-REMOTE');
    const git = simpleGit(w.dir);
    await writeFile(join(w.dir, 'r.txt'), 'remote salvage\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: GC-REMOTE tip',
    ]);
    // Provider worktrees deny ordinary push — publish via Hercules exact-CAS
    // from the shared bare mirror (committed tip + current main base).
    const tip = (await git.raw(['rev-parse', 'HEAD'])).trim().toLowerCase();
    const originUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim();
    const mirrorPath = join(root, '.mirrors', 'app.git');
    const base = (await simpleGit(mirrorPath).revparse(['main'])).trim().toLowerCase();
    await pushTaskBranchWithExactLease({
      git: simpleGit(mirrorPath),
      originUrl,
      branch: 'hercules/GC-REMOTE',
      localTip: tip,
      lease: { expectedBaseRevision: base, expectedRemoteTip: null },
      allowOwnedReset: false,
    });
    await ws1.preserve('GC-REMOTE', 'hercules: GC-REMOTE preserve');

    // Leave a residue worktree for GC to remove.
    const ws2 = makeWorkspaces();
    await ws2.create(repo, 'GC-REMOTE');
    const ws3 = makeWorkspaces();
    await ws3.gcTerminalArtifacts([{ taskId: 'GC-REMOTE', repoKey: 'app' }], {
      dryRun: false,
    });

    // Origin still has the branch at the same tip.
    const ls = (
      await simpleGit(targetUrl).raw(['ls-remote', '--heads', targetUrl, 'hercules/GC-REMOTE'])
    ).trim();
    expect(ls).toContain(tip);
    // Local salvage branch also kept.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    expect((await mirror.branch()).all).toContain('hercules/GC-REMOTE');
  });

  it('rejects unsafe identifiers without touching disk', async () => {
    const ws = makeWorkspaces();
    const result = await ws.gcTerminalArtifacts(
      [{ taskId: '../escape', repoKey: 'app' }],
      { dryRun: false },
    );
    expect(result.worktreesRemoved).toEqual([]);
    expect(result.screenshotsRemoved).toEqual([]);
  });
});

describe('cleanWorktree idempotent for missing / unregistered paths', { timeout: 20_000 }, () => {
  it('purgeTask is a no-op success when the path is already gone', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'GONE-1');
    // preserve drops the checkout but keeps the salvage branch.
    await ws.preserve('GONE-1', 'hercules: GONE-1 preserve');
    expect(await exists(join(root, 'app', 'GONE-1'))).toBe(false);

    await expect(ws.purgeTask('app', 'GONE-1')).resolves.toBeUndefined();
    // Second call stays non-fatal (idempotent).
    await expect(ws.purgeTask('app', 'GONE-1')).resolves.toBeUndefined();
  });

  it('purgeTask cleans a path that exists but is not in git worktree list', async () => {
    const ws = makeWorkspaces();
    // Seed the bare mirror so purgeTask has a git context.
    await ws.create(repo, 'SEED-UNREG');
    await ws.preserve('SEED-UNREG', 'hercules: seed');

    const dir = join(root, 'app', 'UNREG-1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'leftover.txt'), 'junk');
    // Broken gitdir pointer: looks like a worktree on disk, not registered.
    await writeFile(join(dir, '.git'), 'gitdir: /nonexistent/gitdir');

    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const listBefore = await mirror.raw(['worktree', 'list', '--porcelain']);
    expect(listBefore).not.toContain(dir);

    await expect(ws.purgeTask('app', 'UNREG-1')).resolves.toBeUndefined();
    expect(await exists(dir)).toBe(false);

    // Repeat: already gone must not throw into the tick.
    await expect(ws.purgeTask('app', 'UNREG-1')).resolves.toBeUndefined();
  });

  it('purgeTask still removes a registered worktree', async () => {
    const ws1 = makeWorkspaces();
    const w = await ws1.create(repo, 'REG-1');
    expect(await exists(w.dir)).toBe(true);

    // Fresh instance: not in live map (simulates terminal GC / human Delete).
    const ws2 = makeWorkspaces();
    await expect(ws2.purgeTask('app', 'REG-1')).resolves.toBeUndefined();
    expect(await exists(w.dir)).toBe(false);

    const list = await simpleGit(join(root, '.mirrors', 'app.git')).raw([
      'worktree',
      'list',
      '--porcelain',
    ]);
    expect(list).not.toContain(w.dir);
  });

  it('gcTerminalArtifacts removes unregistered leftover without throwing', async () => {
    const ws1 = makeWorkspaces();
    await ws1.create(repo, 'GC-UNREG');
    await ws1.preserve('GC-UNREG', 'hercules: GC-UNREG preserve');

    const dir = join(root, 'app', 'GC-UNREG');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.git'), 'gitdir: /nonexistent/gitdir');

    const ws2 = makeWorkspaces();
    const result = await ws2.gcTerminalArtifacts(
      [{ taskId: 'GC-UNREG', repoKey: 'app' }],
      { dryRun: false },
    );
    expect(result.worktreesRemoved).toContain('GC-UNREG');
    expect(await exists(dir)).toBe(false);
  });

  it('remove still deletes a live registered worktree', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'LIVE-RM');
    await expect(ws.remove('LIVE-RM')).resolves.toBeUndefined();
    expect(await exists(w.dir)).toBe(false);
  });
});

describe('read-path mirror access stays offline (2026-07-17 60s /api/releases)', { timeout: 20_000 }, () => {
  it('defaultBranchHead and rangeDiff read the mirror without fetching origin', async () => {
    const ws = makeWorkspaces();
    const w = await ws.create(repo, 'READ-1');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'A');
    await writeFile(join(w.dir, 'f.txt'), 'x\n');
    await git.add(['-A']);
    await git.raw(['-c', 'user.email=a@h.local', '-c', 'user.name=A', 'commit', '-m', 'work']);
    await ws.preserve('READ-1', 'hercules: READ-1');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const mainSha = (await mirror.raw(['rev-parse', 'main'])).trim();
    const tip = (await mirror.raw(['rev-parse', 'hercules/READ-1'])).trim();

    // Point origin at a DEAD url: any fetch attempt would now fail loudly.
    const dead = { ...repo, url: join(tmp, 'no-such-remote') };
    expect(await ws.defaultBranchHead(dead)).toBe(mainSha);
    const d = await ws.rangeDiff!(dead, mainSha, tip);
    expect(d).not.toBeNull();
    expect(d!.files).toContain('f.txt');
  });
});

describe('refreshDefaultBranchHead — release reconciler drift (C3.51)', { timeout: 20_000 }, () => {
  it('returns null without a mirror and never creates one', async () => {
    const ws = makeWorkspaces();
    expect(await ws.refreshDefaultBranchHead(repo)).toBeNull();
    expect(await exists(join(root, '.mirrors', 'app.git'))).toBe(false);
  });

  it('picks up a push straight to origin main without create()/ensureMirror', async () => {
    let now = 1_000_000;
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), clock: () => now });
    expect(await ws.refreshTrustedDefault(repo)).toBe(true);
    const before = (await ws.defaultBranchHead(repo))!;

    const origin = simpleGit(targetUrl);
    await writeFile(join(targetUrl, 'ship.txt'), 'ship\n');
    await origin.add(['-A']);
    await origin.commit('push straight to main');
    const advanced = (await origin.raw(['rev-parse', 'main'])).trim();
    expect(advanced).not.toBe(before);

    // Plain read path stays stale by design; the refresh path sees origin.
    expect(await ws.defaultBranchHead(repo)).toBe(before);
    now += GitWorkspaces.DEFAULT_BRANCH_REFRESH_MIN_MS;
    expect(await ws.refreshDefaultBranchHead(repo)).toBe(advanced);

    // Rate limit: a second origin advance inside the window is NOT fetched…
    await writeFile(join(targetUrl, 'ship2.txt'), 'ship2\n');
    await origin.add(['-A']);
    await origin.commit('second push');
    const advanced2 = (await origin.raw(['rev-parse', 'main'])).trim();
    now += GitWorkspaces.DEFAULT_BRANCH_REFRESH_MIN_MS - 1;
    expect(await ws.refreshDefaultBranchHead(repo)).toBe(advanced);
    // …until the window elapses.
    now += 1;
    expect(await ws.refreshDefaultBranchHead(repo)).toBe(advanced2);
  });

  it('falls back to the on-disk tip when origin cannot be fetched', async () => {
    const ws = makeWorkspaces();
    expect(await ws.refreshTrustedDefault(repo)).toBe(true);
    const tip = (await ws.defaultBranchHead(repo))!;
    const dead = { ...repo, url: join(tmp, 'no-such-remote') };
    expect(await ws.refreshDefaultBranchHead(dead)).toBe(tip);
  });
});

describe('refreshTrustedDefault — factory dispatch ancestry', { timeout: 20_000 }, () => {
  it('clones a missing mirror so factory dispatch can prove origin ancestry', async () => {
    const ws = makeWorkspaces();
    expect(await exists(join(root, '.mirrors', 'app.git'))).toBe(false);
    expect(await ws.refreshTrustedDefault(repo)).toBe(true);
    expect(await exists(join(root, '.mirrors', 'app.git'))).toBe(true);
    const tip = await ws.defaultBranchHead(repo);
    expect(tip).toMatch(/^[0-9a-f]{40}$/i);
  });

  it('fetches origin so an observed merge SHA becomes reachable without create()', async () => {
    const origin = simpleGit(targetUrl);
    await origin.addConfig('user.email', 't@h.local');
    await origin.addConfig('user.name', 'T');

    const ws = makeWorkspaces();
    expect(await ws.refreshTrustedDefault(repo)).toBe(true);
    const beforeMergeTip = (await ws.defaultBranchHead(repo))!;

    await origin.checkoutLocalBranch('feat-factory');
    await writeFile(join(targetUrl, 'factory.txt'), 'factory\n');
    await origin.add(['-A']);
    await origin.commit('factory slice');
    const feature = (await origin.raw(['rev-parse', 'HEAD'])).trim();
    await origin.checkout('main');
    await origin.raw(['merge', '--no-ff', '-m', 'merge factory slice', feature]);
    const merged = (await origin.raw(['rev-parse', 'main'])).trim();
    expect(merged).not.toBe(beforeMergeTip);

    const stale = await ws.proveDefaultBranchAncestry(repo, [merged]);
    expect(stale.tip).toBe(beforeMergeTip);
    expect(stale.reachable.get(merged)).not.toBe(true);

    expect(await ws.refreshTrustedDefault(repo)).toBe(true);
    const fresh = await ws.proveDefaultBranchAncestry(repo, [merged]);
    expect(fresh.tip).toBe(merged);
    expect(fresh.reachable.get(merged)).toBe(true);
  });

  it('returns false when origin cannot be fetched and leaves the on-disk tip', async () => {
    const ws = makeWorkspaces();
    expect(await ws.refreshTrustedDefault(repo)).toBe(true);
    const tip = (await ws.defaultBranchHead(repo))!;
    const dead = { ...repo, url: join(tmp, 'no-such-remote') };
    expect(await ws.refreshTrustedDefault(dead)).toBe(false);
    expect(await ws.defaultBranchHead(dead)).toBe(tip);
    expect(await ws.proveDefaultBranchAncestry(dead, [tip])).toEqual({
      tip,
      reachable: new Map([[tip, true]]),
    });
  });
});

describe('containsOnDefaultBranch — dependency gate ancestry', { timeout: 20_000 }, () => {
  it('reports ancestor-or-equal after a gate merge lands on main; rejects foreign tips', async () => {
    const origin = simpleGit(targetUrl);
    await origin.addConfig('user.email', 't@h.local');
    await origin.addConfig('user.name', 'T');
    const baseMain = (await origin.raw(['rev-parse', 'main'])).trim();

    // Feature commit on a side branch (simulates verified tip before Merge Selected).
    await origin.checkoutLocalBranch('feat-anc');
    await writeFile(join(targetUrl, 'feat.txt'), 'feature\n');
    await origin.add(['-A']);
    await origin.commit('feat for ancestry');
    const verified = (await origin.raw(['rev-parse', 'HEAD'])).trim();
    await origin.checkout('main');

    const ws = makeWorkspaces();
    // First create seeds the mirror at pre-merge main.
    await ws.create(repo, 'ANC-seed');
    expect(await ws.containsOnDefaultBranch!(repo, baseMain)).toBe(true);
    // Verified tip is in the object store after fetch of all refs? ensureMirror
    // typically fetches heads — feat-anc may not be on mirror. Push is not needed
    // if we only check after merge into main.
    // Before merge into main, verified must not be on default branch.
    // (If the mirror never saw feat-anc, probe returns null = stale; either
    // fails closed for the gate.)
    const before = await ws.containsOnDefaultBranch!(repo, verified);
    expect(before === false || before === null).toBe(true);

    // Gate merge: integrate verified tip into main with a merge commit.
    await origin.raw([
      'merge',
      '--no-ff',
      '-m',
      'hercules: merge ANC-1',
      verified,
    ]);
    const merged = (await origin.raw(['rev-parse', 'main'])).trim();

    // Refresh mirror (ensureMirror fetch on create).
    await ws.create(repo, 'ANC-after');
    expect(await ws.containsOnDefaultBranch!(repo, verified)).toBe(true);
    expect(await ws.containsOnDefaultBranch!(repo, merged)).toBe(true);
    // Unknown object → null (stale), not a hard false.
    expect(
      await ws.containsOnDefaultBranch!(repo, 'ffffffffffffffffffffffffffffffffffffffff'),
    ).toBeNull();

    // Atomic proof: one tip + both ancestry facts together.
    const proof = await ws.proveDefaultBranchAncestry!(repo, [verified, merged]);
    expect(proof.tip).toBe(merged);
    expect(proof.reachable.get(verified)).toBe(true);
    expect(proof.reachable.get(merged)).toBe(true);
  });

  it('create refuses when expectedBaseTip no longer matches after main moves', async () => {
    const origin = simpleGit(targetUrl);
    await origin.addConfig('user.email', 't@h.local');
    await origin.addConfig('user.name', 'T');

    const ws = makeWorkspaces();
    await ws.create(repo, 'TIP-seed');
    const tipAtProof = (await ws.defaultBranchHead!(repo))!;
    expect(tipAtProof).toMatch(/^[0-9a-f]{40}$/i);

    // Concurrent push: main moves on origin after the gate proof.
    await writeFile(join(targetUrl, 'race.txt'), 'moved\n');
    await origin.add(['-A']);
    await origin.commit('main moved after proof');
    const newTip = (await origin.raw(['rev-parse', 'main'])).trim();
    expect(newTip).not.toBe(tipAtProof);

    // create fetches new tip then confirms expectedBaseTip — must refuse.
    await expect(
      ws.create(repo, 'TIP-race', { expectedBaseTip: tipAtProof }),
    ).rejects.toThrow(/tip moved during dependency gate/);
  });

  it('cuts a fresh dependency-gated branch exactly at the expected tip', async () => {
    const ws = makeWorkspaces();
    await ws.create(repo, 'BASE-seed');
    const expected = (await ws.defaultBranchHead!(repo))!;

    const workspace = await ws.create(repo, 'FRESH-gate', {
      hadPriorWork: false,
      expectedBaseTip: expected,
    });

    const head = (await simpleGit(workspace.dir).revparse(['HEAD'])).trim();
    expect(head).toBe(expected);
  });

  it('refuses a recovered task branch that does not contain the expected tip', async () => {
    const origin = simpleGit(targetUrl);
    const ws = makeWorkspaces();
    const stale = await ws.create(repo, 'STALE-gate');
    await writeFile(join(stale.dir, 'prior-work.txt'), 'work on the old base\n');
    await ws.preserve('STALE-gate', 'hercules: STALE-gate — preserve old base');

    await writeFile(join(targetUrl, 'new-main.txt'), 'new trusted base\n');
    await origin.add(['-A']);
    await origin.commit('advance trusted main');
    await ws.create(repo, 'REFRESH-main');
    const expected = (await ws.defaultBranchHead!(repo))!;
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const staleTip = (await mirror.revparse(['refs/heads/hercules/STALE-gate'])).trim();
    expect(staleTip).not.toBe(expected);
    const missingFromStale = Number(
      (await mirror.raw(['rev-list', '--count', `${staleTip}..${expected}`])).trim(),
    );
    expect(missingFromStale).toBeGreaterThan(0);

    await expect(
      ws.create(repo, 'STALE-gate', {
        hadPriorWork: true,
        expectedBaseTip: expected,
      }),
    ).rejects.toThrow(/task branch base mismatch during dependency gate/);
  });
});

/**
 * Mirror clobber race (2026-07-30): verified tip on local hercules/* must not be
 * force-rewound by origin when local is strictly ahead. Three-state policy +
 * not-propagated warning when push fails.
 */
describe('GitWorkspaces hercules/* fetch three-state + not-propagated', { timeout: 30_000 }, () => {
  async function bareRemote(): Promise<{ bare: string; remoteRepo: RepoConfig }> {
    const bare = join(tmp, `remote-clobber-${Math.random().toString(16).slice(2)}.git`);
    const seed = join(tmp, `seed-clobber-${Math.random().toString(16).slice(2)}`);
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);
    return { bare, remoteRepo: { ...repo, url: bare } };
  }

  it('local ahead → reconcile does not overwrite; skip_rewind event', async () => {
    const { bare, remoteRepo } = await bareRemote();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(remoteRepo, 'CLOB-AHEAD');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');

    // Older tip published to origin.
    await writeFile(join(w.dir, 'old.txt'), 'old\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: CLOB-AHEAD — old',
    ]);
    const older = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('CLOB-AHEAD', 'hercules: CLOB-AHEAD — publish old');
    expect((await simpleGit(bare).raw(['rev-parse', 'hercules/CLOB-AHEAD'])).trim()).toBe(older);

    // Local-only newer tip on the mirror (not pushed) — the clobber victim.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    // Need a worktree to create commits; re-create then make newer commit, pin, dispose without push.
    const ws2 = new GitWorkspaces({
      root,
      ports: new PortAllocator(4010, 4),
      push: false, // leave tip local-only
    });
    const w2 = await ws2.create(remoteRepo, 'CLOB-AHEAD');
    const g2 = simpleGit(w2.dir);
    await g2.addConfig('user.email', 'a@h.local');
    await g2.addConfig('user.name', 'Agent');
    await writeFile(join(w2.dir, 'new.txt'), 'new verified\n');
    await g2.add(['-A']);
    await g2.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: CLOB-AHEAD — verified local-only',
    ]);
    const newer = (await g2.raw(['rev-parse', 'HEAD'])).trim();
    await ws2.preserve('CLOB-AHEAD', 'hercules: CLOB-AHEAD — local only');
    expect((await mirror.raw(['rev-parse', 'hercules/CLOB-AHEAD'])).trim()).toBe(newer);
    // Origin still older.
    expect((await simpleGit(bare).raw(['rev-parse', 'hercules/CLOB-AHEAD'])).trim()).toBe(older);

    // Trigger ensureMirror reconcile via a sibling task create.
    const ws3 = new GitWorkspaces({ root, ports: new PortAllocator(4020, 4), push: false });
    await ws3.create(remoteRepo, 'CLOB-SIBLING');

    // Local tip must still be the verified newer commit — not rewound to origin.
    expect((await mirror.raw(['rev-parse', 'hercules/CLOB-AHEAD'])).trim()).toBe(newer);
    const events = ws3.drainMirrorEvents();
    expect(events.some((e) => e.kind === 'skip_rewind' && e.branch === 'hercules/CLOB-AHEAD')).toBe(
      true,
    );
    expect(events.some((e) => e.message.includes('跳过回卷'))).toBe(true);
  });

  it('remote ahead → reconcile advances local tip', async () => {
    const { bare, remoteRepo } = await bareRemote();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(remoteRepo, 'CLOB-FF');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');

    await writeFile(join(w.dir, 'a.txt'), 'a\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: CLOB-FF — base',
    ]);
    const base = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('CLOB-FF', 'hercules: CLOB-FF — base');

    // Advance origin further without updating the local mirror branch tip first.
    const clone = join(tmp, 'clone-ff');
    await simpleGit(tmp).clone(bare, clone);
    const cg = simpleGit(clone);
    await cg.addConfig('user.email', 'r@h.local');
    await cg.addConfig('user.name', 'Remote');
    await cg.checkout(['hercules/CLOB-FF']);
    await writeFile(join(clone, 'b.txt'), 'b\n');
    await cg.add(['-A']);
    await cg.raw([
      '-c',
      'user.email=r@h.local',
      '-c',
      'user.name=Remote',
      'commit',
      '-m',
      'hercules: CLOB-FF — remote advance',
    ]);
    const remoteTip = (await cg.raw(['rev-parse', 'HEAD'])).trim();
    await cg.push(['origin', 'hercules/CLOB-FF']);

    // Rewind local mirror branch to the older base so reconcile has work to do.
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    await mirror.raw(['branch', '-f', 'hercules/CLOB-FF', base]);
    expect((await mirror.raw(['rev-parse', 'hercules/CLOB-FF'])).trim()).toBe(base);

    const ws2 = new GitWorkspaces({ root, ports: new PortAllocator(4030, 4), push: false });
    await ws2.create(remoteRepo, 'CLOB-FF-TRIGGER');
    expect((await mirror.raw(['rev-parse', 'hercules/CLOB-FF'])).trim()).toBe(remoteTip);
  });

  it('diverged → follow remote (status quo) and record event', async () => {
    const { bare, remoteRepo } = await bareRemote();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(remoteRepo, 'CLOB-DIV');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');

    await writeFile(join(w.dir, 'shared.txt'), 'base\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: CLOB-DIV — base',
    ]);
    const base = (await git.raw(['rev-parse', 'HEAD'])).trim();
    await ws.preserve('CLOB-DIV', 'hercules: CLOB-DIV — base');

    // Origin diverges: new commit on hercules/CLOB-DIV from a fresh clone.
    const clone = join(tmp, 'clone-div');
    await simpleGit(tmp).clone(bare, clone);
    const cg = simpleGit(clone);
    await cg.addConfig('user.email', 'r@h.local');
    await cg.addConfig('user.name', 'Remote');
    await cg.checkout(['hercules/CLOB-DIV']);
    await writeFile(join(clone, 'remote-only.txt'), 'remote\n');
    await cg.add(['-A']);
    await cg.raw([
      '-c',
      'user.email=r@h.local',
      '-c',
      'user.name=Remote',
      'commit',
      '-m',
      'hercules: CLOB-DIV — remote side',
    ]);
    const remoteTip = (await cg.raw(['rev-parse', 'HEAD'])).trim();
    await cg.push(['origin', 'hercules/CLOB-DIV', '--force']);

    // Local mirror gets a different commit from the same base (true diverge).
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    // Create local-only divergent commit via temp worktree.
    const tmpWt = join(tmp, 'wt-div-local');
    await mirror.raw(['worktree', 'add', '-f', tmpWt, 'hercules/CLOB-DIV']);
    // Provider setup already enabled extensions.worktreeConfig on the shared
    // mirror; linked trees inherit core.bare=true until made usable. Test setup
    // only — do not install provider deny-push on this temp tree.
    await ensureLinkedWorktreeUsable(tmpWt);
    const lg = simpleGit(tmpWt);
    await lg.addConfig('user.email', 'l@h.local');
    await lg.addConfig('user.name', 'Local');
    // Reset to base then diverge
    await lg.raw(['reset', '--hard', base]);
    await writeFile(join(tmpWt, 'local-only.txt'), 'local\n');
    await lg.add(['-A']);
    await lg.raw([
      '-c',
      'user.email=l@h.local',
      '-c',
      'user.name=Local',
      'commit',
      '-m',
      'hercules: CLOB-DIV — local side',
    ]);
    const localTip = (await lg.raw(['rev-parse', 'HEAD'])).trim();
    await mirror.raw(['worktree', 'remove', '--force', tmpWt]);
    await mirror.raw(['branch', '-f', 'hercules/CLOB-DIV', localTip]);
    expect(localTip).not.toBe(remoteTip);

    const ws2 = new GitWorkspaces({ root, ports: new PortAllocator(4040, 4), push: false });
    await ws2.create(remoteRepo, 'CLOB-DIV-TRIGGER');
    // Status quo: follow remote on diverge.
    expect((await mirror.raw(['rev-parse', 'hercules/CLOB-DIV'])).trim()).toBe(remoteTip);
    const events = ws2.drainMirrorEvents();
    expect(
      events.some((e) => e.kind === 'diverged_take_remote' && e.branch === 'hercules/CLOB-DIV'),
    ).toBe(true);
  });

  it('push failure surfaces notPropagated (未传播) on preserve result', async () => {
    const { bare, remoteRepo } = await bareRemote();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: true });
    const w = await ws.create(remoteRepo, 'CLOB-NOPUSH');
    const git = simpleGit(w.dir);
    await git.addConfig('user.email', 'a@h.local');
    await git.addConfig('user.name', 'Agent');
    await writeFile(join(w.dir, 'work.txt'), 'work\n');
    await git.add(['-A']);
    await git.raw([
      '-c',
      'user.email=a@h.local',
      '-c',
      'user.name=Agent',
      'commit',
      '-m',
      'hercules: CLOB-NOPUSH — work',
    ]);

    // Break origin so push cannot publish.
    const mirrorPath = join(root, '.mirrors', 'app.git');
    await simpleGit(mirrorPath).raw([
      'remote',
      'set-url',
      'origin',
      join(tmp, 'does-not-exist-remote.git'),
    ]);

    const result = await ws.preserve('CLOB-NOPUSH', 'hercules: CLOB-NOPUSH — pin');
    expect(result.notPropagated).toBe(true);
    expect(result.events.some((e) => e.includes('未传播'))).toBe(true);
    const events = ws.drainMirrorEvents();
    expect(events.some((e) => e.kind === 'not_propagated')).toBe(true);
    // Branch still on mirror with the work (not lost).
    const tipFiles = await simpleGit(mirrorPath).raw([
      'show',
      '--name-only',
      '--format=',
      'hercules/CLOB-NOPUSH',
    ]);
    expect(tipFiles).toContain('work.txt');
    void bare;
  });

  it('default branch still force-syncs when remote advances (main untouched by hercules policy)', async () => {
    const { bare, remoteRepo } = await bareRemote();
    const ws = new GitWorkspaces({ root, ports: new PortAllocator(4000, 4), push: false });
    await ws.create(remoteRepo, 'CLOB-MAIN');
    const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
    const oldMain = (await mirror.raw(['rev-parse', 'main'])).trim();

    // Advance bare main.
    const clone = join(tmp, 'clone-main');
    await simpleGit(tmp).clone(bare, clone);
    const cg = simpleGit(clone);
    await cg.addConfig('user.email', 'r@h.local');
    await cg.addConfig('user.name', 'Remote');
    await writeFile(join(clone, 'main-new.txt'), 'main\n');
    await cg.add(['-A']);
    await cg.raw([
      '-c',
      'user.email=r@h.local',
      '-c',
      'user.name=Remote',
      'commit',
      '-m',
      'main advance',
    ]);
    const newMain = (await cg.raw(['rev-parse', 'HEAD'])).trim();
    await cg.push(['origin', 'main']);
    expect(newMain).not.toBe(oldMain);

    // ensureMirror force-syncs main.
    const ws2 = new GitWorkspaces({ root, ports: new PortAllocator(4050, 4), push: false });
    await ws2.create(remoteRepo, 'CLOB-MAIN-2');
    expect((await mirror.raw(['rev-parse', 'main'])).trim()).toBe(newMain);
  });
});

/**
 * Console + durable drainMirrorEvents share one rate-limit gate (injected clock).
 * Covers keep-local, checked-out, and history-less skip paths end-to-end.
 */
describe('GitWorkspaces mirror skip dedupe (console + audit)', { timeout: 60_000 }, () => {
  async function bareRemote(): Promise<{ bare: string; remoteRepo: RepoConfig }> {
    const bare = join(tmp, `bare-dedupe-${Math.random().toString(36).slice(2)}.git`);
    const seed = join(tmp, `seed-dedupe-${Math.random().toString(36).slice(2)}`);
    await mkdir(seed, { recursive: true });
    const sg = simpleGit(seed);
    await sg.init(['-b', 'main']);
    await sg.addConfig('user.email', 's@h.local');
    await sg.addConfig('user.name', 'S');
    await writeFile(join(seed, 'README.md'), '# seed\n');
    await sg.add('.');
    await sg.commit('seed');
    await simpleGit(tmp).clone(seed, bare, ['--bare']);
    return { bare, remoteRepo: { ...repo, url: bare } };
  }

  function captureConsole(): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    return {
      lines,
      restore: () => {
        console.error = orig;
      },
    };
  }

  it('keep-local: console + drainMirrorEvents dedupe inside window, re-emit after, fingerprint change immediate', async () => {
    const { MIRROR_LOG_RATE_LIMIT_MS: windowMs } = await import(
      '../../src/domain/hostExecutor.js'
    );
    const { bare, remoteRepo } = await bareRemote();
    const clock = { now: 1_000 };
    const cap = captureConsole();
    try {
      // Publish older tip to origin, then leave a newer local-only tip on the mirror.
      const wsPub = new GitWorkspaces({
        root,
        ports: new PortAllocator(4100, 8),
        push: true,
        clock: () => clock.now,
      });
      const w = await wsPub.create(remoteRepo, 'DEDUP-KEEP');
      const git = simpleGit(w.dir);
      await git.addConfig('user.email', 'a@h.local');
      await git.addConfig('user.name', 'Agent');
      await writeFile(join(w.dir, 'old.txt'), 'old\n');
      await git.add(['-A']);
      await git.raw([
        '-c',
        'user.email=a@h.local',
        '-c',
        'user.name=Agent',
        'commit',
        '-m',
        'hercules: DEDUP-KEEP — old',
      ]);
      const older = (await git.raw(['rev-parse', 'HEAD'])).trim();
      await wsPub.preserve('DEDUP-KEEP', 'hercules: DEDUP-KEEP — publish old');
      expect((await simpleGit(bare).raw(['rev-parse', 'hercules/DEDUP-KEEP'])).trim()).toBe(older);

      // Local-only newer tip (push:false).
      const wsLocal = new GitWorkspaces({
        root,
        ports: new PortAllocator(4110, 8),
        push: false,
        clock: () => clock.now,
      });
      const w2 = await wsLocal.create(remoteRepo, 'DEDUP-KEEP');
      const g2 = simpleGit(w2.dir);
      await g2.addConfig('user.email', 'a@h.local');
      await g2.addConfig('user.name', 'Agent');
      await writeFile(join(w2.dir, 'new.txt'), 'new\n');
      await g2.add(['-A']);
      await g2.raw([
        '-c',
        'user.email=a@h.local',
        '-c',
        'user.name=Agent',
        'commit',
        '-m',
        'hercules: DEDUP-KEEP — verified local-only',
      ]);
      await wsLocal.preserve('DEDUP-KEEP', 'hercules: DEDUP-KEEP — local only');

      // Same instance: two sibling creates → two reconciles at same clock.
      const ws = new GitWorkspaces({
        root,
        ports: new PortAllocator(4120, 8),
        push: false,
        clock: () => clock.now,
      });
      cap.lines.length = 0;
      await ws.create(remoteRepo, 'DEDUP-SIB-A');
      const firstEvents = ws.drainMirrorEvents().filter((e) => e.branch === 'hercules/DEDUP-KEEP');
      const firstConsole = cap.lines.filter((l) => l.includes('DEDUP-KEEP') && /skip|回卷/.test(l));
      expect(firstEvents.length).toBeGreaterThanOrEqual(1);
      expect(firstConsole.length).toBeGreaterThanOrEqual(1);
      const firstEventCount = firstEvents.length;
      const firstConsoleCount = firstConsole.length;

      // Second reconcile inside window — neither console nor audit re-emits.
      await ws.create(remoteRepo, 'DEDUP-SIB-B');
      const secondEvents = ws.drainMirrorEvents().filter((e) => e.branch === 'hercules/DEDUP-KEEP');
      const secondConsole = cap.lines.filter((l) => l.includes('DEDUP-KEEP') && /skip|回卷/.test(l));
      expect(secondEvents).toHaveLength(0);
      expect(secondConsole.length).toBe(firstConsoleCount);

      // After window → re-emit.
      clock.now += windowMs;
      await ws.create(remoteRepo, 'DEDUP-SIB-C');
      const thirdEvents = ws.drainMirrorEvents().filter((e) => e.branch === 'hercules/DEDUP-KEEP');
      const thirdConsole = cap.lines.filter((l) => l.includes('DEDUP-KEEP') && /skip|回卷/.test(l));
      expect(thirdEvents.length).toBe(firstEventCount);
      expect(thirdConsole.length).toBe(firstConsoleCount + firstConsoleCount);

      // Changed fingerprint (new local tip) emits immediately even mid-window.
      const mirror = simpleGit(join(root, '.mirrors', 'app.git'));
      // Advance local tip with another commit via a worktree.
      const wsBump = new GitWorkspaces({
        root,
        ports: new PortAllocator(4130, 8),
        push: false,
        clock: () => clock.now,
      });
      const wb = await wsBump.create(remoteRepo, 'DEDUP-KEEP');
      const gb = simpleGit(wb.dir);
      await gb.addConfig('user.email', 'a@h.local');
      await gb.addConfig('user.name', 'Agent');
      await writeFile(join(wb.dir, 'newer.txt'), 'newer\n');
      await gb.add(['-A']);
      await gb.raw([
        '-c',
        'user.email=a@h.local',
        '-c',
        'user.name=Agent',
        'commit',
        '-m',
        'hercules: DEDUP-KEEP — even newer local',
      ]);
      await wsBump.preserve('DEDUP-KEEP', 'hercules: DEDUP-KEEP — bump');
      void mirror;

      clock.now += 1; // still inside window relative to last emit at window edge
      const before = cap.lines.length;
      await ws.create(remoteRepo, 'DEDUP-SIB-D');
      const changedEvents = ws.drainMirrorEvents().filter((e) => e.branch === 'hercules/DEDUP-KEEP');
      expect(changedEvents.length).toBeGreaterThanOrEqual(1);
      expect(cap.lines.length).toBeGreaterThan(before);
    } finally {
      cap.restore();
    }
  });

  it('checked-out: console + audit dedupe together; changed remote fingerprint re-emits', async () => {
    const { MIRROR_LOG_RATE_LIMIT_MS: windowMs } = await import(
      '../../src/domain/hostExecutor.js'
    );
    const { bare, remoteRepo } = await bareRemote();
    const clock = { now: 5_000 };
    const cap = captureConsole();
    try {
      // Publish base tip, then re-create so the branch stays checked out live.
      const wsLive = new GitWorkspaces({
        root,
        ports: new PortAllocator(4200, 8),
        push: true,
        clock: () => clock.now,
      });
      const first = await wsLive.create(remoteRepo, 'DEDUP-CO');
      const lg0 = simpleGit(first.dir);
      await lg0.addConfig('user.email', 'a@h.local');
      await lg0.addConfig('user.name', 'Agent');
      await writeFile(join(first.dir, 'base.txt'), 'base\n');
      await lg0.add(['-A']);
      await lg0.raw([
        '-c',
        'user.email=a@h.local',
        '-c',
        'user.name=Agent',
        'commit',
        '-m',
        'hercules: DEDUP-CO — base',
      ]);
      await wsLive.preserve('DEDUP-CO', 'hercules: DEDUP-CO — base');
      // Re-attach: worktree is checked out again at the published tip.
      const live = await wsLive.create(remoteRepo, 'DEDUP-CO');
      expect(live.branch).toBe('hercules/DEDUP-CO');

      // Advance origin ahead of the checked-out local tip.
      const clone = join(tmp, 'co-advance');
      await simpleGit(tmp).clone(bare, clone);
      const cg = simpleGit(clone);
      await cg.addConfig('user.email', 'r@h.local');
      await cg.addConfig('user.name', 'Remote');
      await cg.checkout(['hercules/DEDUP-CO']);
      await writeFile(join(clone, 'remote-ahead.txt'), 'remote\n');
      await cg.add(['-A']);
      await cg.raw([
        '-c',
        'user.email=r@h.local',
        '-c',
        'user.name=Remote',
        'commit',
        '-m',
        'hercules: DEDUP-CO — remote ahead',
      ]);
      await cg.push(['origin', 'hercules/DEDUP-CO']);

      // Sibling creates on the same GitWorkspaces instance (live still checked out).
      cap.lines.length = 0;
      await wsLive.create(remoteRepo, 'DEDUP-CO-SIB1');
      const e1 = wsLive.drainMirrorEvents().filter((e) => e.message.includes('checked out'));
      const c1 = cap.lines.filter((l) => l.includes('checked out') && l.includes('DEDUP-CO'));
      expect(e1.length).toBeGreaterThanOrEqual(1);
      expect(c1.length).toBeGreaterThanOrEqual(1);

      await wsLive.create(remoteRepo, 'DEDUP-CO-SIB2');
      const e2 = wsLive.drainMirrorEvents().filter((e) => e.message.includes('checked out'));
      const c2 = cap.lines.filter((l) => l.includes('checked out') && l.includes('DEDUP-CO'));
      expect(e2).toHaveLength(0);
      expect(c2.length).toBe(c1.length);

      // After window re-emits.
      clock.now += windowMs;
      await wsLive.create(remoteRepo, 'DEDUP-CO-SIB3');
      const e3 = wsLive.drainMirrorEvents().filter((e) => e.message.includes('checked out'));
      expect(e3.length).toBe(e1.length);

      // Change remote fingerprint → immediate emit mid-window.
      await writeFile(join(clone, 'remote-ahead2.txt'), 'remote2\n');
      await cg.add(['-A']);
      await cg.raw([
        '-c',
        'user.email=r@h.local',
        '-c',
        'user.name=Remote',
        'commit',
        '-m',
        'hercules: DEDUP-CO — remote ahead 2',
      ]);
      await cg.push(['origin', 'hercules/DEDUP-CO']);
      clock.now += 1;
      await wsLive.create(remoteRepo, 'DEDUP-CO-SIB4');
      const e4 = wsLive.drainMirrorEvents().filter((e) => e.message.includes('checked out'));
      expect(e4.length).toBeGreaterThanOrEqual(1);
    } finally {
      cap.restore();
    }
  });

  it('history-less: console + audit dedupe together; changed remote fingerprint re-emits', async () => {
    const { MIRROR_LOG_RATE_LIMIT_MS: windowMs } = await import(
      '../../src/domain/hostExecutor.js'
    );
    const { bare, remoteRepo } = await bareRemote();
    const clock = { now: 9_000 };
    const cap = captureConsole();
    try {
      // Create a local hercules branch sitting at main (history-less), then pin
      // the branch on the mirror without deleting it (remove would deleteBranch).
      const ws = new GitWorkspaces({
        root,
        ports: new PortAllocator(4300, 8),
        push: false,
        clock: () => clock.now,
      });
      await ws.create(remoteRepo, 'DEDUP-HL');
      // No task commits → tip is still default; preserve keeps the branch, drops checkout.
      await ws.preserve('DEDUP-HL', 'hercules: DEDUP-HL — pin at main');

      // Origin has an unrelated tip on the same branch name (subject lacks task id).
      const clone = join(tmp, 'hl-advance');
      await simpleGit(tmp).clone(bare, clone);
      const cg = simpleGit(clone);
      await cg.addConfig('user.email', 'r@h.local');
      await cg.addConfig('user.name', 'Remote');
      await cg.checkout(['-B', 'hercules/DEDUP-HL']);
      await writeFile(join(clone, 'foreign.txt'), 'foreign\n');
      await cg.add(['-A']);
      await cg.raw([
        '-c',
        'user.email=r@h.local',
        '-c',
        'user.name=Remote',
        'commit',
        '-m',
        'unrelated foreign tip without task ownership',
      ]);
      await cg.push(['origin', 'hercules/DEDUP-HL', '--force']);

      cap.lines.length = 0;
      // Reconcile via sibling create (no worktree for DEDUP-HL → not checked out).
      await ws.create(remoteRepo, 'DEDUP-HL-SIB1');
      const e1 = ws
        .drainMirrorEvents()
        .filter((e) => e.message.includes('history-less') && e.branch === 'hercules/DEDUP-HL');
      const c1 = cap.lines.filter((l) => l.includes('history-less') && l.includes('DEDUP-HL'));
      expect(e1.length).toBeGreaterThanOrEqual(1);
      expect(c1.length).toBeGreaterThanOrEqual(1);

      await ws.create(remoteRepo, 'DEDUP-HL-SIB2');
      const e2 = ws
        .drainMirrorEvents()
        .filter((e) => e.message.includes('history-less') && e.branch === 'hercules/DEDUP-HL');
      expect(e2).toHaveLength(0);
      expect(
        cap.lines.filter((l) => l.includes('history-less') && l.includes('DEDUP-HL')).length,
      ).toBe(c1.length);

      clock.now += windowMs;
      await ws.create(remoteRepo, 'DEDUP-HL-SIB3');
      const e3 = ws
        .drainMirrorEvents()
        .filter((e) => e.message.includes('history-less') && e.branch === 'hercules/DEDUP-HL');
      expect(e3.length).toBe(e1.length);

      // Changed remote fingerprint emits immediately.
      await writeFile(join(clone, 'foreign2.txt'), 'foreign2\n');
      await cg.add(['-A']);
      await cg.raw([
        '-c',
        'user.email=r@h.local',
        '-c',
        'user.name=Remote',
        'commit',
        '-m',
        'another foreign tip',
      ]);
      await cg.push(['origin', 'hercules/DEDUP-HL', '--force']);
      clock.now += 1;
      await ws.create(remoteRepo, 'DEDUP-HL-SIB4');
      const e4 = ws
        .drainMirrorEvents()
        .filter((e) => e.message.includes('history-less') && e.branch === 'hercules/DEDUP-HL');
      expect(e4.length).toBeGreaterThanOrEqual(1);
    } finally {
      cap.restore();
    }
  });
});
