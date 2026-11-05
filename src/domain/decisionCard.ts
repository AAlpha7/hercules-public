/**
 * Domain — the structured DecisionCard (CEO surface, 2026-07-24).
 *
 * The verifier already holds every fact the human needs to decide: purpose,
 * which areas of the repo the diff touches, boundary guarantees, and each
 * acceptance criterion's status WITH its evidence. Historically it flattened
 * them into packet prose and the UI re-parsed markdown — fragile and lossy.
 * The card is embedded as a machine block in the task body at verify time:
 * single file, git-audited, versioned with its producer, zero re-parsing.
 *
 * Boundary badges must be self-explanatory on phone: each is clickable and
 * expands "what this checks" + "what this task actually did" (incl. foreign
 * commit evidence for cross-task). Never point at a UI section that is not
 * on the card ("出处见发现").
 */
import type { CriterionKind } from './acceptance.js';
import type { CheatFinding, CheatKind, EvidenceMatrixRow, GateResult } from './verification.js';
import { isCriticalCheatKind } from './verification.js';
import { extractGateFailureReason } from './gateReason.js';
import { resolveHumanAcGuidance } from './humanAcGuidance.js';

export interface DecisionCardArea {
  readonly area: string;
  readonly count: number;
}

export interface DecisionCardCriterion {
  readonly text: string;
  readonly kind: CriterionKind;
  readonly status: string;
  /** WHY it is (or is not) satisfied — evidence citation or reason. */
  readonly why: string;
  /**
   * Human only: how to verify (from Operator checklist / self-assessment).
   * Omitted when no real source — UI keeps the default “check after verify” copy.
   */
  readonly how?: string;
  /** Human only: repo-relative docs to open in-place. */
  readonly refs?: readonly string[];
  /**
   * Human only: UI AC has no related L2 evidence steps — soft warn so the
   * operator knows they cannot verify before deploy (not a hard block).
   */
  readonly unprovenUiWarning?: string;
  /** Specific gap (missing click/assert/screenshot for this claim). */
  readonly unprovenUiReason?: string;
}

/** One commit on this branch attributed to another task (lineage blur). */
export interface CrossTaskCommit {
  readonly sha: string;
  readonly subject: string;
  readonly taskId: string;
}

/** Review-only L5 flag named for the CEO card (kind + zh meaning). */
export interface ReviewOnlyFlag {
  readonly kind: string;
  readonly meaningZh: string;
}

export interface DecisionCard {
  readonly v: 1;
  /** First line under ## Goal / ## Task — what this task is FOR. */
  readonly purpose: string | null;
  readonly areas: readonly DecisionCardArea[];
  readonly filesTouched: number;
  readonly boundaries: {
    /** All work confined to this branch (never main). */
    readonly branch: string;
    readonly protectedPathsTouched: boolean;
    readonly testsEdited: boolean;
    readonly crossTaskIds: readonly string[];
    /**
     * Foreign hercules commits aboard this branch (sha + subject + taskId).
     * Empty when none. Older packets may omit; UI treats missing as [].
     */
    readonly crossTaskCommits: readonly CrossTaskCommit[];
  };
  /** Review-only L5 flags with zh meaning (not just a count). */
  readonly reviewOnlyFlags: readonly ReviewOnlyFlag[];
  readonly criteria: readonly DecisionCardCriterion[];
  readonly gates: readonly {
    name: string;
    passed: boolean;
    reason?: string;
    /** Synthesized skipped/info rows — excluded from 门禁 n/m. */
    outcome?: 'skipped' | 'info';
  }[];
  readonly evidence: {
    readonly ran: boolean;
    readonly ok: boolean | null;
    readonly steps: number;
    readonly skipReason?: string;
  };
  readonly reviewer: {
    readonly ran: boolean;
    readonly approved: boolean | null;
    readonly summaryZh?: string;
  };
  /**
   * Mechanical criteria the matcher could not auto-verify (gate green).
   * SPA lists these as human-confirm items. Older cards omit.
   */
  readonly unverifiedCriteria?: readonly {
    readonly text: string;
    readonly warning: string;
  }[];
}

/** Generic area classifier: top path segment; two segments under src/. */
export function classifyAreas(files: readonly string[]): DecisionCardArea[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    const n = f.replace(/\\/g, '/').replace(/^\.\//, '');
    const segs = n.split('/');
    const area =
      segs.length === 1 ? '(root)' : segs[0] === 'src' && segs.length > 2 ? `src/${segs[1]}` : segs[0]!;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([area, count]) => ({ area, count }))
    .sort((a, b) => b.count - a.count);
}

