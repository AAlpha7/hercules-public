/**
 * Verification — the review packet (SPEC §9.6).
 *
 * The verification pipeline's output IS the mobile review artifact: a diff
 * summary + files touched, which gates are green, the reviewer's verdict, the
 * typed DoD axes, and the agent's self-assessment (evidence only). Pure:
 * assembly + markdown rendering.
 */
import {
  buildDodDimensions,
  dimIcon,
  isAutomatedGreen,
  shouldAutoRework,
  type DodDimensions,
} from '../domain/acceptance.js';
import { assessDeliveryHonesty } from '../domain/delivery.js';
import { buildEvidenceMatrix } from '../domain/evidenceMatrix.js';
import {
  buildDecisionCard,
  parseCrossTaskIdsFromDetail,
  renderDecisionCardBlock,
  reviewOnlyFlagMeaningZh,
  type CrossTaskCommit,
} from '../domain/decisionCard.js';
import { resolveEvidencePlan, type EvidenceStepResult } from '../domain/evidence.js';
import { chooseReworkPath } from '../domain/reworkPolicy.js';
import {
  boundReviewerReport,
  countedGates,
  isCriticalCheatKind,
  type CheatFinding,
  type EvidenceMatrixRow,
  type GateResult,
  type PacketRunKind,
  type PacketUsage,
  type ReviewPacket,
  type ReviewerVerdict,
} from '../domain/verification.js';
import type { DefinitionOfDone } from '../domain/acceptance.js';
import type { CliEvidenceLinkStep } from '../domain/uiAcEvidence.js';
import {
  formatBaseDriftMarkdown,
  isBaseDriftBlocking,
  type BaseDriftReport,
} from '../domain/baseDrift.js';
import {
  formatGateFailAttributionMarkdown,
  isTrunkInherited,
  type GateFailAttributionReport,
} from '../domain/gateFailAttribution.js';
import { foldNoiseAndMapDiff, partitionFilesForPacket } from '../domain/packetNoise.js';
import {
  formatHostOperationReceipt,
  HOST_OP_RECEIPT_HEADING,
  isHostMutatingClass,
  parseHostOperationReceipt,
  resolveExecutionClass,
  stripHostOperationReceiptSections,
  validateHostOperationReceipt,
  type ExecutionClass,
  type HostOperationReceipt,
} from '../domain/executionClass.js';
import {
  formatCliEvidenceReceipt,
  isCliEvidenceFailed,
  isCliEvidenceNotRun,
  neutralizeCliEvidenceStructure,
  serializeCliEvidenceReceipt,
  type CliEvidenceReceipt,
} from '../domain/cliEvidence.js';
import {
  computeL2Relevance,
  toL2RelevanceRecord,
  type L2RelevanceRecord,
} from '../domain/l2Relevance.js';
import { parseMechProofBinding } from '../domain/mechProof.js';
import { finalReportBackReferences } from '../domain/finalReport.js';
import {
  collectCliHollowShots,
  collectL2HollowShots,
  detectHollowEvidence,
  HOLLOW_EVIDENCE_DETAIL_PREFIX,
  type HollowEvidenceReport,
} from '../domain/hollowEvidence.js';
import { randomBytes } from 'node:crypto';
import {
  neutralizeUntrustedPacketText as neutralizePacketText,
} from '../domain/packetNeutralize.js';

export {
  neutralizeUntrustedPacketText,
  neutralizeProseHtmlComments,
  PACKET_HEADING_NEUTRALIZER,
} from '../domain/packetNeutralize.js';

type ProseKind = 'report' | 'self-assessment' | 'reviewer';

function pushFencedProse(
  lines: string[],
  kind: ProseKind,
  nonce: string,
  text: string,
  taskId: string,
): void {
  lines.push(`<!-- hercules:prose-begin kind=${kind} nonce=${nonce} -->`);
  lines.push(neutralizePacketText(text, { taskId }));
  lines.push(`<!-- hercules:prose-end nonce=${nonce} -->`);
}

/** True when L2 evidence was attempted and a required step failed (G1). */
export function isBehavioralFailed(
  evidenceRun: ReviewPacket['evidenceRun'] | undefined,
): boolean {
  return evidenceRun !== undefined && evidenceRun.ok === false;
}

/** Detect hollow evidence from L2 step hashes and/or CLI artifacts. */
export function detectHollowEvidenceFromParts(parts: {
  readonly evidenceRun?: ReviewPacket['evidenceRun'];
  readonly cliEvidence?: CliEvidenceReceipt;
}): HollowEvidenceReport {
  const shots = [
    ...(parts.evidenceRun
      ? collectL2HollowShots(parts.evidenceRun.steps)
      : []),
    ...(parts.cliEvidence
      ? collectCliHollowShots(parts.cliEvidence.steps)
      : []),
  ];
  const fromHashes = detectHollowEvidence(shots);
  if (fromHashes.hits.length > 0) return fromHashes;
  // Production L2 path may omit sha256 on the packet (orchestrator map); fall
  // back to the hollow detail marker written by evidenceDrive.
  const marked = parts.evidenceRun?.steps.some(
    (s) => typeof s.detail === 'string' && s.detail.startsWith(HOLLOW_EVIDENCE_DETAIL_PREFIX),
  );
  if (marked) {
    return {
      hits: [
        {
          sha256: 'detail-marker',
          count: 2,
          scenarios: ['(marked)'],
          names: ['(marked)'],
        },
      ],
      packetLine:
        '❌ hollow evidence — screenshots identical across scenarios (see L2 step details)',
      detail:
        '❌ hollow evidence — screenshots identical across scenarios (see L2 step details)',
    };
  }
  return { hits: [], packetLine: null, detail: null };
}

function formatCliEvidenceTrustFragment(cli: CliEvidenceReceipt): string {
  if (cli.status === 'passed') {
    return 'CLI行为证据 ' + String(cli.steps.length) + ' 步通过';
  }
  if (cli.status === 'failed') return 'CLI行为证据未通过';
  return 'CLI行为证据未运行';
}

function formatCliOnlyTrust(cli: CliEvidenceReceipt, browserExpected = false): string {
  return formatCliEvidenceTrustFragment(cli) + (browserExpected ? ' · 浏览器行为证据未运行' : ' · 浏览器证据不适用');
}

function formatBrowserAndCliTrust(
  browser: NonNullable<ReviewPacket['evidenceRun']>,
  cli: CliEvidenceReceipt,
): string {
  const b = browser.ok
    ? '浏览器行为证据 ' + String(browser.steps.length) + ' 步通过'
    : '浏览器行为证据未通过';
  return b + ' · ' + formatCliEvidenceTrustFragment(cli);
}

/**
 * Presentation-only zh fragment for the decision-summary evidence axis.
 * Browser L2 and trusted CLI are separate; CLI-only marks browser N/A.
 */
export function formatEvidenceTrustLine(input: {
  readonly evidenceRun?: ReviewPacket['evidenceRun'];
  readonly cliEvidence?: CliEvidenceReceipt;
  readonly browserExpected?: boolean;
}): string {
  const browser = input.evidenceRun;
  const cli = input.cliEvidence;
  if (!cli && !browser) return '行为证据未运行';
  if (browser && cli) {
    return formatBrowserAndCliTrust(browser, cli);
  }
  if (browser) {
    return browser.ok
      ? '行为证据 ' + String(browser.steps.length) + ' 步通过'
      : '行为证据未通过';
  }
  return formatCliOnlyTrust(cli!, input.browserExpected === true);
}

/**
 * Aggregate presentation ok for the decision-card evidence chip.
 * Browser L2 and trusted CLI are separate channels: both must pass when
 * both are in play; either channel failing or expected-but-missing forces false.
 */
function resolvePresentationEvidenceOk(
  parts: {
    readonly evidenceRun?: ReviewPacket['evidenceRun'];
    readonly cliEvidence?: CliEvidenceReceipt;
    readonly cliEvidenceExpectedButMissing?: boolean;
    readonly behavioralExpectedButMissing?: boolean;
  },
  browserEvidenceOk: boolean | null,
): boolean | null {
  const browserMissing =
    parts.behavioralExpectedButMissing === true && parts.evidenceRun === undefined;
  const cliMissing =
    parts.cliEvidenceExpectedButMissing === true && parts.cliEvidence === undefined;

  const channels: Array<boolean | null> = [];
  if (browserMissing) channels.push(false);
  else if (parts.evidenceRun !== undefined) channels.push(browserEvidenceOk);

  if (cliMissing) channels.push(false);
  else if (parts.cliEvidence !== undefined) channels.push(parts.cliEvidence.ok === true);

  if (channels.length === 0) return null;
  // Any hard fail/missing wins; stale-browser null alone stays null.
  if (channels.some((c) => c === false)) return false;
  if (channels.some((c) => c === null)) return null;
  return true;
}

function resolvePresentationEvidenceSteps(
  parts: { readonly evidenceRun?: ReviewPacket['evidenceRun']; readonly cliEvidence?: CliEvidenceReceipt },
): number {
  const browserSteps = parts.evidenceRun?.steps.length ?? 0;
  const cliSteps = parts.cliEvidence?.steps.length ?? 0;
  return browserSteps + cliSteps;
}

function resolvePresentationEvidenceSkip(
  parts: {
    readonly evidenceRun?: ReviewPacket['evidenceRun'];
    readonly cliEvidence?: CliEvidenceReceipt;
    readonly behavioralSkipDetail?: string;
  },
): string | undefined {
  const browserSkip = parts.behavioralSkipDetail;
  const cli = parts.cliEvidence;
  const cliSkip =
    cli !== undefined && cli.ok !== true ? cli.omissionReason : undefined;
  if (browserSkip && cliSkip) return browserSkip + '; ' + cliSkip;
  if (cliSkip) return cliSkip;
  if (parts.evidenceRun !== undefined) return browserSkip;
  return cli?.omissionReason ?? browserSkip;
}

