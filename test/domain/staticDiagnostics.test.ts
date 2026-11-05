/**
 * Pure policy for test-source static/transform diagnostics.
 */
import { describe, it, expect } from 'vitest';
import {
  assertAllowlistEntryValid,
  assertAllowlistValid,
  DEFAULT_STATIC_DIAGNOSTIC_ALLOWLIST,
  evaluateStaticDiagnostics,
  filterActionableStaticDiagnostics,
  isActionableStaticDiagnostic,
  isAllowlistedStaticDiagnostic,
  KNOWN_ACTIONABLE_STATIC_CODES,
  STATIC_DIAGNOSTIC_REPORT_MAX_CHARS,
  StaticDiagnosticAllowlistError,
  type StaticDiagnostic,
  type StaticDiagnosticAllowlistEntry,
} from '../../src/domain/staticDiagnostics.js';

function diag(
  overrides: Partial<StaticDiagnostic> & Pick<StaticDiagnostic, 'message'>,
): StaticDiagnostic {
  return {
    source: 'typescript',
    severity: 'error',
    code: KNOWN_ACTIONABLE_STATIC_CODES.typescriptDuplicateKey,
    file: 'test/web/render/bad.render.test.tsx',
    line: 12,
    column: 5,
    ...overrides,
  };
}

