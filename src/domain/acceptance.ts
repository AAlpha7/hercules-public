/**
 * Domain layer — typed Definition of Done / acceptance criteria (SPEC §9.4).
 *
 * Each criterion has a proof kind. The implementer may only *evidence* claims;
 * judgment authority is:
 *   - mechanical → L1 gates / scripts / L2 evidence / proof bindings
 *   - reviewer   → fresh L3 session
 *   - human      → phone Approve only (never agent PASS)
 *   - checkpoint → phone confirm before a named step (counts as human for Approve)
 *
 * Untyped checklist items default to `human` (safe: cannot self-green).
 */
import {
  aggregateMechanicalStatus,
  evaluateMechanicalCriterion,
  parseMechProofBinding,
  parseScenarioBinding,
} from './mechProof.js';

export const CRITERION_KINDS = ['mechanical', 'reviewer', 'human', 'checkpoint'] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

export interface AcceptanceCriterion {
  readonly text: string;
  readonly kind: CriterionKind;
  /** Checkbox state from the task body, if written as `- [x]` / `- [ ]`. */
  readonly checked: boolean | null;
  /** `(human, after deploy)`: only checkable once the change is in production; never blocks Approve. */
  readonly afterDeploy?: true;
}

export interface DefinitionOfDone {
  readonly criteria: readonly AcceptanceCriterion[];
  readonly needsReviewer: boolean;
  readonly needsHuman: boolean;
  readonly hasMechanical: boolean;
  /** True when a ## Acceptance criteria section was found. */
  readonly hasSection: boolean;
  /** Parse warnings (e.g. untyped lines treated as human). */
  readonly warnings: readonly string[];
}

export type DimensionStatus =
  | 'pass'
  | 'fail'
  | 'pending'
  | 'n/a'
  | 'skipped'
  /** Matcher could not observe proof; gates green — human must confirm. */
  | 'unverified';

/** Icon for a DoD / criterion dimension status (packet + SPA). */
export function dimIcon(status: DimensionStatus | string): string {
  switch (status) {
    case 'pass':
      return '✅';
    case 'fail':
      return '❌';
    case 'pending':
      return '⏳';
    case 'skipped':
      return '⏭';
    case 'unverified':
      return '❔';
    default:
      return '—';
  }
}

/** Short zh label for criterion / axis status chips. */
export function dimStatusLabelZh(status: DimensionStatus | string): string {
  switch (status) {
    case 'pass':
      return '通过';
    case 'fail':
      return '失败';
    case 'pending':
      return '待定';
    case 'skipped':
      return '跳过';
    case 'unverified':
      return '无法自动核验';
    case 'n/a':
      return '不适用';
    default:
      return status;
  }
}

/**
 * Three-axis proof status for the review packet (not a single false green light).
 */
export interface DodDimensions {
  readonly mechanical: DimensionStatus;
  readonly reviewer: DimensionStatus;
  readonly human: DimensionStatus;
  readonly criteria: readonly {
    readonly text: string;
    readonly kind: CriterionKind;
    readonly status: DimensionStatus;
    /** Human-readable proof source for the packet. */
    readonly proof: string;
    readonly warning?: string | null;
  }[];
  readonly warnings: readonly string[];
  /**
   * Mechanical criteria whose proof matcher could not observe the expected
   * signal (gate green + file in diff). Axis may still be `pass`; SPA lists
   * these as human-confirm items. Empty when none.
   */
  readonly unverifiedCriteria?: readonly {
    readonly text: string;
    readonly warning: string;
  }[];
}

/**
 * Typed criteria may live under either heading (agents often write
 * `## Definition of Done` with `(mechanical)` bullets — same authority as
 * `## Acceptance criteria`).
 */
export const SECTION_RE =
  /^##\s+(?:Acceptance criteria|Definition of Done|验收标准|完成定义|DoD)\s*$/im;
export const ITEM_RE = /^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.+)$/;

/** Kind tags: (mechanical), [reviewer], （机检）, 审稿:, (checkpoint), 检查点: — backticks optional. */
export const KIND_PREFIX_RE =
  /^(?:`+)?(?:[[(【（]\s*(mechanical|reviewer|human|checkpoint|机检|审稿|人工|检查点|l1|l3)\s*[)\]】）]|((?:mechanical|reviewer|human|checkpoint|机检|审稿|人工|检查点))\s*[:：])(?:`+)?\s*/i;

