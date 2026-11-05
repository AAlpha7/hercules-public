/**
 * Domain layer — declarative L2 evidence plan (elegant alternative to
 * guessing UI labels).
 *
 * Evidence is a **contract**: the SPA exposes stable `data-evidence` hooks;
 * WORKFLOW and/or the task body declare steps; the L2 runner executes them
 * without heuristics.
 *
 * Step kinds:
 *   unlock              — inject auth token (handled by runner before steps)
 *   click <selector>    — CSS selector (prefer [data-evidence=…])
 *   assert text=…       — regex/substring against document body (or selector)
 *   assert sel=<css>    — element must exist
 *   screenshot <name>   — capture PNG labeled for the packet
 *
 * Optional steps soft-fail (packet warning); required steps set plan.ok=false.
 */
import {
  classifyFeature,
  evidenceStepsForFeature,
  isEvidenceOffTopicForKind,
  isUiFeature,
} from './featureType.js';
import { extractProductBrief } from './taskBrief.js';
import { isEvidenceHookNegated } from './evidenceClaim.js';

export type EvidenceStepKind = 'unlock' | 'click' | 'assert' | 'screenshot';

export interface EvidenceStep {
  readonly kind: EvidenceStepKind;
  /** CSS selector for click / assert-sel. */
  readonly selector?: string;
  /** Text or /regex/ for assert. */
  readonly text?: string;
  /** Screenshot label (basename without .png). */
  readonly name?: string;
  /** Soft-fail when true (default false for task body; true for WORKFLOW filler). */
  readonly optional?: boolean;
  /** Original source line (packet/debug). */
  readonly raw?: string;
}

export interface EvidencePlan {
  readonly steps: readonly EvidenceStep[];
  /** Where the plan came from. */
  readonly source: 'task' | 'workflow' | 'default' | 'merged';
}

const UNLOCK_RE = /^unlock\b/i;
const CLICK_RE = /^click\s+(.+)$/i;
const SCREEN_RE = /^screenshot(?:\s*[:=]\s*|\s+)([A-Za-z0-9._-]+)\s*$/i;
const ASSERT_TEXT_RE = /^assert\s+text\s*[:=]\s*(.+)$/i;
const ASSERT_SEL_RE = /^assert\s+(?:sel|selector)\s*[:=]\s*(.+)$/i;
const OPTIONAL_RE = /\s+optional\s*$/i;