describe('staticDiagnostics policy', () => {
  it('default allowlist is empty (no silent global promotion)', () => {
    expect(DEFAULT_STATIC_DIAGNOSTIC_ALLOWLIST).toEqual([]);
  });

  it('treats duplicate-key / unresolved-import codes as actionable', () => {
    const dup = diag({
      code: KNOWN_ACTIONABLE_STATIC_CODES.typescriptDuplicateKey,
      message: "An object literal cannot have multiple properties with the same name.",
    });
    const unresolved = diag({
      code: KNOWN_ACTIONABLE_STATIC_CODES.typescriptUnresolvedModule,
      message: "Cannot find module './missing.js' or its corresponding type declarations.",
    });
    expect(isActionableStaticDiagnostic(dup)).toBe(true);
    expect(isActionableStaticDiagnostic(unresolved)).toBe(true);
  });

  it('does not promote info-level tool chatter', () => {
    const info = diag({
      severity: 'info',
      code: null,
      message: 'some compiler note',
    });
    expect(isActionableStaticDiagnostic(info)).toBe(false);
  });

  it('does not treat runtime act() text as a structured diagnostic by itself', () => {
    // Policy: only structured StaticDiagnostic objects count. Raw runtime
    // strings never enter evaluateStaticDiagnostics unless a collector maps them.
    const runtimeNoise =
      'Warning: An update to TaskDetail inside a test was not wrapped in act(...)';
    const result = evaluateStaticDiagnostics([]);
    expect(result.ok).toBe(true);
    expect(result.report).toMatch(/clean/);
    // A mis-modeled runtime string as a diagnostic would still need severity.
    // Info stays non-actionable; we never grep stderr for "Warning:".
    expect(
      isActionableStaticDiagnostic(
        diag({ severity: 'info', code: null, message: runtimeNoise }),
      ),
    ).toBe(false);
  });

  it('allowlist matches only exact source+code and/or full message', () => {
    const entry: StaticDiagnosticAllowlistEntry = {
      reasonCode: 'esbuild-known-noise',
      source: 'esbuild',
      code: 'NOISE-ID',
      messageExact: null,
      doc: 'Documented benign transform noise for a pinned esbuild version.',
    };
    assertAllowlistEntryValid(entry);
    const allowed = diag({
      source: 'esbuild',
      severity: 'warning',
      code: 'NOISE-ID',
      message: 'anything for this code',
    });
    const otherCode = diag({
      source: 'esbuild',
      severity: 'warning',
      code: 'OTHER-ID',
      message: 'anything for this code',
    });
    const otherSource = diag({
      source: 'typescript',
      severity: 'warning',
      code: 'NOISE-ID',
      message: 'anything for this code',
    });
    expect(isAllowlistedStaticDiagnostic(allowed, [entry])).toBe(true);
    expect(isAllowlistedStaticDiagnostic(otherCode, [entry])).toBe(false);
    expect(isAllowlistedStaticDiagnostic(otherSource, [entry])).toBe(false);
    expect(isActionableStaticDiagnostic(allowed, [entry])).toBe(false);
    expect(isActionableStaticDiagnostic(otherCode, [entry])).toBe(true);
  });

  it('allowlist messageExact cannot use patterns that would mask new diagnostics', () => {
    expect(() =>
      assertAllowlistEntryValid({
        reasonCode: 'bad-glob',
        source: 'esbuild',
        code: null,
        messageExact: 'Duplicate key * in object',
        doc: 'Would mask any duplicate-key message.',
      }),
    ).toThrow(StaticDiagnosticAllowlistError);

    expect(() =>
      assertAllowlistEntryValid({
        reasonCode: 'no-matcher',
        source: 'esbuild',
        code: null,
        messageExact: null,
        doc: 'Missing both matchers.',
      }),
    ).toThrow(/code and\/or messageExact/);
  });

  it('rejects duplicate reason codes in an allowlist', () => {
    const a: StaticDiagnosticAllowlistEntry = {
      reasonCode: 'same-code',
      source: 'esbuild',
      code: 'A',
      messageExact: null,
      doc: 'First documented entry for testing.',
    };
    const b: StaticDiagnosticAllowlistEntry = {
      reasonCode: 'same-code',
      source: 'esbuild',
      code: 'B',
      messageExact: null,
      doc: 'Second documented entry for testing.',
    };
    expect(() => assertAllowlistValid([a, b])).toThrow(/duplicate allowlist reasonCode/);
  });

  it('evaluate fails with file/line and redacts secrets in evidence', () => {
    const secretDiag = diag({
      message:
        'Cannot resolve Authorization: Bearer sk-live-abc123token in import',
      file: 'test/web/render/dup.render.test.tsx',
      line: 4,
      column: 9,
    });
    const result = evaluateStaticDiagnostics([secretDiag]);
    expect(result.ok).toBe(false);
    expect(result.report).toContain('test/web/render/dup.render.test.tsx:4:9');
    expect(result.report).toContain(KNOWN_ACTIONABLE_STATIC_CODES.typescriptDuplicateKey);
    expect(result.report).toMatch(/REDACTED/);
    expect(result.report).not.toContain('sk-live-abc123token');
    expect(result.report.length).toBeLessThanOrEqual(STATIC_DIAGNOSTIC_REPORT_MAX_CHARS + 80);
  });

  it('evaluate is green when only allowlisted diagnostics remain', () => {
    const entry: StaticDiagnosticAllowlistEntry = {
      reasonCode: 'pinned-esbuild-noise',
      source: 'esbuild',
      code: 'PINNED',
      messageExact: null,
      doc: 'Pinned non-actionable esbuild noise covered by a unit test.',
    };
    const onlyNoise = diag({
      source: 'esbuild',
      severity: 'warning',
      code: 'PINNED',
      message: 'known noise',
    });
    const result = evaluateStaticDiagnostics([onlyNoise], [entry]);
    expect(result.ok).toBe(true);
    expect(result.allowlisted).toHaveLength(1);
    expect(filterActionableStaticDiagnostics([onlyNoise], [entry])).toEqual([]);
  });

  it('cannot bypass by renaming a warning — match is on structured code/message', () => {
    const entry: StaticDiagnosticAllowlistEntry = {
      reasonCode: 'exact-message-only',
      source: 'esbuild',
      code: null,
      messageExact: 'Duplicate key "policy" in object literal',
      doc: 'Exact message pin for a known esbuild wording.',
    };
    const renamed = diag({
      source: 'esbuild',
      severity: 'warning',
      code: null,
      message: 'Duplicate key "policy" in object literal (renamed)',
    });
    expect(isAllowlistedStaticDiagnostic(renamed, [entry])).toBe(false);
    expect(evaluateStaticDiagnostics([renamed], [entry]).ok).toBe(false);
  });
});