export interface ReviewPacketParts {
  readonly taskId: string;
  readonly branch: string;
  readonly filesTouched: readonly string[];
  readonly diffSummary: string;
  readonly diff?: string;
  readonly gates: readonly GateResult[];
  readonly cheatFindings: readonly CheatFinding[];
  readonly screenshots?: readonly string[];
  readonly evidenceRun?: ReviewPacket['evidenceRun'];
  /**
   * WORKFLOW declared a `behavioral:` block (L2 REQUIRED for this repo) but no
   * evidence was produced — the app was never booted/driven (no browser, boot
   * failed, missing auth, empty plan). Non-green + visible, but NOT auto-rework
   * (re-dispatching the agent can't install a browser — env/config, not code).
   */
  readonly behavioralExpectedButMissing?: boolean;
  /**
   * The repo's WORKFLOW has NO behavioral: block at all — L2 can never run
   * for this repo. Soft WARN row (green unaffected: policy gap, not this
   * task's fault) so the absence is visible instead of silent (bookshelf,
   * 2026-07-23). The readiness checklist blocks mark-ready on the same fact.
   */
  readonly behavioralNotDeclared?: boolean;
  /** EXACT reason evidence did not run — replaces the old guess-list. */
  readonly behavioralSkipDetail?: string;
  /**
   * Repo-relative WORKFLOW path. Verification reads WORKFLOW from the TRUSTED
   * MIRROR (default branch) so a task cannot rewrite its own gates. When the
   * task's own diff edits that file, its new boot/gates are NOT what ran — so
   * L2 failures caused by the old boot are not the change's fault and must
   * never auto-rework (l2-control-fixture burned 3 attempts, 2026-07-25).
   */
  readonly workflowPath?: string;
  readonly reviewerVerdict: ReviewerVerdict | null;
  /** True when L3 actually ran (even if it failed to produce a parseable verdict). */
  readonly reviewerRan?: boolean;
  /** Why L3 did not run (null when it should / did). */
  readonly reviewerSkipReason?: string | null;
  readonly selfAssessment: string;
  readonly finalReport?: string;
  readonly activityLog?: readonly string[];
  readonly usage?: PacketUsage;
  readonly dod?: DefinitionOfDone;
  /** Implementer final text was multi-stream pollution (see report hygiene). */
  readonly reportPolluted?: boolean;
  /** Full implementer vs session-resume steer (cost labeling). */
  readonly runKind?: PacketRunKind;
  /** GitHub compare URL for the full branch diff. */
  readonly diffUrl?: string | null;
  /** Original task title (delivery expectation). */
  readonly taskTitle?: string;
  /** Full task body before/with packet (review sections stripped for intent). */
  readonly taskBody?: string;
  readonly taskLabels?: readonly string[];
  /** Execution class and approved scope used to enforce host receipt freshness. */
  readonly executionClass?: ExecutionClass | null;
  readonly hostCommandScope?: readonly string[] | null;
  /** Worktree HEAD at verification time (approve tip invariant). */
  readonly verifiedSha?: string | null;
  /** Pre-review lag vs default branch (merge-base + conflict risk). */
  readonly baseDrift?: BaseDriftReport;
  /**
   * C3.56: uncommitted paths a verify-only (read-only) agent still left in the
   * worktree; discarded before L1 and never committed.
   */
  readonly verifyOnlyDiscardedPaths?: readonly string[];
  /** C3.56: verify-only worktree tip differs from the seeded tip — fail closed. */
  readonly verifyOnlyTipMismatch?: { readonly seed: string; readonly head: string | null };
  /**
   * Merge-base reproduction probe for a failed test/held-out gate.
   * trunk_inherited → mechanical skipped, no auto-rework.
   */
  readonly gateFailAttribution?: GateFailAttributionReport;
  /**
   * Foreign hercules commits aboard this branch (from isolation/diff detection).
   * Embedded on the DecisionCard for clickable cross-task evidence.
   */
  readonly crossTaskCommits?: readonly CrossTaskCommit[];
  /**
   * Explicit current-run host-op receipt. When absent, it may be recovered only
   * from the current agent final report, never the initial task body.
   */
  readonly hostOperationReceipt?: HostOperationReceipt;
  /** Independent CLI behavioral-evidence receipt (trusted WORKFLOW only). */
  readonly cliEvidence?: CliEvidenceReceipt;
  /** WORKFLOW declared cli_evidence but the run did not produce a receipt. */
  readonly cliEvidenceExpectedButMissing?: boolean;
  /** First test* gate result as it ran; null when none ran. */
  readonly testGate?: {
    readonly passed: boolean;
    readonly output: string;
    readonly command?: string;
  } | null;
  /** it()/test() / Rust #[test] titles present per test file at the verified sha. */
  readonly testCaseIndex?: ReadonlyMap<string, readonly string[]>;
  /** it()/test() titles on ADDED diff lines per test file. */
  readonly addedTestTitles?: ReadonlyMap<string, readonly string[]>;
  /** package.json scripts for @test observation via script name. */
  readonly packageJsonScripts?: Readonly<Record<string, string>>;
}

/** Retain L3 stdout on the packet, bounded like other evidence sections. */
function boundPacketReviewerVerdict(
  verdict: ReviewerVerdict | null,
): ReviewerVerdict | null {
  if (verdict?.report === undefined) return verdict;
  const report = boundReviewerReport(verdict.report);
  if (report === verdict.report) return verdict;
  return { ...verdict, report };
}

/** Lines of diff to include inline in the packet before truncating. */
const MAX_DIFF_LINES = 200;
/** Activity lines rendered into the committed packet (the most recent steps). */
const MAX_ACTIVITY_LINES = 200;
/** Lines of the agent's final report rendered before truncating. */
const MAX_REPORT_LINES = 300;
/** Files list: when short, phone UI expands by default (see taskBodySplit). */
export const SMALL_FILES_THRESHOLD = 12;

/** Drop SPA evidence images from agent prose when this turn has no worktree diff. */
export function stripStaleEvidenceImages(text: string): string {
  return text.replace(
    /!\[[^\]]*\]\(\/api\/tasks\/[^)\s]+\/screenshots\/[^)\s]+\)\s*/g,
    '',
  );
}