/**
 * `(human, after deploy)` / `(人工, 上线后)` and aliases — second pass on the kind
 * token only; does not weaken KIND_PREFIX_RE for other kinds.
 */
export const HUMAN_AFTER_DEPLOY_RE =
  /^(?:`+)?[[(【（]\s*(?:human|人工)\s*[,:，：;]\s*(?:after[\s-]?deploy|post[\s-]?deploy|上线后|部署后)\s*[)\]】）](?:`+)?\s*/i;

function normalizeKind(raw: string): CriterionKind | null {
  const k = raw.trim().toLowerCase();
  if (k === 'mechanical' || k === '机检' || k === 'l1') return 'mechanical';
  if (k === 'reviewer' || k === '审稿' || k === 'l3') return 'reviewer';
  if (k === 'human' || k === '人工') return 'human';
  if (k === 'checkpoint' || k === '检查点') return 'checkpoint';
  return null;
}

function proofForKind(kind: CriterionKind): string {
  if (kind === 'reviewer') return 'L3 review';
  if (kind === 'checkpoint') return 'human confirm before step';
  if (kind === 'human') return 'human approve';
  return 'unbound';
}

/**
 * Parse typed acceptance criteria from a task body.
 * Looks at the first `## Acceptance criteria` / `## Definition of Done` section
 * until the next `##` heading (Review packet stops the block).
 */
/**
 * SPEC §9.4 plan-first gate: does the body carry at least one checkable
 * criterion under a recognized Acceptance criteria / Definition of Done
 * section? Tasks without one are held planPending at creation so a human
 * signs off (or adds criteria) before any agent runs — self-verification is
 * only possible when "done" is defined.
 */
export function hasCheckableCriteria(body: string): boolean {
  const dod = parseDefinitionOfDone(body);
  return dod.hasSection && dod.criteria.length > 0;
}

export function parseDefinitionOfDone(body: string): DefinitionOfDone {
  // Strip committed review packets so re-parses see original DoD only.
  const cut = /^##\s+Review packet\b/im.exec(body);
  const source = cut && cut.index !== undefined ? body.slice(0, cut.index) : body;

  const sectionMatch = SECTION_RE.exec(source);
  if (!sectionMatch || sectionMatch.index === undefined) {
    return {
      criteria: [],
      needsReviewer: false,
      needsHuman: false,
      hasMechanical: false,
      hasSection: false,
      warnings: [],
    };
  }

  const after = source.slice(sectionMatch.index + sectionMatch[0].length);
  const nextHeading = /^##\s+/m.exec(after);
  const block = (nextHeading ? after.slice(0, nextHeading.index) : after).trim();

  const criteria: AcceptanceCriterion[] = [];
  const warnings: string[] = [];

  for (const line of block.split('\n')) {
    const item = ITEM_RE.exec(line);
    if (!item) continue;
    const checkedRaw = item[1];
    const rest = item[2]!.trim();
    if (rest.length === 0) continue;

    const afterDeployMatch = HUMAN_AFTER_DEPLOY_RE.exec(rest);
    const kindMatch = afterDeployMatch ? null : KIND_PREFIX_RE.exec(rest);
    let kind: CriterionKind;
    let text: string;
    let afterDeploy: true | undefined;
    if (afterDeployMatch) {
      kind = 'human';
      text = rest.slice(afterDeployMatch[0].length).trim();
      afterDeploy = true;
    } else if (kindMatch) {
      const rawKind = kindMatch[1] ?? kindMatch[2] ?? '';
      kind = normalizeKind(rawKind) ?? 'human';
      text = rest.slice(kindMatch[0].length).trim();
    } else {
      kind = 'human';
      text = rest;
      warnings.push(`untyped criterion treated as human: "${text.slice(0, 60)}"`);
    }
    if (text.length === 0) continue;
    const checked =
      checkedRaw === undefined ? null : checkedRaw.toLowerCase() === 'x';
    criteria.push(
      afterDeploy === true
        ? { text, kind, checked, afterDeploy: true }
        : { text, kind, checked },
    );
  }

  const hasHumanOrCheckpoint = criteria.some(
    (c) => c.kind === 'human' || c.kind === 'checkpoint',
  );
  return {
    criteria,
    needsReviewer: criteria.some((c) => c.kind === 'reviewer'),
    needsHuman: hasHumanOrCheckpoint || criteria.length === 0,
    hasMechanical: criteria.some((c) => c.kind === 'mechanical'),
    hasSection: true,
    warnings,
  };
}

