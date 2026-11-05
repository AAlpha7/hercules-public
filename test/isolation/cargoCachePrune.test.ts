/**
 * Cargo cache prune FS layer: path guard dry-run + real temp-dir prune.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, utimes, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CargoCachePruneError,
  pruneCargoCacheTarget,
} from '../../src/isolation/cargoCachePrune.js';

const DAY_S = 86_400;

async function touchFile(
  path: string,
  sizeBytes: number,
  mtimeSec: number,
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  const buf = Buffer.alloc(Math.min(sizeBytes, 64 * 1024), 1);
  // For large sizes we don't need full content on disk — write sparse-ish via truncate after small write.
  await writeFile(path, buf);
  const fh = await import('node:fs/promises').then((m) => m.open(path, 'r+'));
  try {
    await fh.truncate(sizeBytes);
  } finally {
    await fh.close();
  }
  await utimes(path, mtimeSec, mtimeSec);
}

describe('pruneCargoCacheTarget path guard', () => {
  it('rejects illegal paths without deleting anything (dry-run and apply)', async () => {
    await expect(
      pruneCargoCacheTarget('/tmp/not-a-cargo-cache', { dryRun: true }),
    ).rejects.toThrow(CargoCachePruneError);
    await expect(
      pruneCargoCacheTarget('/home/ubuntu/hercules-control', { dryRun: false }),
    ).rejects.toThrow(/cargo output|target|\.shared-target/i);
    await expect(pruneCargoCacheTarget('relative/target', { dryRun: true })).rejects.toThrow(
      CargoCachePruneError,
    );
  });
});

describe('pruneCargoCacheTarget apply', () => {
  let root: string;
  let target: string;
  const nowMs = Date.parse('2026-07-28T12:00:00.000Z');
  const nowSec = Math.floor(nowMs / 1000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hercules-cargo-prune-'));
    // Segment `.shared-target` makes the path safe.
    target = join(root, '.shared-target');
    await mkdir(join(target, 'debug', 'incremental', 'crate'), { recursive: true });
    await mkdir(join(target, 'debug', 'deps'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('wipes debug/incremental and old large debug/deps; keeps recent/small', async () => {
    // Small threshold so tests never write 100MB files.
    const largeMin = 2048;
    const inc = join(target, 'debug', 'incremental', 'crate', 'x.o');
    // Stale mtime (>120s) so live-build safety does not skip the wipe.
    const staleSec = nowSec - 600;
    await touchFile(inc, 1024, staleSec);
    await utimes(join(target, 'debug', 'incremental', 'crate'), staleSec, staleSec);

    const oldLarge = join(target, 'debug', 'deps', 'old_bin');
    const newLarge = join(target, 'debug', 'deps', 'new_bin');
    const oldSmall = join(target, 'debug', 'deps', 'old_small');
    await touchFile(oldLarge, largeMin + 100, nowSec - 3 * DAY_S);
    await touchFile(newLarge, largeMin + 100, nowSec - Math.floor(0.5 * DAY_S));
    await touchFile(oldSmall, 100, nowSec - 10 * DAY_S);

    const result = await pruneCargoCacheTarget(target, {
      dryRun: false,
      nowMs,
      retainDays: 2,
      largeFileBytes: largeMin,
      trigger: 'verify-teardown',
    });

    expect(result.rejected).toBe(false);
    expect(result.incrementalDeleted).toBeGreaterThanOrEqual(1);
    expect(result.depsDeleted).toBe(1);
    expect(result.freedBytes).toBeGreaterThan(largeMin);
    expect(result.logLine).toContain('cargo-cache-prune');
    expect(result.logLine).toContain('verify-teardown');

    // incremental gone
    await expect(stat(inc)).rejects.toThrow();
    // old large gone, recent large + old small remain
    await expect(stat(oldLarge)).rejects.toThrow();
    await expect(stat(newLarge)).resolves.toBeTruthy();
    await expect(stat(oldSmall)).resolves.toBeTruthy();
  });

  it('dry-run plans deletes without removing files', async () => {
    const inc = join(target, 'debug', 'incremental', 'a');
    const staleSec = nowSec - 600;
    await touchFile(inc, 2048, staleSec);
    // Age the beforeEach crate dir so live-build mtime probe stays silent.
    await utimes(join(target, 'debug', 'incremental', 'crate'), staleSec, staleSec);
    const result = await pruneCargoCacheTarget(target, {
      dryRun: true,
      nowMs,
      trigger: 'disk-pressure',
    });
    expect(result.dryRun).toBe(true);
    expect(result.incrementalDeleted).toBeGreaterThanOrEqual(1);
    await expect(stat(inc)).resolves.toBeTruthy();
    expect(result.logLine).toContain('dry-run');
  });

  it('no-op when target dir missing (safe, not an error)', async () => {
    // Path is safe (`.shared-target` segment) but directory was never created.
    const missing = join(root, 'never-created', '.shared-target');
    const result = await pruneCargoCacheTarget(missing, { dryRun: false, nowMs });
    expect(result.incrementalDeleted).toBe(0);
    expect(result.depsDeleted).toBe(0);
    expect(result.freedBytes).toBe(0);
  });

  it('accepts a plain target/ segment under temp root', async () => {
    const t = join(root, 'crate', 'target');
    await mkdir(join(t, 'debug', 'incremental'), { recursive: true });
    const staleSec = nowSec - 600;
    await touchFile(join(t, 'debug', 'incremental', 'z'), 100, staleSec);
    const result = await pruneCargoCacheTarget(t, { dryRun: false, nowMs });
    expect(result.incrementalDeleted).toBeGreaterThanOrEqual(1);
    const left = await readdir(join(t, 'debug', 'incremental')).catch(() => []);
    expect(left.length).toBe(0);
  });
});

describe('pruneCargoCacheTarget live-build safety', () => {
  let root: string;
  let target: string;
  /** Fixed "now" for deterministic age windows. */
  const nowMs = Date.parse('2026-07-31T12:00:00.000Z');
  const nowSec = Math.floor(nowMs / 1000);
  const windowSec = 120;
  const logs: string[] = [];

  beforeEach(async () => {
    logs.length = 0;
    root = await mkdtemp(join(tmpdir(), 'hercules-cargo-live-'));
    target = join(root, '.shared-target');
    await mkdir(join(target, 'debug', 'incremental', 'crate'), { recursive: true });
    await mkdir(join(target, 'debug', 'deps'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('active (fresh incremental mtime): skips incremental wipe, still prunes stale deps', async () => {
    const largeMin = 2048;
    const inc = join(target, 'debug', 'incremental', 'crate', 'dep-graph.bin');
    // Touched "now" — inside the 120s active window.
    await touchFile(inc, 512, nowSec);

    const oldLarge = join(target, 'debug', 'deps', 'old_bin');
    await touchFile(oldLarge, largeMin + 100, nowSec - 3 * DAY_S);

    const result = await pruneCargoCacheTarget(target, {
      dryRun: false,
      nowMs,
      retainDays: 2,
      largeFileBytes: largeMin,
      trigger: 'verify-teardown',
      activeBuildWindowMs: windowSec * 1000,
      log: (line) => logs.push(line),
    });

    expect(result.incrementalDeleted).toBe(0);
    expect(result.depsDeleted).toBe(1);
    await expect(stat(inc)).resolves.toBeTruthy();
    await expect(stat(oldLarge)).rejects.toThrow();

    const skipLine = logs.find((l) => l.includes('skipped:') && l.includes('检测到活动构建'));
    expect(skipLine).toBeDefined();
    expect(skipLine).toMatch(/^\[hercules\] cargo-cache-prune skipped:/);
    expect(skipLine).toContain('reason=incremental-mtime');
  });

  it('silent (stale incremental mtime): wipes incremental as before', async () => {
    const inc = join(target, 'debug', 'incremental', 'crate', 'dep-graph.bin');
    // Older than the 120s window → not an active build (file + crate dir).
    const staleSec = nowSec - windowSec - 5;
    await touchFile(inc, 512, staleSec);
    await utimes(join(target, 'debug', 'incremental', 'crate'), staleSec, staleSec);

    const result = await pruneCargoCacheTarget(target, {
      dryRun: false,
      nowMs,
      trigger: 'verify-teardown',
      activeBuildWindowMs: windowSec * 1000,
      log: (line) => logs.push(line),
    });

    expect(result.incrementalDeleted).toBeGreaterThanOrEqual(1);
    await expect(stat(inc)).rejects.toThrow();
    expect(logs.some((l) => l.includes('检测到活动构建'))).toBe(false);
  });

  it('force: wipes incremental despite fresh mtime and logs a force warning', async () => {
    const inc = join(target, 'debug', 'incremental', 'crate', 'dep-graph.bin');
    await touchFile(inc, 512, nowSec);

    const result = await pruneCargoCacheTarget(target, {
      dryRun: false,
      nowMs,
      force: true,
      trigger: 'disk-pressure',
      activeBuildWindowMs: windowSec * 1000,
      log: (line) => logs.push(line),
    });

    expect(result.incrementalDeleted).toBeGreaterThanOrEqual(1);
    await expect(stat(inc)).rejects.toThrow();

    const forceLine = logs.find((l) => l.includes('force:') && l.includes('检测到活动构建'));
    expect(forceLine).toBeDefined();
    expect(forceLine).toMatch(/^\[hercules\] cargo-cache-prune force:/);
    expect(logs.some((l) => l.includes('skipped:') && l.includes('检测到活动构建'))).toBe(
      false,
    );
  });

  it('active via held .cargo-lock flock: skips incremental even when mtimes are stale', async () => {
    const staleSec = nowSec - windowSec - 30;
    const inc = join(target, 'debug', 'incremental', 'crate', 'dep-graph.bin');
    await touchFile(inc, 512, staleSec);
    await utimes(join(target, 'debug', 'incremental', 'crate'), staleSec, staleSec);

    const lockPath = join(target, '.cargo-lock');
    await writeFile(lockPath, '');
    // Hold exclusive flock in a child (cargo's real lock pattern).
    const holder: ChildProcess = spawn(
      'flock',
      ['-x', lockPath, '-c', 'sleep 30'],
      { stdio: 'ignore' },
    );
    try {
      // Give flock a moment to acquire.
      await new Promise((r) => setTimeout(r, 150));
      const result = await pruneCargoCacheTarget(target, {
        dryRun: false,
        nowMs,
        trigger: 'verify-teardown',
        activeBuildWindowMs: windowSec * 1000,
        log: (line) => logs.push(line),
      });
      expect(result.incrementalDeleted).toBe(0);
      await expect(stat(inc)).resolves.toBeTruthy();
      const skipLine = logs.find((l) => l.includes('skipped:') && l.includes('检测到活动构建'));
      expect(skipLine).toBeDefined();
      expect(skipLine).toContain('reason=cargo-lock');
    } finally {
      holder.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        holder.once('exit', () => resolve());
        setTimeout(resolve, 500);
      });
    }
  });

  it('pressure escalation + active build: skips entire second pass (deps too)', async () => {
    const largeMin = 2048;
    const inc = join(target, 'debug', 'incremental', 'crate', 'dep-graph.bin');
    await touchFile(inc, 512, nowSec); // fresh → active

    // Fresh large dep — would be deleted under retainDays=0 if pass ran
    const freshLarge = join(target, 'debug', 'deps', 'fresh_bin');
    await touchFile(freshLarge, largeMin + 100, nowSec);

    const result = await pruneCargoCacheTarget(target, {
      dryRun: false,
      nowMs,
      retainDays: 0,
      largeFileBytes: largeMin,
      trigger: 'disk-pressure',
      pressureEscalation: true,
      activeBuildWindowMs: windowSec * 1000,
      log: (line) => logs.push(line),
    });

    expect(result.incrementalDeleted).toBe(0);
    expect(result.depsDeleted).toBe(0);
    await expect(stat(inc)).resolves.toBeTruthy();
    await expect(stat(freshLarge)).resolves.toBeTruthy();
    const skipLine = logs.find((l) => l.includes('skipped:') && l.includes('检测到活动构建'));
    expect(skipLine).toBeDefined();
  });

  it('pressure escalation + silent: retainDays=0 deletes same-day large deps', async () => {
    const largeMin = 2048;
    const staleSec = nowSec - windowSec - 30;
    const inc = join(target, 'debug', 'incremental', 'crate', 'dep-graph.bin');
    await touchFile(inc, 512, staleSec);
    await utimes(join(target, 'debug', 'incremental', 'crate'), staleSec, staleSec);

    const freshLarge = join(target, 'debug', 'deps', 'fresh_bin');
    await touchFile(freshLarge, largeMin + 100, nowSec); // same day

    const result = await pruneCargoCacheTarget(target, {
      dryRun: false,
      nowMs,
      retainDays: 0,
      largeFileBytes: largeMin,
      trigger: 'disk-pressure',
      pressureEscalation: true,
      keepGenerations: 0,
      activeBuildWindowMs: windowSec * 1000,
      log: (line) => logs.push(line),
    });

    expect(result.depsDeleted).toBe(1);
    await expect(stat(freshLarge)).rejects.toThrow();
    expect(logs.some((l) => l.includes('检测到活动构建'))).toBe(false);
  });
});
