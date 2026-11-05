import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { simpleGit } from 'simple-git';
import {
  acquireDaemonLease,
  acquireFlockHold,
  acquireLeaseForDaemonStartup,
  controlLeasePaths,
  DaemonLeaseConflictError,
  DaemonLeaseIOError,
  DaemonLeaseLostError,
  flockChildEnv,
  FLOCK_BIN,
  FLOCK_CONFLICT_EXIT,
  FlockBusyError,
  hasExactNonceLine,
  inspectWorkRootOwnership,
  pidAlive,
  releaseDaemonLease,
  resolveCanonicalPath,
  workLeasePaths,
} from '../../src/isolation/daemonLease.js';
import {
  LEGACY_OWNER_LOCK_FILENAME,
  serializeLeaseRecord,
  type DaemonLeaseRecord,
  scopeFingerprint,
} from '../../src/domain/daemonLease.js';
import { ControlGit } from '../../src/control/git.js';
import { GitWorkspaces } from '../../src/isolation/worktree.js';
import { PortAllocator } from '../../src/isolation/ports.js';
import { spawn } from 'node:child_process';

describe('acquireDaemonLease (util-linux flock)', () => {
  let root: string;
  let control: string;
  let work: string;
  const recoveries: string[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hercules-lease-'));
    control = join(root, 'ctrl');
    work = join(root, 'work');
    recoveries.length = 0;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function plantOwnerOnly(rec: DaemonLeaseRecord): void {
    mkdirSync(work, { recursive: true });
    mkdirSync(control, { recursive: true });
    const wp = workLeasePaths(work);
    const cp = controlLeasePaths(control);
    mkdirSync(dirname(wp.ownerPath), { recursive: true });
    mkdirSync(dirname(cp.ownerPath), { recursive: true });
    writeFileSync(wp.ownerPath, serializeLeaseRecord(rec));
    writeFileSync(cp.ownerPath, serializeLeaseRecord(rec));
  }

  it('acquires exclusive lease on empty scope', async () => {
    const held = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'self-1',
    });
    expect(held.identity.instanceId).toBe('self-1');
    expect(existsSync(workLeasePaths(work).ownerPath)).toBe(true);
    expect(held.flockPids.length).toBe(2);
    for (const p of held.flockPids) expect(pidAlive(p)).toBe(true);
    await held.release();
    for (const p of held.flockPids) expect(pidAlive(p)).toBe(false);
  });

  it('second acquirer fails closed while first is live', async () => {
    const a = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'owner-a',
    });
    await expect(
      acquireDaemonLease({ controlRepo: control, workRoot: work, instanceId: 'owner-b' }),
    ).rejects.toBeInstanceOf(DaemonLeaseConflictError);
    await a.release();
  });

  it('stale shutdown cannot delete a successor lease', async () => {
    const first = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'first',
    });
    const firstId = first.identity;
    await first.release();
    const second = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'second',
    });
    await releaseDaemonLease(firstId, second.paths);
    expect(readFileSync(workLeasePaths(work).ownerPath, 'utf8')).toContain('second');
    await second.release();
  });

  it('corrupt owner metadata on release still frees both scopes for a successor', async () => {
    const held = await acquireDaemonLease({
      controlRepo: control,
      workRoot: work,
      instanceId: 'corrupt-owner',
    });
    const wp = workLeasePaths(work);
    const cp = controlLeasePaths(control);
    rmSync(wp.ownerPath, { force: true });
    rmSync(cp.ownerPath, { force: true });
    mkdirSync(wp.ownerPath, { recursive: true });
    mkdirSync(cp.ownerPath, { recursive: true });
    const workSentinel = join(wp.ownerPath, 'sentinel-work.txt');
    const controlSentinel = join(cp.ownerPath, 'sentinel-control.txt');
    writeFileSync(workSentinel, 'keep-work');
    writeFileSync(controlSentinel, 'keep-control');
    await held.release();
    // Owner-only: corrupt directory owner paths must not be deleted on release.
    expect(existsSync(wp.ownerPath)).toBe(true);
    expect(existsSync(cp.ownerPath)).toBe(true);
    expect(readFileSync(workSentinel, 'utf8')).toBe('keep-work');
    expect(readFileSync(controlSentinel, 'utf8')).toBe('keep-control');
    // Explicit test cleanup proves locks were released without unauthorized deletion.
    rmSync(wp.ownerPath, { recursive: true, force: true });
    rmSync(cp.ownerPath, { recursive: true, force: true });
    const successor = await acquireDaemonLease({
      controlRepo: control,
      workRoot: work,
      instanceId: 'after-corrupt-release',
    });
    expect(successor.identity.instanceId).toBe('after-corrupt-release');
    expect(successor.flockPids.length).toBe(2);
    expect(existsSync(wp.ownerPath)).toBe(true);
    expect(existsSync(cp.ownerPath)).toBe(true);
    await successor.release();
  });

  it('recovers a stale lease from a dead pid', async () => {
    plantOwnerOnly({
      version: 1,
      instanceId: 'foreign-instance-aaaaaaaa',
      pid: 999999999,
      starttime: '42',
      bootId: 'old',
      controlRepo: control,
      workRoot: work,
      acquiredAtMs: 1,
    });
    const held = await acquireDaemonLease({
      controlRepo: control,
      workRoot: work,
      instanceId: 'successor',
      pidAlive: (pid) => pid === process.pid,
      onStaleRecovery: (m) => recoveries.push(m),
    });
    expect(held.identity.instanceId).toBe('successor');
    expect(recoveries.some((m) => /stale recovery/.test(m))).toBe(true);
    expect(recoveries.join(' | ')).not.toContain(root);
    await held.release();
  });

  it('does not treat recycled PID as the original owner', async () => {
    plantOwnerOnly({
      version: 1,
      instanceId: 'foreign-instance-aaaaaaaa',
      pid: process.pid,
      starttime: '111',
      bootId: 'boot-x',
      controlRepo: control,
      workRoot: work,
      acquiredAtMs: 1,
    });
    const held = await acquireDaemonLease({
      controlRepo: control,
      workRoot: work,
      instanceId: 'new-gen',
      pidAlive: () => true,
      readStarttime: () => '999',
      readBootId: () => 'boot-x',
      onStaleRecovery: (m) => recoveries.push(m),
    });
    expect(held.identity.instanceId).toBe('new-gen');
    await held.release();
  });

  it('legacy live lock blocks', async () => {
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, LEGACY_OWNER_LOCK_FILENAME), '1' + String.fromCharCode(10));
    await expect(
      acquireDaemonLease({
        controlRepo: control,
        workRoot: work,
        instanceId: 'try',
        pidAlive: (p) => p === 1,
      }),
    ).rejects.toBeInstanceOf(DaemonLeaseConflictError);
  });

  it('same control with different work roots conflicts on control', async () => {
    const work2 = join(root, 'work-b');
    const a = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'a',
    });
    await expect(
      acquireDaemonLease({ controlRepo: control, workRoot: work2, instanceId: 'b' }),
    ).rejects.toBeInstanceOf(DaemonLeaseConflictError);
    await a.release();
  });

  it('same work root with different controls conflicts on work', async () => {
    const control2 = join(root, 'ctrl-b');
    const a = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'a',
    });
    await expect(
      acquireDaemonLease({ controlRepo: control2, workRoot: work, instanceId: 'b' }),
    ).rejects.toBeInstanceOf(DaemonLeaseConflictError);
    await a.release();
  });

  it('rolls back work lease when control acquisition fails', async () => {
    const a = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'holder',
    });
    const work2 = join(root, 'work-rb');
    await expect(
      acquireDaemonLease({ controlRepo: control, workRoot: work2, instanceId: 'rollback' }),
    ).rejects.toBeInstanceOf(DaemonLeaseConflictError);
    await a.release();
    const again = await acquireDaemonLease({
      controlRepo: control, workRoot: work2, instanceId: 'after-rb',
    });
    expect(again.identity.instanceId).toBe('after-rb');
    await again.release();
  });

  it('afterWorkAcquired rejection rolls back held resources', async () => {
    await expect(
      acquireDaemonLease({
        controlRepo: control,
        workRoot: work,
        instanceId: 'hook-fail',
        hooks: {
          afterWorkAcquired: async () => {
            throw new Error('hook boom');
          },
        },
      }),
    ).rejects.toThrow('hook boom');
    const again = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'after-hook',
    });
    expect(again.identity.instanceId).toBe('after-hook');
    await again.release();
  });

  it('canonicalizes symlink aliases including missing child under real parent', async () => {
    const realBase = join(root, 'real-base');
    const alias = join(root, 'alias-base');
    mkdirSync(realBase, { recursive: true });
    symlinkSync(realBase, alias);
    const missingChild = join(alias, 'not-yet-created');
    expect(resolveCanonicalPath(missingChild)).toBe(join(realBase, 'not-yet-created'));
    const viaAlias = await acquireDaemonLease({
      controlRepo: join(alias, 'ctrl-x'),
      workRoot: join(alias, 'work-x'),
      instanceId: 'sym-a',
    });
    await expect(
      acquireDaemonLease({
        controlRepo: join(realBase, 'ctrl-x'),
        workRoot: join(realBase, 'work-x'),
        instanceId: 'sym-b',
      }),
    ).rejects.toBeInstanceOf(DaemonLeaseConflictError);
    await viaAlias.release();
  });

  it('two stale reclaimers: exactly one wins', async () => {
    plantOwnerOnly({
      version: 1,
      instanceId: 'foreign-instance-aaaaaaaa',
      pid: 999999998,
      starttime: '1',
      bootId: 'boot-test',
      controlRepo: control,
      workRoot: work,
      acquiredAtMs: 1,
    });
    const results = await Promise.allSettled([
      acquireDaemonLease({
        controlRepo: control, workRoot: work, instanceId: 'racer-1',
        pidAlive: (p) => p === process.pid,
      }),
      acquireDaemonLease({
        controlRepo: control, workRoot: work, instanceId: 'racer-2',
        pidAlive: (p) => p === process.pid,
      }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    if (ok[0]?.status === 'fulfilled') await ok[0].value.release();
  });

  it('three-actor barrier: stale observer cannot displace successor', async () => {
    plantOwnerOnly({
      version: 1,
      instanceId: 'foreign-instance-aaaaaaaa',
      pid: 999999997,
      starttime: '1',
      bootId: 'boot-test',
      controlRepo: control,
      workRoot: work,
      acquiredAtMs: 1,
    });
    let bHeld: Awaited<ReturnType<typeof acquireDaemonLease>> | undefined;
    const aAttempt = acquireDaemonLease({
      controlRepo: control,
      workRoot: work,
      instanceId: 'stale-observer-a',
      pidAlive: (p) => p === process.pid,
      hooks: {
        afterOpenBeforeLock: async () => {
          bHeld = await acquireDaemonLease({
            controlRepo: control,
            workRoot: work,
            instanceId: 'successor-b',
            pidAlive: (p) => p === process.pid,
          });
        },
      },
    });
    await expect(aAttempt).rejects.toBeInstanceOf(DaemonLeaseConflictError);
    expect(bHeld).toBeDefined();
    expect(readFileSync(workLeasePaths(work).ownerPath, 'utf8')).toContain('successor-b');
    await bHeld!.release();
  });

  it('real competing flock process blocks acquisition (exit 73)', async () => {
    mkdirSync(work, { recursive: true });
    mkdirSync(control, { recursive: true });
    const lockPath = workLeasePaths(work).lockPath;
    writeFileSync(lockPath, '', { flag: 'a' });
    const holder = spawn(
      FLOCK_BIN,
      ['-n', '-E', String(FLOCK_CONFLICT_EXIT), lockPath, '/usr/bin/cat'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: flockChildEnv() },
    );
    // Wait until flock is held: write a probe line and see echo (or exit).
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('competitor flock timeout')), 3000);
      holder.stdout?.once('data', () => {
        clearTimeout(t);
        resolve();
      });
      holder.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error('competitor flock exited early code=' + String(code)));
      });
      holder.stdin?.write('ping\n');
    });
    try {
      await expect(
        acquireDaemonLease({
          controlRepo: control, workRoot: work, instanceId: 'blocked',
        }),
      ).rejects.toBeInstanceOf(DaemonLeaseConflictError);
    } finally {
      holder.stdin?.end();
      await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    }
  });

  it('busy flock maps to FlockBusyError without uncaught EPIPE on nonce write', async () => {
    // Regression: when flock -n exits 73 before cat starts, writing the handshake
    // nonce races with EPIPE. That must become FlockBusyError (not uncaught EPIPE).
    mkdirSync(work, { recursive: true });
    const lockPath = workLeasePaths(work).lockPath;
    writeFileSync(lockPath, '', { flag: 'a' });
    const holder = spawn(
      FLOCK_BIN,
      ['-n', '-E', String(FLOCK_CONFLICT_EXIT), lockPath, '/usr/bin/cat'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: flockChildEnv() },
    );
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('holder flock timeout')), 3000);
      holder.stdout?.once('data', () => {
        clearTimeout(t);
        resolve();
      });
      holder.on('exit', (code) => {
        clearTimeout(t);
        reject(new Error('holder flock exited early code=' + String(code)));
      });
      holder.stdin?.write('ping\n');
    });
    try {
      // Stress the race: many concurrent losers; none may surface uncaught EPIPE.
      const attempts = await Promise.allSettled(
        Array.from({ length: 8 }, () => acquireFlockHold(lockPath)),
      );
      expect(attempts.every((r) => r.status === 'rejected')).toBe(true);
      for (const r of attempts) {
        if (r.status === 'rejected') {
          expect(r.reason).toBeInstanceOf(FlockBusyError);
        }
      }
    } finally {
      holder.stdin?.end();
      await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    }
  });

  it('control-scope flock failure reports scope=control (not hard-coded work)', async () => {
    // ensureLockFile path: parent is a regular file → mkdir fails before spawn.
    const secret = join(root, 'secret-control-parent');
    writeFileSync(secret, 'not-a-directory');
    const badLock = join(secret, 'daemon.lock');
    try {
      await acquireFlockHold(badLock, undefined, 'control');
      expect.fail('expected DaemonLeaseIOError for control mkdir');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonLeaseIOError);
      const e = err as InstanceType<typeof DaemonLeaseIOError>;
      expect(e.scopeKind).toBe('control');
      expect(e.message).toMatch(/scope=control/);
      expect(e.message).not.toMatch(/scope=work\b/);
      expect(e.message).not.toContain('secret-control');
      expect(e.message).not.toContain(secret);
    }

    // Post-open handshake path: corrupt the lock parent after ensureLockFile so
    // flock exits non-73; mapEarlyExit/handshake must still carry scope=control.
    mkdirSync(control, { recursive: true });
    const lockPath = controlLeasePaths(control).lockPath;
    const parent = dirname(lockPath);
    mkdirSync(parent, { recursive: true });
    writeFileSync(lockPath, '', { flag: 'a' });
    try {
      await acquireFlockHold(
        lockPath,
        {
          afterOpenBeforeLock: () => {
            rmSync(parent, { recursive: true, force: true });
            writeFileSync(parent, 'not-a-dir');
          },
        },
        'control',
      );
      expect.fail('expected DaemonLeaseIOError for control flock early exit');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonLeaseIOError);
      const e = err as InstanceType<typeof DaemonLeaseIOError>;
      expect(e.scopeKind).toBe('control');
      expect(e.message).toMatch(/scope=control/);
      expect(e.message).not.toMatch(/scope=work\b/);
      expect(e.message).not.toContain(parent);
      expect(e.message).not.toContain(lockPath);
      expect(e.operation).toMatch(
        /^(flock_early_exit|flock_spawn|flock_handshake|open_lock)$/,
      );
    } finally {
      // Parent may be a file (fault hook) or a directory; force either shape.
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('conflict diagnostics never include raw path segments', async () => {
    const secret = join(root, 'secret-token-xyz');
    const c = join(secret, 'ctrl');
    const w = join(secret, 'work');
    const a = await acquireDaemonLease({
      controlRepo: c, workRoot: w, instanceId: 'holder',
    });
    try {
      await acquireDaemonLease({ controlRepo: c, workRoot: w, instanceId: 'loser' });
      expect.fail('expected conflict');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonLeaseConflictError);
      const msg = (err as Error).message;
      expect(msg).not.toContain('secret-token');
      expect(msg).not.toContain(secret);
      expect(msg).toMatch(/controlFp=/);
      expect(msg).toMatch(/workFp=/);
    }
    await a.release();
  });

  it('flock child env never carries secrets or HERCULES_*', () => {
    const env = flockChildEnv({
      PATH: '/usr/bin',
      HERCULES_TOKEN: 'super-secret',
      HERCULES_WORK_DIR: '/secret/work',
      DATABASE_URL: 'postgres://x',
      NODE_OPTIONS: '--inspect',
      LANG: 'C',
    });
    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'C' });
    expect(env['HERCULES_TOKEN']).toBeUndefined();
  });

  it('control lease paths never land inside a non-git control root', () => {
    mkdirSync(control, { recursive: true });
    const paths = controlLeasePaths(control);
    expect(paths.lockPath.startsWith(control + '/')).toBe(false);
    expect(paths.ownerPath.startsWith(control + '/')).toBe(false);
    expect(paths.lockPath).toContain('.hercules-daemon-leases');
  });

  it('handshake requires exact newline-delimited nonce (not substring)', () => {
    const nonce = 'aabbccddeeff00112233445566778899';
    expect(hasExactNonceLine(nonce + '\n', nonce)).toBe(true);
    expect(hasExactNonceLine('x' + nonce + '\n', nonce)).toBe(false);
    expect(hasExactNonceLine(nonce.slice(0, 8) + '\n', nonce)).toBe(false);
    expect(hasExactNonceLine(nonce, nonce)).toBe(false); // incomplete line
    expect(hasExactNonceLine('prefix\n' + nonce + '\n', nonce)).toBe(true);
  });

  it('killing a held flock PID fail-closes mutation via whenLost + assertHeld', async () => {
    const held = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'victim',
    });
    expect(held.isHeld()).toBe(true);
    held.assertHeld(); // must not throw while live
    const pid = held.flockPids[0];
    expect(pid).toBeDefined();
    process.kill(pid!, 'SIGKILL');
    await held.whenLost;
    expect(held.isHeld()).toBe(false);
    expect(() => held.assertHeld()).toThrow(DaemonLeaseLostError);
    // Intentional cleanup of remaining hold (if any) so temp dir can go away.
    await held.release();
  });

  it('intentional release does not signal whenLost as unexpected loss', async () => {
    const held = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'graceful',
    });
    let lostFired = false;
    void held.whenLost.then(() => {
      lostFired = true;
    });
    await held.release();
    expect(held.isHeld()).toBe(false);
    expect(() => held.assertHeld()).toThrow(DaemonLeaseLostError);
    // Give the event loop a turn; whenLost must stay pending.
    await new Promise((r) => setTimeout(r, 50));
    expect(lostFired).toBe(false);
  });

  it('beforeOwnerWrite throw releases the newly acquired flock hold', async () => {
    await expect(
      acquireDaemonLease({
        controlRepo: control,
        workRoot: work,
        instanceId: 'bow-fail',
        hooks: {
          beforeOwnerWrite: async () => {
            throw new Error('beforeOwnerWrite boom');
          },
        },
      }),
    ).rejects.toThrow('beforeOwnerWrite boom');
    // Scope must be free for a successor after the failed claim.
    const again = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'after-bow',
    });
    expect(again.identity.instanceId).toBe('after-bow');
    await again.release();
  });

  it('onStaleRecovery throw releases the newly acquired flock hold', async () => {
    plantOwnerOnly({
      version: 1,
      instanceId: 'foreign-instance-aaaaaaaa',
      pid: 999999996,
      starttime: '1',
      bootId: 'boot-test',
      controlRepo: control,
      workRoot: work,
      acquiredAtMs: 1,
    });
    await expect(
      acquireDaemonLease({
        controlRepo: control,
        workRoot: work,
        instanceId: 'stale-cb-fail',
        pidAlive: (p) => p === process.pid,
        onStaleRecovery: () => {
          throw new Error('onStale boom');
        },
      }),
    ).rejects.toThrow('onStale boom');
    const again = await acquireDaemonLease({
      controlRepo: control,
      workRoot: work,
      instanceId: 'after-stale-cb',
      pidAlive: (p) => p === process.pid,
    });
    expect(again.identity.instanceId).toBe('after-stale-cb');
    await again.release();
  });

  it('mkdir failures are typed and redacted when parent is a secret-named file', async () => {
    const secret = join(root, 'secret-token-xyz');
    writeFileSync(secret, 'not-a-directory');
    const c = join(secret, 'ctrl');
    const w = join(secret, 'work');
    try {
      await acquireDaemonLease({
        controlRepo: c, workRoot: w, instanceId: 'mkdir-fail',
      });
      expect.fail('expected DaemonLeaseIOError');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonLeaseIOError);
      const e = err as InstanceType<typeof DaemonLeaseIOError>;
      expect(e.message).not.toContain('secret-token');
      expect(e.message).not.toContain(secret);
      expect(e.message).toMatch(/op=mkdir/);
      expect(e.message).toMatch(/fp=/);
      expect(e.message).toMatch(/code=/);
      expect(e.operation).toBe('mkdir');
      expect(e.code.length).toBeGreaterThan(0);
    }
  });

  it('owner path as directory yields typed redacted read failure and releases hold', async () => {
    mkdirSync(work, { recursive: true });
    mkdirSync(control, { recursive: true });
    const wp = workLeasePaths(work);
    const cp = controlLeasePaths(control);
    void cp;
    mkdirSync(dirname(wp.ownerPath), { recursive: true });
    mkdirSync(dirname(cp.ownerPath), { recursive: true });
    mkdirSync(wp.ownerPath, { recursive: true });
    try {
      await acquireDaemonLease({
        controlRepo: control, workRoot: work, instanceId: 'bad-owner',
      });
      expect.fail('expected DaemonLeaseIOError');
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonLeaseIOError);
      const e = err as InstanceType<typeof DaemonLeaseIOError>;
      expect(e.message).not.toContain(root);
      expect(e.message).not.toContain(work);
      expect(e.message).toMatch(/fp=/);
      expect(e.message).toMatch(/op=read_owner|op=write_owner/);
      expect(e.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(e.message).toContain('fp=' + e.fingerprint);
      expect(e.fingerprint).toBe(
        scopeFingerprint(workLeasePaths(resolveCanonicalPath(work)).ownerPath),
      );
    }
    rmSync(wp.ownerPath, { recursive: true, force: true });
    const again = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'after-bad-owner',
    });
    expect(again.identity.instanceId).toBe('after-bad-owner');
    await again.release();
  });
});

