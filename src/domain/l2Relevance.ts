/**
 * Domain — L2 relevance labels (acceptance-binding grammar §6).
 *
 * Did the behavioral evidence run exercise the UI this diff changed?
 * Labels are informational only — they never flip green / auto-rework.
 */
export interface L2RelevanceStep {
  readonly kind: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly raw?: string;
  readonly screenshot?: string;
}

export type L2RelevanceLabel =
  | 'no-ui-change'
  | 'l2-not-run'
  | 'covered'
  | 'partial'
  | 'regression-only'
  | 'unbound-ui-change';

export interface L2Relevance {
  readonly label: L2RelevanceLabel;
  /** data-evidence anchors on added lines of the diff (UI files), unique, sorted. */
  readonly changedAnchors: readonly string[];
  /** anchors referenced by executed steps (raw + detail), unique, sorted. */
  readonly exercisedAnchors: readonly string[];
  readonly covered: readonly string[];
  readonly uncovered: readonly string[];
  /** screenshot name → anchors exercised by steps since the previous screenshot. */
  readonly screenshotScenes: ReadonlyMap<string, readonly string[]>;
  /** one-line human sentence for the packet. */
  readonly summary: string;
  /** null when label is no-ui-change or covered. */
  readonly warning: string | null;
}

/** JSON-serializable form of {@link L2Relevance} (Map → plain object). */
export interface L2RelevanceRecord extends Omit<L2Relevance, 'screenshotScenes'> {
  readonly screenshotScenes: Readonly<Record<string, readonly string[]>>;
}

export interface L2RelevanceInput {
  readonly diff: string;
  readonly filesTouched: readonly string[];
  readonly steps: readonly L2RelevanceStep[] | null;
  /** any mechanical criterion bound with @evidence: */
  readonly hasEvidenceBinding: boolean;
}

