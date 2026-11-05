import { describe, it, expect } from 'vitest';
import {
  hasProcessDescendants,
  hasManagedProcessForTask,
  isOsProcessGroupIdentityAlive,
  isOsProcessAlive,
  jiffiesFromProcStat,
  sampleProcessTreeStats,
} from '../../src/adapters/processTree.js';

describe('hasManagedProcessForTask', () => {
  const enoent = (): never => {
    const err = new Error('missing') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    throw err;
  };

  it('finds the inherited task marker even after the worktree path is gone', () => {
    expect(hasManagedProcessForTask('/gone/task', 'T1', {
      platform: 'linux',
      getUid: () => 1000,
      readProcEntries: () => ['42'],
      realpath: enoent,
      readProcFile: (path) =>
        path.endsWith('/status')
          ? 'Name:\tagent\nUid:\t1000\t1000\t1000\t1000\n'
          : 'PATH=/bin\0HERCULES_TASK_ID=T1\0',
    })).toBe(true);
  });

  it('proves no owner when the missing path has no same-uid task marker', () => {
    expect(hasManagedProcessForTask('/gone/task', 'T1', {
      platform: 'linux',
      getUid: () => 1000,
      readProcEntries: () => ['42'],
      realpath: enoent,
      readProcFile: (path) =>
        path.endsWith('/status')
          ? 'Name:\tother\nUid:\t1000\t1000\t1000\t1000\n'
          : 'PATH=/bin\0HERCULES_TASK_ID=T10\0',
    })).toBe(false);
  });

  it('uses canonical path boundaries and stays uncertain on incomplete reads', () => {
    const probes = {
      platform: 'linux',
      getUid: () => 1000,
      readProcEntries: () => ['42'],
      realpath: (path: string) => path === '/work/T1' ? '/real/T1' : '/real/T10',
      readProcFile: (path: string) => {
        if (path.endsWith('/status')) return 'Uid:\t1000\t1000\t1000\t1000\n';
        const err = new Error('denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    };
    expect(hasManagedProcessForTask('/work/T1', 'T1', probes)).toBeNull();
  });
});

describe('jiffiesFromProcStat', () => {
  // pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt
  // cmajflt utime stime cutime cstime ... rss is field 24 (1-based, incl pid/comm).
  const statLine = (f: {
    utime: number;
    stime: number;
    cutime: number;
    cstime: number;
    rssPages: number;
  }): string =>
    `123 (cargo check) S 1 1 1 0 -1 4194304 100 0 0 0 ${f.utime} ${f.stime} ${f.cutime} ${f.cstime} 20 0 1 0 1000 999424 ${f.rssPages} 18446744073709551615`;

  it('sums own AND reaped-children CPU time (cutime/cstime)', () => {
    // Cargo reaps each short-lived rustc: its time lands in cutime/cstime.
    // Counting only utime+stime made compile churn read as CPU 0%.
    const s = jiffiesFromProcStat(statLine({ utime: 10, stime: 5, cutime: 4000, cstime: 300, rssPages: 100 }));
    expect(s).not.toBeNull();
    expect(s!.jiffies).toBe(10 + 5 + 4000 + 300);
    expect(s!.rssPages).toBe(100);
  });

  it('handles comm containing spaces and parens', () => {
    const raw = `9 (a (weird) name) R 1 1 1 0 -1 0 0 0 0 0 7 3 2 1 20 0 1 0 0 0 55 0`;
    const s = jiffiesFromProcStat(raw);
    expect(s!.jiffies).toBe(7 + 3 + 2 + 1);
    expect(s!.rssPages).toBe(55);
  });

  it('returns null on garbage', () => {
    expect(jiffiesFromProcStat('not a stat line')).toBeNull();
    expect(jiffiesFromProcStat('12 (x) S a b')).toBeNull();
  });
});

describe('isOsProcessGroupIdentityAlive', () => {
  const identity = { pid: 123, startTimeTicks: '456', bootId: 'boot-a' };

  it('keeps a live detached group held after its leader exits', () => {
    expect(isOsProcessGroupIdentityAlive(identity, {
      readBootId: () => 'boot-a',
      signalGroup: () => undefined,
      readIdentity: () => null,
    })).toBe(true);
  });

  it('only proves stale when the group is absent or the boot changed', () => {
    expect(isOsProcessGroupIdentityAlive(identity, {
      readBootId: () => 'boot-b',
    })).toBe(false);
    expect(isOsProcessGroupIdentityAlive(identity, {
      readBootId: () => 'boot-a',
      signalGroup: () => {
        const error = new Error('gone') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      },
    })).toBe(false);
  });

  it('treats a reused leader pid as unknown while the group id exists', () => {
    expect(isOsProcessGroupIdentityAlive(identity, {
      readBootId: () => 'boot-a',
      signalGroup: () => undefined,
      readIdentity: () => ({ ...identity, startTimeTicks: '999' }),
    })).toBeNull();
  });
});

describe('isOsProcessAlive', () => {
  it('reports this process as alive', () => {
    expect(isOsProcessAlive(process.pid)).toBe(true);
  });

  it('rejects invalid pids', () => {
    expect(isOsProcessAlive(0)).toBe(false);
    expect(isOsProcessAlive(-1)).toBe(false);
    expect(isOsProcessAlive(Number.NaN)).toBe(false);
  });

  it('returns false for a non-existent pid', () => {
    // High unused pid — Linux rejects with ESRCH.
    expect(isOsProcessAlive(2_147_483_646)).toBe(false);
  });
});

describe('hasProcessDescendants', () => {
  it('returns false for invalid root', () => {
    expect(hasProcessDescendants(0)).toBe(false);
    expect(hasProcessDescendants(-3)).toBe(false);
  });

  it('does not throw for this process (may or may not have children)', () => {
    expect(() => hasProcessDescendants(process.pid)).not.toThrow();
    expect(typeof hasProcessDescendants(process.pid)).toBe('boolean');
  });
});

describe('sampleProcessTreeStats', () => {
  it('reads cumulative jiffies and RSS for a live pid (self)', () => {
    const stats = sampleProcessTreeStats(process.pid);
    expect(stats).not.toBeNull();
    expect(stats!.jiffies).toBeGreaterThan(0);
    expect(stats!.rssBytes).toBeGreaterThan(1024 * 1024);
  });

  it('returns null for a dead pid', () => {
    expect(sampleProcessTreeStats(999999999)).toBeNull();
  });
});