/** First line under ## Goal (preferred) / ## Task. */
function purposeOf(body: string): string | null {
  for (const heading of ['Goal', '目标', 'Task', '任务']) {
    const m = new RegExp(`^##\\s+${heading}\\s*$`, 'm').exec(body);
    if (!m) continue;
    const rest = body.slice(m.index + m[0].length);
    const stop = rest.search(/^##\s+/m);
    const line = (stop >= 0 ? rest.slice(0, stop) : rest)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (line) return line;
  }
  return null;
}

/** One-line zh meaning for each review-only L5 kind (CEO surface). */
export const REVIEW_ONLY_FLAG_ZH: Readonly<Record<string, string>> = {
  'test-edit': '改动了测试文件，需确认测试仍在真正约束行为',
  'cross-task-commits': '分支夹带其他任务的提交，审计血缘交叉',
  // L2 assert sel= placeholders (2026-07-25 twin incidents) — packet names file:line.
  'placeholder-evidence-hook': '疑似为过 L2 assert 而加的占位 data-evidence（无真实功能）',
  // S2: gate-resolved package scripts / configs edited in the worktree.
  'gate-toolchain-edit': '改动了门禁会执行的脚本或配置，机检结论不可信直至人工核验',
  // Verifier/acceptance source edited: merge changes how every later task is judged.
  'verifier-edit': '改动了验证器/验收源码，合并后影响所有任务的判定，需人工审读该 diff',
};

export function reviewOnlyFlagMeaningZh(kind: string): string {
  return REVIEW_ONLY_FLAG_ZH[kind] ?? `需人工/L3 核验的标记:${kind}`;
}

/**
 * Parse `git log --format=%H%x09%s` lines into foreign-task commits.
 * Own task id (from hercules/<id> branch) is excluded. Pure — no git IO.
 */
export function parseForeignTaskCommits(
  logLines: readonly string[],
  ownTaskId: string | null,
): CrossTaskCommit[] {
  const out: CrossTaskCommit[] = [];
  const seenSha = new Set<string>();
  for (const raw of logLines) {
    const line = raw.trim();
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const sha = line.slice(0, tab).trim();
    const subject = line.slice(tab + 1).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(sha) || subject.length === 0) continue;
    if (seenSha.has(sha.toLowerCase())) continue;
    const m = /^hercules:\s*([A-Za-z0-9._-]+)/.exec(subject);
    if (!m?.[1] || m[1] === ownTaskId) continue;
    seenSha.add(sha.toLowerCase());
    out.push({ sha, subject, taskId: m[1] });
  }
  return out;
}