export function assembleReviewPacket(parts: ReviewPacketParts): ReviewPacket {
  const noChanges = parts.filesTouched.length === 0;
  const hostMutating = isHostMutatingClass(resolveExecutionClass(parts));
  // A pure host/deploy run is expected to leave the worktree unchanged. Its
  // current-run receipt and gates replace a source diff as delivery evidence.
  const acceptanceNoChanges = noChanges && !hostMutating;
  const runKind: PacketRunKind = parts.runKind === 'steer' ? 'steer' : 'implementer';
  // Empty worktree: never present L2 screenshots as proof of this turn (they
  // may be leftovers from a prior implement that was later lost/orphaned).
  // CLI artifacts (basenames) merge into the same list so C3 intake stages them
  // like L2 screenshots via verifiedEvidenceIntake basename resolution.
  const cliArtifactNames: string[] = [];
  if (!noChanges && parts.cliEvidence) {
    for (const step of parts.cliEvidence.steps) {
      for (const art of step.artifacts ?? []) cliArtifactNames.push(art.name);
    }
  }
  const screenshotsForPacket = noChanges
    ? []
    : [...new Set([...(parts.screenshots ?? []), ...cliArtifactNames])];
  const rawFinal = parts.finalReport ?? '';
  const finalForDelivery = noChanges ? stripStaleEvidenceImages(rawFinal) : rawFinal;
  const delivery = assessDeliveryHonesty({
    title: parts.taskTitle ?? parts.taskId,
    body: parts.taskBody ?? '',
    labels: parts.taskLabels ?? [],
    runKind,
    noFileChanges: acceptanceNoChanges,
    finalReport: finalForDelivery,
    selfAssessment: parts.selfAssessment,
  });
  const reviewerRan = parts.reviewerRan === true || parts.reviewerVerdict !== null;
  const reviewerSkipReason = parts.reviewerSkipReason ?? null;
  const dodParsed = parts.dod ?? {
    criteria: [],
    needsReviewer: false,
    needsHuman: true,
    hasMechanical: false,
    hasSection: false,
    warnings: [],
  };
  // Soft hygiene: report pollution must not fail the mechanical axis or force
  // auto-rework. Workflow gates + L3 decide hard outcomes; the packet still
  // surfaces a cleaned report and a soft warning for the human.
  const claimFindings: CheatFinding[] = delivery.claimHits.map((hit) => ({
    kind: 'false-delivery' as const,
    file: '(agent report)',
    detail: `claims delivery without diff: "${hit}"`,
  }));
  const hollowReport = detectHollowEvidenceFromParts(parts);
  const hollowFindings: CheatFinding[] =
    hollowReport.hits.length > 0
      ? [
          {
            kind: 'hollow-evidence' as const,
            file: '(behavioral evidence)',
            detail:
              hollowReport.packetLine ??
              hollowReport.detail ??
              'identical screenshots across scenarios',
          },
        ]
      : [];
  const cheatFindings = [...parts.cheatFindings, ...claimFindings, ...hollowFindings];
  const hasCriticalCheats = cheatFindings.some((f) => isCriticalCheatKind(f.kind));
  const workflowSelfChanged =
    parts.workflowPath !== undefined &&
    parts.filesTouched.some((f) => f === parts.workflowPath);
  // L2 ran against the trusted (old) WORKFLOW: a failure here says nothing
  // about the new boot. Non-green + explained, but not the task's failure.
  // Hollow evidence always fails the behavioural axis (not review-only).
  const hollowBehavioralFail = hollowReport.hits.length > 0 && !workflowSelfChanged;
  const behavioralFailed =
    (isBehavioralFailed(parts.evidenceRun) || hollowBehavioralFail) && !workflowSelfChanged;
  const behavioralStaleWorkflow =
    isBehavioralFailed(parts.evidenceRun) && workflowSelfChanged;
  // A stale-WORKFLOW run proves nothing either way: the evidence exercised the
  // OLD boot. Treat it as "did not run" for acceptance so evidence-bound
  // mechanical criteria read as unproven (skipped), not failed — otherwise the
  // mechanical axis fails and auto-rework burns attempts on the impossible
  // (l2-control-fixture, third path found 2026-07-27).
  const evidenceOk: boolean | null =
    parts.evidenceRun === undefined || behavioralStaleWorkflow
      ? null
      : hollowBehavioralFail
        ? false
        : parts.evidenceRun.ok;
  const evidenceStepDetails =
    parts.evidenceRun?.steps.map(
      (s) => `${s.kind} ${s.raw ?? ''} ${s.detail} ${s.screenshot ?? ''}`,
    ) ?? [];
  // Persist hollow failure onto the packet evidenceRun so renderers see ok=false.
  const evidenceRunForPacket =
    parts.evidenceRun === undefined
      ? undefined
      : hollowBehavioralFail && parts.evidenceRun.ok
        ? { ...parts.evidenceRun, ok: false }
        : parts.evidenceRun;

  // Only the explicit verifier input or THIS run's final report may supply a
  // receipt. The task body can contain an old approval or prior-run packet.
  const receiptMarkerCount = finalForDelivery.split(HOST_OP_RECEIPT_HEADING).length - 1;
  const hostOperationReceipt =
    parts.hostOperationReceipt ?? parseHostOperationReceipt(finalForDelivery) ?? undefined;
  const hostReceiptValidation = hostMutating
    ? parts.hostOperationReceipt === undefined && receiptMarkerCount !== 1
      ? {
          ok: false as const,
          reason: `current run must provide exactly one host-operation receipt (found ${receiptMarkerCount})`,
        }
      : validateHostOperationReceipt(hostOperationReceipt, parts.hostCommandScope ?? [])
    : null;
  const hostReceiptFailed = hostReceiptValidation !== null && !hostReceiptValidation.ok;

  const extraGates: GateResult[] = [];
  if (hostReceiptFailed) {
    extraGates.push({
      name: 'host-operation-receipt',
      command: 'hercules:host-operation-receipt',
      passed: false,
      output: hostReceiptValidation.reason,
    });
  }
  if (delivery.deliveryFailed) {
    extraGates.push({
      name: 'delivery',
      command: 'hercules:delivery-honesty',
      passed: false,
      output: delivery.reason ?? 'delivery check failed',
    });
  }
  if (behavioralFailed) {
    const failedSteps =
      parts.evidenceRun?.steps
        .filter((s) => !s.ok && !s.optional)
        .map((s) => s.raw ?? s.kind)
        .join(', ') ?? 'required step';
    extraGates.push({
      name: 'behavioral',
      command: 'hercules:l2-evidence',
      passed: false,
      output: `L2 required evidence failed: ${failedSteps}`,
    });
  }
  const cliEvidenceFailed = isCliEvidenceFailed(parts.cliEvidence);
  const cliEvidenceNotRun = isCliEvidenceNotRun(parts.cliEvidence);
  const cliEvidenceBlocking = cliEvidenceFailed || cliEvidenceNotRun;
  if (cliEvidenceBlocking) {
    const failed =
      parts.cliEvidence?.steps
        .filter((s) => !s.ok && !s.optional)
        .map((s) => s.id + ':' + s.status)
        .join(', ') ?? 'required step';
    extraGates.push({
      name: 'cli-behavioral-evidence',
      command: 'hercules:cli-evidence',
      passed: false,
      output: cliEvidenceNotRun
        ? 'CLI behavioral evidence was required but not run: ' + failed
        : 'CLI behavioral evidence failed: ' + failed,
    });
  }
  if (parts.cliEvidenceExpectedButMissing === true && !cliEvidenceBlocking) {
    extraGates.push({
      name: 'cli-behavioral-evidence',
      command: 'hercules:cli-evidence',
      passed: false,
      output: 'CLI evidence declared in WORKFLOW but produced no receipt',
    });
  }
  // L2 declared in WORKFLOW but produced no evidence at all — closes the
  // fail-open hole where such a task reached review falsely "green" having
  // never booted the app. Visible + non-green (see green calc); not autoRework.
  // NEVER as a gate row: a `{name:'behavioral', passed:true}` entry renders as
  // ✅ behavioral and inflates the card's 门禁 n/m — a green tick whose meaning
  // is "nothing was verified" (orbit-l2-webapp-evidence showed 7/7 with zero
  // evidence steps, 2026-07-25). It is a warning; carry it as one.
  const notDeclaredWarning =
    parts.behavioralNotDeclared === true && !noChanges && parts.cliEvidence === undefined && parts.cliEvidenceExpectedButMissing !== true
      ? 'L2 行为验证未声明 (not declared): 本仓库 WORKFLOW 没有 behavioral 块 — ' +
        '这里的任何任务都没有界面证据。按 SPEC §9.2 声明 base_url + evidence 步骤。'
      : null;
  if (behavioralStaleWorkflow) {
    extraGates.push({
      name: 'behavioral',
      command: 'hercules:l2-evidence',
      passed: false,
      output:
        '本任务修改了 WORKFLOW — 验证按可信 main 的旧 WORKFLOW 执行 (反作弊: 任务不得改写自己的门禁), ' +
        '所以新的 boot/gates 这一轮不可能生效, L2 失败与本次改动无关。' +
        '新配置只在合并到默认分支后生效 — 请人工核验脚本与 WORKFLOW 差异, 合并后再看 L2。 ' +
        '(A task that edits WORKFLOW cannot exercise its own new boot: L1/L2 run the trusted ' +
        'default-branch WORKFLOW; verify after merge.)',
    });
  }
  const behavioralMissing =
    parts.behavioralExpectedButMissing === true && !behavioralFailed && !behavioralStaleWorkflow;
  if (behavioralMissing) {
    extraGates.push({
      name: 'behavioral',
      command: 'hercules:l2-evidence',
      passed: false,
      output: parts.behavioralSkipDetail
        ? `L2 declared in WORKFLOW but produced no evidence — 具体原因:${parts.behavioralSkipDetail}。` +
          'Human must decide — not a false green.'
        : 'L2 declared in WORKFLOW but produced no evidence — app was not ' +
          'machine-verified (exact reason not recorded by this older run). ' +
          'Human must decide — not a false green.',
    });
  }
  if (hasCriticalCheats) {
    const critical = cheatFindings.filter((f) => isCriticalCheatKind(f.kind));
    const kinds = [...new Set(critical.map((f) => f.kind))].join(', ');
    const detailLines = critical
      .slice(0, 16)
      .map(
        (f) =>
          `${f.kind} in ${f.file}${f.line !== undefined ? `:${f.line}` : ''} — ${f.detail}`,
      )
      .join('\n');
    extraGates.push({
      name: 'anti-cheat',
      command: 'hercules:l5-critical',
      passed: false,
      output:
        `Critical L5 findings (${kinds}) — auto-rework; not human code review` +
        (detailLines ? `\n${detailLines}` : ''),
    });
  }
  // Base-drift hard conflict is assembled as a gate by the verifier; also
  // honor a report-only path when the gate row was not pre-injected.
  const baseDriftBlocking =
    parts.baseDrift !== undefined && isBaseDriftBlocking(parts.baseDrift);
  if (
    baseDriftBlocking &&
    !parts.gates.some((g) => g.name === 'base-drift') &&
    !extraGates.some((g) => g.name === 'base-drift')
  ) {
    const d = parts.baseDrift!;
    extraGates.push({
      name: 'base-drift',
      command: 'hercules:base-drift',
      passed: false,
      output:
        `Task branch conflicts with \`${d.defaultBranch}\` (behind ${d.behind}, ahead ${d.ahead}). ` +
        `${d.conflictDetail ?? 'merge-tree conflict'}. ` +
        `Rebase hercules/<id> only — never force-push main, never merge to main.`,
    });
  }

  // C3.56: a verify-only run must publish exactly the seeded tip.
  const verifyOnlyTipMismatch = parts.verifyOnlyTipMismatch !== undefined;
  if (verifyOnlyTipMismatch) {
    const m = parts.verifyOnlyTipMismatch!;
    extraGates.push({
      name: 'verify-only-tip',
      command: 'hercules:verify-only-tip',
      passed: false,
      output:
        `Verify-only run: worktree tip ${m.head ?? '(unknown)'} is not the seeded tip ${m.seed}. ` +
        `A read-only verification cannot publish a different tree — verify again from the seed.`,
    });
  }
  const gatesWithExtras = [...parts.gates, ...extraGates];
  // Workflow L1 only (exclude soft hygiene + synthetic hercules:* gates for "L1 passed?").
  const workflowGates = gatesWithExtras.filter(
    (g) =>
      g.name !== 'report-hygiene' &&
      g.name !== 'delivery' &&
      g.name !== 'behavioral' &&
      g.name !== 'anti-cheat' &&
      g.name !== 'base-drift' &&
      g.name !== 'cli-behavioral-evidence' &&
      g.name !== 'host-operation-receipt',
  );
  const workflowGatesPassed =
    workflowGates.length === 0 || workflowGates.every((g) => g.passed);
  // Trunk-inherited: failed test/held-out also fails on pure merge-base — not
  // this task's debt (2026-07-30 orbit case). DoD mechanical → skipped.
  const trunkInheritedGateFail = isTrunkInherited(parts.gateFailAttribution);
  // Prefer workflow-only for DoD when hygiene is soft-pass noise in the gate list.
  const trunc = parts.reviewerVerdict?.inputTruncation;
  const truncWarn = trunc
    ? `L3 read the first ${trunc.maxChars} of ${trunc.diffChars} diff chars — the rest was not reviewed`
    : null;
  const gateToolchainEdited = cheatFindings.some(
    (f) => f.kind === 'gate-toolchain-edit',
  );
  const dod: DodDimensions = buildDodDimensions({
    dod: dodParsed,
    gatesPassed: workflowGatesPassed,
    noFileChanges: acceptanceNoChanges,
    reviewerVerdict: parts.reviewerVerdict,
    reviewerRan,
    reviewerSkipReason,
    deliveryFailed: delivery.deliveryFailed,
    behavioralFailed: behavioralFailed || cliEvidenceBlocking,
    behavioralMissing: behavioralMissing || behavioralStaleWorkflow,
    hasCriticalCheats,
    gateNames: workflowGates.map((g) => g.name),
    evidenceOk,
    evidenceStepDetails,
    filesTouched: parts.filesTouched,
    selfAssessment: parts.selfAssessment,
    trunkInheritedGateFail,
    gateToolchainEdited,
    ...(parts.testGate !== undefined ? { testGate: parts.testGate } : {}),
    ...(parts.testCaseIndex !== undefined ? { testCaseIndex: parts.testCaseIndex } : {}),
    ...(parts.packageJsonScripts !== undefined
      ? { packageJsonScripts: parts.packageJsonScripts }
      : {}),
    ...(parts.addedTestTitles !== undefined
      ? { addedTestTitles: parts.addedTestTitles }
      : {}),
  });
  const trunkWarning =
    trunkInheritedGateFail && parts.gateFailAttribution
      ? parts.gateFailAttribution.note
      : null;
  // L2 relevance (grammar §6): did the evidence run exercise changed UI anchors?
  // Informational only — warning is soft; green / auto-rework / axes unchanged.
  let l2Relevance: L2RelevanceRecord | undefined;
  let l2RelevanceWarning: string | null = null;
  if (!noChanges) {
    const hasEvidenceBinding = dodParsed.criteria.some(
      (c) =>
        c.kind === 'mechanical' &&
        parseMechProofBinding(c.text).kind === 'evidence',
    );
    const relevance = computeL2Relevance({
      diff: parts.diff ?? '',
      filesTouched: parts.filesTouched,
      steps: parts.evidenceRun?.steps ?? null,
      hasEvidenceBinding,
    });
    l2Relevance = toL2RelevanceRecord(relevance);
    l2RelevanceWarning = relevance.warning;
  }
  const dodWithWarnings: DodDimensions = {
    ...dod,
    warnings: [
      ...dod.warnings,
      ...(notDeclaredWarning !== null ? [notDeclaredWarning] : []),
      ...(trunkWarning !== null ? [trunkWarning] : []),
      ...(truncWarn !== null ? [truncWarn] : []),
      ...(l2RelevanceWarning !== null ? [l2RelevanceWarning] : []),
    ],
  };
  const reportPolluted = parts.reportPolluted === true;
  const prConflicting = gatesWithExtras.some(
    (g) => g.name === 'pr-mergeable' && g.passed === false,
  );
  const baseDriftConflict = gatesWithExtras.some(
    (g) => g.name === 'base-drift' && g.passed === false,
  );
  const green =
    !acceptanceNoChanges &&
    !delivery.deliveryFailed &&
    !behavioralFailed &&
    !behavioralMissing &&
    !behavioralStaleWorkflow &&
    !cliEvidenceBlocking &&
    parts.cliEvidenceExpectedButMissing !== true &&
    !hasCriticalCheats &&
    !gateToolchainEdited &&
    !hostReceiptFailed &&
    !prConflicting &&
    !baseDriftConflict &&
    !verifyOnlyTipMismatch &&
    isAutomatedGreen(dod);
  // Never auto-rework for hygiene alone — L1/L2/L3/L5 critical / delivery decide.
  // (C3.56: a verify-only tip mismatch is terminal via C3.50's verify-only path.)
  const autoRework =
    shouldAutoRework({
      dimensions: dodWithWarnings,
      noFileChanges: acceptanceNoChanges,
      deliveryFailed: delivery.deliveryFailed,
      hasCriticalCheats,
      behavioralFailed: behavioralFailed || cliEvidenceBlocking,
      prConflicting,
      baseDriftConflict,
    }) || verifyOnlyTipMismatch;
  // Steer vs full: pure policy from packet signals (orchestrator honors path).
  // hasSession is decided at complete() time; packet assumes session may exist
  // (orchestrator falls back to full when it does not).
  const reworkDecision = chooseReworkPath({
    autoRework,
    dimensions: dodWithWarnings,
    filesTouched: parts.filesTouched,
    diffSummary: parts.diffSummary,
    reviewerVerdict: parts.reviewerVerdict,
    deliveryFailed: delivery.deliveryFailed,
    priorRunWasSteer: runKind === 'steer',
  });
  const reworkPath = reworkDecision?.path ?? null;
  const reworkPathReason = reworkDecision?.reason ?? null;
  // UI human AC ↔ L2 plan gap (soft warn). Prefer the run's executed steps;
  // fall back to resolving ## Evidence / WORKFLOW default from the task body.
  const planFromRun =
    parts.evidenceRun?.steps.map((s) => ({
      kind: s.kind as 'unlock' | 'click' | 'assert' | 'screenshot',
      ...(s.raw !== undefined ? { raw: s.raw } : {}),
      ...(s.optional !== undefined ? { optional: s.optional } : {}),
      // evidenceRun steps do not carry selector/text/name separately — raw holds DSL.
    })) ?? null;
  const planSteps =
    planFromRun ??
    resolveEvidencePlan({ taskBody: parts.taskBody ?? '' }).steps;
  const evidenceResults: EvidenceStepResult[] | undefined = parts.evidenceRun
    ? parts.evidenceRun.steps.map((s) => ({
        step: {
          kind: s.kind as 'unlock' | 'click' | 'assert' | 'screenshot',
          ...(s.raw !== undefined ? { raw: s.raw } : {}),
          ...(s.optional !== undefined ? { optional: s.optional } : {}),
        },
        ok: s.ok,
        detail: s.detail,
        ...(s.screenshot !== undefined ? { screenshot: s.screenshot } : {}),
      }))
    : undefined;
  // Human criteria on `dod` have @scenario stripped for display; re-join raw
  // texts from the parse so CLI @scenario / recording linkage still sees them.
  const matrixCriteria = dod.criteria.map((c, i) => {
    const raw = dodParsed.criteria[i];
    if (
      raw &&
      (c.kind === 'human' || c.kind === 'checkpoint') &&
      (raw.kind === 'human' || raw.kind === 'checkpoint')
    ) {
      return { text: raw.text, kind: c.kind, status: c.status };
    }
    return { text: c.text, kind: c.kind, status: c.status };
  });
  const cliStepsForLink: CliEvidenceLinkStep[] | undefined = parts.cliEvidence
    ? parts.cliEvidence.steps.map((s) => ({
        id: s.id,
        ok: s.ok,
        status: s.status,
        artifacts: (s.artifacts ?? []).map((a) => ({ name: a.name, kind: a.kind })),
        stdoutTail: s.stdoutTail,
      }))
    : undefined;
  const rawEvidenceMatrix = buildEvidenceMatrix(
    matrixCriteria,
    parts.selfAssessment,
    {
      evidencePlanSteps: planSteps,
      ...(evidenceResults ? { evidenceResults } : {}),
      ...(cliStepsForLink ? { cliSteps: cliStepsForLink } : {}),
    },
  );
  // A host receipt is the authoritative mechanical proof for a host-mutating
  // run. Free-form self-assessment text may describe active services while
  // also admitting the deploy failed; never let those citations render the
  // mechanical rows green when the receipt gate is red.
  const evidenceMatrix: readonly EvidenceMatrixRow[] = hostReceiptFailed
    ? rawEvidenceMatrix.map((row) =>
        row.kind === 'mechanical'
          ? {
              ...row,
              status: 'fail',
              evidence: `Host operation receipt invalid: ${hostReceiptValidation.reason}`,
            }
          : row,
      )
    : rawEvidenceMatrix;
  const finalReport = noChanges ? stripStaleEvidenceImages(rawFinal) : rawFinal;
  // Structured CEO card — same facts, machine-readable, embedded at render.
  const decisionCard = buildDecisionCard({
    taskBody: parts.taskBody ?? '',
    branch: parts.branch,
    filesTouched: parts.filesTouched,
    cheatFindings,
    crossTaskCommits: parts.crossTaskCommits ?? [],
    evidenceMatrix,
    gates: gatesWithExtras,
    evidenceRan: parts.evidenceRun !== undefined || parts.cliEvidence !== undefined,
    evidenceOk: resolvePresentationEvidenceOk(parts, evidenceOk),
    evidenceSteps: resolvePresentationEvidenceSteps(parts),
    evidenceSkipReason: resolvePresentationEvidenceSkip(parts),
    reviewerRan,
    reviewerApproved: parts.reviewerVerdict ? parts.reviewerVerdict.approved : null,
    reviewerSummaryZh: parts.reviewerVerdict?.summaryZh,
    ...(dodWithWarnings.unverifiedCriteria
      ? { unverifiedCriteria: dodWithWarnings.unverifiedCriteria }
      : {}),
  });
  return {
    decisionCard,
    taskId: parts.taskId,
    branch: parts.branch,
    filesTouched: parts.filesTouched,
    diffSummary: parts.diffSummary,
    diff: parts.diff ?? '',
    gates: gatesWithExtras,
    cheatFindings,
    screenshots: screenshotsForPacket,
    reviewerVerdict: boundPacketReviewerVerdict(parts.reviewerVerdict),
    selfAssessment: parts.selfAssessment,
    finalReport,
    green,
    noChanges,
    dod: dodWithWarnings,
    autoRework,
    reworkPath,
    reworkPathReason,
    reportPolluted,
    activityLog: parts.activityLog ?? [],
    runKind,
    reviewerSkipReason,
    diffUrl: parts.diffUrl ?? null,
    evidenceMatrix,
    verifiedSha: parts.verifiedSha ?? null,
    workflowGatesPassed,
    ...(parts.baseDrift ? { baseDrift: parts.baseDrift } : {}),
    ...(parts.verifyOnlyDiscardedPaths && parts.verifyOnlyDiscardedPaths.length > 0
      ? { verifyOnlyDiscardedPaths: parts.verifyOnlyDiscardedPaths }
      : {}),
    ...(parts.gateFailAttribution
      ? { gateFailAttribution: parts.gateFailAttribution }
      : {}),
    ...(evidenceRunForPacket ? { evidenceRun: evidenceRunForPacket } : {}),
    ...(parts.usage ? { usage: parts.usage } : {}),
    ...(hostOperationReceipt ? { hostOperationReceipt } : {}),
    ...(parts.cliEvidence ? { cliEvidence: parts.cliEvidence } : {}),
    ...(l2Relevance ? { l2Relevance } : {}),
  };
}

