/**
 * Disk watermark (twice-filled-disk incident, 2026-07-22): warn at 85% used,
 * stop dispatching at 95%; unknown reads never block.
 * Dispatch-hold surface (2026-07-24): critical → hold with exact zh detail.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateDiskPressure,
  formatDiskDetail,
  formatFreeGiB,
  toDispatchHold,
  toDiskWarnDetail,
} from '../../src/domain/diskPressure.js';

const GB = 1024 ** 3;

describe('evaluateDiskPressure', () => {
  it('maps free/total to ok / warn / critical bands', () => {
    expect(evaluateDiskPressure(50 * GB, 100 * GB)!.level).toBe('ok');
    expect(evaluateDiskPressure(12 * GB, 100 * GB)!.level).toBe('warn'); // 88%
    expect(evaluateDiskPressure(3 * GB, 100 * GB)!.level).toBe('critical'); // 97%
    expect(evaluateDiskPressure(3 * GB, 100 * GB)!.usedPct).toBe(97);
  });

  it('returns null on unknown readings (never blocks on missing data)', () => {
    expect(evaluateDiskPressure(null, 100 * GB)).toBeNull();
    expect(evaluateDiskPressure(5 * GB, null)).toBeNull();
    expect(evaluateDiskPressure(5 * GB, 0)).toBeNull();
  });
});

describe('toDispatchHold (exact-reason surface)', () => {
  it('sets hold at critical with pct + free in detail', () => {
    const p = evaluateDiskPressure(4.7 * GB, 100 * GB)!; // 95%
    expect(p.level).toBe('critical');
    const hold = toDispatchHold(p);
    expect(hold).not.toBeNull();
    expect(hold!.reason).toBe('disk');
    expect(hold!.detail).toMatch(/95%/);
    expect(hold!.detail).toMatch(/4\.7G|5G/);
    expect(hold!.detail).toMatch(/自动恢复|清出空间/);
  });

  it('clears hold at ok and warn (warn is not a pause)', () => {
    expect(toDispatchHold(evaluateDiskPressure(50 * GB, 100 * GB))).toBeNull();
    expect(toDispatchHold(evaluateDiskPressure(12 * GB, 100 * GB))).toBeNull();
    expect(toDispatchHold(null)).toBeNull();
  });

  it('formatDiskDetail / free GiB are stable phone strings', () => {
    expect(formatFreeGiB(4.7 * GB)).toMatch(/4\.7G/);
    const crit = evaluateDiskPressure(2 * GB, 100 * GB)!;
    expect(formatDiskDetail(crit)).toContain(`${crit.usedPct}%`);
    expect(formatDiskDetail(crit)).toMatch(/剩/);
  });

  it('toDiskWarnDetail only at warn band', () => {
    expect(toDiskWarnDetail(evaluateDiskPressure(50 * GB, 100 * GB))).toBeNull();
    expect(toDiskWarnDetail(evaluateDiskPressure(3 * GB, 100 * GB))).toBeNull(); // critical → hold, not warn
    const warn = toDiskWarnDetail(evaluateDiskPressure(12 * GB, 100 * GB));
    expect(warn).toMatch(/88%/);
    expect(warn).toMatch(/磁盘/);
  });

  it('toDiskWarnDetail appends auto-prune note when provided', () => {
    const warn = toDiskWarnDetail(evaluateDiskPressure(12 * GB, 100 * GB), {
      pruneNote: '已自动修剪, 释放 5.2G',
    });
    expect(warn).toMatch(/88%/);
    expect(warn).toMatch(/已自动修剪, 释放 5\.2G/);
  });
});
