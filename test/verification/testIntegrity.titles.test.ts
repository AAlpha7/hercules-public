import { describe, expect, it } from 'vitest';
import {
  collectAddedTestTitles,
  extractRustTestCaseTitles,
  extractTestCaseTitles,
  findRemovedTestCases,
} from '../../src/verification/testIntegrity.js';

const NL = '\n';
const Q = String.fromCharCode(39);

describe('extractRustTestCaseTitles', () => {
  it('indexes #[test], #[tokio::test], and nested modules by fn name', () => {
    const source = [
      '#[cfg(test)]',
      'mod tests {',
      '    use super::*;',
      '',
      '    #[test]',
      '    fn rejects_forged_pin() {',
      '        assert!(true);',
      '    }',
      '',
      '    #[tokio::test]',
      '    async fn async_login_flow() {',
      '        assert!(true);',
      '    }',
      '',
      '    #[some_crate::test]',
      '    fn custom_harness_case() {}',
      '',
      '    fn not_a_test() {}',
      '}',
    ].join(NL);
    const titles = extractRustTestCaseTitles(source);
    expect(titles).toEqual([
      'rejects_forged_pin',
      'async_login_flow',
      'custom_harness_case',
    ]);
    expect(extractTestCaseTitles(source, 'core/tests/guards.rs')).toEqual(titles);
  });
});

describe('extractTestCaseTitles', () => {
  it('extracts it()/test() titles and excludes .skip / .todo', () => {
    const source = [
      "it('keeps this', () => {});",
      'test("also keeps", () => {});',
      `it.skip(${Q}skipped case${Q}, () => {});`, // hercules-allow-silencing — fixture text for title extractor
      'test.todo("todo case");',
      'it.only("still counted", () => {});',
    ].join(NL);
    const titles = extractTestCaseTitles(source);
    expect(titles).toContain('keeps this');
    expect(titles).toContain('also keeps');
    expect(titles).toContain('still counted');
    expect(titles).not.toContain('skipped case');
    expect(titles).not.toContain('todo case');
  });

  it('regex literals with quotes or backticks do not swallow the titles after them (a downstream project 2026-09-12)', () => {
    const source = [
      "it('first', () => {",
      "  assert.match(src, /idempotencyKey(" + Q + "vnext-action:${itemId}" + Q + "),[\\s\\S]*?}\\);/);",
      "  assert.match(src, /\\{ type: 'image'; data_url: string \\}/);",
      '  const ratio = total / count; // a division, not a regex',
      '  return a / b / c;',
      '});',
      "it('loads server-backed chat history as an authenticated read projection', () => {});",
      "it('syncs avatar profiles', () => {});",
    ].join(NL);
    const titles = extractTestCaseTitles(source, 'webapp/tests/vnextApiRequests.test.mjs');
    expect(titles).toEqual([
      'first',
      'loads server-backed chat history as an authenticated read projection',
      'syncs avatar profiles',
    ]);
  });

  it('a .rs path hint wins over a `test(` occurrence inside #[tokio::test(flavor = …)]', () => {
    const source = [
      '#[tokio::test(flavor = "current_thread")]',
      'async fn chat_history_projection_pages_older_messages_with_before() {}',
      '#[test]',
      'fn plain_case() {}',
    ].join(NL);
    expect(extractTestCaseTitles(source, 'core/src/admin_tests/part4.rs')).toEqual([
      'chat_history_projection_pages_older_messages_with_before',
      'plain_case',
    ]);
  });

  it('does not change findRemovedTestCases skip/todo detection', () => {
    // findRemovedTestCases still sees .skip titles in the old view.
    const diff = [
      'diff --git a/test/x.test.ts b/test/x.test.ts',
      '--- a/test/x.test.ts',
      '+++ b/test/x.test.ts',
      '@@ -1,2 +1,1 @@',
      `-it.skip(${Q}was skipped${Q}, () => {});`, // hercules-allow-silencing — fixture diff line
      " it('stays', () => {});",
    ].join(NL);
    const findings = findRemovedTestCases(diff);
    expect(findings.some((f) => /was skipped/.test(f.detail))).toBe(true);
  });
});

describe('collectAddedTestTitles', () => {
  it('collects titles on added lines per test file (b/ prefix stripped)', () => {
    const diff = [
      'diff --git a/test/domain/foo.test.ts b/test/domain/foo.test.ts',
      '--- a/test/domain/foo.test.ts',
      '+++ b/test/domain/foo.test.ts',
      '@@ -1,1 +1,3 @@',
      " it('pre-existing', () => {});",
      `+it(${Q}new in diff${Q}, () => {});`,
      '+it.skip("not counted", () => {});', // hercules-allow-silencing — fixture diff line
    ].join(NL);
    const added = collectAddedTestTitles(diff);
    expect(added.get('test/domain/foo.test.ts')).toEqual(['new in diff']);
  });
});
