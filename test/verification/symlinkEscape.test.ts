import { describe, expect, it } from 'vitest';
import { cheatSeverity } from '../../src/domain/verification.js';
import { scanDiff } from '../../src/verification/antiCheat.js';
import {
  findSymlinkEntries,
  findSymlinkEscapes,
  symlinkTargetEscapes,
} from '../../src/verification/symlinkEscape.js';

function fileToSymlinkDiff(file: string, target: string, removed: readonly string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    'old mode 100644',
    'new mode 120000',
    'index 1111111..2222222',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1 @@`,
    ...removed.map((line) => '-' + line),
    '+' + target,
    '\\ No newline at end of file',
    '',
  ].join('\n');
}

function newSymlinkDiff(file: string, target: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 120000',
    'index 0000000..2222222',
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    '+' + target,
    '\\ No newline at end of file',
    '',
  ].join('\n');
}

const TEST_BODY = [
  "import { it } from 'vitest';",
  "it('keeps the chevron', () => {});",
  "it('names the provider', () => {});",
];

describe('symlink escapes in a diff (C3.42)', () => {
  it('a test file turned into an absolute symlink is one critical symlink-escape finding, not removed tests', () => {
    const diff = fileToSymlinkDiff(
      'test/foo.test.ts', '/home/ubuntu/hercules-drafts-x/test/foo.test.ts', TEST_BODY,
    );
    const findings = scanDiff(diff);
    // `test-edit` (review-only: the file is a test file) is expected alongside.
    const forFile = findings.filter((f) => f.file === 'test/foo.test.ts' && f.kind !== 'test-edit');
    expect(forFile.map((f) => f.kind)).toEqual(['symlink-escape']);
    expect(cheatSeverity(forFile[0]!.kind)).toBe('critical');
    expect(forFile[0]!.detail).toContain('/home/ubuntu/hercules-drafts-x/test/foo.test.ts');
    expect(forFile[0]!.detail).toContain('copy file contents, never link');
    expect(findings.some((f) => f.kind === 'test-integrity')).toBe(false);
  });

  it('resolves relative targets against the link directory', () => {
    // src/deep/a.ts → ../../outside/file resolves to outside/file (inside the root).
    expect(symlinkTargetEscapes('src/deep/a.ts', '../../outside/file')).toBe(false);
    expect(symlinkTargetEscapes('src/deep/a.ts', '../../../outside/file')).toBe(true);
    expect(symlinkTargetEscapes('src/deep/a.ts', '../b.ts')).toBe(false);
    expect(symlinkTargetEscapes('src/deep/a.ts', '../../../x')).toBe(true);
    expect(symlinkTargetEscapes('a.ts', '..')).toBe(true);
    expect(symlinkTargetEscapes('src/a.ts', 'b.ts')).toBe(false);
    expect(findSymlinkEscapes(fileToSymlinkDiff('src/deep/a.ts', '../b.ts', ['x']))).toEqual([]);
    expect(findSymlinkEscapes(fileToSymlinkDiff('src/deep/a.ts', '../../../outside/file', ['x'])))
      .toHaveLength(1);
  });

  it('a brand-new symlink to an absolute path is a finding; text changes are not', () => {
    const escape = findSymlinkEscapes(newSymlinkDiff('src/new.ts', '/etc/passwd'));
    expect(escape).toHaveLength(1);
    expect(escape[0]).toMatchObject({ kind: 'symlink-escape', file: 'src/new.ts' });
    const text = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
    ].join('\n');
    expect(findSymlinkEntries(text)).toEqual([]);
    expect(findSymlinkEscapes(text)).toEqual([]);
  });

  it('re-pointing an EXISTING symlink (index line only, no mode line) is detected (Claude round 21 B1)', () => {
    const diff = [
      'diff --git a/test/link-existing.ts b/test/link-existing.ts',
      'index 1111111..2222222 120000',
      '--- a/test/link-existing.ts',
      '+++ b/test/link-existing.ts',
      '@@ -1 +1 @@',
      '-../inside.ts',
      '+/etc/passwd',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const escape = findSymlinkEscapes(diff);
    expect(escape).toHaveLength(1);
    expect(escape[0]).toMatchObject({ kind: 'symlink-escape', file: 'test/link-existing.ts' });
    // Re-pointing to another inside path stays allowed.
    expect(findSymlinkEscapes(diff.replace('+/etc/passwd', '+../other.ts'))).toEqual([]);
  });

  it('a path with spaces (git appends a tab) still suppresses the removed-test symptom (round 21 N1)', () => {
    const file = 'test/with space.test.ts';
    const diff = [
      `diff --git a/${file} b/${file}`,
      'old mode 100644',
      'new mode 120000',
      `--- a/${file}\t`,
      `+++ b/${file}\t`,
      `@@ -1,${TEST_BODY.length} +1 @@`,
      ...TEST_BODY.map((line) => '-' + line),
      '+/drafts/test/with space.test.ts',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const findings = scanDiff(diff);
    expect(findings.filter((f) => f.kind === 'symlink-escape').map((f) => f.file)).toEqual([file]);
    expect(findings.some((f) => f.kind === 'test-integrity')).toBe(false);
  });

  it('removed-test findings for other files survive alongside a symlink escape', () => {
    const diff = fileToSymlinkDiff('test/a.test.ts', '/drafts/test/a.test.ts', TEST_BODY) + [
      'diff --git a/test/b.test.ts b/test/b.test.ts',
      'index 1111111..2222222 100644',
      '--- a/test/b.test.ts',
      '+++ b/test/b.test.ts',
      '@@ -1,2 +1 @@',
      " it('stays', () => {});",
      "-it('goes away', () => {});",
      '',
    ].join('\n');
    const findings = scanDiff(diff);
    expect(findings.filter((f) => f.file === 'test/a.test.ts' && f.kind !== 'test-edit').map((f) => f.kind))
      .toEqual(['symlink-escape']);
    expect(findings.some((f) => f.file === 'test/b.test.ts' && f.kind === 'test-integrity')).toBe(true);
  });
});
