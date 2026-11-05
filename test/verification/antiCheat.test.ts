import { describe, it, expect } from 'vitest';
import { cheatSeverity, isCriticalCheatKind } from '../../src/domain/verification.js';
import { findPlaceholderEvidenceHooks, scanDiff } from '../../src/verification/antiCheat.js';

function kinds(diff: string, protectedPaths?: string[]): string[] {
  return scanDiff(diff, protectedPaths ? { protectedPaths } : {}).map((f) => f.kind);
}

function addedCall(receiver: string, method: string, args: string): string {
  return `+${receiver}.${method}(${args});`;
}

function aliasControl(alias: string, args: string): string {
  return `+${alias}(${args});`;
}

function rustAttribute(name: string, value: string): string {
  return `+#[${name} = "${value}"]`;
}

describe('scanDiff — silencing tricks in added lines (SPEC §9.5)', () => {
  it('flags eslint-disable, @ts-ignore, as any, .skip, .only and empty catch', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,2 +1,8 @@
 const ok = 1;
+// eslint-disable-next-line
+// @ts-ignore
+const y = z as any;
+it.skip('later', () => {});
+it.only('focus', () => {});
+try { risky(); } catch {}
`;
    const found = kinds(diff);
    expect(found).toContain('eslint-disable');
    expect(found).toContain('ts-ignore');
    expect(found).toContain('as-any');
    expect(found).toContain('test-skip');
    expect(found).toContain('test-only');
    expect(found).toContain('empty-catch');
  });

  it('does not apply code-smell patterns to prose files (docs mentioning `catch {}`)', () => {
    // Live incident: future-ssh-heavy-worker burned 3 attempts on a "critical
    // empty-catch" that was design-doc PROSE explaining the code avoids them.
    const diff = `diff --git a/docs/design.md b/docs/design.md
--- a/docs/design.md
+++ b/docs/design.md
@@ -1,1 +1,4 @@
 # Design
+Transport errors surface in the packet (never a silent \`catch {}\`).
+Do not cast \`as any\`; do not add eslint-disable lines.
+it.only('this is prose, not a test', () => {});
`;
    expect(kinds(diff)).toEqual([]);
  });

  it('still applies code-smell patterns to code files alongside prose in one diff', () => {
    const diff = `diff --git a/docs/design.md b/docs/design.md
--- a/docs/design.md
+++ b/docs/design.md
@@ -1,1 +1,2 @@
 # Design
+Avoid \`catch {}\` blocks.
diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,2 @@
 const ok = 1;
+try { risky(); } catch {}
`;
    const found = scanDiff(diff);
    expect(found.map((f) => [f.kind, f.file])).toEqual([['empty-catch', 'src/x.ts']]);
  });

  it('does not confuse ordinary skip/only methods with test controls', () => {
    const diff = [
      'diff --git a/crates/cli/src/main.rs b/crates/cli/src/main.rs',
      '--- a/crates/cli/src/main.rs',
      '+++ b/crates/cli/src/main.rs',
      '@@ -1,0 +1,1 @@',
      `+let mut args = ${addedCall('env::args()', 'skip', '1').slice(1)}`,
      'diff --git a/src/query.ts b/src/query.ts',
      '--- a/src/query.ts',
      '+++ b/src/query.ts',
      '@@ -1,0 +1,2 @@',
      `+const page = ${addedCall('records', 'skip', 'offset').slice(1)}`,
      `+const selection = ${addedCall('policy', 'only', 'allowed').slice(1)}`,
    ].join('\n');
    const found = kinds(diff);
    expect(found).not.toContain('test-skip');
    expect(found).not.toContain('test-only');
  });

  it('recognizes explicit test-framework skip and only controls', () => {
    const diff = [
      'diff --git a/src/x.ts b/src/x.ts',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,0 +1,5 @@',
      addedCall('suite', 'skip', "'later', () => {}"),
      addedCall('test', 'skipIf', "process.platform === 'win32'"),
      addedCall('bench', 'only', "'focus', () => {}"),
      addedCall('pytest', 'skip', "'unavailable'"),
      addedCall('unittest', 'skip', "'unavailable'"),
    ].join('\n');
    const found = kinds(diff);
    expect(found.filter((kind) => kind === 'test-skip')).toHaveLength(4);
    expect(found.filter((kind) => kind === 'test-only')).toHaveLength(1);
  });

  it('recognizes Rust ignore attributes and focused/skipped test aliases', () => {
    const diff = [
      'diff --git a/crates/core/tests/pipeline.rs b/crates/core/tests/pipeline.rs',
      '--- a/crates/core/tests/pipeline.rs',
      '+++ b/crates/core/tests/pipeline.rs',
      '@@ -1,0 +1,2 @@',
      rustAttribute('ignore', 'flaky'),
      '+fn preserves_evidence() {}',
      'diff --git a/src/x.test.ts b/src/x.test.ts',
      '--- a/src/x.test.ts',
      '+++ b/src/x.test.ts',
      '@@ -1,0 +1,4 @@',
      aliasControl('xit', "'later', () => {}"),
      aliasControl('xdescribe', "'later', () => {}"),
      aliasControl('fit', "'focused', () => {}"),
      aliasControl('fdescribe', "'focused', () => {}"),
    ].join('\n');
    const found = kinds(diff);
    expect(found.filter((kind) => kind === 'test-skip')).toHaveLength(3);
    expect(found.filter((kind) => kind === 'test-only')).toHaveLength(2);
  });

  it('ignores tricks that are only on removed or context lines', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,2 @@
 const ok = 1;
-const bad = z as any;
 const fine = 2;
`;
    expect(kinds(diff)).toEqual([]);
  });

  it('reports the new-file line number for an added violation', () => {
    const diff = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,2 @@
 const ok = 1;
+const y = z as any;
`;
    const findings = scanDiff(diff, {});
    expect(findings[0]!.line).toBe(2);
  });
});

