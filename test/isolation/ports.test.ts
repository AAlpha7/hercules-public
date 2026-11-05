import { describe, it, expect } from 'vitest';
import { createServer } from 'node:net';
import { isHardInfraError } from '../../src/domain/retryPolicy.js';
import {
  PortAllocator,
  PortExhaustedError,
  PortProbeError,
  classifyPortProbeFailure,
  isPortBindable,
  PORT_PROBE_HOST,
} from '../../src/isolation/ports.js';

describe('PortAllocator', () => {
  it('hands out the lowest free port from the pool', async () => {
    const pool = new PortAllocator(4000, 3, () => true);
    expect(await pool.acquire()).toBe(4000);
    expect(await pool.acquire()).toBe(4001);
    expect(await pool.acquire()).toBe(4002);
  });

  it('throws when the pool is exhausted', async () => {
    const pool = new PortAllocator(4000, 2, () => true);
    await pool.acquire();
    await pool.acquire();
    await expect(pool.acquire()).rejects.toBeInstanceOf(PortExhaustedError);
  });

  it('reuses a released port', async () => {
    const pool = new PortAllocator(4000, 2, () => true);
    const a = await pool.acquire();
    await pool.acquire();
    pool.release(a);
    expect(await pool.acquire()).toBe(a);
  });

  it('treats releasing an unallocated port as a no-op', async () => {
    const pool = new PortAllocator(4000, 2, () => true);
    pool.release(4000);
    pool.release(9999);
    expect(await pool.acquire()).toBe(4000);
    expect(await pool.acquire()).toBe(4001);
  });

  it('reports how many ports are free', async () => {
    const pool = new PortAllocator(4000, 2, () => true);
    expect(pool.available).toBe(2);
    await pool.acquire();
    expect(pool.available).toBe(1);
  });

  it('skips ports the OS probe reports as busy (orphaned L2 / foreign listeners)', async () => {
    // Case study 2026-07-29: orbit L2 orphans held 4100/4101; Hercules still
    // allocated them, health_check hit the wrong app, L2 evidence failed.
    const busy = new Set([4100, 4101]);
    const pool = new PortAllocator(4100, 5, (p) => !busy.has(p));
    expect(await pool.acquire()).toBe(4102);
    expect(await pool.acquire()).toBe(4103);
  });

  it('exhausts when every pool port is OS-busy', async () => {
    const pool = new PortAllocator(5000, 2, () => false);
    await expect(pool.acquire()).rejects.toThrow(/no free port|OS-busy/);
  });

  it('injected EADDRINUSE (busy) skips only that port and continues', async () => {
    const probed: number[] = [];
    const pool = new PortAllocator(6000, 3, (p) => {
      probed.push(p);
      // First candidate busy; later ones free.
      return p !== 6000;
    });
    expect(await pool.acquire()).toBe(6001);
    expect(probed).toEqual([6000, 6001]);
  });

  it('injected EPERM fails immediately with host, port, operation, and code', async () => {
    const probed: number[] = [];
    const pool = new PortAllocator(6100, 5, (p) => {
      probed.push(p);
      throw new PortProbeError({
        code: 'EPERM',
        host: PORT_PROBE_HOST,
        port: p,
        operation: 'listen',
      });
    });
    const err = await pool.acquire().then(
      () => {
        throw new Error('expected PortProbeError');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PortProbeError);
    expect(err).toMatchObject({
      code: 'EPERM',
      host: PORT_PROBE_HOST,
      port: 6100,
      operation: 'listen',
    });
    expect(String(err)).toMatch(/EPERM/);
    expect(String(err)).toMatch(/6100/);
    expect(String(err)).toMatch(/listen/);
    // Must not scan the rest of the range as if ports were merely busy.
    expect(probed).toEqual([6100]);
    expect(err).not.toBeInstanceOf(PortExhaustedError);
    expect(String(err)).not.toMatch(/no free port|OS-busy/);
  });

  it('injected EACCES fails immediately and never reports pool exhaustion', async () => {
    const pool = new PortAllocator(6200, 4, (p) => {
      throw new PortProbeError({
        code: 'EACCES',
        host: PORT_PROBE_HOST,
        port: p,
        operation: 'listen',
      });
    });
    await expect(pool.acquire()).rejects.toMatchObject({
      name: 'PortProbeError',
      code: 'EACCES',
      host: PORT_PROBE_HOST,
      port: 6200,
      operation: 'listen',
    });
    await expect(pool.acquire()).rejects.not.toBeInstanceOf(PortExhaustedError);
  });

  it('busy then permission: skips EADDRINUSE then surfaces PortProbeError (not exhaustion)', async () => {
    const probed: number[] = [];
    const pool = new PortAllocator(6300, 4, (p) => {
      probed.push(p);
      if (p === 6300) return false; // EADDRINUSE → busy
      throw new PortProbeError({
        code: 'EPERM',
        host: PORT_PROBE_HOST,
        port: p,
        operation: 'listen',
      });
    });
    const err = await pool.acquire().then(
      () => {
        throw new Error('expected PortProbeError');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PortProbeError);
    expect(err).toMatchObject({ code: 'EPERM', port: 6301 });
    expect(probed).toEqual([6300, 6301]);
    expect(String(err)).not.toMatch(/no free port|OS-busy/);
  });
});

describe('classifyPortProbeFailure', () => {
  const ctx = { host: PORT_PROBE_HOST, port: 4100, operation: 'listen' as const };

  it('maps EADDRINUSE to busy so allocation may continue', () => {
    expect(classifyPortProbeFailure({ code: 'EADDRINUSE' }, ctx)).toBe('busy');
  });

  it('throws PortProbeError for EPERM with host, port, operation, code', () => {
    try {
      classifyPortProbeFailure({ code: 'EPERM' }, ctx);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PortProbeError);
      expect(err).toMatchObject({
        code: 'EPERM',
        host: PORT_PROBE_HOST,
        port: 4100,
        operation: 'listen',
      });
      expect((err as Error).message).toMatch(/EPERM/);
      expect((err as Error).message).toMatch(/4100/);
      expect((err as Error).message).toMatch(/listen/);
    }
  });

  it('throws PortProbeError for EACCES', () => {
    expect(() => classifyPortProbeFailure({ code: 'EACCES' }, ctx)).toThrow(PortProbeError);
    try {
      classifyPortProbeFailure({ code: 'EACCES' }, ctx);
    } catch (err) {
      expect(err).toMatchObject({ code: 'EACCES', port: 4100, operation: 'listen' });
    }
  });

  it('throws PortProbeError for unexpected bind/listen codes (not silent busy)', () => {
    expect(() => classifyPortProbeFailure({ code: 'EINVAL' }, ctx)).toThrow(PortProbeError);
    try {
      classifyPortProbeFailure({ code: 'EADDRNOTAVAIL' }, ctx);
    } catch (err) {
      expect(err).toBeInstanceOf(PortProbeError);
      expect(err).toMatchObject({ code: 'EADDRNOTAVAIL' });
      expect((err as Error).message).not.toMatch(/OS-busy|no free port/);
    }
  });

  it('uses UNKNOWN when errno code is missing', () => {
    try {
      classifyPortProbeFailure({}, ctx);
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toMatchObject({ code: 'UNKNOWN' });
    }
  });

  it('PortProbeError text retains code so provision timelines match hard-infra (not exhaustion)', () => {
    const eperm = new PortProbeError({
      code: 'EPERM',
      host: PORT_PROBE_HOST,
      port: 4100,
      operation: 'listen',
    });
    const eacces = new PortProbeError({
      code: 'EACCES',
      host: PORT_PROBE_HOST,
      port: 4101,
      operation: 'listen',
    });
    expect(isHardInfraError(eperm.message)).toBe(true);
    expect(isHardInfraError(eacces.message)).toBe(true);
    // Genuine exhaustion must not look like permission denial.
    expect(
      isHardInfraError('no free port in [4100, 4120) (pool empty or OS-busy)'),
    ).toBe(false);
  });
});

describe('isPortBindable', () => {
  it('real bind: free/busy when allowed, or explicit permission diagnostic when denied', async () => {
    // Ephemeral holder: if the sandbox forbids bind entirely, listen(0) fails
    // and we assert the probe surfaces PortProbeError — never a vague false/busy.
    const holder = createServer();
    let freePort: number;
    try {
      freePort = await new Promise<number>((resolve, reject) => {
        holder.once('error', reject);
        holder.listen(0, PORT_PROBE_HOST, () => {
          const addr = holder.address();
          if (typeof addr === 'object' && addr !== null) resolve(addr.port);
          else reject(new Error('no port'));
        });
      });
    } catch (setupErr) {
      holder.close();
      const code = (setupErr as NodeJS.ErrnoException).code;
      // Denied sandbox: probe must throw PortProbeError, not report busy/false.
      await expect(isPortBindable(9)).rejects.toBeInstanceOf(PortProbeError);
      const err = await isPortBindable(9).then(
        () => {
          throw new Error('expected PortProbeError in denied sandbox');
        },
        (e: unknown) => e as PortProbeError,
      );
      expect(err).toMatchObject({
        host: PORT_PROBE_HOST,
        port: 9,
        operation: 'listen',
      });
      expect(err.code === 'EPERM' || err.code === 'EACCES' || err.code === code).toBe(true);
      expect(err.message).not.toMatch(/no free port|OS-busy/);
      return;
    }

    try {
      // Port held → busy (false), not permission denial.
      expect(await isPortBindable(freePort)).toBe(false);

      await new Promise<void>((resolve, reject) => {
        holder.close((err) => (err ? reject(err) : resolve()));
      });

      // Released → free (true).
      expect(await isPortBindable(freePort)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => {
        holder.close(() => resolve());
      });
    }
  });
});
