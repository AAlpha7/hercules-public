import { describe, it, expect } from 'vitest';
import {
  formatCompactMs,
  formatQuietProgressLine,
  cpuPctFromSamples,
  hintFromToolLabel,
  pickWorkerName,
  shouldShowQuietProgress,
  QUIET_PROGRESS_THRESHOLD_MS,
} from '../../src/domain/aliveHint.js';

describe('pickWorkerName', () => {
  it('prefers rustc over cargo over shell', () => {
    expect(pickWorkerName(['bash', 'cargo', 'rustc'])).toBe('rustc');
    expect(pickWorkerName(['sh', 'cargo'])).toBe('cargo');
  });

  it('matches pnpm / vitest / chrome', () => {
    expect(pickWorkerName(['node', 'pnpm'])).toBe('pnpm');
    expect(pickWorkerName(['vitest'])).toBe('vitest');
    expect(pickWorkerName(['headless_shell'])).toBe('headless_shell');
  });

  it('handles /proc-style truncated names via prefix', () => {
    // rustc truncated would still match via startsWith on known list
    expect(pickWorkerName(['clippy-driver'])).toBe('clippy-driver');
  });

  it('returns null for empty or agent-only trees', () => {
    expect(pickWorkerName([])).toBeNull();
    expect(pickWorkerName(['grok', 'bash'])).toBeNull();
  });
});

describe('formatQuietProgressLine', () => {
  it('includes silence, optional hint, run and hard kill', () => {
    const line = formatQuietProgressLine({
      silenceMs: 12 * 60_000,
      runMs: 45 * 60_000,
      maxRunMs: 2 * 60 * 60_000,
      aliveHint: 'cargo',
    });
    expect(line).toMatch(/Quiet 12m/);
    expect(line).toMatch(/\(cargo\)/);
    expect(line).toMatch(/run 45m/);
    expect(line).toMatch(/hard kill 2h/);
  });

  it('omits parens when no hint', () => {
    const line = formatQuietProgressLine({
      silenceMs: 45_000,
      runMs: 90_000,
      maxRunMs: 3_600_000,
      aliveHint: null,
    });
    expect(line).not.toMatch(/\(\)/);
    expect(line).toMatch(/process alive ·/);
  });
});

describe('shouldShowQuietProgress', () => {
  it('requires processAlive and threshold silence', () => {
    expect(shouldShowQuietProgress(QUIET_PROGRESS_THRESHOLD_MS, true)).toBe(true);
    expect(shouldShowQuietProgress(QUIET_PROGRESS_THRESHOLD_MS - 1, true)).toBe(false);
    expect(shouldShowQuietProgress(QUIET_PROGRESS_THRESHOLD_MS, false)).toBe(false);
  });
});

describe('formatCompactMs', () => {
  it('formats hours minutes seconds', () => {
    expect(formatCompactMs(45_000)).toBe('45s');
    expect(formatCompactMs(5 * 60_000)).toBe('5m');
    expect(formatCompactMs(2 * 3600_000 + 5 * 60_000)).toBe('2h 5m');
  });
});

describe('hintFromToolLabel', () => {
  it('extracts known workers from shell-like labels', () => {
    expect(hintFromToolLabel('Bash: cargo test --workspace')).toBe('cargo');
    expect(hintFromToolLabel('$ pnpm check:full')).toBe('pnpm');
    expect(hintFromToolLabel('tool:rustc')).toBe('rustc');
  });

  it('returns null for empty', () => {
    expect(hintFromToolLabel('   ')).toBeNull();
  });
});

describe('quiet-period process stats (CPU / RSS)', () => {
  it('cpuPctFromSamples: jiffies delta over wall time at hz', () => {
    // 200 jiffies at hz=100 → 2s of CPU over 1s wall = 200% (multi-core).
    expect(
      cpuPctFromSamples({ jiffies: 1000, atMs: 0 }, { jiffies: 1200, atMs: 1000 }, 100),
    ).toBe(200);
    // No wall time elapsed / going backwards → null (no honest number).
    expect(cpuPctFromSamples({ jiffies: 0, atMs: 5 }, { jiffies: 1, atMs: 5 }, 100)).toBeNull();
    expect(cpuPctFromSamples({ jiffies: 10, atMs: 10 }, { jiffies: 5, atMs: 20 }, 100)).toBeNull();
  });

  it('formatQuietProgressLine folds CPU and memory into the alive hint', () => {
    const line = formatQuietProgressLine({
      silenceMs: 62_000,
      runMs: 12 * 60_000,
      maxRunMs: 2 * 60 * 60_000,
      aliveHint: 'rustc',
      cpuPct: 187,
      rssMb: 1433,
    });
    expect(line).toMatch(/\(rustc · CPU 187% · 1\.4GB\)/);
    // Metrics without a worker name still show (process alive, unnamed child).
    const noName = formatQuietProgressLine({
      silenceMs: 62_000,
      runMs: 60_000,
      maxRunMs: 3_600_000,
      aliveHint: null,
      cpuPct: 12,
      rssMb: 300,
    });
    expect(noName).toMatch(/\(CPU 12% · 300MB\)/);
  });
});
