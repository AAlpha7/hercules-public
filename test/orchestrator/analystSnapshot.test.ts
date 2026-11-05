/**
 * Analyst confinement: one cached read-only snapshot per repo tip, always
 * carrying the `hercules-analyst` sandbox profile; private GROK_HOME with
 * credentials only; never throws (empty sandboxed fallback), prunes old tips,
 * tolerates concurrent callers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANALYST_SANDBOX_PROFILE,
  createAnalystSnapshots,
  refreshAnalystPrivateHome,
  renderAnalystSandboxToml,
  resolveOperatorGrokHome,
} from '../../src/orchestrator/analystSnapshot.js';
import type { RepoConfig } from '../../src/domain/repos.js';

const repo: RepoConfig = {
  key: 'app', url: 'x', defaultBranch: 'main', workflow: 'WORKFLOW.md',
  maxConcurrent: 1, adapter: null, readiness: 'ready',
};
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

let root: string;
let operatorHome: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hercules-snap-'));
  operatorHome = join(root, 'operator-grok');
  await mkdir(operatorHome, { recursive: true });
  await writeFile(join(operatorHome, 'auth.json'), '{"token":"t"}\n', {
    mode: 0o600,
  });
  await writeFile(join(operatorHome, 'agent_id'), 'agent-1\n', { mode: 0o600 });
  // Litter that must NEVER be copied into the private home.
  await mkdir(join(operatorHome, 'rules'), { recursive: true });
  await writeFile(join(operatorHome, 'rules', '00-continuity.md'), 'nope\n');
  await mkdir(join(operatorHome, 'continuity'), { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Fake export: writes a tree plus a repo-supplied grok config that must not survive. */
async function fakeExport(_r: RepoConfig, sha: string, dest: string): Promise<void> {
  await writeFile(join(dest, 'README.md'), `tree ${sha}\n`);
  await mkdir(join(dest, '.grok'), { recursive: true });
  await writeFile(join(dest, '.grok', 'config.toml'), '[mcp_servers.evil]\n');
}

describe('renderAnalystSandboxToml', () => {
  it('extends strict with an empty deny list (no deny candidates since grok 1.0.13)', () => {
    const toml = renderAnalystSandboxToml();
    expect(toml).toContain(`[profiles.${ANALYST_SANDBOX_PROFILE}]`);
    expect(toml).toContain('extends = "strict"');
    expect(toml).toContain('restrict_network = true');
    expect(toml).toContain('deny = []');
    expect(toml).not.toContain('continuity');
    expect(toml).not.toContain('DENY');
    expect(toml).not.toMatch(/deny = \[[^\]]*[^\s\]]/);
  });
});

describe('resolveOperatorGrokHome', () => {
  it('prefers explicit, then $GROK_HOME, then ~/.grok', () => {
    expect(resolveOperatorGrokHome('/explicit', { GROK_HOME: '/env' }, '/home/u')).toBe(
      '/explicit',
    );
    expect(resolveOperatorGrokHome(undefined, { GROK_HOME: '/env' }, '/home/u')).toBe('/env');
    expect(resolveOperatorGrokHome(undefined, {}, '/home/u')).toBe(join('/home/u', '.grok'));
  });
});

