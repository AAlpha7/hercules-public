import { describe, it, expect } from 'vitest';
import { cheatSeverity, isCriticalCheatKind } from '../../src/domain/verification.js';
import { scanDiff } from '../../src/verification/antiCheat.js';

const SKIP = 'skip';
const ONLY = 'only';
const NL = '\n';
const Q = String.fromCharCode(39);

function qt(s: string): string {
  return Q + s + Q;
}

// Builds a single-hunk unified diff for integrity fixtures.
function makeDiff(file: string, rows: readonly (readonly ['ctx' | 'add' | 'del', string])[]): string {
  return makeMultiHunkDiff(file, [{ oldStart: 1, newStart: 1, rows }]);
}

type DiffOp = 'ctx' | 'add' | 'del';
type DiffRow = readonly [DiffOp, string];
type DiffHunk = {
  readonly oldStart: number;
  readonly newStart: number;
  readonly rows: readonly DiffRow[];
};

function makeMultiHunkDiff(file: string, hunks: readonly DiffHunk[]): string {
  const parts = [
    'diff --git a/' + file + ' b/' + file,
    dashHeader('a/' + file),
    plusHeader('b/' + file),
  ];
  for (const h of hunks) {
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (const [op, text] of h.rows) {
      if (op === 'ctx') {
        oldCount += 1;
        newCount += 1;
        body.push(' ' + text);
      } else if (op === 'add') {
        newCount += 1;
        body.push('+' + text);
      } else {
        oldCount += 1;
        body.push('-' + text);
      }
    }
    parts.push(hunkHeader(h.oldStart, oldCount, h.newStart, newCount), ...body);
  }
  return parts.join(NL);
}

function dashHeader(path: string): string {
  return '--- ' + path;
}

function plusHeader(path: string): string {
  return '+++ ' + path;
}

function hunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  const at = String.fromCharCode(64);
  return at + at + ' -' + String(oldStart) + ',' + String(oldCount) + ' +' + String(newStart) + ',' + String(newCount) + ' ' + at + at;
}

function integrity(diff: string) {
  return scanDiff(diff).filter((f) => f.kind === 'test-integrity');
}

function kinds(diff: string): string[] {
  return scanDiff(diff).map((f) => f.kind);
}