/** Parse one evidence line (string DSL). */
export function parseEvidenceLine(line: string): EvidenceStep | null {
  let raw = line.trim();
  if (raw.length === 0 || raw.startsWith('#')) return null;
  // Markdown list prefix
  raw = raw.replace(/^[-*]\s+/, '').trim();
  // Strip surrounding backticks
  if (raw.startsWith('`') && raw.endsWith('`')) raw = raw.slice(1, -1).trim();

  let optional = false;
  if (OPTIONAL_RE.test(raw)) {
    optional = true;
    raw = raw.replace(OPTIONAL_RE, '').trim();
  }

  if (UNLOCK_RE.test(raw)) {
    return { kind: 'unlock', optional, raw: line.trim() };
  }

  let m = CLICK_RE.exec(raw);
  if (m) {
    const selector = stripQuotes(m[1]!.trim());
    if (!selector) return null;
    return { kind: 'click', selector, optional, raw: line.trim() };
  }

  m = SCREEN_RE.exec(raw);
  if (m) {
    return { kind: 'screenshot', name: m[1]!.trim(), optional, raw: line.trim() };
  }

  m = ASSERT_TEXT_RE.exec(raw);
  if (m) {
    return { kind: 'assert', text: stripQuotes(m[1]!.trim()), optional, raw: line.trim() };
  }

  m = ASSERT_SEL_RE.exec(raw);
  if (m) {
    return { kind: 'assert', selector: stripQuotes(m[1]!.trim()), optional, raw: line.trim() };
  }

  // Object-like YAML already expanded to strings by callers
  return null;
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parse YAML-ish evidence entries (strings or small maps) from WORKFLOW front matter.
 */
export function parseEvidenceEntries(raw: unknown): EvidenceStep[] {
  if (!Array.isArray(raw)) return [];
  const out: EvidenceStep[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const step = parseEvidenceLine(item);
      if (step) out.push(step);
      continue;
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const optional = o['optional'] === true;
    if (o['unlock'] === true || o['unlock'] === '') {
      out.push({ kind: 'unlock', optional, raw: 'unlock' });
      continue;
    }
    if (typeof o['click'] === 'string') {
      out.push({
        kind: 'click',
        selector: o['click'],
        optional,
        raw: `click ${o['click']}`,
      });
      continue;
    }
    if (typeof o['screenshot'] === 'string') {
      out.push({
        kind: 'screenshot',
        name: o['screenshot'],
        optional,
        raw: `screenshot ${o['screenshot']}`,
      });
      continue;
    }
    if (typeof o['assert'] === 'string') {
      const step = parseEvidenceLine(`assert ${o['assert']}`);
      if (step) out.push({ ...step, optional: optional || step.optional === true });
      continue;
    }
    if (o['assert'] && typeof o['assert'] === 'object' && !Array.isArray(o['assert'])) {
      const a = o['assert'] as Record<string, unknown>;
      if (typeof a['text'] === 'string') {
        out.push({
          kind: 'assert',
          text: a['text'],
          optional,
          raw: `assert text=${a['text']}`,
        });
      } else if (typeof a['selector'] === 'string' || typeof a['sel'] === 'string') {
        const sel = String(a['selector'] ?? a['sel']);
        out.push({
          kind: 'assert',
          selector: sel,
          optional,
          raw: `assert sel=${sel}`,
        });
      }
    }
  }
  return out;
}

/** Parse `## Evidence` section from a task body (until next ##). */
export function parseTaskEvidenceSection(body: string): EvidenceStep[] {
  // Shared task-brief boundary: ignore harness audit tails.
  const source = extractProductBrief(body);
  const sec = /^##\s+Evidence\s*$/im.exec(source);
  if (!sec || sec.index === undefined) return [];
  const after = source.slice(sec.index + sec[0].length);
  const next = /^##\s+/m.exec(after);
  const block = (next ? after.slice(0, next.index) : after).trim();
  const steps: EvidenceStep[] = [];
  // Support both trailing `optional` on the step line and a following indented
  // `optional: true` (draft-from-intent / phone form emits the YAML-ish form).
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const step = parseEvidenceLine(line);
    if (!step) continue;
    let optional = step.optional === true;
    const peek = lines[i + 1] ?? '';
    if (/^\s+optional\s*:\s*true\s*$/i.test(peek)) {
      optional = true;
      i += 1; // consume the property line
    } else if (/^\s+optional\s*:\s*false\s*$/i.test(peek)) {
      optional = false;
      i += 1;
    }
    steps.push(optional === step.optional ? step : { ...step, optional });
  }
  return steps;
}

/**
 * True when ## Evidence is clearly the wrong chrome for the task intent
 * (e.g. pull-to-refresh task still carries optional Settings template).
 */
export function isEvidenceOffTopicForTask(
  taskBody: string,
  steps: readonly EvidenceStep[],
): boolean {
  const brief = taskBodyWithoutEvidenceSection(taskBody);
  if (steps.length === 0) return false;
  const kind = classifyFeature(brief);
  return isEvidenceOffTopicForKind(kind, steps);
}

/** Required PTR evidence plan (replaces Settings template for list-refresh tasks). */
export function pullToRefreshEvidenceSteps(): EvidenceStep[] {
  return evidenceStepsForFeature('pull_to_refresh') ?? [];
}

function repairStepsForBody(body: string): EvidenceStep[] | null {
  const kind = classifyFeature(taskBodyWithoutEvidenceSection(body));
  if (!isUiFeature(kind) && kind !== 'settings') return null;
  return evidenceStepsForFeature(kind);
}

/**
 * Resolve the plan: task ## Evidence wins when present; else WORKFLOW evidence;
 * else a minimal default (unlock + shell screenshot).
 *
 * When the task body **claims** `data-evidence=…` hooks (DoD / feature list —
 * outside `## Evidence`), matching click/assert steps become **required** even
 * if marked optional. Soft-fail optional is only for exploratory chrome the
 * task never promised.
 *
 * Off-topic Evidence for a classified feature is **replaced** with the canonical
 * template so L2 cannot greenwash (task-5 case study; extended to form/list/auth).
 */
