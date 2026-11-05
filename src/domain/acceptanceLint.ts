/**
 * Domain — grammar-aware acceptance-criteria linter (creation-time).
 *
 * Surfaces unbound mechanical criteria and other binding-grammar issues before
 * a task is dispatched. Pure: uses parseDefinitionOfDone + parseMechProofBinding
 * / evaluateMechanicalCriterion — does not re-implement parsing.
 */
import {
  HUMAN_AFTER_DEPLOY_RE,
  ITEM_RE,
  KIND_PREFIX_RE,
  SECTION_RE,
  parseDefinitionOfDone,
} from './acceptance.js';
import {
  evaluateMechanicalCriterion,
  parseMechProofBinding,
} from './mechProof.js';
import {
  extractDataEvidenceHooks,
  parseTaskEvidenceSection,
  stepTargetsEvidenceHook,
} from './evidence.js';

export type AcLintSeverity = 'error' | 'warn' | 'info';

export type AcLintCode =
  | 'no-criteria'
  | 'unbound-mechanical'
  | 'all-gate-bound'
  | 'test-path-no-title'
  | 'probe-no-verifier'
  | 'stacked-bindings'
  | 'checkpoint-missing-step'
  | 'untyped-criterion'
  | 'duplicate-criterion'
  | 'evidence-hook-in-prose';

export interface AcLintFinding {
  readonly severity: AcLintSeverity;
  readonly code: AcLintCode;
  /** English, one line, includes the suggestion when there is one. */
  readonly message: string;
  /** 1-based line in body when the finding is about one item. */
  readonly line?: number;
  readonly criterion?: string;
}

export interface AcLintReport {
  /** True when there are no 'error' findings. */
  readonly ok: boolean;
  /** Stable order: by line, then code. */
  readonly findings: readonly AcLintFinding[];
  readonly counts: {
    readonly error: number;
    readonly warn: number;
    readonly info: number;
  };
}

const MAX_BODY_CHARS = 200_000;
const MAX_CRITERIA = 200;

const STACKED_BINDING_RE = /@(?:gate|evidence|test|prove|probe)\s*:/gi;
const CHECKPOINT_EN_RE = /^before\s+.+?:\s*.+$/i;
const CHECKPOINT_ZH_RE = /^在.+之前[:：].+$/;


function unboundSuggestionText(criterionText: string): string {
  const ev = evaluateMechanicalCriterion({
    criterionText,
    gatesPassed: true,
    gateNames: [],
    evidenceOk: null,
    evidenceStepDetails: [],
    filesTouched: [],
    selfAssessment: '',
  });
  const warning = ev.warning ?? '';
  const prefix = 'unbound mechanical criterion — ';
  if (warning.startsWith(prefix)) return warning.slice(prefix.length);
  return warning.length > 0
    ? warning
    : 'add @test:path#title, @evidence:anchor or @gate:name';
}

/** Cursor over the body: each criterion is located at/after the previous match so true duplicates get their own line. */
class LineLocator {
  private cursor: number;
  private readonly lines: readonly string[];
  constructor(private readonly body: string, sectionStart: number) {
    this.cursor = sectionStart;
    this.lines = body.split('\n');
  }
  /** 1-based line of the criterion's next occurrence; undefined if missing. */
  locate(criterionText: string): number | undefined {
    if (criterionText.length === 0) return undefined;
    const idx = this.body.indexOf(criterionText, this.cursor);
    if (idx < 0) return undefined;
    this.cursor = idx + criterionText.length;
    let line = 1;
    for (let i = 0; i < idx; i += 1) {
      if (this.body.charCodeAt(i) === 10) line += 1;
    }
    return line;
  }
  /** False only when the item on `line` provably lacks a (kind) prefix. */
  hasKindPrefix(line: number | undefined): boolean {
    if (line === undefined) return true;
    const raw = this.lines[line - 1];
    if (raw === undefined) return true;
    const item = ITEM_RE.exec(raw);
    if (!item?.[2]) return true;
    const rest = item[2].trim();
    return KIND_PREFIX_RE.test(rest) || HUMAN_AFTER_DEPLOY_RE.test(rest);
  }
}

function makeFinding(
  severity: AcLintSeverity,
  code: AcLintCode,
  message: string,
  opts?: { readonly line?: number; readonly criterion?: string },
): AcLintFinding {
  const out: {
    severity: AcLintSeverity;
    code: AcLintCode;
    message: string;
    line?: number;
    criterion?: string;
  } = { severity, code, message };
  if (opts?.line !== undefined) out.line = opts.line;
  if (opts?.criterion !== undefined) out.criterion = opts.criterion;
  return out;
}

function compareFindings(a: AcLintFinding, b: AcLintFinding): number {
  const la = a.line ?? 0;
  const lb = b.line ?? 0;
  if (la !== lb) return la - lb;
  return a.code.localeCompare(b.code);
}

function buildReport(findings: readonly AcLintFinding[]): AcLintReport {
  const sorted = [...findings].sort(compareFindings);
  let error = 0;
  let warn = 0;
  let info = 0;
  for (const f of sorted) {
    if (f.severity === 'error') error += 1;
    else if (f.severity === 'warn') warn += 1;
    else info += 1;
  }
  return {
    ok: error === 0,
    findings: sorted,
    counts: { error, warn, info },
  };
}

/**
 * Lint acceptance / Definition of Done criteria in a task body.
 */
