/**
 * Domain — first-class repo readiness onboarding (SPEC §15 / G8).
 *
 * Incomplete repos only dispatch tasks labeled `onboarding` / `readiness`.
 *
 * Prefer the **multi-stage readiness pipeline** (`draftReadinessPipeline`) for
 * heavy repos (Rust/orbit, etc.) so free-tier agents get small stages instead
 * of one monolithic SPEC §15 checklist. The single-task draft remains for
 * light repos and the create-form fill affordance.
 */

/** Labels that allow dispatch while `readiness: incomplete`. */
export const ONBOARDING_LABELS = ['onboarding', 'readiness'] as const;

export interface OnboardingPlanDraft {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly priority: number;
  /** Always true — human edits checklist then Approve plan. */
  readonly planPending: true;
}

/** One stage of the recommended readiness pipeline (POST /api/pipelines). */
export interface ReadinessPipelineStageDraft {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

/**
 * Payload for `POST /api/pipelines` — 4-stage SPEC §15 readiness pattern.
 * Stages are intentionally small for free-tier agent runs.
 */
export interface ReadinessPipelineDraft {
  readonly repo: string;
  readonly title: string;
  /** Stages become `{idPrefix}-1` … `{idPrefix}-4` with linear blocked_by. */
  readonly idPrefix: string;
  readonly priority: number;
  readonly stages: readonly ReadinessPipelineStageDraft[];
}

const STAGE_LABELS: readonly string[] = [...ONBOARDING_LABELS];

/**
 * Build a plan-pending **single** task body for light onboardings.
 * For heavy repos prefer {@link draftReadinessPipeline}.
 * Labels always include onboarding + readiness so incomplete repos can dispatch.
 */
export function draftOnboardingPlan(repoKey: string): OnboardingPlanDraft {
  const key = repoKey.trim() || 'repo';
  const body = [
    '## Task',
    `Make **${key}** ready for autonomous Hercules work (SPEC §15 readiness).`,
    '',
    'This is the **single-task** onboarding path (light repos). For heavy stacks',
    '(Rust, large monorepos, broken baselines) prefer the **4-stage readiness',
    'pipeline** — see `docs/readiness-pipeline.md` or Repos → Start onboarding',
    '(creates R1→R4 automatically).',
    '',
    'This task is labeled `onboarding` / `readiness` so it can dispatch while the',
    'repo is still `readiness: incomplete`. When the checklist is green, a human',
    'marks the repo **ready** in Repos (or leaves it incomplete until sure).',
    '',
    `## Repo`,
    key,
    '',
    '## Definition of Done',
    '- [ ] (mechanical) `AGENTS.md` (or thin `CLAUDE.md` → AGENTS) exists as a map, not an encyclopedia',
    '- [ ] (mechanical) `WORKFLOW.md` has install/boot/gates; Layer-1 gates green @gate:test',
    '- [ ] (mechanical) App boots in isolation via WORKFLOW boot + health_check when applicable',
    '- [ ] (reviewer) "How to verify a change" is documented; first tasks can be crisp',
    '- [ ] (human) Spot-check README / entry docs; set repo readiness to **ready** in Repos when done',
    '',
    '## Notes',
    '- Prefer small first tasks after this: bug with repro, tight feature, test-guarded refactor.',
    '- Do not mark the repo ready until gates and WORKFLOW are trustworthy.',
    '',
  ].join('\n');

  return {
    title: `${key}: repo readiness onboarding`,
    body,
    labels: ['onboarding', 'readiness', 'needs-plan'],
    priority: 20,
    planPending: true,
  };
}

/**
 * Recommended multi-stage readiness pipeline (SPEC §15 split for free-tier agents).
 *
 * | Stage | Focus |
 * |-------|--------|
 * | R1 | AGENTS.md map + thin CLAUDE.md |
 * | R2 | WORKFLOW.md install/boot/gates (gates need not be green yet) |
 * | R3 | Prove L1 green + isolated boot |
 * | R4 | Human checklist + mark repo readiness ready |
 *
 * Compatible with `ActionService.createPipeline` / `POST /api/pipelines`.
 */
export function draftReadinessPipeline(repoKey: string): ReadinessPipelineDraft {
  const key = repoKey.trim() || 'repo';
  const idPrefix = `${key}-ready`;

  const r1Body = [
    '## Goal',
    `Install a short agent map for **${key}** so every coding agent shares one entry point.`,
    '',
    '## Task',
    '- Add or tighten `AGENTS.md` as a **map** (layout, conventions, quality commands, runtime knobs).',
    '- Keep it ≤ ~120 lines — link to SPEC / README / WORKFLOW; do not paste encyclopedias.',
    '- Add a thin `CLAUDE.md` (≤ ~20 lines) that only points agents at `AGENTS.md`.',
    '- Do **not** implement full WORKFLOW gates or chase green CI in this stage.',
    '',
    `## Repo`,
    key,
    '',
    '## Definition of Done',
    '- [ ] (mechanical) `AGENTS.md` exists on the task branch with substantial map content',
    '- [ ] (mechanical) `AGENTS.md` stays within ~120 lines (map, not encyclopedia)',
    '- [ ] (mechanical) `CLAUDE.md` is a thin pointer to `AGENTS.md` (≤ ~20 lines)',
    '- [ ] (reviewer) A new agent can find layout + how to run checks from the map alone',
    '',
    '## Notes',
    '- Next stage (R2) installs WORKFLOW; this stage is docs/map only.',
    '- Labels `onboarding`/`readiness` keep this dispatchable while the repo is incomplete.',
    '',
  ].join('\n');

  const r2Body = [
    '## Goal',
    `Install executable harness policy for **${key}** (WORKFLOW install/boot/gates).`,
    '',
    '## Task',
    '- Add or fix `WORKFLOW.md` (copy from Hercules `WORKFLOW.template.md` and fill placeholders).',
    '- Declare `setup.install`, gate commands (`typecheck`/`lint`/`test`/`build` as applicable),',
    '  and `setup.boot` + `health_check` when the repo is an app.',
    '- **Gates need not be green yet** if the baseline is broken — this stage is about',
    '  declaring a trustworthy command surface, not fixing the entire suite.',
    '- Do not expand AGENTS.md into an encyclopedia; touch the map only if WORKFLOW paths change.',
    '',
    `## Repo`,
    key,
    '',
    '## Definition of Done',
    '- [ ] (mechanical) `WORKFLOW.md` present with YAML front matter that parses',
    '- [ ] (mechanical) At least one gate command is defined under `gates:`',
    '- [ ] (mechanical) `setup.install` is declared (or documented N/A for pure-docs repos)',
    '- [ ] (reviewer) Gate/boot commands match the real stack (cargo/pnpm/etc.)',
    '- [ ] (reviewer) Body prompt points agents at AGENTS.md and does not invent tribal steps',
    '',
    '## Notes',
    '- Green gates + isolated boot proof are **R3**, not this stage.',
    '- Soft checklist score (`Check readiness` in Repos) may still fail until R3.',
    '',
  ].join('\n');

  const r3Body = [
    '## Goal',
    `Prove Layer-1 gates and isolated boot for **${key}** (mechanical readiness).`,
    '',
    '## Task',
    '- Make Layer-1 gates green on the default-branch-compatible worktree (`pnpm check:full`,',
    '  `cargo test`, or whatever WORKFLOW declares).',
    '- Ensure WORKFLOW boot + health_check work in isolation (`{port}`, `{scratch_dir}`,',
    '  ephemeral DB) when the repo is an app; document N/A for pure libraries/docs.',
    '- Fix only what blocks gates/boot — no drive-by refactors.',
    '',
    `## Repo`,
    key,
    '',
    '## Definition of Done',
    '- [ ] (mechanical) All WORKFLOW Layer-1 gates pass @gate:test',
    '- [ ] (mechanical) Isolated boot + health_check succeed when declared in WORKFLOW',
    '- [ ] (reviewer) Failure output is agent-actionable; no silenced tests or empty catches',
    '',
    '## Notes',
    '- If a gate is intentionally deferred, document why in WORKFLOW/AGENTS and keep the',
    '  command honest — do not delete or skip tests to greenwash.',
    '- Human still marks the repo ready in R4; this stage does not flip `readiness`.',
    '',
  ].join('\n');

  const r4Body = [
    '## Goal',
    `Close the human loop for **${key}**: verify checklist, document verification, mark ready.`,
    '',
    '## Task',
    '- Confirm soft readiness checklist is green (Repos → Check readiness) on the trusted branch.',
    '- Ensure "How to verify a change" is obvious (AGENTS map + WORKFLOW gates/boot).',
    '- Suggest first post-onboard tasks (small bug, tight feature, test-guarded refactor).',
    '- **Do not** auto-flip `repos.yaml` readiness — only a human marks ready in Repos.',
    '',
    `## Repo`,
    key,
    '',
    '## Definition of Done',
    '- [ ] (mechanical) Soft readiness checklist required items pass (Reprobe in Repos)',
    '- [ ] (reviewer) Entry docs tell a human how to verify a change without tribal knowledge',
    '- [ ] (human) Spot-check README / map / WORKFLOW; **Mark ready** in Repos when trustworthy',
    '',
    '## Notes',
    '- Leave the repo incomplete if anything still feels untrustworthy.',
    '- After ready: prefer small first autonomous tasks, not vague judgment-heavy work.',
    '',
  ].join('\n');

  return {
    repo: key,
    title: `${key} readiness`,
    idPrefix,
    priority: 20,
    stages: [
      {
        title: 'R1: AGENTS.md map + thin CLAUDE.md',
        body: r1Body,
        labels: STAGE_LABELS,
      },
      {
        title: 'R2: WORKFLOW install/boot/gates',
        body: r2Body,
        labels: STAGE_LABELS,
      },
      {
        title: 'R3: Prove L1 green + isolated boot',
        body: r3Body,
        labels: STAGE_LABELS,
      },
      {
        title: 'R4: Human checklist + mark ready',
        body: r4Body,
        labels: STAGE_LABELS,
      },
    ],
  };
}

/** True when a task may run on an incomplete repo (scheduling G8). */
export function isOnboardingLabel(label: string): boolean {
  const x = label.trim().toLowerCase();
  return x === 'onboarding' || x === 'readiness';
}

export function taskHasOnboardingLabel(labels: readonly string[]): boolean {
  return labels.some(isOnboardingLabel);
}