describe('scanDiff — protected paths and test edits', () => {
  it('flags edits to a protected path', () => {
    const diff = `diff --git a/test/smoke/core.test.ts b/test/smoke/core.test.ts
--- a/test/smoke/core.test.ts
+++ b/test/smoke/core.test.ts
@@ -1,1 +1,1 @@
-expect(x).toBe(1);
+expect(x).toBe(2);
`;
    const found = kinds(diff, ['test/smoke/**']);
    expect(found).toContain('protected-path');
  });

  it('flags edits to test files (reviewer attention)', () => {
    const diff = `diff --git a/src/foo.test.ts b/src/foo.test.ts
--- a/src/foo.test.ts
+++ b/src/foo.test.ts
@@ -1,1 +1,1 @@
-expect(x).toBe(1);
+expect(x).toBe(2);
`;
    expect(kinds(diff)).toContain('test-edit');
  });

  it('does not flag ordinary source edits', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;
    expect(scanDiff(diff, { protectedPaths: ['test/smoke/**'] })).toEqual([]);
  });
});

describe('cheatSeverity — red UI is critical only', () => {
  it('marks test-edit as review, silencing as critical', () => {
    expect(cheatSeverity('test-edit')).toBe('review');
    expect(isCriticalCheatKind('test-edit')).toBe(false);
    expect(cheatSeverity('eslint-disable')).toBe('critical');
    expect(cheatSeverity('false-delivery')).toBe('critical');
    expect(isCriticalCheatKind('as-any')).toBe(true);
  });

  it('marks placeholder-evidence-hook as REVIEW_ONLY (not auto-rework)', () => {
    expect(cheatSeverity('placeholder-evidence-hook')).toBe('review');
    expect(isCriticalCheatKind('placeholder-evidence-hook')).toBe(false);
  });
});

