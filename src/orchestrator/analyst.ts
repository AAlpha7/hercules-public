/**
 * Analyst stage — LLM drafts a bound task (title / DoD / evidence) from user
 * intent. Fresh read-only session via the same ReviewRunner as L3; never
 * creates or dispatches a task. Human edits + approve-plan on the phone.
 */
import {
  lintAcceptance,
  type AcLintReport,
} from '../domain/acceptanceLint.js';
import type { AnalystActivityListener } from '../domain/analystActivity.js';
import {
  detectIntentSlots,
  draftTaskFromIntent,
  filledFromBoundBody,
  questionsForMissingSlots,
  questionsFromAnalystNotes,
  type IntentDraft,
} from '../domain/intentDraft.js';
import type { RepoConfig } from '../domain/repos.js';
import { isValidTaskSlug, shortSlug } from '../domain/taskSlug.js';
import { redactHostOutput } from '../domain/hostExecutor.js';
import { ReviewerInfraError, type ReviewRunner } from '../verification/reviewer.js';
import type { AnalystRepoContext } from './analystContext.js';

export interface AnalystDraft extends IntentDraft {
  readonly source: 'analyst' | 'heuristic';
  readonly lint: AcLintReport;
  readonly notes: readonly string[];
  readonly repairRounds: number;
}

/** Appended to grok's system prompt (`--rules`) so the analyst does not try to leave its snapshot. */
export const ANALYST_SESSION_RULES =
  'This session is confined to the current working directory, a read-only snapshot of one repository. ' +
  'Files outside it (home directory, ~/.grok, continuity notes, other repositories, host configs) are ' +
  'inaccessible and out of scope — never attempt to read, list, or search them, and do not read continuity files.';

const GRAMMAR_CHEATSHEET = `Criterion line: - [ ] (<kind>) <claim> @<binding>
kinds: mechanical | reviewer | human | checkpoint (text: \`before <step>: <what the human confirms>\`)
bindings (exactly one per mechanical line):
  @test:<path>#<title>   a named it()/test() case that must exist and run green   ← preferred for new behaviour
  @test:<path>           a test file changed by this diff that runs green
  @evidence:<anchor>     an L2 browser step exercises data-evidence=<anchor>      ← UI changes
  @gate:<name>           regression only (typecheck | lint | test | build | all)
  @probe:<kind>:<ref>    non-code archetype probe (stays pending until a verifier exists)
Rules: every mechanical line MUST be bound; prefer @test:path#title with the exact title the implementer
must write — the title is matched against the it()/test() string alone (describe names are not part of
it), so write a self-contained sentence, not "<functionName> <does X>" that assumes a describe prefix; use real paths from the context (existing test files) or a new path under test/ mirroring
src/; (human) lines ONLY for what the system cannot prove — an external account, a physical device, a third-party UI, a payment; never "look at the diff/log/packet", never a restatement of the pipeline (L1/L2/review/merge), never a placeholder ("accept the outcome"); UI behaviour is proved by @evidence or @test, not by a person; a check that is only possible once the change is live in production is written \`(human, after deploy) <what to check>\` and does not block Approve; zero (human) lines is the normal case; do not bind to files you
cannot see in the context unless you mark them "(new)" in the claim; never use @gate: as the only proof
of a feature. Never write \`data-evidence=<anchor>\` inside claim text — any anchor named in prose becomes a hard L2 assert; name an anchor only through @evidence:<anchor> and, if no WORKFLOW scene already reaches it, add a ## Evidence step list (unlock / click / assert / screenshot) that navigates to it; a render test (@test:test/web/render/…) proves a component without naming its anchor.`;

const MAX_PROMPT_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_NOTES = 8;
const MAX_TITLE = 90;
/**
 * Per-attempt budget: initial run and the optional repair run each get this.
 * Drafting is asynchronous (the heuristic draft is returned immediately), so
 * this only bounds the confined grok session; a heavy intent on the live
 * hercules tree took ~40 tool calls and >120 s.
 */
const DEFAULT_TIMEOUT_MS = 240_000;

const JSON_FENCE_OPEN_RE = /```json\s*/gi;
const FENCE_RE = /```/g;