export interface ReviewerRunInput {
  readonly dod: DefinitionOfDone;
  readonly noFileChanges: boolean;
  readonly gatesPassed: boolean;
  readonly reviewerAvailable: boolean;
  /** Env opt-out HERCULES_REVIEWER=0 */
  readonly reviewerDisabled?: boolean;
}

/**
 * Why L3 did not run (null when it should / did run). Surfaced in the review
 * packet so humans never see a silent `n/a` with no explanation.
 */
export function reviewerSkipReason(input: ReviewerRunInput): string | null {
  if (input.reviewerDisabled) return 'L3 disabled (HERCULES_REVIEWER=0)';
  if (!input.reviewerAvailable) return 'no L3 runner configured';
  if (!input.gatesPassed) return 'L1 gates failed — L3 not run';
  if (input.noFileChanges) return 'no file changes (read-only / Q&A)';
  return null;
}

/**
 * Should L3 run for this completion?
 * Any changeful green run gets independent review by default (non-trivial work).
 * Skip only for: disabled / no runner / failed gates / no file changes.
 */
export function shouldRunReviewer(input: ReviewerRunInput): boolean {
  return reviewerSkipReason(input) === null;
}

export interface BuildDodInput {
  readonly dod: DefinitionOfDone;
  readonly gatesPassed: boolean;
  readonly noFileChanges: boolean;
  readonly reviewerVerdict: { readonly approved: boolean } | null;
  readonly reviewerRan: boolean;
  /**
   * When L3 did not run, why (from {@link reviewerSkipReason}). Used to choose
   * `n/a` (nothing to review / no file changes) vs `skipped` (disabled, no
   * runner, or expected but missing — visible, never green).
   */
  readonly reviewerSkipReason?: string | null;
  /**
   * Empty worktree but task expected changes / false delivery claim.
   * Forces mechanical fail (not soft n/a).
   */
  readonly deliveryFailed?: boolean;
  /**
   * L2 required steps failed (G1). null/undefined = L2 not applicable / not run.
   * true = failed; false = ok.
   */
  readonly behavioralFailed?: boolean;
  /** L2 declared + expected but produced no evidence (never ran). */
  readonly behavioralMissing?: boolean;
  /** Critical L5 findings (G4) — hard mechanical fail until fixed. */
  readonly hasCriticalCheats?: boolean;
  /** Gate names that ran (for @gate: bindings). */
  readonly gateNames?: readonly string[];
  /** L2 step detail strings for @evidence: matching. */
  readonly evidenceStepDetails?: readonly string[];
  /** L2 overall ok when run; null if not run. */
  readonly evidenceOk?: boolean | null;
  readonly filesTouched?: readonly string[];
  readonly selfAssessment?: string;
  /**
   * L1 test/held-out failure fully reproduces on merge-base (trunk debt).
   * Mechanical criteria for gates are skipped; no auto-rework.
   */
  readonly trunkInheritedGateFail?: boolean;
  readonly testGate?: {
    readonly passed: boolean;
    readonly output: string;
    readonly command?: string;
  } | null;
  readonly testCaseIndex?: ReadonlyMap<string, readonly string[]>;
  readonly addedTestTitles?: ReadonlyMap<string, readonly string[]>;
  /** package.json scripts for @test path observation via script name. */
  readonly packageJsonScripts?: Readonly<Record<string, string>>;
  /**
   * Diff touches a gate-resolved toolchain file (S2). Mechanical pass/n/a
   * become pending — verdict cannot be trusted until a human reviews.
   */
  readonly gateToolchainEdited?: boolean;
}

/**
 * Build three-axis status from gates + optional L3 + DoD + L2/L5 hard gates.
 * Human is always `pending` when human/checkpoint ACs exist or DoD is empty; else `n/a`.
 */