describe('findPlaceholderEvidenceHooks — L2 assert placeholder chrome', () => {
  it('hits: disabled data-evidence control with empty event body (shellMarkReadyChrome case)', () => {
    const diff = `diff --git a/src/web/ReposPanel.tsx b/src/web/ReposPanel.tsx
--- a/src/web/ReposPanel.tsx
+++ b/src/web/ReposPanel.tsx
@@ -10,0 +10,8 @@
+      {/* shellMarkReadyChrome — so evidence assert sel=[data-evidence=repo-mark-ready] passes */}
+      <button
+        type="button"
+        data-evidence="repo-mark-ready"
+        disabled
+        onClick={() => { /* no-op */ }}
+      >
+        Mark ready
+      </button>
`;
    const findings = findPlaceholderEvidenceHooks(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.every((f) => f.kind === 'placeholder-evidence-hook')).toBe(true);
    expect(findings.some((f) => f.file.includes('ReposPanel.tsx'))).toBe(true);
    expect(findings.some((f) => typeof f.line === 'number' && f.line > 0)).toBe(true);
    expect(findings.some((f) => /占位|禁用|L2|钩子/.test(f.detail))).toBe(true);
    // Also wired through scanDiff
    expect(kinds(diff)).toContain('placeholder-evidence-hook');
  });

  it('hits: data-evidence host with placeholder text only (human-ac-unproven case)', () => {
    const diff = `diff --git a/src/web/App.tsx b/src/web/App.tsx
--- a/src/web/App.tsx
+++ b/src/web/App.tsx
@@ -20,0 +20,1 @@
+      <div data-evidence="human-ac-unproven">unproven-ui-ac-host</div>
`;
    const findings = findPlaceholderEvidenceHooks(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('placeholder-evidence-hook');
    expect(findings[0]!.file).toBe('src/web/App.tsx');
    expect(findings[0]!.line).toBe(20);
    expect(findings[0]!.detail).toMatch(/占位/);
  });

  it('hits: comment declares the element exists only for L2 assert', () => {
    const diff = `diff --git a/web/Panel.tsx b/web/Panel.tsx
--- a/web/Panel.tsx
+++ b/web/Panel.tsx
@@ -1,0 +1,3 @@
+      {/* for L2 evidence hook only */}
+      <span data-evidence="fake-panel">ok</span>
`;
    const findings = findPlaceholderEvidenceHooks(diff);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]!.kind).toBe('placeholder-evidence-hook');
  });

  it('misses: real interactive control with data-evidence and real handler', () => {
    const diff = `diff --git a/src/web/SettingsPanel.tsx b/src/web/SettingsPanel.tsx
--- a/src/web/SettingsPanel.tsx
+++ b/src/web/SettingsPanel.tsx
@@ -100,0 +100,8 @@
+      <button
+        type="button"
+        data-evidence="settings-logout"
+        onClick={() => {
+          void api.logout();
+          navigate('/');
+        }}
+      >
+        Log out
+      </button>
`;
    expect(findPlaceholderEvidenceHooks(diff)).toEqual([]);
    expect(kinds(diff)).not.toContain('placeholder-evidence-hook');
  });

  it('misses: existing data-evidence only on context/removed lines (not newly added)', () => {
    const diff = `diff --git a/src/web/App.tsx b/src/web/App.tsx
--- a/src/web/App.tsx
+++ b/src/web/App.tsx
@@ -1,4 +1,4 @@
 <nav data-evidence="bottom-nav">
-  <button data-evidence="nav-tasks" disabled onClick={() => {}}>Tasks</button>
+  <button data-evidence="nav-tasks" onClick={() => openTasks()}>Tasks</button>
   <span>ok</span>
`;
    expect(findPlaceholderEvidenceHooks(diff)).toEqual([]);
  });

  it('misses: non-JSX source with the string data-evidence in a test or string', () => {
    const diff = `diff --git a/src/domain/evidence.ts b/src/domain/evidence.ts
--- a/src/domain/evidence.ts
+++ b/src/domain/evidence.ts
@@ -1,0 +1,2 @@
+const HOOK = 'data-evidence=nav-tasks';
+export const label = 'placeholder-host';
`;
    expect(findPlaceholderEvidenceHooks(diff)).toEqual([]);
  });

  it('misses: real data-evidence panel with nearby unrelated disabled empty WIP button (same-element scope)', () => {
    // L3 rework: pattern 1 must not soup ±12 lines — disabled+empty on a sibling
    // must not flag a real panel that only gained a data-evidence hook.
    const diff = `diff --git a/src/web/ReposPanel.tsx b/src/web/ReposPanel.tsx
--- a/src/web/ReposPanel.tsx
+++ b/src/web/ReposPanel.tsx
@@ -40,0 +40,14 @@
+      <section data-evidence="settings-panel" className="panel">
+        <h2>Settings</h2>
+        <button type="button" onClick={() => save()}>Save</button>
+      </section>
+      {/* WIP — not product chrome */}
+      <button
+        type="button"
+        disabled
+        onClick={() => { /* unfinished */ }}
+      >
+        WIP export
+      </button>
`;
    expect(findPlaceholderEvidenceHooks(diff)).toEqual([]);
  });

  it('misses: real control with product comment mentioning L2 near a real handler', () => {
    const diff = `diff --git a/src/web/Nav.tsx b/src/web/Nav.tsx
--- a/src/web/Nav.tsx
+++ b/src/web/Nav.tsx
@@ -5,0 +5,6 @@
+      {/* Exposed for L2 evidence plan — real navigation */}
+      <button
+        type="button"
+        data-evidence="nav-tasks"
+        onClick={() => goTasks()}
+      >Tasks</button>
`;
    expect(findPlaceholderEvidenceHooks(diff)).toEqual([]);
  });

  it('misses: product visible text containing bare "shell" is not placeholder host text', () => {
    const diff = `diff --git a/src/web/Shell.tsx b/src/web/Shell.tsx
--- a/src/web/Shell.tsx
+++ b/src/web/Shell.tsx
@@ -1,0 +1,1 @@
+      <div data-evidence="app-status">App shell ready</div>
`;
    expect(findPlaceholderEvidenceHooks(diff)).toEqual([]);
  });

  it('hits: same-element disabled + empty handler even when siblings are real controls', () => {
    const diff = `diff --git a/src/web/ReposPanel.tsx b/src/web/ReposPanel.tsx
--- a/src/web/ReposPanel.tsx
+++ b/src/web/ReposPanel.tsx
@@ -10,0 +10,12 @@
+      <button type="button" data-evidence="real-save" onClick={() => save()}>Save</button>
+      <button
+        type="button"
+        data-evidence="repo-mark-ready"
+        disabled
+        onClick={() => { /* no-op */ }}
+      >
+        Mark ready
+      </button>
`;
    const findings = findPlaceholderEvidenceHooks(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('placeholder-evidence-hook');
    expect(findings[0]!.detail).toMatch(/禁用|占位|L2/);
    // Line should point at the fake button's data-evidence, not the real Save.
    expect(findings[0]!.line).toBe(13);
  });
});