describe('scanDiff test-integrity', () => {
  it('is critical kind', () => {
    expect(cheatSeverity('test-integrity')).toBe('critical');
    expect(isCriticalCheatKind('test-integrity')).toBe(true);
  });

  it('flags removal of an existing named it case as critical', () => {
    const t = 'retries upload three times';
    const diff = makeDiff('test/foo.test.ts', [
      ['del', 'it(' + qt(t) + ', () => {});'],
      ['ctx', 'export {};'],
    ]);
    const found = integrity(diff);
    expect(found).toHaveLength(1);
    expect(found[0]!.file).toBe('test/foo.test.ts');
    expect(found[0]!.detail).toContain(t);
    expect(kinds(diff)).toContain('test-edit');
  });

  it('treats a renamed title as old-title removal', () => {
    const oldT = 'validates auth token expiry';
    const newT = 'checks token';
    const diff = makeDiff('src/bar.spec.ts', [
      ['del', 'test(' + qt(oldT) + ', () => {'],
      ['add', 'test(' + qt(newT) + ', () => {'],
      ['ctx', '  expect(true).toBe(true);'],
      ['ctx', '});'],
    ]);
    const found = integrity(diff);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(oldT);
    expect(found[0]!.detail).not.toContain(newT);
  });

  it('does not flag a pure reformat that preserves the normalized title', () => {
    const t = 'preserves title across formatting';
    const diff = makeDiff('test/move.test.ts', [
      ['del', 'it(' + qt(t) + ', () => {'],
      ['del', '  expect(1).toBe(1);'],
      ['del', '});'],
      ['add', 'it('],
      ['add', '  ' + qt(t) + ','],
      ['add', '  () => {'],
      ['add', '    expect(1).toBe(1);'],
      ['add', '  },'],
      ['add', ');'],
    ]);
    expect(kinds(diff)).not.toContain('test-integrity');
    expect(kinds(diff)).toContain('test-edit');
  });

  it('added-only tests stay review-only test-edit', () => {
    const diff = makeDiff('test/new.test.ts', [
      ['ctx', 'it(' + qt('existing') + ', () => { expect(1).toBe(1); });'],
      ['add', 'it(' + qt('brand new coverage') + ', () => {'],
      ['add', '  expect(2).toBe(2);'],
      ['add', '});'],
    ]);
    expect(kinds(diff)).toContain('test-edit');
    expect(kinds(diff)).not.toContain('test-integrity');
  });

  it('body edits with preserved title lines do not fire test-integrity', () => {
    const diff = makeDiff('test/body.test.ts', [
      ['ctx', 'it(' + qt('still constrains behavior') + ', () => {'],
      ['del', '  expect(value).toBe(1);'],
      ['add', '  expect(value).toBe(2);'],
      ['ctx', '});'],
    ]);
    expect(kinds(diff)).not.toContain('test-integrity');
    expect(kinds(diff)).toContain('test-edit');
  });

  it('detects single-line it.each title removal', () => {
    const t = 'returns double of %i';
    const diff = makeDiff('test/each.test.ts', [
      ['del', 'it.each([1, 2])(' + qt(t) + ', (n) => {'],
      ['del', '  expect(n * 2).toBe(n + n);'],
      ['del', '});'],
      ['ctx', 'export {};'],
    ]);
    const found = integrity(diff);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(t);
  });

  it('detects multiline it.each table title removal (auth-style)', () => {
    const t = 'negative auth clause %j is not positive auth intent';
    const diff = makeDiff('test/domain/authNegationPrecedence.test.ts', [
      ['del', 'it.each(['],
      ['del', '  [' + qt('No login UI') + '],'],
      ['del', '  [' + qt('without authentication screen') + '],'],
      ['del', '])(' + qt(t) + ', (text) => {'],
      ['del', '  expect(text).toBeTruthy();'],
      ['del', '});'],
      ['ctx', 'export {};'],
    ]);
    const found = integrity(diff);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(t);
  });

  it('detects multiline it.each object-table title removal (evidenceClaim-style)', () => {
    const t = 'positive after adversative: $name';
    const diff = makeDiff('test/domain/evidenceClaim.test.ts', [
      ['del', 'it.each(['],
      ['del', '  {'],
      ['del', '    name: ' + qt('English but') + ','],
      ['del', '    line: ' + qt('must not emit data-evidence=login but must emit data-evidence=shell') + ','],
      ['del', '  },'],
      ['del', '])(' + qt(t) + ', ({ line }) => {'],
      ['del', '  expect(line).toBeTruthy();'],
      ['del', '});'],
      ['ctx', 'export {};'],
    ]);
    const found = integrity(diff);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(t);
  });

  it('does not flag multiline it.each when the normalized title is preserved', () => {
    const t = 'negative auth clause %j is not positive auth intent';
    const diff = makeDiff('test/domain/authNegationPrecedence.test.ts', [
      ['del', 'it.each(['],
      ['del', '  [' + qt('No login UI') + '],'],
      ['del', '])(' + qt(t) + ', (text) => {'],
      ['del', '  expect(true).toBe(true);'],
      ['del', '});'],
      ['add', 'it.each(['],
      ['add', '  [' + qt('No login UI') + '],'],
      ['add', '  [' + qt('without authentication screen') + '],'],
      ['add', '])(' + qt(t) + ', (text) => {'],
      ['add', '  expect(true).toBe(true);'],
      ['add', '});'],
    ]);
    expect(kinds(diff)).not.toContain('test-integrity');
  });

  it('detects multiline it.each when title is on the line after table close', () => {
    const t = 'separate positive auth clause still wins: %j';
    const diff = makeDiff('test/domain/authNegationPrecedence.test.ts', [
      ['del', 'it.each(['],
      ['del', '  [' + qt('No login UI. Add re-auth flow.') + '],'],
      ['del', '])('],
      ['del', '  ' + qt(t) + ','],
      ['del', '  (text) => {'],
      ['del', '    expect(text).toBeTruthy();'],
      ['del', '  },'],
      ['del', ');'],
      ['ctx', 'export {};'],
    ]);
    const found = integrity(diff);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(t);
  });

  it('preserves multiline it.each title when moved to the line after table close', () => {
    const t = 'positive after adversative: $name';
    const diff = makeDiff('test/domain/evidenceClaim.test.ts', [
      ['del', 'it.each(['],
      ['del', '  { name: ' + qt('English but') + ' },'],
      ['del', '])(' + qt(t) + ', ({ name }) => {'],
      ['del', '  expect(name).toBeTruthy();'],
      ['del', '});'],
      ['add', 'it.each(['],
      ['add', '  { name: ' + qt('English but') + ' },'],
      ['add', '])('],
      ['add', '  ' + qt(t) + ','],
      ['add', '  ({ name }) => {'],
      ['add', '    expect(name).toBeTruthy();'],
      ['add', '  },'],
      ['add', ');'],
    ]);
    expect(kinds(diff)).not.toContain('test-integrity');
  });

  it('detects modifier alias title removal without self-flagging source', () => {
    const diff = makeDiff('test/alias.test.ts', [
      ['del', 'it.' + SKIP + '(' + qt('deferred flaky path') + ', () => {});'],
      ['del', 'test.' + ONLY + '(' + qt('focused path') + ', () => {});'],
      ['ctx', 'export {};'],
    ]);
    const details = integrity(diff).map((f) => f.detail);
    expect(details.some((d) => d.includes('deferred flaky path'))).toBe(true);
    expect(details.some((d) => d.includes('focused path'))).toBe(true);
  });

  it('false positives: comments strings snapshots helpers prose', () => {
    const code = makeDiff('test/fp.test.ts', [
      ['del', '// it(' + qt('commented out case') + ', () => {});'],
      ['del', '/* test(' + qt('block comment case') + ', () => {}); */'],
      ['del', 'const note = ' + qt('prefix it call in a string') + ';'],
      ['del', 'expect(x).toMatchInlineSnapshot(' + qt('snapshot with it and test words') + ');'],
      ['del', 'helperCall(it, ' + qt('not a declaration') + ');'],
      ['ctx', 'it(' + qt('real remaining case') + ', () => {'],
      ['ctx', '  expect(1).toBe(1);'],
      ['ctx', '});'],
    ]);
    const docs = makeDiff('docs/testing.md', [
      ['del', 'Always keep it regression titles when refactoring.'],
      ['ctx', '# Testing policy'],
    ]);
    expect(kinds(code + NL + docs)).not.toContain('test-integrity');
  });

  it('false positives: multiline block comment and template snapshot bodies', () => {
    const tick = String.fromCharCode(96);
    const block = makeDiff('test/fp-block.test.ts', [
      ['del', '/*'],
      ['del', ' * it(' + qt('commented multiline case') + ', () => {});'],
      ['del', ' * test(' + qt('another commented case') + ', () => {});'],
      ['del', ' */'],
      ['ctx', 'it(' + qt('real remaining case') + ', () => {'],
      ['ctx', '  expect(1).toBe(1);'],
      ['ctx', '});'],
    ]);
    const snap = makeDiff('test/fp-snap.test.ts', [
      ['del', 'expect(x).toMatchInlineSnapshot(' + tick],
      ['del', '  it(' + qt('inside snapshot body') + ', () => {}),'],
      ['del', '  test(' + qt('also inside template') + ', () => {}),'],
      ['del', tick + ');'],
      ['ctx', 'it(' + qt('real remaining case') + ', () => {'],
      ['ctx', '  expect(1).toBe(1);'],
      ['ctx', '});'],
    ]);
    expect(kinds(block)).not.toContain('test-integrity');
    expect(kinds(snap)).not.toContain('test-integrity');
  });

  it('ignores non-test source files even if they delete it-looking lines', () => {
    const diff = makeDiff('src/domain/example.ts', [
      ['del', 'it(' + qt('looks like a test but is production code text') + ');'],
      ['ctx', 'export const x = 1;'],
    ]);
    expect(kinds(diff)).not.toContain('test-integrity');
  });

  it('ignores deleted test-looking line inside context-open block comment', () => {
    const diff = makeDiff('test/fp-ctx-comment.test.ts', [
      ['ctx', '/*'],
      ['del', 'it(' + qt('commented with context open') + ', () => {});'],
      ['ctx', ' */'],
      ['ctx', 'it(' + qt('real remaining case') + ', () => {'],
      ['ctx', '  expect(1).toBe(1);'],
      ['ctx', '});'],
    ]);
    expect(kinds(diff)).not.toContain('test-integrity');
  });

  it('ignores deleted test-looking line inside context-open multiline template', () => {
    const tick = String.fromCharCode(96);
    const diff = makeDiff('test/fp-ctx-template.test.ts', [
      ['ctx', 'expect(x).toMatchInlineSnapshot(' + tick],
      ['del', 'it(' + qt('inside open template body') + ', () => {}),'],
      ['ctx', tick + ');'],
      ['ctx', 'it(' + qt('real remaining case') + ', () => {'],
      ['ctx', '  expect(1).toBe(1);'],
      ['ctx', '});'],
    ]);
    expect(kinds(diff)).not.toContain('test-integrity');
  });

  it('detects old-title removal when it( is context and only title lines change', () => {
    const oldT = 'old title on next line';
    const newT = 'renamed title on next line';
    const diff = makeDiff('test/title-only-change.test.ts', [
      ['ctx', 'it('],
      ['del', '  ' + qt(oldT) + ','],
      ['add', '  ' + qt(newT) + ','],
      ['ctx', '  () => {'],
      ['ctx', '    expect(1).toBe(1);'],
      ['ctx', '  },'],
      ['ctx', ');'],
    ]);
    const found = integrity(diff);
    expect(found).toHaveLength(1);
    expect(found[0]!.detail).toContain(oldT);
    expect(found[0]!.detail).not.toContain(newT);
  });

  it('preserves same normalized title moved across separate hunks in one file', () => {
    const t = 'moved across hunks without rename';
    const diff = makeMultiHunkDiff('test/cross-hunk.test.ts', [
      {
        oldStart: 1,
        newStart: 1,
        rows: [
          ['del', 'it(' + qt(t) + ', () => {'],
          ['del', '  expect(1).toBe(1);'],
          ['del', '});'],
          ['ctx', 'export const keep = 1;'],
        ],
      },
      {
        oldStart: 20,
        newStart: 18,
        rows: [
          ['ctx', 'export const tail = 2;'],
          ['add', 'it(' + qt(t) + ', () => {'],
          ['add', '  expect(1).toBe(1);'],
          ['add', '});'],
        ],
      },
    ]);
    expect(kinds(diff)).not.toContain('test-integrity');
    expect(kinds(diff)).toContain('test-edit');
  });

  it('flags net removal when duplicate titles drop from two to one', () => {
    const t = 'duplicate title net removal';
    const diff = makeDiff('test/dup-title.test.ts', [
      ['del', 'it(' + qt(t) + ', () => {'],
      ['del', '  expect(1).toBe(1);'],
      ['del', '});'],
      ['ctx', 'it(' + qt(t) + ', () => {'],
      ['ctx', '  expect(2).toBe(2);'],
      ['ctx', '});'],
    ]);
    const found = integrity(diff);
    expect(found).toHaveLength(1);
    expect(found[0]!.file).toBe('test/dup-title.test.ts');
    expect(found[0]!.detail).toContain(t);
  });

  it('keeps equal-count duplicate titles clean across hunks', () => {
    const t = 'equal count cross hunk move';
    const diff = makeMultiHunkDiff('test/dup-move.test.ts', [
      {
        oldStart: 1,
        newStart: 1,
        rows: [
          ['del', 'it(' + qt(t) + ', () => {'],
          ['del', '  expect(1).toBe(1);'],
          ['del', '});'],
          ['ctx', 'it(' + qt(t) + ', () => {'],
          ['ctx', '  expect(2).toBe(2);'],
          ['ctx', '});'],
        ],
      },
      {
        oldStart: 30,
        newStart: 28,
        rows: [
          ['ctx', 'export const tail = 1;'],
          ['add', 'it(' + qt(t) + ', () => {'],
          ['add', '  expect(1).toBe(1);'],
          ['add', '});'],
        ],
      },
    ]);
    expect(kinds(diff)).not.toContain('test-integrity');
    expect(kinds(diff)).toContain('test-edit');
  });
});