export function resolveEvidencePlan(input: {
  readonly taskBody?: string;
  readonly workflowEvidence?: readonly EvidenceStep[];
}): EvidencePlan {
  const body = input.taskBody ?? '';
  const fromTask = parseTaskEvidenceSection(body);
  if (fromTask.length > 0) {
    if (isEvidenceOffTopicForTask(body, fromTask)) {
      const repair = repairStepsForBody(body);
      if (repair && repair.length > 0) {
        return {
          steps: ensureUnlockAndShot(hardenEvidenceHooks(body, repair)),
          source: 'task',
        };
      }
    }
    return {
      steps: ensureUnlockAndShot(hardenEvidenceHooks(body, fromTask)),
      source: 'task',
    };
  }
  const fromWf = input.workflowEvidence ?? [];
  if (fromWf.length > 0) {
    // WORKFLOW default may still be Settings chrome; repair for classified tasks.
    if (isEvidenceOffTopicForTask(body, fromWf)) {
      const repair = repairStepsForBody(body);
      if (repair && repair.length > 0) {
        return {
          steps: ensureUnlockAndShot(hardenEvidenceHooks(body, repair)),
          source: 'task',
        };
      }
    }
    return {
      steps: ensureUnlockAndShot(hardenEvidenceHooks(body, [...fromWf])),
      source: 'workflow',
    };
  }
  // No ## Evidence: if intent is a known UI feature, require its hooks.
  const repair = repairStepsForBody(body);
  if (repair && repair.length > 0 && classifyFeature(taskBodyWithoutEvidenceSection(body)) !== 'ui_generic') {
    return {
      steps: ensureUnlockAndShot(hardenEvidenceHooks(body, repair)),
      source: 'task',
    };
  }
  return {
    steps: [
      { kind: 'unlock', raw: 'unlock' },
      { kind: 'screenshot', name: 'shell', raw: 'screenshot shell' },
    ],
    source: 'default',
  };
}

/**
 * Strip `## Evidence` … next `##` so optional evidence lines do not self-claim
 * their own hooks (optional stays meaningful for exploratory steps).
 */
export function taskBodyWithoutEvidenceSection(taskBody: string): string {
  // Shared task-brief boundary (all harness sections, not only Review packet).
  const brief = extractProductBrief(taskBody);
  const sec = /^##\s+Evidence\s*$/im.exec(brief);
  if (!sec || sec.index === undefined) return brief;
  const before = brief.slice(0, sec.index);
  const after = brief.slice(sec.index + sec[0].length);
  const next = /^##\s+/m.exec(after);
  const rest = next ? after.slice(next.index) : '';
  return `${before}${rest}`;
}

/**
 * Lines that cite `data-evidence` as a *negative example* (cheat incident,
 * placeholder detection target) rather than a product promise. Harden must not
 * force L2 to assert those selectors exist (l5-placeholder-evidence-hook 2026-07-25).
 */
const NON_CLAIM_EVIDENCE_LINE =
  /仅为|占位|假\s|假的|作弊|中招|反作弊|无真实功能|空注释|造的占位|placeholder|no-op|empty\s+handler|shellMarkReady|unproven-ui-ac-host|anti-?cheat|for\s+L2|evidence\s+hook\s+only|识别为|detect(?:s|ing)?\s+placeholder/i;

/**
 * Section titles that document incidents / case studies — not DoD claims.
 * Content under these headings is excluded from claim extraction.
 *
 * Note: do **not** put `\b` after CJK alternatives. JS word boundaries are
 * ASCII-only (`\w` = [A-Za-z0-9_]), so `## 真实案例 (` never matched `\b`
 * and incident sections leaked into claim scan (l5-placeholder 2026-07-25).
 */
const NON_CLAIM_SECTION_RE =
  /^##\s*(?:真实案例|案例|Case\s*stud(?:y|ies)\b|Incidents?\b|Anti-?cheat\s*examples?\b)/im;

/**
 * Drop incident / case-study sections so example hooks are not treated as
 * product promises (WORKFLOW: claims come from DoD / feature list).
 */