describe('refreshAnalystPrivateHome', () => {
  it('copies only auth.json + agent_id with mode 600/700 and skips litter', async () => {
    const dest = join(root, '.grok-home');
    const ok = await refreshAnalystPrivateHome({
      destHome: dest,
      operatorGrokHome: operatorHome,
    });
    expect(ok).toBe(true);
    const homeSt = await stat(dest);
    expect(homeSt.mode & 0o777).toBe(0o700);
    const names = (await readdir(dest)).sort();
    expect(names).toEqual(['agent_id', 'auth.json']);
    for (const name of names) {
      const st = await stat(join(dest, name));
      expect(st.mode & 0o777).toBe(0o600);
    }
    expect(await readFile(join(dest, 'auth.json'), 'utf8')).toContain('"token"');
    expect(existsSync(join(dest, 'rules'))).toBe(false);
    expect(existsSync(join(dest, 'continuity'))).toBe(false);
  });

  it('refreshes a credential when the source mtime is newer', async () => {
    const dest = join(root, '.grok-home');
    expect(
      await refreshAnalystPrivateHome({
        destHome: dest,
        operatorGrokHome: operatorHome,
      }),
    ).toBe(true);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(dest, 'auth.json'), old, old);
    await writeFile(join(operatorHome, 'auth.json'), '{"token":"rotated"}\n', {
      mode: 0o600,
    });
    const newer = new Date(Date.now() + 5_000);
    await utimes(join(operatorHome, 'auth.json'), newer, newer);
    expect(
      await refreshAnalystPrivateHome({
        destHome: dest,
        operatorGrokHome: operatorHome,
      }),
    ).toBe(true);
    expect(await readFile(join(dest, 'auth.json'), 'utf8')).toContain('rotated');
  });

  it('returns false and logs when auth.json is missing (no throw)', async () => {
    const dest = join(root, '.grok-home');
    const emptyOp = join(root, 'empty-op');
    await mkdir(emptyOp, { recursive: true });
    const log = vi.fn();
    const ok = await refreshAnalystPrivateHome({
      destHome: dest,
      operatorGrokHome: emptyOp,
      log,
    });
    expect(ok).toBe(false);
    expect(existsSync(join(dest, 'auth.json'))).toBe(false);
    expect(String(log.mock.calls[0]![0])).toMatch(/UNAVAILABLE.*auth\.json/i);
  });
});