/** Status-line fragment naming a non-pass automated axis (when checks are green). */
function statusLineAxisGap(
  axis: 'mechanical' | 'reviewer',
  status: DodDimensions['mechanical'],
  p: ReviewPacket,
): string {
  if (axis === 'mechanical') {
    if (status === 'n/a') return 'mechanical n/a (no bound mechanical criteria)';
    return `mechanical ${status}`;
  }
  if (status === 'n/a') {
    const skip =
      p.reviewerSkipReason ??
      p.dod.warnings
        .map((w) => /^L3 not run:\s*(.+)$/i.exec(w)?.[1]?.trim())
        .find((s): s is string => typeof s === 'string' && s.length > 0);
    if (skip) {
      // Prefer the short form used in contract examples when it matches.
      if (/no file changes/i.test(skip)) return 'reviewer n/a (no file changes)';
      return `reviewer n/a (${skip})`;
    }
    return 'reviewer n/a (no file changes)';
  }
  return `reviewer ${status}`;
}

/** Status line under the packet title — three axes, no single false green. */
export function packetStatusLine(
  p: ReviewPacket,
  opts?: { readonly attemptsExhausted?: boolean },
): string {
  if (p.autoRework) {
    if (opts?.attemptsExhausted) {
      return '**❌ attempts exhausted** — task failed; branch preserved for salvage (not re-queued)';
    }
    const path = p.reworkPath ?? 'full';
    if (path === 'steer') {
      return '**🔄 auto-rework (steer)** — cheap session resume will be queued (see DoD axes)';
    }
    return '**🔄 auto-rework (full)** — full implementer re-dispatch will be queued (see DoD axes)';
  }
  if (p.green) {
    const soft = p.reportPolluted
      ? ' · ⚠️ final message cleaned (soft hygiene)'
      : '';
    const unverifiedN = p.dod.unverifiedCriteria?.length ?? 0;
    if (p.dod.mechanical === 'pass' && p.dod.reviewer === 'pass') {
      if (unverifiedN > 0) {
        return (
          `**✅ automated proof complete** (${unverifiedN} 项无法自动核验，需人工确认` +
          ` · human Approve still required if human ACs exist)` +
          soft
        );
      }
      return (
        '**✅ automated proof complete** (human Approve still required if human ACs exist)' +
        soft
      );
    }
    const gaps: string[] = [];
    if (p.dod.mechanical !== 'pass') {
      gaps.push(statusLineAxisGap('mechanical', p.dod.mechanical, p));
    }
    if (p.dod.reviewer !== 'pass') {
      gaps.push(statusLineAxisGap('reviewer', p.dod.reviewer, p));
    }
    return (
      '**✅ automated checks green** — ' +
      (gaps.length > 0 ? gaps.join(' · ') : 'axes incomplete') +
      soft
    );
  }
  const d = p.dod;
  const soft = p.reportPolluted ? ' · ⚠️ report cleaned (soft)' : '';
  return (
    `**DoD** mechanical ${dimIcon(d.mechanical)} \`${d.mechanical}\` · ` +
    `reviewer ${dimIcon(d.reviewer)} \`${d.reviewer}\` · ` +
    `human ${dimIcon(d.human)} \`${d.human}\`` +
    soft
  );
}