export function lintAcceptance(body: string): AcLintReport {
  if (body.length > MAX_BODY_CHARS) {
    return buildReport([
      makeFinding('error', 'no-criteria', 'body too large to lint'),
    ]);
  }

  const dod = parseDefinitionOfDone(body);
  const findings: AcLintFinding[] = [];

  if (!dod.hasSection || dod.criteria.length === 0) {
    findings.push(
      makeFinding(
        'error',
        'no-criteria',
        dod.hasSection
          ? 'Acceptance criteria section has no items — add at least one criterion'
          : 'no ## Acceptance criteria / Definition of Done section — add typed criteria',
      ),
    );
    return buildReport(findings);
  }

  const sectionMatch = SECTION_RE.exec(body);
  const sectionStart =
    sectionMatch && sectionMatch.index !== undefined
      ? sectionMatch.index + sectionMatch[0].length
      : 0;

  const criteria = dod.criteria.slice(0, MAX_CRITERIA);
  const locator = new LineLocator(body, sectionStart);
  const seenClean = new Map<string, number>();
  const evidenceSteps = parseTaskEvidenceSection(body);
  let mechanicalCount = 0;
  let gateBoundCount = 0;

  for (const c of criteria) {
    const binding = parseMechProofBinding(c.text);
    const clean = binding.cleanText;
    const line = locator.locate(c.text);
    const display = clean.length > 0 ? clean : c.text;

    if (!locator.hasKindPrefix(line)) {
      findings.push(
        makeFinding(
          'info',
          'untyped-criterion',
          `untyped criterion treated as human — prefer (mechanical|reviewer|human|checkpoint): "${display.slice(0, 80)}"`,
          { ...(line !== undefined ? { line } : {}), criterion: display },
        ),
      );
    }

    const prior = seenClean.get(clean);
    if (prior !== undefined) {
      findings.push(
        makeFinding(
          'warn',
          'duplicate-criterion',
          `duplicate criterion text — already listed earlier: "${display.slice(0, 80)}"`,
          { ...(line !== undefined ? { line } : {}), criterion: display },
        ),
      );
    } else {
      seenClean.set(clean, line ?? 0);
    }

    const stacked = c.text.match(STACKED_BINDING_RE);
    if (stacked && stacked.length >= 2) {
      findings.push(
        makeFinding(
          'error',
          'stacked-bindings',
          `two @bindings on one line — write one criterion per proof: "${display.slice(0, 60)}"`,
          { ...(line !== undefined ? { line } : {}), criterion: display },
        ),
      );
    }

    const hooks = extractDataEvidenceHooks(clean);
    for (const hook of hooks) {
      if (binding.kind === 'evidence' && binding.ref === hook) continue;
      if (evidenceSteps.some((s) => stepTargetsEvidenceHook(s, [hook]))) continue;
      findings.push(
        makeFinding(
          'error',
          'evidence-hook-in-prose',
          `data-evidence=${hook} named in prose becomes a hard L2 assert with no scene that reaches it — bind it as @evidence:${hook} plus a ## Evidence step that navigates there, or drop the anchor name: "${display.slice(0, 60)}"`,
          { ...(line !== undefined ? { line } : {}), criterion: display },
        ),
      );
    }

    if (c.kind === 'checkpoint') {
      if (!CHECKPOINT_EN_RE.test(clean) && !CHECKPOINT_ZH_RE.test(clean)) {
        findings.push(
          makeFinding(
            'warn',
            'checkpoint-missing-step',
            `checkpoint should be "before <step>: <what>" (or 在<step>之前: <what>) — got "${display.slice(0, 80)}"`,
            { ...(line !== undefined ? { line } : {}), criterion: display },
          ),
        );
      }
    }

    if (c.kind !== 'mechanical') continue;

    mechanicalCount += 1;
    if (binding.kind === 'gate') gateBoundCount += 1;

    if (binding.kind === 'unbound') {
      const suggestion = unboundSuggestionText(c.text);
      findings.push(
        makeFinding(
          'error',
          'unbound-mechanical',
          `mechanical criterion never passes without a binding — ${suggestion}`,
          { ...(line !== undefined ? { line } : {}), criterion: display },
        ),
      );
    }

    if (binding.kind === 'test-path') {
      findings.push(
        makeFinding(
          'warn',
          'test-path-no-title',
          `prefer @test:${binding.ref}#<title> over path-only — title makes the contracted case explicit`,
          { ...(line !== undefined ? { line } : {}), criterion: display },
        ),
      );
    }

    if (binding.kind === 'probe') {
      const probeKind = binding.probeKind ?? 'unknown';
      findings.push(
        makeFinding(
          'warn',
          'probe-no-verifier',
          `@probe:${probeKind} has no verifier yet — criterion will stay pending until a verifier exists`,
          { ...(line !== undefined ? { line } : {}), criterion: display },
        ),
      );
    }
  }

  if (mechanicalCount >= 1 && gateBoundCount === mechanicalCount) {
    findings.push(
      makeFinding(
        'warn',
        'all-gate-bound',
        'every mechanical criterion is @gate: — add a feature proof (@test:… / @evidence:…) when this is not pure regression',
      ),
    );
  }

  return buildReport(findings);
}

/**
 * One-liner summary for UI/CLI, e.g. "2 errors · 1 warn: …".
 */
export function formatAcLint(report: AcLintReport): string {
  const parts: string[] = [];
  if (report.counts.error > 0) {
    parts.push(
      `${report.counts.error} error${report.counts.error === 1 ? '' : 's'}`,
    );
  }
  if (report.counts.warn > 0) {
    parts.push(`${report.counts.warn} warn`);
  }
  if (report.counts.info > 0) {
    parts.push(`${report.counts.info} info`);
  }
  if (parts.length === 0) return 'ok';
  const preview = report.findings
    .slice(0, 2)
    .map((f) => f.message)
    .join('; ');
  return `${parts.join(' · ')}: ${preview}`;
}