export function buildDodDimensions(input: BuildDodInput): DodDimensions {
  const { dod, gatesPassed, noFileChanges, reviewerVerdict, reviewerRan } = input;
  const skip = input.reviewerSkipReason ?? null;
  const deliveryFailed = input.deliveryFailed === true;
  const behavioralFailed = input.behavioralFailed === true;
  const behavioralMissing = input.behavioralMissing === true && !behavioralFailed;
  const hasCriticalCheats = input.hasCriticalCheats === true;
  const gateNames = input.gateNames ?? [];
  const evidenceOk = input.evidenceOk ?? null;
  const evidenceStepDetails = input.evidenceStepDetails ?? [];
  const filesTouched = input.filesTouched ?? [];
  const selfAssessment = input.selfAssessment ?? '';

  const trunkInheritedGateFail = input.trunkInheritedGateFail === true;
  const gateToolchainEdited = input.gateToolchainEdited === true;
  const warnings: string[] = [...dod.warnings];
  if (behavioralFailed) {
    warnings.push('L2 behavioral evidence: required step failed');
  }
  if (hasCriticalCheats) {
    warnings.push('Critical L5 anti-cheat findings — auto-rework (not human queue)');
  }
  if (trunkInheritedGateFail) {
    warnings.push(
      'L1 test/held-out failure reproduces on merge-base (trunk) — mechanical skipped, no auto-rework',
    );
  }
  if (gateToolchainEdited) {
    warnings.push(
      'gate toolchain edited — mechanical verdict cannot be trusted until a human reviews the listed files',
    );
  }

  const mechCriteria = dod.criteria.filter((c) => c.kind === 'mechanical');
  const criterionEvals = mechCriteria.map((c) => {
    // Trunk-inherited: gate-bound mechanical items are not this task's debt.
    if (trunkInheritedGateFail) {
      const clean = parseMechProofBinding(c.text).cleanText;
      return {
        text: clean.length > 0 ? clean : c.text,
        kind: c.kind,
        status: 'skipped' as const,
        proof: 'trunk-inherited skip',
        warning: null as string | null,
        raw: c,
      };
    }
    const ev = evaluateMechanicalCriterion({
      criterionText: c.text,
      gatesPassed: gatesPassed && !deliveryFailed && !behavioralFailed && !hasCriticalCheats,
      gateNames,
      evidenceOk,
      evidenceStepDetails,
      filesTouched,
      selfAssessment,
      behavioralMissing,
      ...(input.testGate !== undefined ? { testGate: input.testGate } : {}),
      ...(input.testCaseIndex !== undefined ? { testCaseIndex: input.testCaseIndex } : {}),
      ...(input.addedTestTitles !== undefined
        ? { addedTestTitles: input.addedTestTitles }
        : {}),
      ...(input.packageJsonScripts !== undefined
        ? { packageJsonScripts: input.packageJsonScripts }
        : {}),
    });
    // Unverified warnings stay on the criterion row only — do not also push
    // them into dod.warnings (packet would repeat 「无法自动核验」 three times).
    if (ev.warning && ev.status !== 'unverified') warnings.push(ev.warning);
    // Display clean text (strip @binding) in packet criteria list.
    const clean = parseMechProofBinding(c.text).cleanText;
    return {
      text: clean.length > 0 ? clean : c.text,
      kind: c.kind,
      status: ev.status,
      proof: ev.proof,
      warning: ev.warning,
      raw: c,
    };
  });

  // When no mechanical criteria, axis follows L1/L2/delivery only.
  const mechanical: DimensionStatus = (() => {
    if (hasCriticalCheats) return 'fail';
    const base = aggregateMechanicalStatus({
      gatesPassed,
      deliveryFailed,
      noFileChanges,
      hasMechanicalCriteria: dod.hasMechanical,
      behavioralFailed,
      behavioralMissing,
      trunkInheritedGateFail,
      criterionStatuses: criterionEvals.map((e) => e.status),
    });
    // S2: gate-toolchain edits demote pass/n/a → pending (fail/skipped unchanged).
    if (gateToolchainEdited && (base === 'pass' || base === 'n/a')) {
      return 'pending';
    }
    return base;
  })();

  const reviewer: DimensionStatus = (() => {
    if (reviewerRan && reviewerVerdict) {
      return reviewerVerdict.approved ? 'pass' : 'fail';
    }
    if (reviewerRan) return 'fail'; // ran but no parseable verdict
    // Not run.
    if (noFileChanges) return 'n/a';
    if (skip !== null) {
      // Explicit reviewer ACs without an L3 run → hard skip (visible, not green).
      if (dod.needsReviewer) return 'skipped';
      // Pure host/deploy runs intentionally leave no source diff. Their exact
      // current-run receipt is verified mechanically, so the code reviewer has
      // nothing to inspect and is not applicable.
      if (skip.startsWith('no file changes')) return 'n/a';
      // Disabled / no runner with a non-empty diff → skipped (never n/a).
      if (skip.startsWith('L3 disabled') || skip.startsWith('no L3 runner')) {
        return 'skipped';
      }
      // No AC section + real diff expected L3; missing run is a hard skip.
      if (!dod.hasSection) return 'skipped';
      // e.g. L1 gates failed — L3 not run (nothing to review yet).
      return 'n/a';
    }
    // Should have run but didn't (unexpected).
    return 'skipped';
  })();

  const hasCheckpoint = dod.criteria.some((c) => c.kind === 'checkpoint');
  const human: DimensionStatus =
    dod.needsHuman || !dod.hasSection || hasCheckpoint
      ? 'pending'
      : dod.criteria.some((c) => c.kind === 'human')
        ? 'pending'
        : 'n/a';

  const criteria = dod.criteria.map((c) => {
    if (c.kind === 'mechanical') {
      const found = criterionEvals.find((e) => e.raw === c);
      const status =
        found?.status ??
        (mechanical === 'pass' ? 'pass' : mechanical === 'fail' ? 'fail' : 'n/a');
      const text = parseMechProofBinding(c.text).cleanText || c.text;
      return {
        text,
        kind: c.kind,
        status,
        proof: found?.proof ?? 'unbound',
        warning: found?.warning ?? null,
      };
    }
    if (c.kind === 'reviewer') {
      return {
        text: c.text,
        kind: c.kind,
        status: reviewer,
        proof: proofForKind(c.kind),
        warning: null,
      };
    }
    // human + checkpoint — strip @scenario:<id> like other bindings
    const scenario = parseScenarioBinding(c.text);
    return {
      text: scenario.cleanText.length > 0 ? scenario.cleanText : c.text,
      kind: c.kind,
      status: 'pending' as const,
      proof: proofForKind(c.kind),
      warning: null,
    };
  });

  if (skip !== null && !reviewerRan && !noFileChanges) {
    warnings.push(`L3 not run: ${skip}`);
  }

  const unverifiedCriteria = criterionEvals
    .filter(
      (e): e is typeof e & { warning: string } =>
        e.status === 'unverified' && typeof e.warning === 'string' && e.warning.length > 0,
    )
    .map((e) => ({ text: e.text, warning: e.warning }));

  return {
    mechanical,
    reviewer,
    human,
    criteria,
    warnings,
    ...(unverifiedCriteria.length > 0 ? { unverifiedCriteria } : {}),
  };
}