export function taskBodyWithoutIncidentSections(taskBody: string): string {
  const lines = taskBody.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      skipping = NON_CLAIM_SECTION_RE.test(line);
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

/** Extract data-evidence attribute values mentioned as product claims. */
export function extractDataEvidenceHooks(taskBody: string): string[] {
  // Incident writeups name cheat selectors; never promote those to L2 claims.
  const prose = taskBodyWithoutIncidentSections(taskBody);
  const found = new Set<string>();
  // data-evidence=foo or data-evidence="foo"
  const eq = /data-evidence\s*=\s*["']?([a-z][a-z0-9_-]*)/gi;
  // Chinese/prose lists: data-evidence（nav-settings / settings-panel / …）
  // or data-evidence (nav-settings, settings-panel)
  const list =
    /data-evidence\b[\s=:：（(]*([a-z][a-z0-9_-]*(?:\s*[/|,、]\s*[a-z][a-z0-9_-]*)+)/gi;

  for (const line of prose.split('\n')) {
    if (NON_CLAIM_EVIDENCE_LINE.test(line)) continue;
    let m: RegExpExecArray | null;
    eq.lastIndex = 0;
    while ((m = eq.exec(line)) !== null) {
      if (m[1] && !isEvidenceHookNegated(line, m.index)) found.add(m[1]);
    }
    list.lastIndex = 0;
    while ((m = list.exec(line)) !== null) {
      if (isEvidenceHookNegated(line, m.index)) continue;
      const chunk = m[1] ?? '';
      for (const tok of chunk.split(/[/|,、\s]+/)) {
        if (/^[a-z][a-z0-9_-]*$/i.test(tok)) found.add(tok.toLowerCase());
      }
    }
  }
  return [...found];
}

/** True when a click/assert step targets one of the claimed hooks. */
export function stepTargetsEvidenceHook(
  step: EvidenceStep,
  hooks: readonly string[],
): boolean {
  if (hooks.length === 0) return false;
  if ((step.kind === 'click' || step.kind === 'assert') && step.selector) {
    return hooks.some((h) => step.selector!.includes(`data-evidence=${h}`));
  }
  return false;
}

/**
 * Promote optional click/assert steps (and add missing asserts) for hooks the
 * task body claims outside `## Evidence`. Critical path cannot soft-fail.
 */
function hardenEvidenceHooks(
  taskBody: string,
  steps: EvidenceStep[],
): EvidenceStep[] {
  // Claims live in DoD / feature prose — not in the Evidence plan itself, and
  // not in prior review packets.
  const claimSource = taskBodyWithoutEvidenceSection(taskBody);
  const hooks = extractDataEvidenceHooks(claimSource);
  if (hooks.length === 0) return steps;

  const out = steps.map((s) => {
    if (!s.optional || !stepTargetsEvidenceHook(s, hooks)) return s;
    const raw = (s.raw ?? '').replace(/\s+optional\s*$/i, '') || describeStep(s);
    return { ...s, optional: false, raw };
  });

  for (const h of hooks) {
    const sel = `[data-evidence=${h}]`;
    // Bottom-nav destinations need a click so subsequent panel asserts succeed
    // when the SPA mounts sheets only after navigation (Settings/Releases/etc.).
    if (h.startsWith('nav-')) {
      const hasClick = out.some(
        (s) => s.kind === 'click' && s.selector?.includes(`data-evidence=${h}`),
      );
      if (!hasClick) {
        out.push({
          kind: 'click',
          selector: sel,
          raw: `click ${sel}`,
        });
      }
      continue;
    }
    const covered = out.some(
      (s) =>
        (s.kind === 'assert' && s.selector?.includes(`data-evidence=${h}`)) ||
        (s.kind === 'click' && s.selector?.includes(`data-evidence=${h}`)),
    );
    if (!covered) {
      out.push({
        kind: 'assert',
        selector: sel,
        raw: `assert sel=${sel}`,
      });
    }
  }
  return out;
}

function describeStep(s: EvidenceStep): string {
  if (s.kind === 'click' && s.selector) return `click ${s.selector}`;
  if (s.kind === 'assert' && s.selector) return `assert sel=${s.selector}`;
  if (s.kind === 'assert' && s.text) return `assert text=${s.text}`;
  if (s.kind === 'screenshot' && s.name) return `screenshot ${s.name}`;
  return s.kind;
}

/** Ensure plan starts with unlock and has at least one screenshot. */
function ensureUnlockAndShot(steps: EvidenceStep[]): EvidenceStep[] {
  const out = [...steps];
  if (!out.some((s) => s.kind === 'unlock')) {
    out.unshift({ kind: 'unlock', raw: 'unlock' });
  }
  if (!out.some((s) => s.kind === 'screenshot')) {
    out.push({ kind: 'screenshot', name: 'shell', raw: 'screenshot shell' });
  }
  return out;
}

export interface EvidenceStepResult {
  readonly step: EvidenceStep;
  readonly ok: boolean;
  readonly detail: string;
  /** Basename of PNG when this step captured one. */
  readonly screenshot?: string;
  /** Lowercase hex sha256 of the screenshot bytes when captured. */
  readonly screenshotSha256?: string;
}

export interface EvidenceRunSummary {
  readonly plan: EvidencePlan;
  readonly results: readonly EvidenceStepResult[];
  /** False when any required step failed. */
  readonly ok: boolean;
  readonly screenshots: readonly string[];
}
