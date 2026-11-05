import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { GitRepoProbe, RepoProbeError } from '../../src/orchestrator/repoProbe.js';
import { RepoUrlError } from '../../src/control/reposConfig.js';

describe('GitRepoProbe', () => {
  it('lists head branches of a reachable repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'herc-probe-'));
    try {
      const git = simpleGit(dir);
      await git.init(['--initial-branch=main']);
      await git.addConfig('user.email', 't@t');
      await git.addConfig('user.name', 't');
      await git.commit('init', [], { '--allow-empty': null });
      const { branches } = await new GitRepoProbe().probe(dir);
      expect(branches).toContain('main');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws RepoProbeError for an unreachable url (fast-fail local path)', async () => {
    const err = await new GitRepoProbe({ timeoutMs: 2000 }).probe('/no/such/repo-xyz').catch((e) => e);
    expect(err).toBeInstanceOf(RepoProbeError);
    expect((err as Error).name).toBe('RepoProbeError');
  });

  it('throws RepoProbeError when connection hangs until timeout (non-routable address)', async () => {
    // RFC 5737 TEST-NET-1 — not routable; git will either block until our
    // timeoutMs fires or the OS returns EHOSTUNREACH immediately.  Both paths
    // must still throw RepoProbeError.
    await expect(
      new GitRepoProbe({ timeoutMs: 1500 }).probe('git://192.0.2.1/x'),
    ).rejects.toBeInstanceOf(RepoProbeError);
  }, 10_000);

  it('rejects ext:: transport URL with RepoUrlError before touching git', async () => {
    // Validation must run before any git subprocess is spawned — RCE vector.
    const err = await new GitRepoProbe().probe('ext::sh -c whoami').catch((e) => e);
    expect(err).toBeInstanceOf(RepoUrlError);
    expect((err as Error).name).toBe('RepoUrlError');
  });

  it('succeeds when blocked env vars (ssh/pager/editor) are set in process.env', async () => {
    // Mirrors the vars interactive shells and CI commonly inject; simple-git
    // rejects them unless stripped by the probe's denylist.
    const dir = await mkdtemp(join(tmpdir(), 'herc-probe-ssh-'));
    const poisoned = {
      GIT_SSH_COMMAND: 'ssh -i /tmp/x',
      GIT_SEQUENCE_EDITOR: 'true',
      GIT_EDITOR: 'true',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
    } as const;
    const prev = new Map<string, string | undefined>();
    for (const k of Object.keys(poisoned)) prev.set(k, process.env[k]);
    try {
      const git = simpleGit(dir);
      await git.init(['--initial-branch=main']);
      await git.addConfig('user.email', 't@t');
      await git.addConfig('user.name', 't');
      await git.commit('init', [], { '--allow-empty': null });
      for (const [k, v] of Object.entries(poisoned)) process.env[k] = v;
      const { branches } = await new GitRepoProbe().probe(dir);
      expect(branches).toContain('main');
    } finally {
      for (const [k, v] of prev) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('redacts credentials from error messages (no secret in RepoProbeError)', async () => {
    // Use a non-routable address with embedded credentials and a short timeout.
    // Whether git rejects it before connecting or our timeout fires, the error
    // message must NOT contain the raw secret.
    const err = await new GitRepoProbe({ timeoutMs: 3000 })
      .probe('https://user:secret@192.0.2.1/x.git')
      .catch((e) => e);
    expect(err).toBeInstanceOf(RepoProbeError);
    expect((err as Error).message).not.toContain('secret');
  }, 10_000);
});