/** Extract foreign task ids from a cross-task-commits finding detail. */
export function parseCrossTaskIdsFromDetail(detail: string): string[] {
  // Verifier format: "…aboard: R2, R1 — lineage crosses…"
  const aboard = /aboard:\s*([^—]+)/.exec(detail)?.[1];
  if (!aboard) return [];
  return aboard
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Badge keys match L2 data-evidence contract:
 *   boundary-badge-{key}  → branch | protected | tests | cross
 *   boundary-badge-detail → shared expand panel (stable, not per-key)
 */
export type BoundaryBadgeKey = 'branch' | 'protected' | 'tests' | 'cross';

/**
 * Self-explanatory boundary badge: label + what it checks + this-task actual.
 * Green and yellow both expand — green confirms the check ran clean.
 */
export interface BoundaryBadgeExplain {
  readonly key: BoundaryBadgeKey;
  readonly warn: boolean;
  readonly label: string;
  /** 这条徽章判什么 */
  readonly what: string;
  /** 本任务实际情况 (may include commit lines for cross-task) */
  readonly actual: string;
}

/** Normalize boundaries from a possibly-old card (missing crossTaskCommits). */
export function normalizeBoundaries(
  b: DecisionCard['boundaries'] | (Omit<DecisionCard['boundaries'], 'crossTaskCommits'> & {
    readonly crossTaskCommits?: readonly CrossTaskCommit[];
  }),
): DecisionCard['boundaries'] {
  return {
    branch: b.branch,
    protectedPathsTouched: b.protectedPathsTouched,
    testsEdited: b.testsEdited,
    crossTaskIds: b.crossTaskIds,
    crossTaskCommits: b.crossTaskCommits ?? [],
  };
}

/** Build the four boundary badge explanations from card boundaries. */
export function explainBoundaryBadges(
  boundaries: DecisionCard['boundaries'],
): readonly BoundaryBadgeExplain[] {
  const b = normalizeBoundaries(boundaries);
  const commits = b.crossTaskCommits;
  const crossIds = b.crossTaskIds.length > 0
    ? b.crossTaskIds
    : [...new Set(commits.map((c) => c.taskId))];
  const crossWarn = crossIds.length > 0;

  let crossActual: string;
  if (!crossWarn) {
    crossActual = '分支提交均归属本任务，无外来 hercules 提交。';
  } else if (commits.length > 0) {
    const lines = commits.map(
      (c) => `· ${c.sha.slice(0, 8)} [${c.taskId}] ${c.subject}`,
    );
    crossActual =
      `发现来自其他任务的提交（${crossIds.join('、')}）:\n` + lines.join('\n');
  } else {
    // Self-contained: name task ids only — never "见 X" where X is off-card.
    crossActual =
      `发现来自其他任务的提交（任务 id: ${crossIds.join('、')}）；` +
      '本包未嵌入逐条 sha/主题（旧卡或缺 diff 证据）。';
  }

  return [
    {
      key: 'branch',
      warn: false,
      label: '✓ 仅任务分支',
      what: '工作是否只在 hercules/<任务id> 分支上推进，从不直接改主干。',
      actual: `本任务分支 \`${b.branch}\`；合并前不会动主干。`,
    },
    {
      key: 'protected',
      warn: b.protectedPathsTouched,
      label: b.protectedPathsTouched ? '⚠ 保护路径' : '✓ 保护路径',
      what: '是否改动了 WORKFLOW 声明的受保护路径（门禁/策略文件等）。',
      actual: b.protectedPathsTouched
        ? '检测到对保护路径的改动，需确认是否为任务意图内。'
        : '未触及受保护路径。',
    },
    {
      key: 'tests',
      warn: b.testsEdited,
      label: b.testsEdited ? '⚠ 测试有改动' : '✓ 测试未动',
      what: '是否修改了测试文件（可能削弱门禁；L3 会核验）。',
      actual: b.testsEdited
        ? '本任务改动了测试文件；属 review-only 标记，L3 应已核验。'
        : '未改动测试文件。',
    },
    {
      key: 'cross',
      warn: crossWarn,
      label: crossWarn ? `⚠ 跨任务 ${crossIds.join('、')}` : '✓ 无跨任务',
      what: '分支历史是否夹带其他任务的 hercules: <id> 提交（樱桃采/复用会模糊审计血缘）。',
      actual: crossActual,
    },
  ];
}

/** Unique review-only flags from cheat findings (kind + zh meaning). */
export function collectReviewOnlyFlags(
  findings: readonly Pick<CheatFinding, 'kind'>[],
): ReviewOnlyFlag[] {
  const seen = new Set<string>();
  const out: ReviewOnlyFlag[] = [];
  for (const f of findings) {
    if (isCriticalCheatKind(f.kind as CheatKind)) continue;
    if (seen.has(f.kind)) continue;
    seen.add(f.kind);
    out.push({ kind: f.kind, meaningZh: reviewOnlyFlagMeaningZh(f.kind) });
  }
  return out;
}

export interface DecisionCardInput {
  readonly taskBody: string;
  readonly branch: string;
  readonly filesTouched: readonly string[];
  readonly cheatFindings: readonly Pick<CheatFinding, 'kind' | 'detail'>[];
  /** Foreign commits from isolation/diff (no extra git in the card builder). */
  readonly crossTaskCommits?: readonly CrossTaskCommit[];
  readonly evidenceMatrix: readonly EvidenceMatrixRow[];
  readonly gates: readonly GateResult[];
  readonly evidenceRan: boolean;
  readonly evidenceOk: boolean | null;
  readonly evidenceSteps: number;
  readonly evidenceSkipReason?: string | undefined;
  readonly reviewerRan: boolean;
  readonly reviewerApproved: boolean | null;
  readonly reviewerSummaryZh?: string | undefined;
  readonly unverifiedCriteria?: readonly {
    readonly text: string;
    readonly warning: string;
  }[];
}

export function buildDecisionCard(input: DecisionCardInput): DecisionCard {
  const crossTaskCommits = input.crossTaskCommits ?? [];
  const fromFinding =
    input.cheatFindings
      .find((f) => f.kind === 'cross-task-commits')
      ?.detail ?? null;
  const crossTaskIds =
    crossTaskCommits.length > 0
      ? [...new Set(crossTaskCommits.map((c) => c.taskId))]
      : fromFinding
        ? parseCrossTaskIdsFromDetail(fromFinding)
        : [];
  const unverifiedCriteria = input.unverifiedCriteria ?? [];
  return {
    v: 1,
    purpose: purposeOf(input.taskBody),
    areas: classifyAreas(input.filesTouched),
    filesTouched: input.filesTouched.length,
    boundaries: {
      branch: input.branch,
      protectedPathsTouched: input.cheatFindings.some(
        (f) => f.kind === 'protected-path' && isCriticalCheatKind(f.kind),
      ),
      testsEdited: input.cheatFindings.some((f) => f.kind === 'test-edit'),
      crossTaskIds,
      crossTaskCommits,
    },
    reviewOnlyFlags: collectReviewOnlyFlags(input.cheatFindings),
    // Human ACs carry how/refs from human-ac-actionable (in-place核验).
    criteria: input.evidenceMatrix.map((r) => {
      const base = {
        text: r.text,
        kind: r.kind,
        status: r.status,
        why: r.evidence,
      };
      // checkpoint counts as human-authority for Approve / how-to-verify guidance.
      if (r.kind !== 'human' && r.kind !== 'checkpoint') return base;
      const g = resolveHumanAcGuidance({
        criterionText: r.text,
        taskBody: input.taskBody,
        evidence: r.evidence,
        files: input.filesTouched,
      });
      return {
        ...base,
        ...(g.how !== null ? { how: g.how } : {}),
        ...(g.refs.length > 0 ? { refs: g.refs } : {}),
        ...(r.unprovenUiWarning
          ? {
              unprovenUiWarning: r.unprovenUiWarning,
              ...(r.unprovenUiReason ? { unprovenUiReason: r.unprovenUiReason } : {}),
            }
          : {}),
      };
    }),
    gates: input.gates.map((g) => ({
      name: g.name,
      passed: g.passed,
      ...(g.outcome !== undefined ? { outcome: g.outcome } : {}),
      ...(g.passed ? {} : { reason: extractGateFailureReason(g.output, 200) }),
    })),
    evidence: {
      ran: input.evidenceRan,
      ok: input.evidenceOk,
      steps: input.evidenceSteps,
      ...(input.evidenceSkipReason ? { skipReason: input.evidenceSkipReason } : {}),
    },
    reviewer: {
      ran: input.reviewerRan,
      approved: input.reviewerApproved,
      ...(input.reviewerSummaryZh ? { summaryZh: input.reviewerSummaryZh } : {}),
    },
    ...(unverifiedCriteria.length > 0 ? { unverifiedCriteria } : {}),
  };
}

const BLOCK_RE = /<!-- hercules:decision-card\n([\s\S]*?)\n-->/g;

/** Machine block appended to the packet markdown (hidden from display). */
export function renderDecisionCardBlock(card: DecisionCard): string {
  return `\n<!-- hercules:decision-card\n${JSON.stringify(card)}\n-->\n`;
}

/** Latest embedded card in a task body, or null (old packets). */
export function parseDecisionCard(body: string): DecisionCard | null {
  const matches = [...body.matchAll(new RegExp(BLOCK_RE.source, 'g'))];
  const last = matches[matches.length - 1]?.[1];
  if (!last) return null;
  try {
    const raw = JSON.parse(last) as DecisionCard;
    if (raw.v !== 1) return null;
    // Older cards lack crossTaskCommits / reviewOnlyFlags — normalize.
    return {
      ...raw,
      boundaries: normalizeBoundaries(raw.boundaries),
      reviewOnlyFlags: raw.reviewOnlyFlags ?? [],
    };
  } catch {
    return null;
  }
}

/**
 * Soft UI-AC gap fields from an embedded DecisionCard (if any pending human
 * criterion carries unprovenUiWarning). Used by list cards so the warn is
 * visible without opening the sheet — and stays in the DOM under Settings.
 */
export function unprovenUiFromTaskBody(body: string): {
  readonly warning: string;
  readonly reason?: string;
} | null {
  const card = parseDecisionCard(body);
  if (!card) return null;
  for (const c of card.criteria) {
    if (c.kind !== 'human' || c.status === 'pass') continue;
    if (!c.unprovenUiWarning) continue;
    return {
      warning: c.unprovenUiWarning,
      ...(c.unprovenUiReason ? { reason: c.unprovenUiReason } : {}),
    };
  }
  return null;
}

/** Remove machine blocks before rendering body text for humans. */
export function stripDecisionCardBlocks(body: string): string {
  return body.replace(new RegExp(BLOCK_RE.source, 'g'), '').replace(/\n{3,}/g, '\n\n');
}
