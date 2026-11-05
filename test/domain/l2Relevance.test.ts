import { describe, it, expect } from 'vitest';
import {
  computeL2Relevance,
  extractDataEvidenceAnchors,
  isUiFile,
  toL2RelevanceRecord,
  type L2RelevanceStep,
} from '../../src/domain/l2Relevance.js';

function uiDiff(path: string, bodyLines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,3 +1,4 @@',
    ...bodyLines,
  ].join('\n');
}

describe('extractDataEvidenceAnchors', () => {
  it('extracts anchors with =, quotes, and JSX brace', () => {
    expect(extractDataEvidenceAnchors('data-evidence=nav-settings')).toEqual([
      'nav-settings',
    ]);
    expect(
      extractDataEvidenceAnchors('data-evidence="promote-btn" data-evidence=\'x\''),
    ).toEqual(['promote-btn', 'x']);
    expect(extractDataEvidenceAnchors('data-evidence={task-card}')).toEqual([
      'task-card',
    ]);
  });
});

describe('isUiFile', () => {
  it('matches UI extensions and src/web/ prefix', () => {
    expect(isUiFile('src/web/App.tsx')).toBe(true);
    expect(isUiFile('src/web/foo.ts')).toBe(true);
    expect(isUiFile('components/Button.tsx')).toBe(true);
    expect(isUiFile('page.html')).toBe(true);
    expect(isUiFile('Widget.vue')).toBe(true);
    expect(isUiFile('X.svelte')).toBe(true);
    expect(isUiFile('src/domain/x.ts')).toBe(false);
    expect(isUiFile('src/verification/packet.ts')).toBe(false);
  });
});

