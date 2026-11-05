/**
 * Domain — human AC how-to-verify + action patterns (CEO surface).
 *
 * Human acceptance items used to show only "check after you verify" with no
 * guidance on *what* to verify, *how*, or *where* to act. This module extracts
 * real sources only (never invents):
 *
 *   (a) task body `## Operator checklist` / `## 核验指引`
 *   (b) per-criterion self-assessment evidence text
 *   (c) branch paths matching operator / readiness checklist globs
 *
 * Pure — no IO / git / fs / network.
 */

export interface HumanAcGuidance {
  /** How to verify — null when no real source. */
  readonly how: string | null;
  /** Repo-relative doc paths the CEO can open in-place. */
  readonly refs: readonly string[];
}

export interface HumanAcAction {
  readonly kind: 'mark-ready';
  /** Button label (EN or ZH). */
  readonly label: string;
}

const CHECKLIST_HEADINGS = ['Operator checklist', '核验指引'] as const;

/** Extract `## Operator checklist` / `## 核验指引` section body, or null. */
export function extractOperatorChecklistSection(taskBody: string): string | null {
  for (const heading of CHECKLIST_HEADINGS) {
    const m = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'm').exec(taskBody);
    if (!m || m.index === undefined) continue;
    const rest = taskBody.slice(m.index + m[0].length);
    const stop = rest.search(/^##\s+/m);
    const block = (stop >= 0 ? rest.slice(0, stop) : rest).trim();
    if (block.length > 0) return block;
  }
  return null;
}

/**
 * Paths matching:
 *   - any path whose basename is operator-checklist*.md
 *   - docs/agent/*readiness*checklist*.md
 */
export function matchOperatorChecklistPaths(files: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const raw of files) {
    const n = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!n.toLowerCase().endsWith('.md')) continue;
    const base = n.includes('/') ? n.slice(n.lastIndexOf('/') + 1) : n;
    if (/^operator-checklist.*\.md$/i.test(base)) {
      out.push(n);
      continue;
    }
    // docs/agent/*readiness*checklist*.md (glob * = any run of chars)
    if (/^docs\/agent\/[^/]*readiness[^/]*checklist[^/]*\.md$/i.test(n)) {
      out.push(n);
    }
  }
  return out;
}

/** Repo-relative `.md` paths mentioned in free text (backticks optional). */
export function extractMentionedPaths(text: string): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Require at least one `/` so bare `AGENTS.md` is not treated as a ref path
  // the file API can open as a nested checklist (still openable via browse).
  const re = /(?:^|[\s`"'([{])((?:[\w.-]+\/)+[\w.-]+\.md)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1]!.replace(/\\/g, '/');
    if (p.includes('..') || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** True when evidence is a real citation, not a placeholder. */
export function isUsefulHumanEvidence(evidence: string): boolean {
  const t = evidence.trim();
  if (t.length === 0) return false;
  if (/^\(no evidence cited\)$/i.test(t)) return false;
  if (/^\(agent provided none\)$/i.test(t)) return false;
  if (/^\(none\)$/i.test(t)) return false;
  if (/^\(human判断\)$/i.test(t)) return false;
  if (/^pending\b/i.test(t)) return false;
  return true;
}

/**
 * Action-type human AC patterns (human still clicks — never auto-approve):
 *   - `set … in Repos UI`
 *   - `mark … ready`
 *   - `在 … 界面设置`
 */
export function matchHumanAcAction(text: string): HumanAcAction | null {
  const t = text.replace(/\*+/g, '').trim();
  if (t.length === 0) return null;

  // EN: set … in Repos UI
  if (/\bset\b[\s\S]{0,80}\bin\s+Repos\s+UI\b/i.test(t)) {
    return { kind: 'mark-ready', label: 'Mark ready' };
  }
  // EN: mark … ready (also "Mark ready in Repos")
  if (/\bmark\b[\s\S]{0,40}\bready\b/i.test(t)) {
    return { kind: 'mark-ready', label: 'Mark ready' };
  }
  // ZH: 在 … 界面设置
  if (/在[\s\S]{0,40}界面\s*设置/.test(t)) {
    return { kind: 'mark-ready', label: '标记就绪' };
  }
  return null;
}

export interface ResolveHumanAcInput {
  readonly criterionText: string;
  readonly taskBody: string;
  /** Per-criterion self-assessment / matrix evidence line. */
  readonly evidence: string;
  /** Files on the verified branch (or filesTouched). */
  readonly files: readonly string[];
}

/**
 * Resolve how + refs with source priority:
 *   (a) Operator checklist / 核验指引 section → how
 *   (b) else useful self-assessment evidence → how
 *   (c) checklist path globs on the branch → refs
 *
 * Paths mentioned in how/evidence are merged into refs when present.
 * Never invents: empty how/refs when no source.
 */
export function resolveHumanAcGuidance(input: ResolveHumanAcInput): HumanAcGuidance {
  const section = extractOperatorChecklistSection(input.taskBody);
  let how: string | null = null;
  if (section !== null) {
    how = section;
  } else if (isUsefulHumanEvidence(input.evidence)) {
    how = input.evidence.trim();
  }

  const refs = mergeRefs([
    ...(how ? extractMentionedPaths(how) : []),
    ...extractMentionedPaths(input.evidence),
    ...matchOperatorChecklistPaths(input.files),
  ], input.files);

  return { how, refs };
}

/** Prefer order-stable unique paths; when files known, keep only existing. */
function mergeRefs(candidates: readonly string[], files: readonly string[]): readonly string[] {
  const fileSet =
    files.length > 0
      ? new Set(files.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')))
      : null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (seen.has(p)) continue;
    if (fileSet && !fileSet.has(p)) {
      // Still keep if a file ends with this path (partial mention).
      const hit = [...fileSet].find((f) => f === p || f.endsWith(`/${p}`));
      if (!hit) continue;
      if (seen.has(hit)) continue;
      seen.add(hit);
      out.push(hit);
      continue;
    }
    seen.add(p);
    out.push(p);
  }
  return out;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
