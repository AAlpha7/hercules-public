/**
 * Verification Layer 3 — agent-as-reviewer (SPEC §9.3).
 *
 * When the implementer believes it is done, a SEPARATE reviewer agent with a
 * FRESH context critiques the diff against the task's acceptance criteria and
 * the repo's golden principles — looking for missed intent, over-engineering,
 * scope creep, security smells, and (Layer 5, §9.5) whether the change satisfied
 * the spirit or merely gamed the metric.
 *
 * The prompt builder and verdict parser are pure; the fresh-session run is
 * injected (a new `claude -p`, never `--resume` of the implementer's session).
 */
import type { DefinitionOfDone } from '../domain/acceptance.js';
import type { AdapterKind } from '../domain/agents.js';
import type { AnalystActivityListener } from '../domain/analystActivity.js';
import type { ReviewerInfrastructureReceipt } from '../domain/reviewerInfrastructure.js';
import type { Task } from '../domain/task.js';
import {
  boundReviewerReport,
  type CheatFinding,
  type ReviewerVerdict,
} from '../domain/verification.js';

export interface ReviewInput {
  readonly task: Task;
  readonly diff: string;
  readonly cheatFindings: readonly CheatFinding[];
  /** The repo's golden principles (from WORKFLOW.md), if any. */
  readonly principles: string;
  /** Typed DoD when parsed from the task body. */
  readonly dod?: DefinitionOfDone;
  /**
   * The task's diff edits the repo's WORKFLOW. L1/L2 ran the TRUSTED
   * (default-branch) config, so the new boot/gates were not exercised — the
   * reviewer must not request changes for that (it burned 3 attempts on
   * l2-control-fixture, 2026-07-26).
   */
  readonly workflowSelfChanged?: boolean;
  /** Human cancel — abort the fresh reviewer process mid-run. */
  readonly signal?: AbortSignal;
  /** Repo policy for the reviewer child env boundary (explicit allowlist honored). */
  readonly executionPolicy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null;
}

/** Cap prompt size so `grok -p <prompt>` does not hit spawn E2BIG (ARG_MAX). */
const MAX_DIFF_CHARS = 80_000;
const MAX_BODY_CHARS = 24_000;
const MAX_PRINCIPLES_CHARS = 8_000;

function truncateBlock(text: string, max: number, label: string): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return (
    `${t.slice(0, max)}\n\n… (${label} truncated from ${t.length} to ${max} chars for L3 ARG_MAX safety)`
  );
}