export type RenderPacketOpts = {
  readonly attemptsExhausted?: boolean;
  /** Optional cost-caps summary (from domain/costCaps) when policy enabled. */
  readonly costCapSection?: string;
  /**
   * Provenance nonce (32 hex chars). Defaults to `randomBytes(16).toString('hex')`.
   * Tests pass a fixed value so fence lines are deterministic.
   */
  readonly nonce?: string;
};

/**
 * Render a review packet and return the markdown plus the provenance nonce
 * actually written into the header/end fences (generated when not supplied).
 */
export function renderPacketMarkdownWithNonce(
  p: ReviewPacket,
  opts?: RenderPacketOpts,
): { readonly markdown: string; readonly nonce: string } {
  const nonce = opts?.nonce ?? randomBytes(16).toString('hex');
  return {
    markdown: renderPacketMarkdown(p, { ...opts, nonce }),
    nonce,
  };
}

export function renderPacketMarkdown(
  p: ReviewPacket,
  opts?: RenderPacketOpts,
): string {
  // Defensive defaults so partial/mock packets (tests, old bodies) still render.
  const evidenceMatrix = p.evidenceMatrix ?? [];
  const runKind = p.runKind ?? 'implementer';
  const reviewerSkipReason = p.reviewerSkipReason ?? null;
  const diffUrl = p.diffUrl ?? null;
  const screenshots = p.screenshots ?? [];
  const activityLog = p.activityLog ?? [];
  const filesTouched = p.filesTouched ?? [];
  const gates = p.gates ?? [];
  const cheatFindings = p.cheatFindings ?? [];
  const nonce = opts?.nonce ?? randomBytes(16).toString('hex');
  // Bind task id so only `### <thisTaskId>` headings are broken — ordinary
  // `### Summary` in agent prose must render unchanged.
  const neutralizeUntrustedPacketText = (text: string): string =>
    neutralizePacketText(text, { taskId: p.taskId });

  const lines: string[] = [];
  lines.push(`### ${p.taskId} — \`${p.branch}\``);
  lines.push(`<!-- hercules:packet v1 nonce=${nonce} -->`);
  lines.push(packetStatusLine(p, opts));
  // ── 决策摘要 (CEO lens, 2026-07-23) ───────────────────────────────────
  // 改动 = reviewer's business-language line (deterministic fallback).
  // 可信度 + 风险 = STRICTLY mechanical from packet facts — never invented.
  {
    const counted = countedGates(gates);
    const gatesTotal = counted.length;
    const gatesGreen = counted.filter((g) => g.passed).length;
    const browserExpected = gates.some(
      (g) => g.name === 'behavioral' && !g.passed,
    );
    const evidenceZh = formatEvidenceTrustLine({
      ...(p.evidenceRun !== undefined ? { evidenceRun: p.evidenceRun } : {}),
      ...(p.cliEvidence !== undefined ? { cliEvidence: p.cliEvidence } : {}),
      browserExpected,
    });
    const reviewerZh = p.reviewerVerdict
      ? p.reviewerVerdict.approved
        ? '独立审稿:通过'
        : '独立审稿:要求修改'
      : '独立审稿:未运行';
    // Risk lines must be self-contained on the card — never "见 X" where X is
    // not visible (CEO case study: "出处见发现" pointed at nothing, 2026-07-24).
    const risks: string[] = cheatFindings.map((f) => {
      switch (f.kind) {
        case 'test-edit':
          return '测试被改动(审稿已核)';
        case 'cross-task-commits': {
          const ids = parseCrossTaskIdsFromDetail(f.detail).map((id) =>
            neutralizeUntrustedPacketText(id),
          );
          return ids.length > 0
            ? `含跨任务提交: ${ids.join('、')}`
            : '含跨任务提交';
        }
        case 'protected-path':
          return '触碰受保护路径';
        case 'false-delivery':
          return '声称交付与实际不符';
        case 'test-integrity':
          return f.detail
            ? `删除/重命名测试: ${neutralizeUntrustedPacketText(f.detail)}`
            : '删除/重命名了已有测试用例';
        case 'placeholder-evidence-hook':
          return '疑似L2占位证据钩子(无真实功能)';
        case 'hollow-evidence':
          return '空洞证据(相同截图跨场景)';
        case 'symlink-escape':
          return f.detail
            ? `符号链接指向工作树之外: ${neutralizeUntrustedPacketText(f.detail)}`
            : '符号链接指向工作树之外(应复制内容而非链接)';
        default:
          return `发现:${neutralizeUntrustedPacketText(f.kind)}`;
      }
    });
    if (p.baseDrift && p.baseDrift.behind > 0) {
      risks.push(`分支落后主干 ${p.baseDrift.behind} 个提交`);
    }
    if (p.gateFailAttribution && isTrunkInherited(p.gateFailAttribution)) {
      risks.push('门禁失败属主干既有问题(需先修 main)');
    }
    lines.push('');
    lines.push('## 决策摘要');
    lines.push('');
    const changeLine = p.reviewerVerdict?.summaryZh
      ? neutralizeUntrustedPacketText(p.reviewerVerdict.summaryZh)
      : `${p.taskId}(${filesTouched.length} 个文件改动)`;
    lines.push(`- **改动**:${changeLine}`);
    const unverifiedN = p.dod.unverifiedCriteria?.length ?? 0;
    const unverifiedTrust =
      unverifiedN > 0 ? ` · 无法自动核验 ${unverifiedN} 项` : '';
    lines.push(
      `- **可信度**:门禁 ${gatesGreen}/${gatesTotal} 绿 · ${reviewerZh} · ${evidenceZh}${unverifiedTrust}`,
    );
    lines.push(`- **风险**:${risks.length > 0 ? [...new Set(risks)].join(';') : '无标记风险'}`);
  }
  if (p.verifiedSha) {
    // Approve holds the branch tip to this commit (verified-SHA invariant).
    lines.push(`_Verified tip: \`${p.verifiedSha.slice(0, 12)}\`_`);
  }
  if (p.baseDrift) {
    lines.push('');
    for (const line of formatBaseDriftMarkdown(p.baseDrift)) {
      lines.push(line);
    }
  }
  if (p.gateFailAttribution) {
    lines.push('');
    for (const line of formatGateFailAttributionMarkdown(p.gateFailAttribution)) {
      lines.push(line);
    }
  }
  if (p.autoRework && p.reworkPath) {
    lines.push('');
    lines.push(
      `**Rework path:** \`${p.reworkPath}\`${
        p.reworkPathReason
          ? ` — ${neutralizeUntrustedPacketText(p.reworkPathReason)}`
          : ''
      }`,
    );
  }
  const deliveryGate = gates.find((g) => g.name === 'delivery' && !g.passed);
  if (deliveryGate) {
    lines.push('');
    lines.push(
      `**❌ Delivery check failed.** ${neutralizeUntrustedPacketText(deliveryGate.output)}`,
    );
    lines.push(
      '_System policy: implementation tasks need a real worktree diff; ' +
        '"已上线/shipped" without files is auto-rework. Opt out only with ' +
        '`hercules:no-diff-ok` or label `analysis`._',
    );
    if (p.noChanges) {
      lines.push(
        '_Prior behavioral screenshots (if any on disk) are **not** evidence for this empty-diff turn._',
      );
    }
  } else if (p.noChanges) {
    lines.push('');
    // Soft banner only when delivery gate did not already hard-fail.
    // (Implement tasks never reach here with deliveryFailed=false.)
    lines.push(
      "**ℹ️ No file changes.** Allowed for this run (explicit analysis / `no-diff-ok`). " +
        "Confirm the agent's report is a real Q&A outcome, not a missing implementation. " +
        "Implementation tasks without a worktree diff auto-rework instead of human review.",
    );
    lines.push(
      '_Prior behavioral screenshots (if any on disk) are **not** evidence for this empty-diff turn._',
    );
  }
  lines.push('');

  // Three-axis Definition of Done (trust model) — show first for phone scan.
  lines.push('**Definition of Done**');
  lines.push(`| Axis | Status |`);
  lines.push(`|---|---|`);
  lines.push(`| mechanical (L1/L2/L5) | ${dimIcon(p.dod.mechanical)} ${p.dod.mechanical} |`);
  lines.push(`| reviewer (L3) | ${dimIcon(p.dod.reviewer)} ${p.dod.reviewer} |`);
  lines.push(`| human | ${dimIcon(p.dod.human)} ${p.dod.human} |`);
  if (p.evidenceRun && !p.evidenceRun.ok) {
    lines.push('');
    lines.push(
      '**❌ L2 behavioral evidence failed** (required step) — auto-rework; not phone QA.',
    );
  }
  const hollowFinding = (p.cheatFindings ?? []).find((f) => f.kind === 'hollow-evidence');
  if (hollowFinding) {
    lines.push('');
    lines.push(neutralizeUntrustedPacketText(hollowFinding.detail));
  }
  if ((p.cheatFindings ?? []).some((f) => isCriticalCheatKind(f.kind)) && p.autoRework) {
    lines.push('');
    lines.push(
      '**❌ Critical L5** — system auto-reworks; independent of human code reading.',
    );
  }
  if (p.dod.criteria.length > 0) {
    lines.push('');
    lines.push('Criteria:');
    for (const c of p.dod.criteria) {
      lines.push(
        `- ${dimIcon(c.status)} \`(${c.kind})\` ${neutralizeUntrustedPacketText(c.text)} — proof: ${neutralizeUntrustedPacketText(c.proof)}`,
      );
      if (c.warning) {
        lines.push(`  ⚠️ ${neutralizeUntrustedPacketText(c.warning)}`);
      }
    }
  }
  if (p.dod.warnings.length > 0) {
    lines.push('');
    for (const w of p.dod.warnings) {
      lines.push(`- ⚠️ ${neutralizeUntrustedPacketText(w)}`);
    }
  }
  if (reviewerSkipReason && !p.reviewerVerdict) {
    lines.push('');
    lines.push(
      `**L3 not run:** ${neutralizeUntrustedPacketText(reviewerSkipReason)}`,
    );
  }
  lines.push('');

  // Per-criterion evidence matrix — primary scan surface for quality judgment.
  if (evidenceMatrix.length > 0) {
    lines.push('**Evidence matrix** *(agent citations — not a verdict)*');
    lines.push('| Criterion | Kind | Status | Evidence |');
    lines.push('|---|---|---|---|');
    for (const row of evidenceMatrix) {
      const crit = escapeTableCell(neutralizeUntrustedPacketText(row.text));
      const ev = escapeTableCell(neutralizeUntrustedPacketText(row.evidence));
      lines.push(
        `| ${crit} | \`${neutralizeUntrustedPacketText(row.kind)}\` | ${dimIcon(row.status as DodDimensions['mechanical'])} ${neutralizeUntrustedPacketText(row.status)} | ${ev} |`,
      );
      if (row.unprovenUiWarning) {
        lines.push(
          `| ⚠️ |  |  | ${escapeTableCell(
            neutralizeUntrustedPacketText(
              `${row.unprovenUiWarning}${row.unprovenUiReason ? ` — ${row.unprovenUiReason}` : ''}`,
            ),
          )} |`,
        );
      }
    }
    lines.push('');
  }

  // Explicit soft warnings for UI human ACs lacking L2 proof (never blocks).
  const unprovenUi = evidenceMatrix.filter((r) => r.unprovenUiWarning);
  if (unprovenUi.length > 0) {
    lines.push('**⚠ UI 人工项缺少证据步骤** *(只警告，不阻断批准)*');
    for (const row of unprovenUi) {
      const warn = neutralizeUntrustedPacketText(row.unprovenUiWarning ?? '');
      const reason = row.unprovenUiReason
        ? neutralizeUntrustedPacketText(row.unprovenUiReason)
        : '';
      lines.push(
        `- ${warn} — \`${escapeTableCell(neutralizeUntrustedPacketText(row.text)).slice(0, 80)}\`${
          reason ? `: ${reason}` : ''
        }`,
      );
    }
    lines.push('');
  }

  // Self-assessment before long dumps — humans need the evidence table first.
  lines.push('**Self-assessment** *(agent evidence only — not authoritative)*');
  pushFencedProse(lines, 'self-assessment', nonce, p.selfAssessment || '(none)', p.taskId);
  lines.push('');

  // Host-operation receipt — durable scope / outcome / post-check for humans.
  if (p.hostOperationReceipt) {
    const receiptMd = neutralizeUntrustedPacketText(
      formatHostOperationReceipt(p.hostOperationReceipt).trimEnd(),
    );
    lines.push(receiptMd);
    lines.push('');
  }

  if (p.cliEvidence) {
    // CLI receipt narrative has its own structural neutralizer; do not re-write.
    lines.push(formatCliEvidenceReceipt(p.cliEvidence, { taskId: p.taskId }).trimEnd());
    lines.push('');
  }

  if (p.reviewerVerdict) {
    lines.push(
      `**Reviewer (L3):** ${p.reviewerVerdict.approved ? '✅ approved' : '❌ changes requested'}`,
    );
    const reviewerProse: string[] = [];
    if (p.reviewerVerdict.summary) {
      reviewerProse.push(`> ${p.reviewerVerdict.summary}`);
    }
    for (const c of p.reviewerVerdict.comments) reviewerProse.push(`- ${c}`);
    if (reviewerProse.length > 0) {
      pushFencedProse(lines, 'reviewer', nonce, reviewerProse.join('\n'), p.taskId);
    }
    const trunc = p.reviewerVerdict.inputTruncation;
    if (trunc) {
      lines.push(
        `⚠️ L3 read the first ${trunc.maxChars} of ${trunc.diffChars} diff chars — the rest was not reviewed`,
      );
    }
    lines.push('');
    const rawReport = p.reviewerVerdict.report;
    const report = rawReport ? boundReviewerReport(rawReport).trimEnd() : '';
    if (report) {
      lines.push('**L3 report**');
      // Fence for provenance; keep blockquote so embedded ## / ** cannot
      // split phone sections (sectionize still sees the raw packet text).
      const quoted = report
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      pushFencedProse(lines, 'reviewer', nonce, quoted, p.taskId);
      lines.push('');
    }
  }

  lines.push('**Gates**');
  for (const g of gates) {
    const gateName = neutralizeUntrustedPacketText(g.name);
    if (g.outcome === 'skipped') {
      lines.push(`- ⏭ ${gateName} (skipped: no file changes)`);
      continue;
    }
    if (g.outcome === 'info') {
      lines.push(`- ℹ️ ${gateName}`);
      if (g.output) {
        const out = neutralizeUntrustedPacketText(g.output);
        lines.push('  ```');
        lines.push(`  ${out.split('\n').slice(-12).join('\n  ')}`);
        lines.push('  ```');
      }
      continue;
    }
    lines.push(`- ${g.passed ? '✅' : '❌'} ${gateName}`);
    if (!g.passed && g.output) {
      const out = neutralizeUntrustedPacketText(g.output);
      lines.push('  ```');
      lines.push(`  ${out.split('\n').slice(-12).join('\n  ')}`);
      lines.push('  ```');
    }
  }
  lines.push('');

  if (p.reportPolluted) {
    lines.push(
      '**⚠️ Report hygiene (soft):** final message was a multi-stream dump — ' +
        'showing cleaned excerpt only. **Does not block review.** Branch files are source of truth.',
    );
    lines.push('');
  }

  // Agent report: when we already emit a canonical host receipt, strip the
  // single receipt block from the embedded final report so the packet has
  // exactly one heading. Zero/multiple markers stay raw (gate still fails).
  {
    let reportText = p.finalReport ?? '';
    if (p.hostOperationReceipt) {
      const markers = reportText.split(HOST_OP_RECEIPT_HEADING).length - 1;
      if (markers === 1) {
        reportText = stripHostOperationReceiptSections(reportText);
      }
    }
    if (reportText.trim().length > 0) {
      lines.push("**Agent's report** *(evidence, not a verdict)*");
      const reportLines = reportText.trimEnd().split('\n');
      const reportBody = reportLines.slice(0, MAX_REPORT_LINES).join('\n');
      // N4: note once when render-time neutralization rewrote the report.
      if (neutralizeUntrustedPacketText(reportBody) !== reportBody) {
        lines.push('_HTML 注释已中和_');
      }
      pushFencedProse(lines, 'report', nonce, reportBody, p.taskId);
      if (reportLines.length > MAX_REPORT_LINES) {
        lines.push(`… (${reportLines.length - MAX_REPORT_LINES} more lines truncated)`);
      }
      lines.push('');
    }
    const backRefs = finalReportBackReferences(p.finalReport ?? '');
    if (backRefs.length > 0) {
      const listed = backRefs
        .map((phrase) => '`' + neutralizeUntrustedPacketText(phrase) + '`')
        .join(', ');
      lines.push(
        '**ℹ️ Final report back-references (soft):** found ' +
          listed +
          ' - final message should stand alone (goal / changed / proof / blocker). **Does not block review.**',
      );
      lines.push('');
    }
  }

  const evidenceRun = p.evidenceRun;
  const l2Relevance = p.l2Relevance;
  if (evidenceRun || screenshots.length > 0) {
    lines.push('**Behavioral evidence** *(declarative plan — not label guessing)*');
    lines.push(
      '_Runs against the **task worktree** build (not production main). ' +
        'SPA must expose stable `data-evidence` hooks; steps come from WORKFLOW ' +
        '`behavioral.evidence` or task `## Evidence`._',
    );
    if (evidenceRun) {
      lines.push('');
      lines.push(
        `Plan source: \`${evidenceRun.source}\` · ${evidenceRun.ok ? '✅ all required steps ok' : '❌ required step failed'}`,
      );
      if (l2Relevance) {
        lines.push(`_${neutralizeUntrustedPacketText(l2Relevance.summary)}_`);
      }
      for (const st of evidenceRun.steps) {
        const mark = st.ok ? '✅' : st.optional ? '⚠️' : '❌';
        const opt = st.optional ? ' _(optional)_' : '';
        const raw = st.raw
          ? ` \`${neutralizeUntrustedPacketText(st.raw)}\``
          : ` ${st.kind}`;
        lines.push(
          `- ${mark}${opt}${raw} — ${neutralizeUntrustedPacketText(st.detail)}`,
        );
      }
    }
    lines.push('');
    // Map screenshots: prefer names from evidence run, else list files.
    const labeled = evidenceRun?.steps.filter((s) => s.screenshot) ?? [];
    if (labeled.length > 0) {
      for (const st of labeled) {
        const shot = neutralizeUntrustedPacketText(st.screenshot ?? '');
        const sceneAnchors =
          st.screenshot !== undefined
            ? l2Relevance?.screenshotScenes[st.screenshot]
            : undefined;
        const sceneSuffix =
          sceneAnchors === undefined
            ? ''
            : sceneAnchors.length > 0
              ? ` (scene: ${sceneAnchors.map((a) => neutralizeUntrustedPacketText(a)).join(', ')})`
              : ' (scene: no anchors)';
        lines.push(`_Screenshot: ${shot}_${sceneSuffix}`);
        // URL path keeps the raw screenshot basename (filesystem key); label is neutralized.
        lines.push(`![evidence](/api/tasks/${p.taskId}/screenshots/${st.screenshot})`);
      }
    } else {
      for (let i = 0; i < screenshots.length; i += 1) {
        const name = screenshots[i]!;
        lines.push(`_Evidence ${i}: ${neutralizeUntrustedPacketText(name)}_`);
        lines.push(`![evidence](/api/tasks/${p.taskId}/screenshots/${name})`);
      }
    }
    lines.push('');
  } else if (l2Relevance?.label === 'l2-not-run') {
    lines.push(
      `**Behavioral evidence** — ${neutralizeUntrustedPacketText(l2Relevance.summary)}`,
    );
    lines.push('');
  }

  if (cheatFindings.length > 0) {
    // Human packet: L5 is L3's job. Do not dump file lists when L3 already approved.
    for (const line of formatCheatFindingsForHumanPacket({
      cheatFindings,
      reviewerVerdict: p.reviewerVerdict,
    })) {
      lines.push(line);
    }
    lines.push('');
  }

  const toolchainEdits = cheatFindings.filter((f) => f.kind === 'gate-toolchain-edit');
  if (toolchainEdits.length > 0) {
    lines.push('**Gate toolchain edited (human review required)**');
    for (const f of toolchainEdits) {
      lines.push(
        `- ${neutralizeUntrustedPacketText(f.file)}: ${neutralizeUntrustedPacketText(f.detail)}`,
      );
    }
    lines.push('');
  }

  const verifierEdits = cheatFindings.filter((f) => f.kind === 'verifier-edit');
  if (verifierEdits.length > 0) {
    lines.push('**Verifier source edited (read the diff before merge)**');
    for (const f of verifierEdits) {
      lines.push(`- ${neutralizeUntrustedPacketText(f.file)}`);
    }
    lines.push('');
  }

  if (p.verifyOnlyDiscardedPaths !== undefined && p.verifyOnlyDiscardedPaths.length > 0) {
    const d = p.verifyOnlyDiscardedPaths;
    lines.push(
      `**Verify-only run:** ${d.length} uncommitted path(s) left by the read-only agent were ` +
        `discarded before L1 and never committed: ` +
        d.map((f) => `\`${neutralizeUntrustedPacketText(f)}\``).join(', '),
    );
    lines.push('');
  }
  lines.push('**Files touched**');
  if (filesTouched.length === 0) {
    lines.push('- _(none)_');
  } else {
    const { primary, noise } = partitionFilesForPacket(filesTouched);
    for (const f of primary) {
      lines.push(`- \`${neutralizeUntrustedPacketText(f)}\``);
    }
    if (noise.length > 0) {
      if (primary.length === 0) {
        // Only noise — still list them so the packet is not empty.
        for (const f of noise) {
          lines.push(`- \`${neutralizeUntrustedPacketText(f)}\``);
        }
      } else {
        const sample = noise
          .slice(0, 3)
          .map((f) => neutralizeUntrustedPacketText(f))
          .join('`, `');
        lines.push(
          `- _+${noise.length} noise/generated_ (\`${sample}\`${
            noise.length > 3 ? ', …' : ''
          })`,
        );
      }
    }
  }
  lines.push('');
  lines.push(
    `**Diff summary:** ${neutralizeUntrustedPacketText(p.diffSummary)}`,
  );
  if (diffUrl) {
    lines.push('');
    lines.push(`**Full diff on GitHub:** [compare \`${p.branch}\`](${diffUrl})`);
  }
  lines.push('');

  if (p.diff) {
    // Fold map (WORKFLOW/AGENTS) + generated noise hunks so onboarding rewrites
    // do not bury human AC / L1–L3 axes; full diff remains on GitHub.
    const { primary: primaryDiff, folded } = foldNoiseAndMapDiff(p.diff);
    const diffLines = (primaryDiff.length > 0 ? primaryDiff : p.diff).split('\n');
    const shown = diffLines.slice(0, MAX_DIFF_LINES);
    lines.push('**Diff**');
    lines.push('```diff');
    // Diff hunks are tool output — neutralize fence/heading spoofs inside.
    lines.push(neutralizeUntrustedPacketText(shown.join('\n')));
    if (diffLines.length > MAX_DIFF_LINES) {
      lines.push(`… (${diffLines.length - MAX_DIFF_LINES} more lines truncated)`);
      if (diffUrl) {
        lines.push(`… open full diff on GitHub: ${diffUrl}`);
      }
    }
    lines.push('```');
    if (folded.length > 0 && primaryDiff.length > 0) {
      const mapN = folded.filter((f) => f.reason === 'map').length;
      const noiseN = folded.filter((f) => f.reason === 'noise').length;
      const sample = folded
        .slice(0, 4)
        .map((f) => `\`${neutralizeUntrustedPacketText(f.path)}\``)
        .join(', ');
      const parts: string[] = [];
      if (mapN > 0) parts.push(`${mapN} agent-map/policy`);
      if (noiseN > 0) parts.push(`${noiseN} noise/generated`);
      lines.push(
        `_Folded ${parts.join(' + ')} from inline diff_ (${sample}${
          folded.length > 4 ? ', …' : ''
        })${diffUrl ? ' — open full compare on GitHub' : ''}.`,
      );
    }
    lines.push('');
  }

  if (activityLog.length > 0) {
    const shown = activityLog.slice(-MAX_ACTIVITY_LINES);
    const omitted = activityLog.length - shown.length;
    lines.push(
      `**Agent activity** (${activityLog.length} steps${omitted > 0 ? `, showing last ${MAX_ACTIVITY_LINES}` : ''})`,
    );
    lines.push('```');
    if (omitted > 0) lines.push(`… (${omitted} earlier steps omitted)`);
    lines.push(
      neutralizeUntrustedPacketText(shown.join('\n')),
    );
    lines.push('```');
    lines.push('');
  }

  if (p.usage) {
    const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
    if (runKind === 'steer') {
      lines.push('**Cost (steer resume)**');
      lines.push(
        `💵 **Steer turn** $${p.usage.costUsd.toFixed(2)} · ${k(p.usage.inputTokens)} in / ${k(p.usage.outputTokens)} out · _session resume — not a full implementer run_`,
      );
    } else {
      lines.push('**Cost (full implementer)**');
      lines.push(
        `💰 **Full run** $${p.usage.costUsd.toFixed(2)} · ${k(p.usage.inputTokens)} in / ${k(p.usage.outputTokens)} out`,
      );
    }
    lines.push('');
  } else if (runKind === 'steer') {
    lines.push('**Cost (steer resume)**');
    lines.push('_Steer resume turn — adapter did not report token usage for this run._');
    lines.push('');
  }

  const costCapSection = (opts?.costCapSection ?? '').trim();
  if (costCapSection.length > 0) {
    lines.push(neutralizeUntrustedPacketText(costCapSection));
    if (!costCapSection.endsWith('\n')) lines.push('');
  }

  // Machine block last — hidden from display, parsed by the phone UI.
  // Decision-card and CLI receipt blocks are NOT neutralized (Hercules-owned).
  if (p.decisionCard) {
    lines.push(renderDecisionCardBlock(p.decisionCard));
  }
  const narrative = neutralizeCliEvidenceStructure(lines.join('\n'));
  const withReceipt = p.cliEvidence
    ? narrative + '\n' + serializeCliEvidenceReceipt(p.cliEvidence)
    : narrative;
  return `${withReceipt}\n<!-- hercules:packet-end nonce=${nonce} -->`;
}

