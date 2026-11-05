/**
 * Domain — test-source static / transform diagnostic policy.
 *
 * Test TypeScript and transform diagnostics are part of the executable
 * specification: a green Vitest run with silent esbuild/tsc warnings can
 * invalidate fixtures (e.g. duplicate object keys). This module is pure:
 * classify, allowlist-filter, and format structured diagnostics. Collectors
 * live in verification/ (TypeScript program API, esbuild messages).
 *
 * Design constraints:
 * - Prefer structured compiler/transform evidence over brittle stderr greps.
 * - Do NOT promote arbitrary runtime warnings (React act, etc.).
 * - Allowlist entries are exact (source + code and/or full message) with
 *   stable reason codes — never substring wildcards that mask new faults.
 */
import { redactHostOutput } from './hostExecutor.js';

/** Tool that produced the diagnostic. */
export type StaticDiagnosticSource = 'typescript' | 'esbuild' | 'vite';

export type StaticDiagnosticSeverity = 'error' | 'warning' | 'info';

/** One structured static/transform finding (file/line when known). */
export interface StaticDiagnostic {
  readonly source: StaticDiagnosticSource;
  readonly severity: StaticDiagnosticSeverity;
  /** Tool-stable code when available (e.g. TS1117, or esbuild id). */
  readonly code: string | null;
  readonly message: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
}

/**
 * Exact allowlist entry for known non-actionable tool noise.
 * Match requires: source equality AND (code equality if both set) AND
 * (messageExact equality if set). At least code or messageExact required.
 */
export interface StaticDiagnosticAllowlistEntry {
  /** Stable reason code for docs + packet (not free-form prose). */
  readonly reasonCode: string;
  readonly source: StaticDiagnosticSource;
  /** When set, must equal diagnostic.code exactly. */
  readonly code: string | null;
  /** When set, must equal diagnostic.message exactly (full string). */
  readonly messageExact: string | null;
  /** Why this noise is non-actionable (human docs). */
  readonly doc: string;
}

/**
 * Default allowlist — intentionally empty / narrow.
 * Runtime Vitest/React warnings are never listed here: they are not static
 * diagnostics and must not be globally promoted via stderr greps.
 *
 * Add entries only with a unit test that pins the exact code/message and a
 * reasonCode. Broad patterns that could mask new diagnostics are rejected
 * by assertAllowlistEntryValid.
 */
export const DEFAULT_STATIC_DIAGNOSTIC_ALLOWLIST: readonly StaticDiagnosticAllowlistEntry[] =
  Object.freeze([]);

/** Severity ranks: info is never actionable for this gate. */
const SEVERITY_RANK: Record<StaticDiagnosticSeverity, number> = {
  error: 2,
  warning: 1,
  info: 0,
};

/** Max diagnostics included in a gate report. */
export const STATIC_DIAGNOSTIC_REPORT_MAX_ITEMS = 20;

/** Max chars for the full redacted report body. */
export const STATIC_DIAGNOSTIC_REPORT_MAX_CHARS = 4_000;

export class StaticDiagnosticAllowlistError extends Error {
  override readonly name = 'StaticDiagnosticAllowlistError';
}

const REASON_CODE_RE = /^[a-z][a-z0-9-]{2,64}$/;

function messageLooksLikePattern(message: string): boolean {
  if (message.includes('*') || message.includes('?')) return true;
  if (message.includes('.*') || message.includes('[^')) return true;
  if (message.includes('(?')) return true;
  return false;
}

/**
 * Reject allowlist entries that could mask new diagnostics (empty matchers,
 * wildcard-ish message patterns, missing reason codes).
 */
export function assertAllowlistEntryValid(
  entry: StaticDiagnosticAllowlistEntry,
): void {
  if (!entry.reasonCode || !REASON_CODE_RE.test(entry.reasonCode)) {
    throw new StaticDiagnosticAllowlistError(
      'allowlist reasonCode must be kebab-case (got ' +
        JSON.stringify(entry.reasonCode) +
        ')',
    );
  }
  if (!entry.code && !entry.messageExact) {
    throw new StaticDiagnosticAllowlistError(
      'allowlist ' + entry.reasonCode + ': need exact code and/or messageExact',
    );
  }
  if (entry.messageExact !== null) {
    if (entry.messageExact.length === 0) {
      throw new StaticDiagnosticAllowlistError(
        'allowlist ' + entry.reasonCode + ': messageExact must not be empty',
      );
    }
    if (messageLooksLikePattern(entry.messageExact)) {
      throw new StaticDiagnosticAllowlistError(
        'allowlist ' +
          entry.reasonCode +
          ': messageExact must be a literal string, not a pattern',
      );
    }
  }
  if (entry.code !== null && entry.code.length === 0) {
    throw new StaticDiagnosticAllowlistError(
      'allowlist ' + entry.reasonCode + ': code must not be empty when set',
    );
  }
  if (!entry.doc || entry.doc.trim().length < 8) {
    throw new StaticDiagnosticAllowlistError(
      'allowlist ' +
        entry.reasonCode +
        ': doc must explain why noise is non-actionable',
    );
  }
}