function truncatePrompt(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… (prompt truncated from ${text.length} to ${max} chars)`;
}

function formatLintFeedback(lint: AcLintReport): string {
  const lines = lint.findings.map(
    (f) =>
      `- [${f.severity}] ${f.code}${f.line !== undefined ? ` L${f.line}` : ''}: ${f.message}`,
  );
  return [
    '## Lint report (previous draft failed AC lint)',
    'Fix every error; keep the rest.',
    `errors=${lint.counts.error} warns=${lint.counts.warn} infos=${lint.counts.info}`,
    ...lines,
  ].join('\n');
}

export function analystPrompt(input: {
  intent: string;
  context: AnalystRepoContext;
  lintFeedback?: AcLintReport;
}): string {
  const { intent, context } = input;
  const sections = [
    'You are Hercules analyst. Draft a bound task plan from the human intent and',
    'the trusted repo context below. You do NOT implement, create, or dispatch',
    'the task — a human edits your draft and approves it on the phone.',
    '',
    'Draft body language follows the intent language (中文 intent → 中文 claims).',
    'Bindings and paths stay ASCII.',
    '',
    '## Acceptance-binding grammar (cheat-sheet — follow exactly)',
    GRAMMAR_CHEATSHEET,
    '',
    '## Repo context',
    `repoKey: ${context.repoKey}`,
    `archetype: ${context.archetype}`,
    '',
    '### Workflow gates (do not require editing WORKFLOW / protected paths)',
    context.workflowGates.length > 0
      ? context.workflowGates.map((g) => `- ${g}`).join('\n')
      : '(none)',
    '',
    '### Protected paths (draft must not require editing these)',
    context.protectedPaths.length > 0
      ? context.protectedPaths.map((p) => `- ${p}`).join('\n')
      : '(none)',
    '',
    '### Evidence anchors (data-evidence values in src/)',
    context.evidenceAnchors.length > 0
      ? context.evidenceAnchors.map((a) => `- ${a}`).join('\n')
      : '(none found)',
    '',
    '### Test files',
    context.testFiles.length > 0
      ? context.testFiles.map((p) => `- ${p}`).join('\n')
      : '(none found)',
    '',
    '### Intent keyword hits (path:line:text)',
    context.intentHits.length > 0
      ? context.intentHits.map((h) => `- ${h}`).join('\n')
      : '(none)',
    '',
    '### AGENTS.md (trusted, truncated)',
    context.agentsMd ?? '(missing)',
    '',
    '## Human intent',
    intent.trim() || '(empty)',
    '',
  ];

  if (input.lintFeedback !== undefined) {
    sections.push(formatLintFeedback(input.lintFeedback), '');
  }

  sections.push(
    '## Scope',
    'Your working directory is a read-only snapshot of this repository at its trusted default-branch tip. Use only relative paths under it with read_file / grep / list_dir. Anything outside it is inaccessible and out of scope.',
    '',
    '## Output contract',
    'Respond with exactly one fenced JSON block:',
    '```json',
    '{',
    '  "title": "≤ 90 chars",',
    '  "slug": "3–6 lowercase English words joined by -, ≤ 40 chars, e.g. sort-tasks-by-last-active; ALWAYS in English even when the intent is Chinese",',
    '  "body": "markdown with ## Intent, ## Acceptance criteria, optional ## Evidence (L2 steps, same DSL as WORKFLOW behavioral.evidence), optional ## Out of scope",',
    '  "labels": ["string"],',
    '  "priority": 1,',
    '  "notes": ["assumptions / open questions for the human; prefix questions with question:"]',
    '}',
    '```',
    'priority is 1–5 (1 = highest). notes ≤ 8 entries. No other fences.',
  );

  return truncatePrompt(sections.join('\n'), MAX_PROMPT_CHARS);
}

/**
 * Last ```json block whose content parses. The body legitimately contains
 * fences of its own (an `## Evidence` section is a ```yaml L2 step list), so
 * a non-greedy "first closing fence" match truncates the JSON mid-string;
 * instead try each later closing fence until one yields valid JSON.
 */
