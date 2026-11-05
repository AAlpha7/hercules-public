/**
 * Cargo cache auto-prune policy (pure): path guard, mtime window, incremental wipe.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACTIVE_BUILD_WINDOW_MS,
  DEFAULT_CARGO_CACHE_RETAIN_DAYS,
  DEFAULT_CARGO_DEPS_KEEP_GENERATIONS,
  DEFAULT_CARGO_LARGE_FILE_BYTES,
  formatCargoCachePruneEscalationLogLine,
  formatCargoCachePruneForceActiveBuildLogLine,
  formatCargoCachePruneLogLine,
  formatCargoCachePruneSkipActiveBuildLogLine,
  formatCargoCachePruneSkipNoDirsLogLine,
  formatCargoPruneBannerNote,
  hasRecentIncrementalActivity,
  isSafeCargoTargetPath,
  planCargoCachePrune,
  resolveCargoTargetDirs,
  shouldRunPressureEscalationPass,
  type CargoCacheFileMeta,
} from '../../src/domain/cargoCachePrune.js';

const DAY = 86_400_000;
const MB = 1024 ** 2;
const GB = 1024 ** 3;

describe('isSafeCargoTargetPath', () => {
  it('accepts absolute paths with a .shared-target or target segment', () => {
    expect(isSafeCargoTargetPath('/home/ubuntu/acme/.shared-target')).toBe(true);
    expect(isSafeCargoTargetPath('/home/u/proj/target')).toBe(true);
    expect(isSafeCargoTargetPath('/home/u/proj/target/debug')).toBe(true);
    expect(isSafeCargoTargetPath('/var/cache/.shared-target/debug')).toBe(true);
  });

  it('rejects paths without cargo output segments (source, control, worktree)', () => {
    expect(isSafeCargoTargetPath('/home/ubuntu/acme/src')).toBe(false);
    expect(isSafeCargoTargetPath('/home/ubuntu/hercules-control')).toBe(false);
    expect(isSafeCargoTargetPath('/home/u/work/repo/task-id')).toBe(false);
    expect(isSafeCargoTargetPath('/srv/production/app')).toBe(false);
    expect(isSafeCargoTargetPath('/tmp/not-cargo')).toBe(false);
  });

  it('rejects relative, empty, and traversal-looking roots', () => {
    expect(isSafeCargoTargetPath('')).toBe(false);
    expect(isSafeCargoTargetPath('   ')).toBe(false);
    expect(isSafeCargoTargetPath('target')).toBe(false);
    expect(isSafeCargoTargetPath('./target')).toBe(false);
    expect(isSafeCargoTargetPath('../.shared-target')).toBe(false);
    expect(isSafeCargoTargetPath('/home/u/my-target-dir')).toBe(false); // not a segment
  });
});

describe('planCargoCachePrune', () => {
  const now = Date.parse('2026-07-28T12:00:00.000Z');
  const retainDays = DEFAULT_CARGO_CACHE_RETAIN_DAYS; // 2

  function meta(
    relPath: string,
    sizeBytes: number,
    ageDays: number,
  ): CargoCacheFileMeta {
    return {
      relPath,
      sizeBytes,
      mtimeMs: now - ageDays * DAY,
    };
  }

  it('selects all debug/incremental/* for deletion (fully regenerative)', () => {
    const plan = planCargoCachePrune(
      [
        meta('debug/incremental/foo/bar', 10 * MB, 0),
        meta('debug/incremental/fresh', 1 * MB, 0),
        meta('debug/deps/keep_recent_small', 10 * MB, 0),
      ],
      { nowMs: now, retainDays },
    );
    expect(plan.incremental).toEqual([
      'debug/incremental/foo/bar',
      'debug/incremental/fresh',
    ]);
    expect(plan.deps).toEqual([]);
  });

  it('keeps recent large deps; deletes old large deps only', () => {
    const plan = planCargoCachePrune(
      [
        meta('debug/deps/new_test_bin', 1.5 * GB, 0.5), // half day ago — keep
        meta('debug/deps/old_test_bin', 1.2 * GB, 3), // 3 days — delete
        meta('debug/deps/old_small', 50 * MB, 10), // old but small — keep
        meta('debug/deps/borderline', DEFAULT_CARGO_LARGE_FILE_BYTES + 1, 2.1),
      ],
      { nowMs: now, retainDays },
    );
    expect(plan.deps).toEqual([
      'debug/deps/old_test_bin',
      'debug/deps/borderline',
    ]);
    expect(plan.incremental).toEqual([]);
  });

  it('respects custom retainDays window', () => {
    const plan = planCargoCachePrune(
      [meta('debug/deps/mid', 200 * MB, 1.5)],
      { nowMs: now, retainDays: 1, keepGenerations: 0 },
    );
    expect(plan.deps).toEqual(['debug/deps/mid']);
    const keep = planCargoCachePrune(
      [meta('debug/deps/mid', 200 * MB, 1.5)],
      { nowMs: now, retainDays: 2, keepGenerations: 0 },
    );
    expect(keep.deps).toEqual([]);
  });

  it('retainDays=0 drops age filter (all large deps eligible — pressure escalation)', () => {
    const plan = planCargoCachePrune(
      [
        meta('debug/deps/fresh_bin', 1.2 * GB, 0), // same-day build
        meta('debug/deps/hour_old', 1.2 * GB, 0.05),
        meta('debug/deps/small_fresh', 10 * MB, 0), // still size-gated
      ],
      { nowMs: now, retainDays: 0, keepGenerations: 0 },
    );
    expect(plan.deps).toEqual(['debug/deps/fresh_bin', 'debug/deps/hour_old']);
  });

  it('keeps only latest N hash generations of same-named large deps (default N=2)', () => {
    // Same crate stem, three hash generations — all within retain window.
    const files: CargoCacheFileMeta[] = [
      {
        relPath: 'debug/deps/libfoo-aaaaaaaaaaaaaaaa.rlib',
        sizeBytes: 200 * MB,
        mtimeMs: now - 0.1 * DAY, // newest
      },
      {
        relPath: 'debug/deps/libfoo-bbbbbbbbbbbbbbbb.rlib',
        sizeBytes: 200 * MB,
        mtimeMs: now - 0.5 * DAY,
      },
      {
        relPath: 'debug/deps/libfoo-cccccccccccccccc.rlib',
        sizeBytes: 200 * MB,
        mtimeMs: now - 1.0 * DAY, // oldest of 3 → drop
      },
      {
        relPath: 'debug/deps/libbar-dddddddddddddddd.rlib',
        sizeBytes: 200 * MB,
        mtimeMs: now - 0.2 * DAY, // only one gen — keep
      },
    ];
    const plan = planCargoCachePrune(files, {
      nowMs: now,
      retainDays: 2,
      keepGenerations: DEFAULT_CARGO_DEPS_KEEP_GENERATIONS,
    });
    expect(plan.deps).toEqual(['debug/deps/libfoo-cccccccccccccccc.rlib']);
  });

  it('ignores non-debug cargo paths (never touch source-shaped trees)', () => {
    const plan = planCargoCachePrune(
      [
        meta('release/deps/big', 2 * GB, 10),
        meta('src/main.rs', 1 * GB, 10),
        meta('debug/build/foo', 2 * GB, 10),
      ],
      { nowMs: now, retainDays },
    );
    expect(plan.incremental).toEqual([]);
    expect(plan.deps).toEqual([]);
  });
});

/**
 * Pressure-escalation second pass (2026-07-31 high-frequency build blowout):
 * fixed retain window freed=0 while still critical → escalate retainDays=0.
 */
