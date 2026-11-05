import { describe, it, expect } from 'vitest';
import {
  classifyBaseDrift,
  isBaseDriftBlocking,
  isAutoRebaseEnabled,
  formatBaseDriftMarkdown,
  baseDriftConflictGate,
  unknownBaseDrift,
  type BaseDriftReport,
} from '../../src/domain/baseDrift.js';

function report(partial: Partial<BaseDriftReport> & Pick<BaseDriftReport, 'behind' | 'ahead' | 'status' | 'conflictRisk'>): BaseDriftReport {
  return {
    defaultBranch: 'main',
    mergeBase: 'aaaaaaaaaaaa',
    headSha: 'bbbbbbbbbbbb',
    baseSha: 'cccccccccccc',
    conflictDetail: null,
    rebaseAttempted: false,
    rebaseOk: null,
    rebaseDetail: null,
    ...partial,
  };
}

describe('classifyBaseDrift', () => {
  it('classifies current / behind / ahead / diverged', () => {
    expect(classifyBaseDrift(0, 0)).toBe('current');
    expect(classifyBaseDrift(3, 0)).toBe('behind');
    expect(classifyBaseDrift(0, 2)).toBe('ahead');
    expect(classifyBaseDrift(1, 1)).toBe('diverged');
  });
});

describe('isBaseDriftBlocking', () => {
  it('blocks only on hard conflict risk', () => {
    expect(
      isBaseDriftBlocking(report({ behind: 2, ahead: 1, status: 'diverged', conflictRisk: 'none' })),
    ).toBe(false);
    expect(
      isBaseDriftBlocking(
        report({ behind: 2, ahead: 1, status: 'diverged', conflictRisk: 'conflict' }),
      ),
    ).toBe(true);
  });
});

describe('isAutoRebaseEnabled', () => {
  it('defaults off; accepts 1/true/on/yes', () => {
    expect(isAutoRebaseEnabled({})).toBe(false);
    expect(isAutoRebaseEnabled({ HERCULES_AUTO_REBASE: '0' })).toBe(false);
    expect(isAutoRebaseEnabled({ HERCULES_AUTO_REBASE: '1' })).toBe(true);
    expect(isAutoRebaseEnabled({ HERCULES_AUTO_REBASE: 'true' })).toBe(true);
    expect(isAutoRebaseEnabled({ HERCULES_AUTO_REBASE: 'ON' })).toBe(true);
    expect(isAutoRebaseEnabled({ HERCULES_AUTO_REBASE: ' yes ' })).toBe(true);
  });
});

describe('formatBaseDriftMarkdown', () => {
  it('renders behind + conflict risk for the packet', () => {
    const md = formatBaseDriftMarkdown(
      report({
        behind: 2,
        ahead: 1,
        status: 'diverged',
        conflictRisk: 'none',
      }),
    ).join('\n');
    expect(md).toContain('**Base drift**');
    expect(md).toContain('behind **2**');
    expect(md).toContain('ahead **1**');
    expect(md).toContain('conflict risk **none**');
    expect(md).toMatch(/diverged/);
  });

  it('surfaces conflict risk with remediation (never merge to main)', () => {
    const md = formatBaseDriftMarkdown(
      report({
        behind: 1,
        ahead: 1,
        status: 'diverged',
        conflictRisk: 'conflict',
        conflictDetail: 'CONFLICT (content): Merge conflict in a.txt',
      }),
    ).join('\n');
    expect(md).toContain('Conflict risk');
    expect(md).toContain('never merge to main');
    expect(md).toContain('a.txt');
  });

  it('records auto-rebase outcome', () => {
    const ok = formatBaseDriftMarkdown(
      report({
        behind: 0,
        ahead: 1,
        status: 'ahead',
        conflictRisk: 'none',
        rebaseAttempted: true,
        rebaseOk: true,
        rebaseDetail: 'rebased 2 commits onto main',
      }),
    ).join('\n');
    expect(ok).toMatch(/Auto-rebase.*✅/);
    const fail = formatBaseDriftMarkdown(
      report({
        behind: 1,
        ahead: 1,
        status: 'diverged',
        conflictRisk: 'conflict',
        rebaseAttempted: true,
        rebaseOk: false,
        rebaseDetail: 'conflict; aborted',
      }),
    ).join('\n');
    expect(fail).toMatch(/Auto-rebase.*❌/);
  });
});

describe('baseDriftConflictGate', () => {
  it('emits a failing hercules:base-drift gate', () => {
    const g = baseDriftConflictGate(
      report({
        behind: 1,
        ahead: 1,
        status: 'diverged',
        conflictRisk: 'conflict',
        conflictDetail: 'CONFLICT in foo.ts',
      }),
    );
    expect(g.name).toBe('base-drift');
    expect(g.passed).toBe(false);
    expect(g.command).toBe('hercules:base-drift');
    expect(g.output).toMatch(/never merge to main/i);
    expect(g.output).toContain('foo.ts');
  });
});

describe('unknownBaseDrift', () => {
  it('returns a safe unknown snapshot', () => {
    const u = unknownBaseDrift('main', 'not a git dir');
    expect(u.status).toBe('unknown');
    expect(u.conflictRisk).toBe('unknown');
    expect(u.behind).toBe(0);
  });
});