function lastParsableJsonBlock(text: string): unknown {
  const fences: number[] = [];
  FENCE_RE.lastIndex = 0;
  for (const m of text.matchAll(FENCE_RE)) fences.push(m.index);
  let result: unknown;
  JSON_FENCE_OPEN_RE.lastIndex = 0;
  for (const open of text.matchAll(JSON_FENCE_OPEN_RE)) {
    const start = open.index + open[0].length;
    for (const close of fences) {
      if (close < start) continue;
      try {
        result = JSON.parse(text.slice(start, close).trim());
        break;
      } catch {
        // inner fence — keep scanning for the real closing fence
      }
    }
  }
  return result;
}

export function parseAnalystOutput(
  text: string,
): {
  title: string;
  body: string;
  labels: string[];
  priority: number;
  notes: string[];
  slug?: string;
} | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  const capped = text.length > MAX_OUTPUT_CHARS ? text.slice(0, MAX_OUTPUT_CHARS) : text;
  const parsed = lastParsableJsonBlock(capped);
  if (parsed === undefined) return null;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['title'] !== 'string' || typeof obj['body'] !== 'string') return null;
  const title = obj['title'].trim().slice(0, MAX_TITLE);
  const body = obj['body'];
  if (title.length === 0 || body.trim().length === 0) return null;

  const labelsRaw = obj['labels'];
  const labels: string[] = Array.isArray(labelsRaw)
    ? labelsRaw.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
    : [];

  let priority = 3;
  if (typeof obj['priority'] === 'number' && Number.isFinite(obj['priority'])) {
    priority = Math.min(5, Math.max(1, Math.round(obj['priority'])));
  }

  const notesRaw = obj['notes'];
  const notes: string[] = Array.isArray(notesRaw)
    ? notesRaw
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_NOTES)
    : [];

  let slug: string | undefined;
  const slugRaw = obj['slug'];
  if (typeof slugRaw === 'string') {
    const normalised = shortSlug(slugRaw);
    if (isValidTaskSlug(normalised)) slug = normalised;
  }
  if (slug === undefined) {
    const fromTitle = shortSlug(title);
    if (fromTitle.length > 0) slug = fromTitle;
  }

  return { title, body, labels, priority, notes, ...(slug ? { slug } : {}) };
}

