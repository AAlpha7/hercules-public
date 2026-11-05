/**
 * Coordination layer — agent prompt assembly (SPEC §12).
 *
 * The daemon assembles each agent's prompt as: the repo's WORKFLOW.md body +
 * the task (title, body, acceptance criteria) + the allocation context the boot
 * hook needs. Pure and testable; the dispatch path supplies the WORKFLOW body
 * read from the task's worktree. Rework re-dispatch embeds a verification digest
 * (trusted verdict inputs only) via {@link renderImplementerTaskBody}, not the
 * prior agent's full review-packet narrative.
 *
 * Comment-to-steer (SPEC §14) uses {@link assembleSteerPrompt}: a short follow-up
 * for session resume, deliberately omitting WORKFLOW + full task body so token
 * cost stays proportional to the human question.
 */
import type { Task } from '../domain/task.js';
import { hasOpenPr } from '../domain/task.js';
import type { AllocationContext } from '../domain/allocation.js';
import { isHostMutatingClass, resolveExecutionClass } from '../domain/executionClass.js';
import { factoryOpenPrDuties } from '../domain/factoryConflict.js';
import { factoryFirstLaunchDuties } from '../domain/factoryDraft.js';
import { renderImplementerTaskBody } from '../domain/implementerBrief.js';

export interface PromptParts {
  /** The target repo's WORKFLOW.md body (empty if none). */
  readonly workflowBody: string;
  readonly task: Task;
  readonly allocation: AllocationContext;
}

const SELF_ASSESSMENT_CLOSING = [
  '## Before you finish',
  '',
  '### Final message contract (strict — phone packet hygiene)',
  'Your **final message** is the human-facing deliverable. Structure it as:',
  '1. A short clean narrative (what you did / concluded) — plain markdown only.',
  '2. Then exactly one `## Self-assessment` section with evidence.',
  '',
  'The final message must **stand alone** (operators may not have read the session):',
  '1. One line restating the goal',
  '2. What changed (files / diff summary)',
  '3. Proof (commands run + result)',
  '4. Blocker or open question, or `none`',
  'Forbidden back-references (substring match): `as above`, `see earlier`,',
  '`as discussed`, `如上`, `见上`, `上述`.',
  '',
  '**Forbidden in the final message:**',
  '- Pasting sub-agent / multi-reviewer transcripts',
  '- Multiple `## Verdict` / `## Confidence` / `## Findings` blocks',
  '- Interleaved parallel streams (garbled CJK+Latin mid-line)',
  '- Raw tool logs or long review dumps (write those to files if needed, summarize)',
  'Violations fail the mechanical `report-hygiene` gate and trigger auto-rework.',
  '',
  '### Test integrity (mechanical `test-integrity` gate)',
  'Never delete or rename an existing `it`/`test` title. When behaviour changes,',
  'update that case under its existing title and add new cases for the new',
  'behaviour. A removed or renamed title fails closed and triggers auto-rework.',
  'When you add, rename, or remove a `data-evidence` anchor under `src/web`, run',
  '`pnpm feature-map` and commit the regenerated `docs/agent-readiness/feature-map.md`;',
  'the feature-map sync test fails closed on a stale map.',
  '',
  '### Acceptance criteria types (Definition of Done)',
  'Prefer criteria written as:',
  '- [ ] (mechanical) …   ← proved by L1 gates/scripts only',
  '- [ ] (reviewer) …     ← independent L3 agent decides',
  '- [ ] (human) …        ← phone Approve only; you cannot PASS these',
  '- [ ] (human, after deploy) … ← checked in production after promote; never blocks Approve; you cannot PASS these',
  'A mechanical criterion bound as `@test:<path>#<title>` passes only when `<path>`',
  'declares an `it`/`test` case whose title is **exactly** `<title>` (the `it()` string',
  'alone — `describe` names are not part of it). Write the case under that exact',
  'title; a different title fails closed even when the behaviour is covered.',
  'Untyped items are treated as **human**. Your self-assessment is **evidence**,',
  'not a verdict — you do not have authority to declare the task done.',
  '',
  'In `## Self-assessment`: for each criterion cite evidence (commands, paths,',
  'measurements). For human criteria write `pending human`. Do **not** write',
  '`Result: PASS` for human or unproven reviewer criteria. If you changed no',
  'files, say why that is correct.',
].join('\n');

function hostOperationContract(task: Task): string | null {
  if (!isHostMutatingClass(resolveExecutionClass(task))) return null;
  const scope = (task.hostCommandScope ?? []).map((command) => `- \`${command}\``).join('\n');
  return [
    '## Approved host operation',
    '',
    'Hercules executes these human-approved commands **deterministically** (no LLM tool loop):',
    scope || '- (none)',
    '',
    'Commands run once each, in order, in process groups with an explicit timeout.',
    'On timeout, non-zero exit, cancel, signal, or ambiguous launch, execution stops and',
    'later commands are not run. Automatic retry is forbidden; replay after interrupt is blocked.',
    'The daemon emits exactly one mechanical `## Host operation receipt` with:',
    '- `- **Command scope:**` every approved command in backticks, in the approved order',
    '- `- **Outcome:** success|failed|skipped|partial`',
    '- `- **Post-check evidence:**` bounded/redacted command evidence from this run',
    'A missing, stale, mismatched, non-success, or evidence-free receipt cannot be green.',
  ].join('\n');
}