/**
 * Human-facing L5 section. Full findings always go to L3's prompt; the phone
 * packet must not turn the human into a second code reviewer.
 *
 * - L3 approved → one-line "scrutinized · approved" (no file dump)
 * - L3 rejected → details for implementer rework, explicit not-a-human-queue
 * - L3 not run → compact summary; critical listed for the next L3 pass
 */
export function formatCheatFindingsForHumanPacket(input: {
  readonly cheatFindings: readonly CheatFinding[];
  readonly reviewerVerdict: ReviewerVerdict | null;
}): string[] {
  const findings = input.cheatFindings;
  if (findings.length === 0) return [];

  const critical = findings.filter((f) => isCriticalCheatKind(f.kind));
  const reviewOnly = findings.filter((f) => !isCriticalCheatKind(f.kind));
  const verdict = input.reviewerVerdict;
  const lines: string[] = [];

  if (verdict?.approved) {
    lines.push('**Anti-cheating (L5 → L3)**');
    // When critical findings exist, G4 still auto-reworks; details listed below.
    lines.push(
      `- ✅ Independent L3 scrutinized ${critical.length} critical + ${reviewOnly.length} review-only ` +
        `flag(s) · **approved** — see L3 summary`,
    );
    if (reviewOnly.length > 0) {
      // Placeholders name file:line; other review-only kinds use kind + zh meaning.
      appendReviewOnlySummary(lines, reviewOnly, { approvedByL3: true });
    }
    if (critical.length > 0) {
      // G4: critical L5 still auto-reworks; name file+detail for rework.
      lines.push(
        '- ⚠️ Critical L5 still fails mechanically (auto-rework; L3 approval does not override):',
      );
      appendDetailedCheatLines(lines, critical, []);
    }
    return lines;
  }

  if (verdict && !verdict.approved) {
    lines.push('**Anti-cheating (L5 → L3)**');
    lines.push(
      '- ❌ L3 requested changes → **auto-rework** (implementer queue, not human code review)',
    );
    appendDetailedCheatLines(lines, critical, reviewOnly);
    return lines;
  }

  // L3 did not run / no verdict yet
  lines.push('**Anti-cheating (L5 → L3)**');
  if (critical.length > 0) {
    lines.push(
      '- ⚠️ L3 did not run — critical flags below are for the **next independent review**, not a human queue',
    );
    appendDetailedCheatLines(lines, critical, reviewOnly);
  } else if (reviewOnly.length > 0) {
    appendReviewOnlySummary(lines, reviewOnly, { approvedByL3: false });
  }
  return lines;
}