/**
 * True when the run should auto-requeue for rework instead of human review:
 * L3 requested changes, L1/L2 failed, critical L5, or delivery honesty failed.
 */
export function shouldAutoRework(input: {
  readonly dimensions: DodDimensions;
  readonly noFileChanges: boolean;
  /** Empty-diff run that still must rework (implementation expected / false claim). */
  readonly deliveryFailed?: boolean;
  /** Critical anti-cheat findings (G4). */
  readonly hasCriticalCheats?: boolean;
  /** L2 required evidence failed (G1). */
  readonly behavioralFailed?: boolean;
  /**
   * Open PR still CONFLICTING after this turn (settings-build: agent claimed
   * conflicts fixed; harness must re-queue, even on empty-diff steers).
   */
  readonly prConflicting?: boolean;
  /**
   * Task branch conflicts with the default branch (base-drift probe).
   * Harness must re-queue; never force-push main / never merge to main.
   */
  readonly baseDriftConflict?: boolean;
}): boolean {
  if (input.deliveryFailed) return true;
  if (input.hasCriticalCheats) return true;
  if (input.behavioralFailed) return true;
  if (input.prConflicting) return true;
  if (input.baseDriftConflict) return true;
  // Soft no-diff Q&A parks in review for the human; never auto-loop forever.
  if (input.noFileChanges) return false;
  if (input.dimensions.reviewer === 'fail') return true;
  if (input.dimensions.mechanical === 'fail') return true;
  return false;
}