const DATA_EVIDENCE_RE = /data-evidence\s*=\s*["'{]?([\w-]+)/gi;

/** Max unique anchors collected while scanning a diff. */
const MAX_DIFF_ANCHORS = 500;
/** Max diff lines scanned. */
const MAX_DIFF_LINES = 200_000;

/** Extract `data-evidence` anchor values from arbitrary text. */
export function extractDataEvidenceAnchors(text: string): readonly string[] {
  const out: string[] = [];
  DATA_EVIDENCE_RE.lastIndex = 0;
  for (const m of text.matchAll(DATA_EVIDENCE_RE)) {
    const v = m[1];
    if (v) out.push(v);
  }
  return out;
}

/** True when the path is a UI source file (tsx/jsx/vue/svelte/html or under src/web/). */
export function isUiFile(path: string): boolean {
  if (path.startsWith('src/web/')) return true;
  return /\.(tsx|jsx|vue|svelte|html)$/.test(path);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

function formatList(anchors: readonly string[]): string {
  return anchors.join(', ');
}

/**
 * Collect data-evidence anchors on ADDED hunk lines whose +++ b/<path> is a UI
 * file. Anchors that only appear on removed lines cannot be exercised by any
 * run (a rename's old name would stay "uncovered" forever), so they do not
 * count as changed anchors. Caps at {@link MAX_DIFF_ANCHORS} anchors and
 * {@link MAX_DIFF_LINES} lines.
 */
function collectChangedAnchors(diff: string): readonly string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let currentIsUi = false;
  let linesScanned = 0;

  for (const line of diff.split('\n')) {
    linesScanned += 1;
    if (linesScanned > MAX_DIFF_LINES) break;
    if (seen.size >= MAX_DIFF_ANCHORS) break;

    if (line.startsWith('+++ ')) {
      // +++ b/<path> or +++ /dev/null
      const rest = line.slice(4);
      let path = rest;
      if (path.startsWith('b/')) path = path.slice(2);
      currentIsUi = path !== '/dev/null' && isUiFile(path);
      continue;
    }
    // Skip file headers --- a/... (not content lines).
    if (line.startsWith('--- ')) continue;
    if (!currentIsUi) continue;
    // Added content lines only (+++ headers already handled above).
    if (line.startsWith('+')) {
      for (const a of extractDataEvidenceAnchors(line.slice(1))) {
        if (seen.has(a)) continue;
        seen.add(a);
        found.push(a);
        if (seen.size >= MAX_DIFF_ANCHORS) break;
      }
    }
  }
  return uniqueSorted(found);
}

function collectExercisedAnchors(
  steps: readonly L2RelevanceStep[],
): readonly string[] {
  const found: string[] = [];
  for (const st of steps) {
    if (!st.ok) continue;
    if (st.raw) found.push(...extractDataEvidenceAnchors(st.raw));
    found.push(...extractDataEvidenceAnchors(st.detail));
  }
  return uniqueSorted(found);
}

/**
 * Walk steps in order; accumulate exercised anchors; on a step with
 * `screenshot`, record the accumulated list under that name and reset.
 */
function collectScreenshotScenes(
  steps: readonly L2RelevanceStep[],
): Map<string, readonly string[]> {
  const scenes = new Map<string, readonly string[]>();
  let acc: string[] = [];
  const accSeen = new Set<string>();

  for (const st of steps) {
    if (st.ok) {
      const fromRaw = st.raw ? extractDataEvidenceAnchors(st.raw) : [];
      const fromDetail = extractDataEvidenceAnchors(st.detail);
      for (const a of [...fromRaw, ...fromDetail]) {
        if (accSeen.has(a)) continue;
        accSeen.add(a);
        acc.push(a);
      }
    }
    if (st.screenshot !== undefined && st.screenshot.length > 0) {
      scenes.set(st.screenshot, uniqueSorted(acc));
      acc = [];
      accSeen.clear();
    }
  }
  return scenes;
}

function buildSummaryAndWarning(
  label: L2RelevanceLabel,
  opts: {
    readonly uiFileCount: number;
    readonly covered: readonly string[];
    readonly uncovered: readonly string[];
  },
): { readonly summary: string; readonly warning: string | null } {
  switch (label) {
    case 'no-ui-change':
      return { summary: 'L2: no UI change in diff', warning: null };
    case 'l2-not-run': {
      const text = `L2: not run — UI changed (${opts.uiFileCount} file(s))`;
      return { summary: text, warning: text };
    }
    case 'covered': {
      const text = `L2: covered — changed anchors exercised (${formatList(opts.covered)})`;
      return { summary: text, warning: null };
    }
    case 'partial': {
      const text = `L2: partial — uncovered changed anchors: ${formatList(opts.uncovered)}`;
      return { summary: text, warning: text };
    }
    case 'regression-only': {
      const suffix =
        opts.uncovered.length > 0 ? ` (${formatList(opts.uncovered)})` : '';
      const text = `L2: regression only — changed UI not exercised${suffix}`;
      return { summary: text, warning: text };
    }
    case 'unbound-ui-change': {
      const text =
        'L2: UI change without evidence binding — add @evidence:<anchor> or a ## Evidence step';
      return { summary: text, warning: text };
    }
  }
}

/** Pure: label whether this L2 run exercised the UI anchors the diff changed. */
export function computeL2Relevance(input: L2RelevanceInput): L2Relevance {
  const uiFiles = input.filesTouched.filter(isUiFile);
  const emptyScenes = new Map<string, readonly string[]>();

  if (uiFiles.length === 0) {
    const { summary, warning } = buildSummaryAndWarning('no-ui-change', {
      uiFileCount: 0,
      covered: [],
      uncovered: [],
    });
    return {
      label: 'no-ui-change',
      changedAnchors: [],
      exercisedAnchors: [],
      covered: [],
      uncovered: [],
      screenshotScenes: emptyScenes,
      summary,
      warning,
    };
  }

  if (input.steps === null) {
    const { summary, warning } = buildSummaryAndWarning('l2-not-run', {
      uiFileCount: uiFiles.length,
      covered: [],
      uncovered: [],
    });
    return {
      label: 'l2-not-run',
      changedAnchors: [],
      exercisedAnchors: [],
      covered: [],
      uncovered: [],
      screenshotScenes: emptyScenes,
      summary,
      warning,
    };
  }

  const changedAnchors = collectChangedAnchors(input.diff);
  const exercisedAnchors = collectExercisedAnchors(input.steps);
  const screenshotScenes = collectScreenshotScenes(input.steps);
  const exercisedSet = new Set(exercisedAnchors);
  const covered = changedAnchors.filter((a) => exercisedSet.has(a));
  const uncovered = changedAnchors.filter((a) => !exercisedSet.has(a));

  let label: L2RelevanceLabel;
  if (changedAnchors.length === 0) {
    label = input.hasEvidenceBinding ? 'regression-only' : 'unbound-ui-change';
  } else if (uncovered.length === 0) {
    label = 'covered';
  } else if (covered.length === 0) {
    label = 'regression-only';
  } else {
    label = 'partial';
  }

  const { summary, warning } = buildSummaryAndWarning(label, {
    uiFileCount: uiFiles.length,
    covered,
    uncovered,
  });

  return {
    label,
    changedAnchors,
    exercisedAnchors,
    covered,
    uncovered,
    screenshotScenes,
    summary,
    warning,
  };
}

/** Convert Map-bearing relevance to a JSON-serializable record. */
export function toL2RelevanceRecord(r: L2Relevance): L2RelevanceRecord {
  const screenshotScenes: Record<string, readonly string[]> = {};
  for (const [name, anchors] of r.screenshotScenes) {
    screenshotScenes[name] = anchors;
  }
  return {
    label: r.label,
    changedAnchors: r.changedAnchors,
    exercisedAnchors: r.exercisedAnchors,
    covered: r.covered,
    uncovered: r.uncovered,
    screenshotScenes,
    summary: r.summary,
    warning: r.warning,
  };
}