describe('shouldRunPressureEscalationPass', () => {
  it('freed=0 and still critical → escalate', () => {
    // freed bytes are not part of the gate — residual critical is.
    expect(
      shouldRunPressureEscalationPass({
        stillCritical: true,
        activeBuild: false,
        force: false,
      }),
    ).toBe(true);
  });

  it('after escalation below critical line → stop (no further pass)', () => {
    expect(
      shouldRunPressureEscalationPass({
        stillCritical: false,
        activeBuild: false,
        force: false,
      }),
    ).toBe(false);
  });

  it('active build → skip escalation unless force', () => {
    expect(
      shouldRunPressureEscalationPass({
        stillCritical: true,
        activeBuild: true,
        force: false,
      }),
    ).toBe(false);
    expect(
      shouldRunPressureEscalationPass({
        stillCritical: true,
        activeBuild: true,
        force: true,
      }),
    ).toBe(true);
  });
});

describe('formatCargoCachePruneEscalationLogLine', () => {
  it('names the pressure-upgrade second pass in Chinese', () => {
    const line = formatCargoCachePruneEscalationLogLine({
      trigger: 'disk-pressure',
      retainDays: 0,
    });
    expect(line).toMatch(/^\[hercules\] cargo-cache-prune /);
    expect(line).toContain('压力升级第二遍');
    expect(line).toContain('trigger=disk-pressure');
    expect(line).toContain('retainDays=0');
    expect(line).not.toContain('\n');
  });
});

