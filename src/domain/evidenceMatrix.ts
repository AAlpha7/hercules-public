/**
 * Domain — build a per-criterion evidence matrix for the review packet.
 *
 * Joins typed DoD rows with citations scraped from the agent's self-assessment
 * so the phone UI can show Criterion → kind → status → evidence at a glance.
 */
import type { CriterionKind } from './acceptance.js';
import type { EvidenceStep, EvidenceStepResult } from './evidence.js';
import { parseScenarioBinding } from './mechProof.js';
import {
  findUnprovenUiCriteria,
  formatCliEvidenceCell,
  matchCliEvidenceForHuman,
  type CliEvidenceLinkStep,
} from './uiAcEvidence.js';
import type { EvidenceMatrixRow } from './verification.js';

export interface MatrixCriterion {
  readonly text: string;
  readonly kind: CriterionKind;
  readonly status: string;
}

export interface BuildEvidenceMatrixOpts {
  /** Resolved L2 plan steps (for UI-AC ↔ evidence gap detection). */
  readonly evidencePlanSteps?: readonly EvidenceStep[];
  /** Optional L2 run results (relatedness via detail/screenshot names). */
  readonly evidenceResults?: readonly EvidenceStepResult[];
  /** Trusted CLI evidence steps (human AC ↔ scenario / recording linkage). */
  readonly cliSteps?: readonly CliEvidenceLinkStep[];
}

/**
 * Extract a short evidence citation for one criterion from free-form
 * self-assessment text (tables, bullets, or prose that mentions the criterion).
 */
export function citeEvidenceForCriterion(criterionText: string, selfAssessment: string): string {
  const sa = selfAssessment.trim();
  if (!sa || sa === '(agent provided none)' || sa === '(none)') {
    return '(no evidence cited)';
  }

  const needle = criterionText.trim().toLowerCase();
  const needleKey = significantTokens(needle).slice(0, 6);
  const lines = sa.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  // Prefer a line that contains most of the criterion wording.
  let best: { line: string; score: number } | null = null;
  for (const line of lines) {
    const lower = line.toLowerCase();
    // Skip pure headers
    if (/^#{1,3}\s/.test(line) || /^\|?\s*-+\s*\|/.test(line)) continue;
    if (needle.length >= 8 && lower.includes(needle.slice(0, Math.min(needle.length, 48)))) {
      return cleanEvidenceLine(line);
    }
    if (needleKey.length === 0) continue;
    let hits = 0;
    for (const t of needleKey) {
      if (lower.includes(t)) hits += 1;
    }
    const score = hits / needleKey.length;
    if (score >= 0.5 && (!best || score > best.score)) {
      best = { line, score };
    }
  }
  if (best) return cleanEvidenceLine(best.line);

  // Table row: | criterion | evidence | style — last cell often holds proof
  for (const line of lines) {
    if (!line.includes('|')) continue;
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length < 2) continue;
    const joined = cells.join(' ').toLowerCase();
    if (needleKey.some((t) => joined.includes(t))) {
      return cleanEvidenceLine(cells[cells.length - 1]!);
    }
  }

  return '(no evidence cited)';
}

function significantTokens(text: string): string[] {
  return text
    .replace(/[`*_[\]()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !/^(the|and|for|with|that|this|from|when|are|was)$/i.test(t));
}

function cleanEvidenceLine(line: string): string {
  let s = line
    .replace(/^[-*]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/^\|?\s*/, '')
    .replace(/\s*\|$/, '')
    .trim();
  // Drop leading kind tags
  s = s.replace(/^(?:\[[^\]]+\]|\([^)]+\)|（[^）]+）)\s*/, '');
  if (s.length > 160) s = `${s.slice(0, 157)}…`;
  return s.length > 0 ? s : '(no evidence cited)';
}

/** Build matrix rows from DoD criteria + self-assessment citations. */
export function buildEvidenceMatrix(
  criteria: readonly MatrixCriterion[],
  selfAssessment: string,
  opts?: BuildEvidenceMatrixOpts,
): EvidenceMatrixRow[] {
  if (criteria.length === 0) {
    // No typed DoD — still surface self-assessment as a single free-form row.
    const ev = selfAssessment.trim();
    if (!ev || ev === '(agent provided none)' || ev === '(none)') return [];
    return [
      {
        text: '(no typed acceptance criteria)',
        kind: 'human',
        status: 'pending',
        evidence: cleanEvidenceLine(ev.split('\n').find((l) => l.trim()) ?? ev),
      },
    ];
  }

  const cliSteps = opts?.cliSteps ?? [];
  // checkpoint counts as human-authority for Approve / UI-AC gap detection.
  // Keep raw text (with @scenario) for linkage; display uses stripped text.
  const humanTexts = criteria
    .filter((c) => c.kind === 'human' || c.kind === 'checkpoint')
    .map((c) => c.text);
  const unproven =
    opts?.evidencePlanSteps !== undefined
      ? findUnprovenUiCriteria({
          humanCriteria: humanTexts,
          evidencePlanSteps: opts.evidencePlanSteps,
          ...(opts.evidenceResults ? { evidenceResults: opts.evidenceResults } : {}),
          ...(cliSteps.length > 0 ? { cliSteps } : {}),
        })
      : [];
  const unprovenByText = new Map(unproven.map((u) => [u.text, u]));

  return criteria.map((c) => {
    const displayText =
      c.kind === 'human' || c.kind === 'checkpoint'
        ? parseScenarioBinding(c.text).cleanText || c.text
        : c.text;
    const base: EvidenceMatrixRow = {
      text: displayText,
      kind: c.kind,
      status: c.status,
      evidence: citeEvidenceForCriterion(c.text, selfAssessment),
    };
    if (c.kind !== 'human' && c.kind !== 'checkpoint') return base;

    const cliLink = matchCliEvidenceForHuman(c.text, cliSteps);
    if (cliLink !== null) {
      return {
        ...base,
        evidence: formatCliEvidenceCell(cliLink),
      };
    }

    const gap = unprovenByText.get(displayText) ?? unprovenByText.get(c.text);
    if (!gap) return base;
    return {
      ...base,
      unprovenUiWarning: gap.warning,
      unprovenUiReason: gap.reason,
    };
  });
}