export function assertAllowlistValid(
  entries: readonly StaticDiagnosticAllowlistEntry[],
): void {
  const seen = new Set<string>();
  for (const e of entries) {
    assertAllowlistEntryValid(e);
    if (seen.has(e.reasonCode)) {
      throw new StaticDiagnosticAllowlistError(
        'duplicate allowlist reasonCode: ' + e.reasonCode,
      );
    }
    seen.add(e.reasonCode);
  }
}

/** True when the diagnostic is exactly covered by one allowlist entry. */
export function isAllowlistedStaticDiagnostic(
  diag: StaticDiagnostic,
  allowlist: readonly StaticDiagnosticAllowlistEntry[] = DEFAULT_STATIC_DIAGNOSTIC_ALLOWLIST,
): boolean {
  for (const entry of allowlist) {
    if (entry.source !== diag.source) continue;
    // Invalid entries never match (cannot mask by omitting both matchers).
    if (entry.code === null && entry.messageExact === null) continue;
    if (entry.code !== null) {
      if (diag.code === null || entry.code !== diag.code) continue;
    }
    if (entry.messageExact !== null) {
      if (entry.messageExact !== diag.message) continue;
    }
    return true;
  }
  return false;
}

/**
 * Actionable = error or warning severity, not allowlisted.
 * Info-level tool chatter is never a hard fail (not promoted).
 */
export function isActionableStaticDiagnostic(
  diag: StaticDiagnostic,
  allowlist: readonly StaticDiagnosticAllowlistEntry[] = DEFAULT_STATIC_DIAGNOSTIC_ALLOWLIST,
): boolean {
  if (SEVERITY_RANK[diag.severity] < SEVERITY_RANK.warning) return false;
  if (isAllowlistedStaticDiagnostic(diag, allowlist)) return false;
  return true;
}

export function filterActionableStaticDiagnostics(
  diags: readonly StaticDiagnostic[],
  allowlist: readonly StaticDiagnosticAllowlistEntry[] = DEFAULT_STATIC_DIAGNOSTIC_ALLOWLIST,
): readonly StaticDiagnostic[] {
  return diags.filter((d) => isActionableStaticDiagnostic(d, allowlist));
}

export interface StaticDiagnosticsGateResult {
  readonly ok: boolean;
  readonly actionable: readonly StaticDiagnostic[];
  readonly allowlisted: readonly StaticDiagnostic[];
  /** Bounded, secret-redacted evidence for gate output / packet. */
  readonly report: string;
}

function formatOne(d: StaticDiagnostic): string {
  let loc = '(no-file)';
  if (d.file != null) {
    if (d.line != null && d.column != null) {
      loc = d.file + ':' + d.line + ':' + d.column;
    } else if (d.line != null) {
      loc = d.file + ':' + d.line;
    } else {
      loc = d.file;
    }
  }
  const code = d.code ? '[' + d.code + '] ' : '';
  const safeMessage = redactHostOutput(d.message, STATIC_DIAGNOSTIC_REPORT_MAX_CHARS);
  // Message-only redaction keeps file/line/code out of [REDACTED LINE] blanking.
  return d.source + ' ' + d.severity + ' ' + loc + ': ' + code + safeMessage;
}

/**
 * Evaluate structured diagnostics against the allowlist and produce a
 * bounded redacted report. Does not inspect raw stderr — callers must feed
 * structured evidence from tsc/esbuild APIs.
 */
export function evaluateStaticDiagnostics(
  diags: readonly StaticDiagnostic[],
  allowlist: readonly StaticDiagnosticAllowlistEntry[] = DEFAULT_STATIC_DIAGNOSTIC_ALLOWLIST,
): StaticDiagnosticsGateResult {
  assertAllowlistValid(allowlist);
  const actionable = filterActionableStaticDiagnostics(diags, allowlist);
  const allowlisted = diags.filter((d) => isAllowlistedStaticDiagnostic(d, allowlist));
  if (actionable.length === 0) {
    return {
      ok: true,
      actionable: [],
      allowlisted,
      report: 'test-source static diagnostics: clean',
    };
  }
  const head = actionable.slice(0, STATIC_DIAGNOSTIC_REPORT_MAX_ITEMS);
  const extra = actionable.length - head.length;
  const lines = [
    'test-source static diagnostics: ' +
      String(actionable.length) +
      ' actionable finding(s)',
    ...head.map((d) => '- ' + formatOne(d)),
  ];
  if (extra > 0) lines.push('- ... +' + String(extra) + ' more');
  const raw = lines.join('\n');
  // Secrets already redacted per-message in formatOne. Bound length only so
  // full-line blanking cannot erase structured file/line/code evidence.
  const max = STATIC_DIAGNOSTIC_REPORT_MAX_CHARS;
  const report =
    raw.length <= max ? raw : raw.slice(-max);
  return { ok: false, actionable, allowlisted, report };
}

/**
 * Codes that are always treated as static/transform failures when present
 * (documentation + tests). Collectors may surface additional codes.
 */
export const KNOWN_ACTIONABLE_STATIC_CODES = Object.freeze({
  /** Object literal cannot have multiple properties with the same name. */
  typescriptDuplicateKey: 'TS1117',
  /** Cannot find module / unresolved import. */
  typescriptUnresolvedModule: 'TS2307',
  /** Cannot find name (often broken syntax recovery residue). */
  typescriptCannotFindName: 'TS2304',
} as const);