export function reviewerPrompt(input: ReviewInput): string {
  const { task, diff, cheatFindings, principles, dod } = input;
  const workflowNote =
    input.workflowSelfChanged === true
      ? '\n## 重要: 本任务修改了 WORKFLOW\n' +
        '验证按可信默认分支的旧 WORKFLOW 执行 (反作弊: 任务不得改写自己的门禁), ' +
        '所以新的 boot/gates/behavioral 这一轮**不可能**生效, 新配置只在合并后才起作用。\n' +
        '不要仅因为「L2 仍是旧行为/空控制面」就要求改动 — 那是制度决定的, 不是这次改动的缺陷。\n' +
        '请改为审查 diff 本身: 新配置是否正确、是否削弱门禁、是否把夹具塞进生产代码路径。\n' +
        '(This task edits WORKFLOW; L1/L2 ran the trusted config and cannot exercise the new one ' +
        'before merge — judge the diff, not the stale L2 result.)\n'
      : '';
  const cheats =
    cheatFindings.length > 0
      ? cheatFindings.map((f) => `- ${f.kind} in ${f.file}${f.line ? `:${f.line}` : ''} — ${f.detail}`).join('\n')
      : '(none detected)';

  const toolchainFindings = cheatFindings.filter((f) => f.kind === 'gate-toolchain-edit');
  const toolchainSection =
    toolchainFindings.length > 0
      ? [
          '## Gate toolchain edits (scrutinize)',
          ...toolchainFindings.map((f) => `- ${f.file}: ${f.detail}`),
          'These files are executed by the verification gates. Confirm each edit is required by the task and does not weaken, skip, or pre-empt any gate. If it does, request changes.',
          '',
        ].join('\n')
      : '';

  const verifierFindings = cheatFindings.filter((f) => f.kind === 'verifier-edit');
  const verifierSection =
    verifierFindings.length > 0
      ? [
          '## Verifier source edits (scrutinize)',
          ...verifierFindings.map((f) => `- ${f.file}`),
          'These files decide verdicts for every task after merge. Request changes for any edit that weakens a check, special-cases a task id / fixture / path, or narrows what counts as evidence — unless the task explicitly asks for that exact change.',
          '',
        ].join('\n')
      : '';

  const reviewerCriteria =
    dod?.criteria.filter((c) => c.kind === 'reviewer') ?? [];
  const criteriaBlock =
    reviewerCriteria.length > 0
      ? reviewerCriteria.map((c) => `- (reviewer) ${c.text}`).join('\n')
      : '(no explicit reviewer criteria — judge spirit of the whole task + diff quality)';

  // Prefer the brief (before review packet) so L3 is not flooded with prior packets.
  const bodyBrief = task.body.split(/^##\s+Review packet\b/m)[0] ?? task.body;

  return [
    'You are an independent reviewer with a FRESH context. You did NOT produce',
    'this work. You have judgment authority over **reviewer**-typed acceptance',
    'criteria and overall spirit. The implementer\'s self-assessment is evidence',
    'only — not a verdict. Look for: missed intent, draft-quality / incomplete',
    'delivery, over-engineering, scope creep, security smells, and whether the',
    'change satisfied the SPIRIT of the task or merely GAMED the metric.',
    '',
    `# Task ${task.id}: ${task.title}`,
    '',
    truncateBlock(bodyBrief, MAX_BODY_CHARS, 'task body'),
    '',
    workflowNote,
    '## Reviewer-axis criteria (you must decide these)',
    criteriaBlock,
    '',
    '## Golden principles',
    truncateBlock(principles || '(none provided)', MAX_PRINCIPLES_CHARS, 'principles'),
    '',
    '## Automated anti-cheating findings to scrutinize (YOUR job — not the human\'s)',
    'The phone human does **not** re-review these. You own L5 judgment:',
    '- **Critical** (`eslint-disable`, `@ts-ignore`, `as any`, `.skip`/`.only`, empty catch,',
    '  protected-path, false-delivery, test-integrity): accept only if clearly justified; otherwise',
    '  VERDICT: changes_requested with concrete fix bullets.',
    '- **test-integrity** (removed or renamed named it/test case): mechanical critical gate.',
    '  List separately from ordinary test-edit. L1 cannot prove a deleted test still',
    '  constrains behavior. This gate **cannot be overridden** by an approving reviewer —',
    '  restore the missing title or keep coverage under the same normalized title.',
    '- **test-edit**: normal when adding/updating tests for a real feature. Request',
    '  changes only if tests were weakened, deleted, or gamed to force a green gate.',
    '- **placeholder-evidence-hook** (and any new `data-evidence=…` in the diff): judge whether',
    '  the element has **real functionality** (真实功能) — handlers that do work, real copy,',
    '  real UI — or is a dead placeholder only so L2 `assert sel=` can pass (disabled empty',
    '  buttons, `*-host` shells, "for L2" comments). Request changes if it is chrome without',
    '  product behavior.',
    cheats,
    '',
    toolchainSection,
    verifierSection,
    '## Diff',
    '```diff',
    truncateBlock(diff || '(empty diff)', MAX_DIFF_CHARS, 'diff'),
    '```',
    '',
    'Respond with your critique, then end with exactly:',
    'VERDICT: approved   (or)   VERDICT: changes_requested',
    'SUMMARY: <one line>',
    'SUMMARY_ZH: <一句中文,用业务语言说清这个改动做了什么、对使用者意味着什么 — 给不读代码的决策者看>',
    'followed by bullet points (- ...) for any required changes the implementer',
    'must address on the next turn.',
  ].join('\n');
}

/**
 * L3 infrastructure failure (child launch/exit/timeout/missing credentials,
 * empty or verdict-less output). Must propagate to the orchestrator's
 * verify_infra retry path — never be serialized as a product verdict; a
 * fabricated "changes_requested" burned implementer attempts and misstated
 * the evidence (guardian-repo-execution-policy, 2026-08-01).
 */
export class ReviewerInfraError extends Error {
  readonly code = 'reviewer_infra' as const;
  readonly provider: AdapterKind;
  readonly receipt: ReviewerInfrastructureReceipt | null;
  constructor(
    message: string,
    options: {
      readonly provider?: AdapterKind;
      readonly receipt?: ReviewerInfrastructureReceipt | null;
    } = {},
  ) {
    super(message);
    this.name = 'ReviewerInfraError';
    this.provider = options.provider ?? 'grok';
    this.receipt = options.receipt ?? null;
  }
}

/**
 * Every `VERDICT:` **field line** (line-start, optional whitespace around the
 * colon), returning the trimmed field value in document order. Malformed
 * values ("approved_but_unverified", "wat") are collected too so the validator
 * can reject valid-plus-malformed output. Prose mentioning VERDICT mid-line is
 * not a field.
 */
export function extractVerdictLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*VERDICT\s*:\s*(.*)$/i.exec(line);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

/**
 * True only when the text has exactly ONE `VERDICT:` field line and its value
 * is exactly `approved` or `changes_requested` (case-insensitive). Missing,
 * partial/prefix/suffix mutations ("approved_but_unverified",
 * "changes_requested_later"), duplicate, conflicting, or valid-plus-malformed
 * verdict lines, error banners, and empty output are NOT a reviewer response
 * and must be rejected before parseVerdict.
 */
export function hasValidVerdictLine(text: string): boolean {
  const fields = extractVerdictLines(text);
  return fields.length === 1 && /^(?:approved|changes_requested)$/i.test(fields[0]!);
}

export function parseVerdict(text: string): ReviewerVerdict {
  // Same contract as hasValidVerdictLine, fail closed: exactly one VERDICT
  // field line whose value is exactly "approved". Prefix matches, duplicates,
  // conflicts, and valid-plus-malformed are never an approval.
  const fields = extractVerdictLines(text);
  const approved = fields.length === 1 && /^approved$/i.test(fields[0]!);
  const summaryMatch = /^SUMMARY:\s*(.+)$/im.exec(text);
  const summary = summaryMatch ? summaryMatch[1]!.trim() : '';
  const zhMatch = /^SUMMARY_ZH:\s*(.+)$/im.exec(text);
  const summaryZh = zhMatch?.[1]?.trim();
  const comments = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter((l) => l.length > 0);
  return { approved, summary, comments, ...(summaryZh ? { summaryZh } : {}) };
}

/** Runs the reviewer prompt in a fresh agent session and returns its raw text. */
export type ReviewRunner = (
  prompt: string,
  opts?: {
    readonly signal?: AbortSignal;
    readonly executionPolicy?: import('../domain/repoExecutionPolicy.js').EffectiveRepoExecutionPolicy | null;
    /** Live activity (tool calls / text / thought deltas). Streaming mode is used only when set. */
    readonly onActivity?: AnalystActivityListener;
    /** Working directory for this run (analyst snapshot). Overrides the runner's default cwd. */
    readonly cwd?: string;
    /** Child env override (analyst private GROK_HOME). */
    readonly env?: NodeJS.ProcessEnv;
  },
) => Promise<string>;

export class Reviewer {
  constructor(
    private readonly run: ReviewRunner,
    private readonly provider: AdapterKind = 'grok',
  ) {}

  async review(input: ReviewInput): Promise<ReviewerVerdict> {
    let text: string;
    try {
      text = await this.run(reviewerPrompt(input), {
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.executionPolicy !== undefined
          ? { executionPolicy: input.executionPolicy }
          : {}),
      });
    } catch (err) {
      if (err instanceof ReviewerInfraError && err.provider !== this.provider) {
        throw new ReviewerInfraError(err.message, { provider: this.provider });
      }
      throw err;
    }
    // Central fail-closed gate for every runner: only an exact verdict line is
    // L3 evidence. No raw runner text into the durable error (secret safety).
    if (!hasValidVerdictLine(text)) {
      throw new ReviewerInfraError(
        'L3 reviewer response has no single valid VERDICT line (missing, partial, duplicate, or conflicting) — infrastructure failure, not a product verdict',
        { provider: this.provider },
      );
    }
    // Parse first, then bound the retained stdout so truncation cannot affect verdict.
    const verdict: ReviewerVerdict = { ...parseVerdict(text), report: boundReviewerReport(text) };
    if (input.diff.length > MAX_DIFF_CHARS) {
      return {
        ...verdict,
        inputTruncation: { diffChars: input.diff.length, maxChars: MAX_DIFF_CHARS },
      };
    }
    return verdict;
  }
}
