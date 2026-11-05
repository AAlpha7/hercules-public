import { mkdtemp, chmod, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ArchiveLockBusyError,
  ArchiveLockLostError,
  openArchiveLockManager,
} from '../../../src/control/artifacts/archiveLock.js';

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'hercules-artifact-lock-'));
  await chmod(value, 0o700);
  return value;
}

describe('archive lock', () => {
  it('excludes a second process and releases idempotently', async () => {
    const dir = await root();
    const first = await openArchiveLockManager(join(dir, '.archive.lock'));
    const second = await openArchiveLockManager(join(dir, '.archive.lock'));
    const lease = await first.acquire();

    await expect(second.acquire()).rejects.toBeInstanceOf(ArchiveLockBusyError);
    await lease.release();
    await lease.release();

    const next = await second.acquire();
    next.assertHealthy();
    await next.release();
  });

  it('surfaces unexpected holder death and refuses further use', async () => {
    const dir = await root();
    const manager = await openArchiveLockManager(join(dir, '.archive.lock'));
    const lease = await manager.acquire();

    process.kill(lease.pid, 'SIGKILL');
    await expect(lease.whenLost).resolves.toBeInstanceOf(ArchiveLockLostError);
    expect(() => lease.assertHealthy()).toThrow(ArchiveLockLostError);
    await expect(manager.acquire()).rejects.toBeInstanceOf(ArchiveLockLostError);
    await lease.release();
  });

  it('rejects replacement of the stable lock-file inode while held', async () => {
    const dir = await root();
    const lockPath = join(dir, '.archive.lock');
    const manager = await openArchiveLockManager(lockPath);
    const lease = await manager.acquire();

    await unlink(lockPath);
    await writeFile(lockPath, '', { mode: 0o600, flag: 'wx' });

    await expect(manager.assertOwns(lease)).rejects.toMatchObject({
      code: 'archive_lock_io',
      operation: 'lock_identity',
    });
    await expect(manager.assertOwns(lease)).rejects.toMatchObject({
      code: 'archive_lock_io',
      operation: 'lock_identity',
    });
    await lease.release();
  });
});