/** Full automated green (still never includes human). */
export function isAutomatedGreen(d: DodDimensions): boolean {
  if (d.mechanical === 'fail') return false;
  if (d.reviewer === 'fail' || d.reviewer === 'skipped') return false;
  const mechOk = d.mechanical === 'pass' || d.mechanical === 'n/a';
  const revOk = d.reviewer === 'pass' || d.reviewer === 'n/a';
  return mechOk && revOk;
}

/**
 * Human-axis criterion texts that must be acknowledged before Approve.
 * Prefer the DoD / Acceptance criteria section; if missing, fall back to
 * review-packet lines that still carry an explicit `(human)` tag.
 * Checkpoint texts are first-class (Approve must acknowledge them).
 */
export function listHumanCriteriaTexts(body: string): readonly string[] {
  const dod = parseDefinitionOfDone(body);
  if (dod.hasSection) {
    return dod.criteria
      .filter(
        (c) =>
          (c.kind === 'human' || c.kind === 'checkpoint') && c.afterDeploy !== true,
      )
      // Same display text as the DoD dims / evidence matrix / decision card
      // (which strip `@scenario:<id>`), so checklist ↔ card rows match by text.
      .map((c) => parseScenarioBinding(c.text).cleanText || c.text);
  }
  return listHumanFromPacket(body);
}

/** After-deploy human criteria (never gate Approve; surfaced post-promote). */
export function listAfterDeployCriteriaTexts(body: string): readonly string[] {
  const dod = parseDefinitionOfDone(body);
  if (!dod.hasSection) return [];
  return dod.criteria.filter((c) => c.afterDeploy === true).map((c) => c.text);
}

/** Packet fallback when no DoD section (legacy / hollow bodies). */
function listHumanFromPacket(body: string): readonly string[] {
  const out: string[] = [];
  // Optional status token, then `(human)` or `(human, after deploy)` (backticks optional).
  const re =
    /^\s*[-*]\s+[^\s]*\s+`?\((?:human|人工)(\s*[,:，：;]\s*(?:after[\s-]?deploy|post[\s-]?deploy|上线后|部署后))?\)`?\s+(.+)$/i;
  for (const line of body.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    // Modifier present → after-deploy; never blocks Approve.
    if (m[1]) continue;
    const text = m[2]?.trim();
    if (text) out.push(text);
  }
  return out;
}

/**
 * Human criteria still missing from the phone checklist.
 * Empty ⇒ Approve may proceed (server + UI share this chokepoint).
 * Matching is exact on trimmed criterion text.
 */
export function missingHumanAcknowledgements(
  body: string,
  acknowledged: readonly string[],
): readonly string[] {
  const required = listHumanCriteriaTexts(body);
  if (required.length === 0) return [];
  const ack = new Set(
    acknowledged.map((t) => t.trim()).filter((t) => t.length > 0),
  );
  return required.filter((text) => !ack.has(text));
}

/** Operator-facing bilingual reason when a task is held for Approve plan. */
export interface PlanPendingReason {
  readonly en: string;
  readonly zh: string;
}

export const PLAN_PENDING_REASON: PlanPendingReason = {
  en:
    'No checkable acceptance criteria. Add a section headed Acceptance criteria / Definition of Done / 验收标准 / 完成定义 / DoD with at least one binding ((mechanical), (reviewer), or (human)), then Approve plan.',
  zh:
    '缺少可机检的验收标准。请添加「Acceptance criteria / Definition of Done / 验收标准 / 完成定义 / DoD」标题，并在条目中带绑定类型（(mechanical)/(reviewer)/(human)），然后点「批准计划」。',
};

export function planPendingReasonFor(task: {
  readonly planPending: boolean;
}): PlanPendingReason | null {
  return task.planPending ? PLAN_PENDING_REASON : null;
}