describe('acquireLeaseForDaemonStartup lifecycle', () => {
  let root: string;
  let control: string;
  let work: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hercules-lease-startup-'));
    control = join(root, 'ctrl');
    work = join(root, 'work');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('releases lease when early boot fails so a successor can acquire', async () => {
    await expect(
      acquireLeaseForDaemonStartup(control, work, () => {
        throw new Error('seed boom');
      }),
    ).rejects.toThrow('seed boom');
    const held = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'after-fail',
    });
    expect(held.identity.instanceId).toBe('after-fail');
    await held.release();
  });

  it('holds lease when early boot succeeds (blocks second instance)', async () => {
    const held = await acquireLeaseForDaemonStartup(control, work, () => {
      // early boot ok
    });
    await expect(
      acquireDaemonLease({
        controlRepo: control, workRoot: work, instanceId: 'other',
      }),
    ).rejects.toBeInstanceOf(DaemonLeaseConflictError);
    await held.release();
  });
});

describe('lease git hygiene and reclaim integration', () => {
  it('acquire leaves control git status clean and commitAll ignores lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hercules-lease-git-'));
    const control = join(root, 'ctrl');
    const work = join(root, 'work');
    mkdirSync(control, { recursive: true });
    const git = simpleGit(control);
    await git.init(['-b', 'main']);
    await git.addConfig('user.email', 't@hercules.local');
    await git.addConfig('user.name', 'T');
    writeFileSync(join(control, 'README'), 'seed');
    await git.add('.');
    await git.commit('seed');
    const held = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'git-clean',
    });
    expect((await git.status()).files).toEqual([]);
    // Control lease lives under .git common dir, not the worktree.
    const cp = controlLeasePaths(control);
    expect(cp.lockPath.includes('/.git/')).toBe(true);
    writeFileSync(join(control, 'task.md'), 'x');
    const result = await new ControlGit(control).commitAll('add task');
    expect(result.committed).toBe(true);
    const show = await git.show(['--name-only', '--pretty=format:', 'HEAD']);
    expect(show).toContain('task.md');
    expect(show).not.toMatch(/hercules-daemon/);
    await held.release();
    rmSync(root, { recursive: true, force: true });
  });

  it('GitWorkspaces reclaim with injected identity; separate live owner blocks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hercules-lease-reclaim-'));
    const control = join(root, 'ctrl');
    const work = join(root, 'work');
    const held = await acquireDaemonLease({
      controlRepo: control, workRoot: work, instanceId: 'reclaim-owner',
    });
    const orphan = join(work, 'app', 'ORPHAN-1');
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, '.git'), 'gitdir: /tmp/nonexistent');
    const ws = new GitWorkspaces({
      root: work,
      ports: new PortAllocator(5000, 5),
      leaseIdentity: held.identity,
    });
    expect(await ws.reclaimOrphans(new Set())).toContain('ORPHAN-1');
    const orphan2 = join(work, 'app', 'ORPHAN-2');
    mkdirSync(orphan2, { recursive: true });
    writeFileSync(join(orphan2, '.git'), 'gitdir: /tmp/nonexistent');
    const wsForeign = new GitWorkspaces({ root: work, ports: new PortAllocator(5100, 5) });
    expect(await wsForeign.reclaimOrphans(new Set())).toEqual([]);
    expect(existsSync(orphan2)).toBe(true);
    expect(inspectWorkRootOwnership(work).kind).toBe('live_foreign');
    await held.release();
    rmSync(root, { recursive: true, force: true });
  });
});
