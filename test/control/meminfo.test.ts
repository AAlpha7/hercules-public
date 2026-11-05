import { describe, it, expect } from 'vitest';
import { parseMemAvailableBytes, readMemAvailableBytes } from '../../src/control/meminfo.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SAMPLE = `MemTotal:       12288000 kB
MemFree:          200000 kB
MemAvailable:    3145728 kB
Buffers:          100000 kB
Cached:          2000000 kB
`;

describe('parseMemAvailableBytes', () => {
  it('parses Linux /proc/meminfo MemAvailable into bytes', () => {
    // 3145728 kB * 1024 = 3 GiB
    expect(parseMemAvailableBytes(SAMPLE)).toBe(3145728 * 1024);
  });

  it('returns null when MemAvailable is missing', () => {
    expect(parseMemAvailableBytes('MemTotal: 1000 kB\n')).toBeNull();
  });

  it('returns null on empty / garbage input', () => {
    expect(parseMemAvailableBytes('')).toBeNull();
    expect(parseMemAvailableBytes('not meminfo')).toBeNull();
  });
});

describe('readMemAvailableBytes (injected path)', () => {
  it('reads MemAvailable from a file path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hercules-meminfo-'));
    const path = join(dir, 'meminfo');
    await writeFile(path, SAMPLE, 'utf8');
    expect(await readMemAvailableBytes(path)).toBe(3145728 * 1024);
  });

  it('returns null when the file is missing (non-Linux)', async () => {
    expect(await readMemAvailableBytes('/no/such/meminfo')).toBeNull();
  });
});