/** Group review-only findings by kind with count + zh meaning. */
function formatReviewOnlyNamed(reviewOnly: readonly CheatFinding[]): string {
  const counts = new Map<string, number>();
  for (const f of reviewOnly) {
    counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, n]) => {
      const zh = reviewOnlyFlagMeaningZh(kind);
      return n > 1 ? `${kind} ×${n}（${zh}）` : `${kind}（${zh}）`;
    })
    .join('; ');
}

/**
 * Compact review-only summary for the phone packet.
 * Placeholder hooks always name file:line (CEO / L3 must find the chrome);
 * other kinds stay kind+zh so the human is not a second code reviewer.
 */
function appendReviewOnlySummary(
  lines: string[],
  reviewOnly: readonly CheatFinding[],
  opts: { readonly approvedByL3: boolean },
): void {
  const placeholders = reviewOnly.filter((f) => f.kind === 'placeholder-evidence-hook');
  const rest = reviewOnly.filter((f) => f.kind !== 'placeholder-evidence-hook');

  if (opts.approvedByL3) {
    if (rest.length > 0) {
      lines.push(`- _${formatReviewOnlyNamed(rest)}_`);
    }
    for (const f of placeholders) {
      lines.push(
        `- _placeholder-evidence-hook in \`${neutralizePacketText(f.file)}\`${f.line ? `:${f.line}` : ''} — ${neutralizePacketText(f.detail)} (L3 owns this)_`,
      );
    }
    return;
  }

  // No L3 yet — name placeholders to file+line; keep other kinds compact.
  if (placeholders.length === 0 && rest.length > 0) {
    lines.push(
      `- ℹ️ ${formatReviewOnlyNamed(rest)} — L3 will scrutinize when review runs ` +
        `(**not** a human code-review queue)`,
    );
    return;
  }
  if (rest.length > 0) {
    lines.push(`- ℹ️ ${formatReviewOnlyNamed(rest)}`);
  }
  for (const f of placeholders) {
    lines.push(
      `- ℹ️ placeholder-evidence-hook in \`${neutralizePacketText(f.file)}\`${f.line ? `:${f.line}` : ''} — ${neutralizePacketText(f.detail)}`,
    );
  }
}