function withNeedsPlan(labels: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const l of ['needs-plan', ...labels]) {
    const t = l.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function clarifyForAnalyst(
  intent: string,
  repoKey: string,
  notes: readonly string[],
  body: string,
): { questions: IntentDraft['questions']; filled: IntentDraft['filled']; vague: boolean } {
  const fromNotes = questionsFromAnalystNotes(notes, repoKey);
  const questions =
    fromNotes.length > 0
      ? fromNotes
      : questionsForMissingSlots(detectIntentSlots(intent), repoKey);
  const filled = filledFromBoundBody(body);
  return { questions, filled, vague: questions.length > 0 };
}

function heuristicFallback(
  intent: string,
  repoKey: string,
  reason: string,
): AnalystDraft {
  const base = draftTaskFromIntent(intent, repoKey);
  const lint = lintAcceptance(base.body);
  return {
    ...base,
    labels: withNeedsPlan(base.labels),
    source: 'heuristic',
    lint,
    notes: [],
    repairRounds: 0,
    warnings: [...base.warnings, `analyst unavailable: ${reason}`],
  };
}

/** Bound for draft-warning detail — redacted stderr, never raw secrets. */
const FALLBACK_DETAIL_MAX = 200;

function abortReason(err: unknown): string {
  if (err instanceof Error && (err.name === 'AbortError' || /aborted|timed? ?out/i.test(err.message))) {
    return 'timeout';
  }
  // Prefer a redacted, bounded stderr/infra detail over opaque "runner error"
  // so the phone shows why the sandbox refused (e.g. grok 1.0.13 deny mounts).
  const raw =
    err instanceof ReviewerInfraError
      ? err.message
      : err instanceof Error
        ? err.message
        : '';
  const detail = redactHostOutput(raw, FALLBACK_DETAIL_MAX).trim().replace(/\s+/g, ' ');
  if (detail.length === 0) return 'runner error';
  return detail.length > FALLBACK_DETAIL_MAX
    ? `${detail.slice(0, FALLBACK_DETAIL_MAX - 1)}…`
    : detail;
}

export class Analyst {
  private readonly timeoutMs: number;

  constructor(
    private readonly run: ReviewRunner,
    opts?: { readonly timeoutMs?: number },
  ) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async draft(input: {
    intent: string;
    repo: RepoConfig;
    context: AnalystRepoContext;
    readonly onActivity?: AnalystActivityListener;
    /** Read-only repo snapshot the grok session runs in; omitted = runner default. */
    readonly cwd?: string;
    /** Private GROK_HOME env (credentials only). Omitted = runner default. */
    readonly env?: NodeJS.ProcessEnv;
  }): Promise<AnalystDraft> {
    const { intent, repo, context, onActivity, cwd, env } = input;

    const emit: AnalystActivityListener = (activity) => {
      if (!onActivity) return;
      try {
        onActivity(activity);
      } catch {
        /* listener errors must not break the draft */
      }
    };

    const runOnce = async (
      lintFeedback?: AcLintReport,
    ): Promise<ReturnType<typeof parseAnalystOutput>> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const prompt = analystPrompt({
          intent,
          context,
          ...(lintFeedback !== undefined ? { lintFeedback } : {}),
        });
        const text = await this.run(prompt, {
          signal: controller.signal,
          ...(onActivity ? { onActivity } : {}),
          ...(cwd ? { cwd } : {}),
          ...(env ? { env } : {}),
        });
        return parseAnalystOutput(text);
      } finally {
        clearTimeout(timer);
      }
    };

    emit({ kind: 'phase', phase: 'draft' });

    let parsed: ReturnType<typeof parseAnalystOutput>;
    try {
      parsed = await runOnce();
    } catch (err) {
      // A single timeout is usually a slow model turn, not a dead runner
      // (normal runs 80–90 s vs a 240 s budget; one 240 s stall seen live
      // 2026-09-03). Retry once with a fresh budget before degrading the
      // whole draft to the heuristic — but never retry runner errors.
      if (abortReason(err) !== 'timeout') {
        emit({ kind: 'phase', phase: 'done' });
        return heuristicFallback(intent, repo.key, abortReason(err));
      }
      emit({ kind: 'phase', phase: 'retry' });
      try {
        parsed = await runOnce();
      } catch (retryErr) {
        emit({ kind: 'phase', phase: 'done' });
        return heuristicFallback(intent, repo.key, `${abortReason(retryErr)} (after retry)`);
      }
    }
    if (parsed === null) {
      emit({ kind: 'phase', phase: 'done' });
      return heuristicFallback(intent, repo.key, 'invalid output');
    }

    let repairRounds = 0;
    let title = parsed.title;
    let body = parsed.body;
    let labels = parsed.labels;
    let priority = parsed.priority;
    let notes = parsed.notes;
    let slug = parsed.slug;
    let lint = lintAcceptance(body);

    if (lint.counts.error > 0) {
      repairRounds = 1;
      emit({ kind: 'phase', phase: 'repair' });
      let repaired: ReturnType<typeof parseAnalystOutput>;
      try {
        repaired = await runOnce(lint);
      } catch {
        repaired = null;
      }
      if (repaired !== null) {
        const repairedLint = lintAcceptance(repaired.body);
        if (repairedLint.counts.error < lint.counts.error) {
          title = repaired.title;
          body = repaired.body;
          labels = repaired.labels;
          priority = repaired.priority;
          notes = repaired.notes;
          slug = repaired.slug;
          lint = repairedLint;
        }
      }
    }

    const finalLabels = withNeedsPlan(labels);
    const clarify = clarifyForAnalyst(intent, repo.key, notes, body);
    const warnings: string[] = [];

    emit({ kind: 'phase', phase: 'done' });
    return {
      title,
      ...(slug ? { slug } : {}),
      body,
      priority,
      labels: finalLabels,
      vague: clarify.vague,
      warnings,
      questions: clarify.questions,
      filled: clarify.filled,
      source: 'analyst',
      lint,
      notes: notes.slice(0, MAX_NOTES),
      repairRounds,
    };
  }
}