describe('hasRecentIncrementalActivity', () => {
  const now = Date.parse('2026-07-31T12:00:00.000Z');
  const windowMs = DEFAULT_ACTIVE_BUILD_WINDOW_MS; // 120s

  it('detects incremental file touched within the active window', () => {
    expect(
      hasRecentIncrementalActivity(
        [
          {
            relPath: 'debug/incremental/crate/dep-graph.bin',
            sizeBytes: 100,
            mtimeMs: now - 30_000, // 30s ago
          },
        ],
        { nowMs: now, windowMs },
      ),
    ).toBe(true);
  });

  it('silent when incremental mtimes are older than the window', () => {
    expect(
      hasRecentIncrementalActivity(
        [
          {
            relPath: 'debug/incremental/crate/dep-graph.bin',
            sizeBytes: 100,
            mtimeMs: now - windowMs - 1,
          },
          {
            relPath: 'debug/deps/old_bin',
            sizeBytes: 200 * MB,
            mtimeMs: now, // deps mtime does not count as incremental activity
          },
        ],
        { nowMs: now, windowMs },
      ),
    ).toBe(false);
  });

  it('ignores non-incremental paths', () => {
    expect(
      hasRecentIncrementalActivity(
        [{ relPath: 'debug/deps/fresh', sizeBytes: 1, mtimeMs: now }],
        { nowMs: now, windowMs },
      ),
    ).toBe(false);
  });
});

describe('formatCargoCachePruneLogLine / banner note', () => {
  it('one-line log: categories, freed, duration', () => {
    const line = formatCargoCachePruneLogLine({
      trigger: 'verify-teardown',
      targetDir: '/home/u/proj/.shared-target',
      incrementalDeleted: 12,
      depsDeleted: 3,
      freedBytes: 5.2 * GB,
      durationMs: 420,
      dryRun: false,
    });
    expect(line).toMatch(/\[hercules\] cargo-cache-prune/);
    expect(line).toContain('verify-teardown');
    expect(line).toContain('incremental=12');
    expect(line).toContain('deps=3');
    expect(line).toMatch(/freed=5\.2G/);
    expect(line).toContain('420ms');
    expect(line).not.toContain('\n');
  });

  it('banner note matches phone copy', () => {
    expect(formatCargoPruneBannerNote(5.2 * GB)).toBe('已自动修剪, 释放 5.2G');
  });

  it('skip-no-dirs tip is one operator line (empty config under pressure)', () => {
    const line = formatCargoCachePruneSkipNoDirsLogLine();
    expect(line).toMatch(/^\[hercules\] cargo-cache-prune skipped:/);
    expect(line).toContain('no cargo_target_dir configured');
    expect(line).toContain('repos.yaml cargo_target_dir');
    expect(line).toContain('HERCULES_CARGO_TARGET_DIRS');
    expect(line).not.toContain('\n');
  });

  it('skip-active-build line matches prune style (跳过: 检测到活动构建)', () => {
    const line = formatCargoCachePruneSkipActiveBuildLogLine({
      trigger: 'verify-teardown',
      targetDir: '/home/u/proj/.shared-target',
      reason: 'incremental-mtime',
    });
    expect(line).toMatch(/^\[hercules\] cargo-cache-prune skipped:/);
    expect(line).toContain('检测到活动构建');
    expect(line).toContain('verify-teardown');
    expect(line).toContain('dir=/home/u/proj/.shared-target');
    expect(line).toContain('reason=incremental-mtime');
    expect(line).not.toContain('\n');
  });

  it('force-active-build warn line matches prune style', () => {
    const line = formatCargoCachePruneForceActiveBuildLogLine({
      trigger: 'disk-pressure',
      targetDir: '/tmp/.shared-target',
      reason: 'cargo-lock',
    });
    expect(line).toMatch(/^\[hercules\] cargo-cache-prune force:/);
    expect(line).toContain('检测到活动构建');
    expect(line).toContain('disk-pressure');
    expect(line).toContain('reason=cargo-lock');
    expect(line).not.toContain('\n');
  });
});

describe('resolveCargoTargetDirs', () => {
  it('merges env + repo paths, dedupes, drops empties', () => {
    expect(
      resolveCargoTargetDirs({
        envValue: '/a/.shared-target,/b/target',
        repoPaths: ['/b/target', '/c/target', null, ''],
      }),
    ).toEqual(['/a/.shared-target', '/b/target', '/c/target']);
  });

  it('returns empty when nothing configured (no hard-coded orbit path)', () => {
    expect(resolveCargoTargetDirs({ envValue: undefined, repoPaths: [] })).toEqual([]);
  });
});