function appendDetailedCheatLines(
  lines: string[],
  critical: readonly CheatFinding[],
  reviewOnly: readonly CheatFinding[],
): void {
  for (const f of critical) {
    lines.push(
      `- 🚨 ${neutralizePacketText(f.kind)} in \`${neutralizePacketText(f.file)}\`${f.line ? `:${f.line}` : ''} — ${neutralizePacketText(f.detail)}`,
    );
  }
  const placeholders = reviewOnly.filter((f) => f.kind === 'placeholder-evidence-hook');
  const rest = reviewOnly.filter((f) => f.kind !== 'placeholder-evidence-hook');
  for (const f of placeholders) {
    lines.push(
      `- ℹ️ placeholder-evidence-hook in \`${neutralizePacketText(f.file)}\`${f.line ? `:${f.line}` : ''} — ${neutralizePacketText(f.detail)}`,
    );
  }
  if (rest.length > 0) {
    // Group by kind; still list a few files for implementer rework context.
    const byKind = new Map<string, CheatFinding[]>();
    for (const f of rest) {
      const list = byKind.get(f.kind) ?? [];
      list.push(f);
      byKind.set(f.kind, list);
    }
    for (const [kind, list] of byKind) {
      const files = list.map(
        (f) => `\`${neutralizePacketText(f.file)}\``,
      );
      const shown = files.slice(0, 8);
      const more = files.length > 8 ? `, +${files.length - 8} more` : '';
      const zh = reviewOnlyFlagMeaningZh(kind);
      lines.push(
        `- ℹ️ ${neutralizePacketText(kind)} ×${list.length}（${zh}）— ${shown.join(', ')}${more}`,
      );
    }
  }
}

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}