export function assemblePrompt({ workflowBody, task, allocation }: PromptParts): string {
  const sections: string[] = [];

  const policy = workflowBody.trim();
  if (policy.length > 0) {
    sections.push(policy);
  }

  sections.push(`# Task ${task.id}: ${task.title}\n\n${renderImplementerTaskBody(task.body)}`);

  sections.push(
    [
      '## Allocated workspace',
      'Use these for any isolated boot (unique port, ephemeral DB under the scratch dir):',
      `- slug: \`${allocation.slug}\``,
      `- port: \`${allocation.port}\``,
      `- scratch_dir: \`${allocation.scratchDir}\``,
    ].join('\n'),
  );

  const hostContract = hostOperationContract(task);
  if (hostContract) sections.push(hostContract);

  const factoryPr = factoryOpenPrDuties(task);
  if (factoryPr) {
    sections.push(factoryPr);
  } else {
    const firstLaunch = factoryFirstLaunchDuties(task);
    if (firstLaunch) sections.push(firstLaunch);
  }

  // The acceptance contract (SPEC §9.4): the daemon captures the agent's final
  // message into the review packet, so require it to end with an explicit, per-
  // criterion self-assessment. The `## Self-assessment` marker is parsed back out
  // into the packet's dedicated self-assessment slot.
  sections.push(SELF_ASSESSMENT_CLOSING);

  return sections.join('\n\n---\n\n');
}

/** Shorter closing for resume turns — full contract already lived in the prior turn. */
const STEER_SELF_ASSESSMENT_CLOSING = [
  '## Before you finish',
  'Answer only the follow-up. Final message: short clean narrative + one',
  '`## Self-assessment` with evidence (pending human for human ACs).',
  'Stand alone: goal / changed / proof / blocker; no as-above / see-earlier.',
  'Do not dump multi-reviewer transcripts into the final message.',
].join('\n');

/**
 * Short prompt for a comment-to-steer continue turn. Paired with adapter session
 * resume so the model keeps prior context without re-ingesting the full task.
 * When the task already has an open PR, add mechanical conflict/PR duties so
 * "resolve PR conflicts" is not answered as a short chat reply only.
 */
export function assembleSteerPrompt(task: Task, comment: string): string {
  const followUp = comment.trim();
  const sections: string[] = [
    `# Human follow-up for task ${task.id}: ${task.title}`,
    '',
    'You are continuing the same session. Answer only this follow-up.',
    'Prefer context you already have; open files only when needed for the answer.',
    'Keep the response concise **unless** the follow-up requires git/PR work.',
    '',
    '## Follow-up',
    followUp,
  ];

  if (hasOpenPr(task)) {
    const factoryPr = factoryOpenPrDuties(task);
    if (factoryPr) {
      sections.push('', factoryPr);
    } else {
      sections.push(
        '',
        '## Open PR on this task',
        `PR: ${task.prUrl}`,
        'If this follow-up is about merge conflicts, CI, or PR feedback, you MUST:',
        '1. In this worktree: fetch origin and merge or rebase the default branch.',
        '2. Resolve every conflict; commit the resolution on `hercules/<taskId>`.',
        '3. Push the branch so the open PR updates (do not only claim success in text).',
        '4. Do not claim mergeable until the PR is actually conflict-free on GitHub.',
        'Hercules re-checks PR mergeability mechanically after you finish — a false',
        '"conflicts fixed" report fails the `pr-mergeable` gate and auto-reworks.',
      );
    }
  }

  const hostContract = hostOperationContract(task);
  if (hostContract) sections.push('', hostContract);

  sections.push('', STEER_SELF_ASSESSMENT_CLOSING);
  return sections.join('\n');
}

/**
 * Free Remote Control session — interactive pair-programming, no formal DoD.
 * Still gets allocation context so the agent can boot tools if needed.
 */
const TASK_PROPOSAL_INSTRUCTIONS = [
  '## When to propose a formal Hercules task',
  'If the work is non-trivial, should be tracked, needs gates/review, or the human',
  'asks to "make a task" / "queue this" / "开 task", end your reply with ONE fenced',
  'block (the phone will show an Approve card; you cannot create tasks yourself):',
  '',
  '```hercules-task-proposal',
  'title: Short imperative title',
  `repo: <repo-key or omit to use session default>`,
  'priority: 50',
  'body: |',
  '  ## Task',
  '  What to do (crisp).',
  '  ## Acceptance criteria',
  '  - [ ] (mechanical) …',
  '  - [ ] (reviewer) …',
  '  - [ ] (human) …',
  '```',
  'Do **not** invent proposals for tiny Q&A. Prefer editing in this session when small.',
].join('\n');

export function assembleChatPrompt(input: {
  readonly message: string;
  readonly allocation: AllocationContext;
  readonly repoKey: string;
}): string {
  return [
    '# Remote Control session (interactive)',
    '',
    'You are chatting with a human on their phone. Help with this repository.',
    'Be concise and actionable. Prefer small, correct edits over large rewrites.',
    'You do **not** need a Self-assessment section unless the human asks for a formal report.',
    '',
    `Repo key: \`${input.repoKey}\``,
    '',
    '## Allocated workspace',
    `- slug: \`${input.allocation.slug}\``,
    `- port: \`${input.allocation.port}\``,
    `- scratch_dir: \`${input.allocation.scratchDir}\``,
    '',
    TASK_PROPOSAL_INSTRUCTIONS,
    '',
    '## Human',
    input.message.trim(),
  ].join('\n');
}

/** Continue a free RC session (paired with adapter --resume). */
export function assembleChatContinuePrompt(message: string): string {
  return [
    '# Human follow-up (Remote Control)',
    '',
    'You are continuing the same interactive session. Answer only this message.',
    'Prefer context you already have. Keep the response concise.',
    '',
    TASK_PROPOSAL_INSTRUCTIONS,
    '',
    '## Human',
    message.trim(),
  ].join('\n');
}