describe('createAnalystSnapshots.ensure', () => {
  it('exports once per tip, writes the sandbox profile, drops repo grok config, then caches', async () => {
    const exportTree = vi.fn(fakeExport);
    const snaps = createAnalystSnapshots({
      root,
      operatorGrokHome: operatorHome,
      exportTree,
      defaultBranchHead: async () => SHA_A,
    });
    const first = await snaps.ensure(repo);
    expect(first.dir).toBe(join(root, 'app', SHA_A));
    expect(first.sha).toBe(SHA_A);
    expect(first.grokHome).toBe(join(root, '.grok-home'));
    expect(await readFile(join(first.dir, 'README.md'), 'utf8')).toContain(SHA_A);
    const toml = await readFile(join(first.dir, '.grok', 'sandbox.toml'), 'utf8');
    expect(toml).toContain(`[profiles.${ANALYST_SANDBOX_PROFILE}]`);
    expect(toml).toContain('extends = "strict"');
    expect(toml).toContain('deny = []');
    expect(await readdir(join(first.dir, '.grok'))).toEqual(['sandbox.toml']);
    expect(await readFile(join(first.dir, '.hercules-snapshot'), 'utf8')).toBe(SHA_A);
    // Private home is beside the snapshot root, not inside the repo tree.
    expect(existsSync(join(first.dir, '.grok-home'))).toBe(false);
    expect(existsSync(join(root, '.grok-home', 'auth.json'))).toBe(true);
    expect((await stat(join(root, '.grok-home'))).mode & 0o777).toBe(0o700);

    const second = await snaps.ensure(repo);
    expect(second).toEqual(first);
    expect(exportTree).toHaveBeenCalledTimes(1);
    const entries = await readdir(join(root, 'app'));
    expect(entries).toEqual([SHA_A]);
  });

  it('shares one in-flight build between concurrent callers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const exportTree = vi.fn(async (r: RepoConfig, sha: string, dest: string) => {
      await gate;
      await fakeExport(r, sha, dest);
    });
    const snaps = createAnalystSnapshots({
      root,
      operatorGrokHome: operatorHome,
      exportTree,
      defaultBranchHead: async () => SHA_A,
    });
    const p1 = snaps.ensure(repo);
    const p2 = snaps.ensure(repo);
    release();
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(s1.dir).toBe(s2.dir);
    expect(exportTree).toHaveBeenCalledTimes(1);
  });

  it('falls back to a sandboxed empty dir when the tip is unknown or the export fails', async () => {
    const log = vi.fn();
    const noTip = createAnalystSnapshots({
      root,
      operatorGrokHome: operatorHome,
      log,
      defaultBranchHead: async () => null,
      exportTree: fakeExport,
    });
    const empty = await noTip.ensure(repo);
    expect(empty).toEqual({
      dir: join(root, 'app', '_empty'),
      sha: null,
      grokHome: join(root, '.grok-home'),
    });
    expect(existsSync(join(empty.dir, '.grok', 'sandbox.toml'))).toBe(true);
    expect(log.mock.calls.some((c) => String(c[0]).includes('fallback'))).toBe(true);

    const failing = createAnalystSnapshots({
      root,
      operatorGrokHome: operatorHome,
      log,
      defaultBranchHead: async () => SHA_B,
      exportTree: async () => {
        throw new Error('mirror gone');
      },
    });
    const again = await failing.ensure(repo);
    expect(again.sha).toBeNull();
    expect(again.dir).toBe(empty.dir);
    const entries = await readdir(join(root, 'app'));
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false);
    expect(entries).not.toContain(SHA_B);
    expect(log.mock.calls.some((c) => String(c[0]).includes('mirror gone'))).toBe(true);

    const malformed = createAnalystSnapshots({
      root,
      operatorGrokHome: operatorHome,
      log,
      defaultBranchHead: async () => '../escape',
      exportTree: fakeExport,
    });
    expect((await malformed.ensure(repo)).sha).toBeNull();
    expect(existsSync(join(root, 'escape'))).toBe(false);
  });

  it('never uses an invalid repo key as a path segment', async () => {
    const snaps = createAnalystSnapshots({
      root,
      operatorGrokHome: operatorHome,
      exportTree: fakeExport,
      defaultBranchHead: async () => SHA_A,
    });
    const s = await snaps.ensure({ ...repo, key: '../up' });
    expect(s).toEqual({
      dir: join(root, '_invalid', '_empty'),
      sha: null,
      grokHome: join(root, '.grok-home'),
    });
    expect(existsSync(join(root, '..', 'up'))).toBe(false);
  });

  it('prunes tips beyond `keep`, leaving _empty and in-flight tmp dirs alone', async () => {
    let tip = SHA_A;
    const snaps = createAnalystSnapshots({
      root,
      operatorGrokHome: operatorHome,
      keep: 2,
      exportTree: fakeExport,
      defaultBranchHead: async () => tip,
    });
    await mkdir(join(root, 'app', '_empty'), { recursive: true });
    await mkdir(join(root, 'app', '.tmp-zzz'), { recursive: true });
    await snaps.ensure(repo);
    const old = new Date(Date.now() - 60_000);
    await utimes(join(root, 'app', SHA_A), old, old);
    tip = SHA_B;
    await snaps.ensure(repo);
    tip = SHA_C;
    await snaps.ensure(repo);
    const entries = (await readdir(join(root, 'app'))).sort();
    expect(entries).toEqual(['.tmp-zzz', SHA_B, SHA_C, '_empty'].sort());
  });

  it('ensurePrivateHome returns null when operator auth is missing', async () => {
    const emptyOp = join(root, 'no-auth');
    await mkdir(emptyOp, { recursive: true });
    const log = vi.fn();
    const snaps = createAnalystSnapshots({
      root,
      operatorGrokHome: emptyOp,
      log,
      exportTree: fakeExport,
      defaultBranchHead: async () => SHA_A,
    });
    expect(await snaps.ensurePrivateHome()).toBeNull();
    const snap = await snaps.ensure(repo);
    expect(snap.grokHome).toBeNull();
    expect(snap.sha).toBe(SHA_A);
  });
});