describe('computeL2Relevance', () => {
  const click = (
    anchor: string,
    ok = true,
  ): L2RelevanceStep => ({
    kind: 'click',
    ok,
    detail: 'ok',
    raw: `click [data-evidence=${anchor}]`,
  });

  it('labels no-ui-change when no UI file is touched', () => {
    const r = computeL2Relevance({
      diff: uiDiff('src/domain/x.ts', ['+data-evidence=should-ignore']),
      filesTouched: ['src/domain/x.ts'],
      steps: [click('should-ignore')],
      hasEvidenceBinding: false,
    });
    expect(r.label).toBe('no-ui-change');
    expect(r.summary).toBe('L2: no UI change in diff');
    expect(r.warning).toBeNull();
    expect(r.changedAnchors).toEqual([]);
  });

  it('labels l2-not-run when UI changed but steps is null', () => {
    const r = computeL2Relevance({
      diff: '',
      filesTouched: ['src/web/App.tsx', 'src/web/Settings.tsx'],
      steps: null,
      hasEvidenceBinding: false,
    });
    expect(r.label).toBe('l2-not-run');
    expect(r.summary).toBe('L2: not run — UI changed (2 file(s))');
    expect(r.warning).toBe(r.summary);
  });

  it('extracts changedAnchors from added lines of UI files only (removed-only anchors cannot be exercised)', () => {
    const diff = [
      uiDiff('src/web/App.tsx', [
        ' context',
        '-  <div data-evidence="old-hook">',
        '+  <div data-evidence="new-hook">',
        '+  <button data-evidence=promote-btn />',
      ]),
      '',
      uiDiff('src/domain/x.ts', [
        '+  data-evidence="not-ui"',
      ]),
      '',
      // File headers must not contribute (+++ / --- lines).
      'diff --git a/src/web/Other.tsx b/src/web/Other.tsx',
      '--- a/src/web/Other.tsx',
      '+++ b/src/web/Other.tsx',
      '@@ -1 +1 @@',
      '+plain line without anchor',
    ].join('\n');

    const r = computeL2Relevance({
      diff,
      filesTouched: ['src/web/App.tsx', 'src/domain/x.ts', 'src/web/Other.tsx'],
      steps: [click('new-hook'), click('promote-btn')],
      hasEvidenceBinding: false,
    });
    expect(r.changedAnchors).toEqual(['new-hook', 'promote-btn']);
    expect(r.changedAnchors).not.toContain('old-hook');
    expect(r.changedAnchors).not.toContain('not-ui');
    expect(r.label).toBe('covered');
  });

  it('labels covered when every changed anchor was exercised', () => {
    const r = computeL2Relevance({
      diff: uiDiff('src/web/App.tsx', [
        '+data-evidence=a',
        '+data-evidence=b',
      ]),
      filesTouched: ['src/web/App.tsx'],
      steps: [click('a'), click('b')],
      hasEvidenceBinding: false,
    });
    expect(r.label).toBe('covered');
    expect(r.covered).toEqual(['a', 'b']);
    expect(r.uncovered).toEqual([]);
    expect(r.summary).toBe('L2: covered — changed anchors exercised (a, b)');
    expect(r.warning).toBeNull();
  });

  it('labels partial when some changed anchors are uncovered', () => {
    const r = computeL2Relevance({
      diff: uiDiff('src/web/App.tsx', [
        '+data-evidence=hit',
        '+data-evidence=miss',
      ]),
      filesTouched: ['src/web/App.tsx'],
      steps: [click('hit')],
      hasEvidenceBinding: false,
    });
    expect(r.label).toBe('partial');
    expect(r.covered).toEqual(['hit']);
    expect(r.uncovered).toEqual(['miss']);
    expect(r.summary).toBe('L2: partial — uncovered changed anchors: miss');
    expect(r.warning).toBe(r.summary);
  });

  it('labels regression-only when no changed anchor was exercised', () => {
    const r = computeL2Relevance({
      diff: uiDiff('src/web/App.tsx', ['+data-evidence=promote-btn']),
      filesTouched: ['src/web/App.tsx'],
      steps: [click('nav-settings')],
      hasEvidenceBinding: false,
    });
    expect(r.label).toBe('regression-only');
    expect(r.summary).toBe(
      'L2: regression only — changed UI not exercised (promote-btn)',
    );
    expect(r.warning).toBe(r.summary);
  });

  it('labels regression-only (no uncovered list) when UI has no anchors but @evidence binding exists', () => {
    const r = computeL2Relevance({
      diff: uiDiff('src/web/App.tsx', ['+const x = 1;']),
      filesTouched: ['src/web/App.tsx'],
      steps: [click('nav-settings')],
      hasEvidenceBinding: true,
    });
    expect(r.label).toBe('regression-only');
    expect(r.changedAnchors).toEqual([]);
    expect(r.summary).toBe('L2: regression only — changed UI not exercised');
    expect(r.warning).toBe(r.summary);
  });

  it('labels unbound-ui-change when UI changed with no anchors and no @evidence binding', () => {
    const r = computeL2Relevance({
      diff: uiDiff('src/web/App.tsx', ['+const x = 1;']),
      filesTouched: ['src/web/App.tsx'],
      steps: [click('nav-settings')],
      hasEvidenceBinding: false,
    });
    expect(r.label).toBe('unbound-ui-change');
    expect(r.summary).toBe(
      'L2: UI change without evidence binding — add @evidence:<anchor> or a ## Evidence step',
    );
    expect(r.warning).toBe(r.summary);
  });

  it('does not count ok===false steps as exercised', () => {
    const r = computeL2Relevance({
      diff: uiDiff('src/web/App.tsx', ['+data-evidence=promote-btn']),
      filesTouched: ['src/web/App.tsx'],
      steps: [click('promote-btn', false), click('other')],
      hasEvidenceBinding: false,
    });
    expect(r.exercisedAnchors).toEqual(['other']);
    expect(r.label).toBe('regression-only');
  });

  it('resets screenshotScenes per screenshot step', () => {
    const steps: L2RelevanceStep[] = [
      click('nav-settings'),
      {
        kind: 'assert',
        ok: true,
        detail: 'found data-evidence=settings-panel',
        raw: 'assert sel=[data-evidence=settings-panel]',
      },
      {
        kind: 'screenshot',
        ok: true,
        detail: 'wrote',
        raw: 'screenshot settings',
        screenshot: 'settings.png',
      },
      click('nav-releases'),
      {
        kind: 'screenshot',
        ok: true,
        detail: 'wrote',
        raw: 'screenshot releases',
        screenshot: 'releases.png',
      },
      {
        kind: 'screenshot',
        ok: true,
        detail: 'wrote',
        raw: 'screenshot empty',
        screenshot: 'empty.png',
      },
    ];
    const r = computeL2Relevance({
      diff: uiDiff('src/web/App.tsx', ['+data-evidence=nav-settings']),
      filesTouched: ['src/web/App.tsx'],
      steps,
      hasEvidenceBinding: false,
    });
    expect([...r.screenshotScenes.keys()]).toEqual([
      'settings.png',
      'releases.png',
      'empty.png',
    ]);
    expect(r.screenshotScenes.get('settings.png')).toEqual([
      'nav-settings',
      'settings-panel',
    ]);
    expect(r.screenshotScenes.get('releases.png')).toEqual(['nav-releases']);
    expect(r.screenshotScenes.get('empty.png')).toEqual([]);
  });

  it('bounds anchor scan at 500 and stops after 200_000 diff lines', () => {
    // 500 unique anchors on + lines of a UI file.
    const anchorLines = Array.from(
      { length: 520 },
      (_, i) => `+data-evidence=a${String(i).padStart(4, '0')}`,
    );
    const r = computeL2Relevance({
      diff: uiDiff('src/web/App.tsx', anchorLines),
      filesTouched: ['src/web/App.tsx'],
      steps: [],
      hasEvidenceBinding: false,
    });
    expect(r.changedAnchors.length).toBe(500);
    expect(r.changedAnchors[0]).toBe('a0000');
    expect(r.changedAnchors[499]).toBe('a0499');

    // Line cap: a huge non-UI preamble then a UI file — only first 200k lines scanned.
    const filler = Array.from({ length: 200_001 }, () => ' context').join('\n');
    const lateUi = [
      'diff --git a/src/web/Late.tsx b/src/web/Late.tsx',
      '--- a/src/web/Late.tsx',
      '+++ b/src/web/Late.tsx',
      '@@ -1 +1 @@',
      '+data-evidence=late-anchor',
    ].join('\n');
    const capped = computeL2Relevance({
      diff: filler + '\n' + lateUi,
      filesTouched: ['src/web/Late.tsx'],
      steps: [],
      hasEvidenceBinding: false,
    });
    expect(capped.changedAnchors).not.toContain('late-anchor');
  });

  it('toL2RelevanceRecord converts Map to plain object', () => {
    const r = computeL2Relevance({
      diff: uiDiff('src/web/App.tsx', ['+data-evidence=x']),
      filesTouched: ['src/web/App.tsx'],
      steps: [
        click('x'),
        {
          kind: 'screenshot',
          ok: true,
          detail: 'ok',
          screenshot: 's.png',
        },
      ],
      hasEvidenceBinding: false,
    });
    const rec = toL2RelevanceRecord(r);
    expect(rec.screenshotScenes).toEqual({ 's.png': ['x'] });
    expect(rec.label).toBe('covered');
  });
});
