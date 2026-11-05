/**
 * Domain — detect human ACs that claim UI behavior without L2 evidence steps.
 *
 * Real case (boundary-badge-why, 2026-07-25): human item said "tap the yellow
 * badge on phone and understand why", but the evidence plan only unlocked and
 * screenshotted the task list. Operators had to checkbox-blind. This module
 * surfaces that gap as a visible warning (never a hard block).
 *
 * Also links human items to trusted CLI evidence steps (@scenario: / recordings).
 *
 * Pure — no IO / git / fs / network.
 */
import type { EvidenceStep, EvidenceStepResult } from './evidence.js';
import { parseScenarioBinding } from './mechProof.js';

/** CLI step shape needed for human-AC ↔ artifact linkage (packet / matrix). */
export interface CliEvidenceLinkStep {
  readonly id: string;
  readonly ok: boolean;
  readonly status: string;
  readonly artifacts: readonly { readonly name: string; readonly kind: 'image' | 'video' }[];
  readonly stdoutTail: string;
}

export interface CliEvidenceLink {
  readonly stepId: string;
  readonly imageCount: number;
  readonly videoCount: number;
}

/** Evidence-matrix cell when a human AC is proven-linked to a CLI step. */
export function formatCliEvidenceCell(link: CliEvidenceLink): string {
  return (
    `CLI 步骤 ${link.stepId} ✓ · ${link.imageCount} 张截图 · ${link.videoCount} 段录像`
  );
}

const RECORDING_VIDEO_RE = /video|recording|录像|录屏|视频|screen\s*recording/i;
const RECORDING_IMAGE_RE = /screenshot|截图/i;

/** Whole-line `hercules-scenario: <id>` (optional ` surfaces=…`) in step stdout. */
function stdoutDeclaresScenario(stdoutTail: string, scenarioId: string): boolean {
  const re = new RegExp(
    `(?:^|\\n)hercules-scenario:\\s*${escapeRegExp(scenarioId)}(?:\\s+surfaces=\\S*)?(?:\\n|$)`,
  );
  return re.test(stdoutTail);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match a human criterion to a PASSED CLI evidence step via:
 * (i) `@scenario:<id>` equals step id, or stdout has `hercules-scenario: <id>`;
 * (ii) recording/screenshot language + matching artifact kind on a passed step.
 */
export function matchCliEvidenceForHuman(
  criterionText: string,
  cliSteps: readonly CliEvidenceLinkStep[],
): CliEvidenceLink | null {
  if (cliSteps.length === 0) return null;
  const scenario = parseScenarioBinding(criterionText);
  const passed = cliSteps.filter((s) => s.ok === true && s.status === 'passed');

  if (scenario.id !== null) {
    for (const step of passed) {
      // Bind by step id, or by a scenario line printed by THAT step which also
      // produced at least one artifact — a bare stdout line on an unrelated
      // step must not mark a human item proven-linked (Claude R17 N1).
      const declares =
        stdoutDeclaresScenario(step.stdoutTail, scenario.id) && step.artifacts.length > 0;
      if (step.id === scenario.id || declares) {
        return cliLinkFromStep(step);
      }
    }
  }

  const wantsVideo = RECORDING_VIDEO_RE.test(criterionText);
  const wantsImage = RECORDING_IMAGE_RE.test(criterionText);
  if (!wantsVideo && !wantsImage) return null;

  for (const step of passed) {
    const images = step.artifacts.filter((a) => a.kind === 'image').length;
    const videos = step.artifacts.filter((a) => a.kind === 'video').length;
    if (wantsVideo && videos >= 1) return cliLinkFromStep(step);
    if (wantsImage && images >= 1) return cliLinkFromStep(step);
  }
  return null;
}

function cliLinkFromStep(step: CliEvidenceLinkStep): CliEvidenceLink {
  return {
    stepId: step.id,
    imageCount: step.artifacts.filter((a) => a.kind === 'image').length,
    videoCount: step.artifacts.filter((a) => a.kind === 'video').length,
  };
}

/** Visible operator warning (packet + DecisionCard + checkbox annotation). */
export const UNPROVEN_UI_AC_WARNING =
  '⚠ 该人工项无对应证据步骤——你无法在部署前核验';

/** Draft-from-intent note when UI human ACs lack a ## Evidence section. */
export const UI_AC_EVIDENCE_REMINDER =
  '⚠ UI 类人工验收项需要 `## Evidence`（click / assert / screenshot）才能在部署前核验；请补步骤或改写为可机检/审稿项。';

export interface UnprovenUiCriterion {
  readonly text: string;
  /** Operator-facing short warning. */
  readonly warning: string;
  /** What is missing (specific, not generic). */
  readonly reason: string;
}

/**
 * UI-behavior language (CN + EN). Human ACs matching these claim something
 * an operator must *see* or *tap* — L2 click/assert/screenshot should cover it.
 */
const UI_LANG_RE =
  /点(?:开|击|选|一下)?|展开|看到|一眼|截图|界面|手机上|按钮|页面|面板|弹窗|徽章|底栏|列表|显示|查看|打开.{0,8}(?:页|板|窗|单)|click|tap|expand|screenshot|on\s+(?:the\s+)?phone|button|badge|panel|modal|sheet|page|screen|open\s+the|see\s+(?:the|why|that)|look\s+(?:at|like)|UI\b|interface/i;

/** Generic chrome words that do not prove a specific UI claim by themselves. */
const GENERIC_STEP_STOP = new Set([
  'unlock',
  'shell',
  'nav',
  'tasks',
  'task',
  'list',
  'click',
  'assert',
  'sel',
  'selector',
  'screenshot',
  'data',
  'evidence',
  'optional',
  'true',
  'false',
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'when',
  'are',
  'was',
  'you',
  'can',
  'see',
  'open',
  'show',
  'page',
  'panel',
  'button',
  'phone',
  'mobile',
  '界面',
  '页面',
  '按钮',
  '手机',
  '截图',
  '打开',
  '看到',
  '点击',
  '点开',
  '展开',
  '显示',
  '查看',
  '一眼',
  '列表',
]);

/**
 * CN↔EN bridges so Chinese human ACs match English data-evidence hooks
 * (e.g. 徽章 ↔ badge, 提交 ↔ commit).
 */
const TOKEN_BRIDGES: ReadonlyArray<readonly [string, string]> = [
  ['badge', '徽章'],
  ['yellow', '黄'],
  ['commit', '提交'],
  ['settings', '设置'],
  ['button', '按钮'],
  ['page', '页面'],
  ['panel', '面板'],
  ['modal', '弹窗'],
  ['sheet', '面板'],
  ['list', '列表'],
  ['nav', '导航'],
  ['language', '语言'],
  ['why', '为什么'],
  ['why', '原因'],
  ['boundary', '跨任务'],
  ['boundary', '边界'],
  ['cross-task', '跨任务'],
  ['crosstask', '跨任务'],
];

export function isUiHumanCriterion(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false;
  return UI_LANG_RE.test(t);
}

/**
 * Significant tokens for relatedness (EN words + CJK runs / bigrams).
 * UI-trigger and generic chrome words are dropped so "click button" alone
 * does not match every click step.
 */
export function criterionTokens(text: string): ReadonlySet<string> {
  return extractTokens(text, /*dropUiLang*/ true);
}

function stepTokens(
  step: EvidenceStep,
  result?: Pick<EvidenceStepResult, 'detail' | 'screenshot'>,
): ReadonlySet<string> {
  const parts = [
    step.raw ?? '',
    step.selector ?? '',
    step.text ?? '',
    step.name ?? '',
    step.kind,
    result?.detail ?? '',
    result?.screenshot ?? '',
  ].join(' ');
  return extractTokens(parts, /*dropUiLang*/ false);
}

function extractTokens(text: string, _dropUiLang: boolean): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();

  for (const w of lower.match(/[a-z][a-z0-9_-]{2,}/g) ?? []) {
    if (GENERIC_STEP_STOP.has(w)) continue;
    // data-evidence compounds: boundary-badge → boundary + badge
    out.add(w);
    for (const part of w.split(/[_-]+/)) {
      if (part.length >= 3 && !GENERIC_STEP_STOP.has(part)) out.add(part);
    }
  }

  for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    if (!GENERIC_STEP_STOP.has(run)) out.add(run);
    for (let i = 0; i < run.length - 1; i += 1) {
      const bi = run.slice(i, i + 2);
      if (!GENERIC_STEP_STOP.has(bi)) out.add(bi);
    }
    // Single CJK that matters for bridges (黄)
    for (const ch of run) {
      if (ch === '黄') out.add(ch);
    }
  }

  // Expand bilingual bridges. EN side is exact-token only (avoid
  // "task-list".includes("task") greening unrelated list chrome).
  // ZH side allows compound containment (跨任务徽章 contains 徽章).
  const bridged = new Set<string>();
  for (const t of out) {
    for (const [en, zh] of TOKEN_BRIDGES) {
      if (t === en) {
        bridged.add(zh);
        continue;
      }
      if (t === zh || (zh.length >= 2 && t.includes(zh))) {
        bridged.add(en);
      }
    }
  }
  for (const b of bridged) out.add(b);

  return out;
}

function isUiProofStep(step: EvidenceStep): boolean {
  return step.kind === 'click' || step.kind === 'assert' || step.kind === 'screenshot';
}

function sharesTokens(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) {
    if (b.has(t)) return true;
    // Partial: longer CJK compound contains shorter, or EN substring ≥4
    for (const u of b) {
      if (t.length >= 2 && u.length >= 2 && (t.includes(u) || u.includes(t))) {
        if (/[\u4e00-\u9fff]/.test(t) || t.length >= 4) return true;
      }
    }
  }
  return false;
}

function describeMissing(text: string, planSteps: readonly EvidenceStep[]): string {
  const hasClick = planSteps.some((s) => s.kind === 'click');
  const hasAssert = planSteps.some((s) => s.kind === 'assert');
  const hasShot = planSteps.some((s) => s.kind === 'screenshot');
  const kinds: string[] = [];
  if (!hasClick) kinds.push('click');
  if (!hasAssert) kinds.push('assert');
  if (!hasShot) kinds.push('screenshot');

  const hint = summarizeUiClaim(text);
  if (kinds.length === 3 || planSteps.every((s) => s.kind === 'unlock')) {
    return `缺 click/assert/screenshot 步骤覆盖「${hint}」——计划里只有 unlock 或空，L2 无法在部署前证明该界面行为`;
  }
  if (kinds.length > 0) {
    return `缺与「${hint}」相关的证据（现有步骤未命中该 UI 用语；可补 ${kinds.join('/')} 指向该控件）`;
  }
  return `现有证据步骤与「${hint}」无关（例如只截了任务列表）——请补 click/assert/screenshot 指向该 UI 断言`;
}

/** Short quote of the criterion for the reason line. */
function summarizeUiClaim(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 36 ? `${t.slice(0, 33)}…` : t;
}

export interface FindUnprovenUiInput {
  readonly humanCriteria: readonly string[];
  readonly evidencePlanSteps: readonly EvidenceStep[];
  readonly evidenceResults?: readonly EvidenceStepResult[];
  /** Trusted CLI evidence steps — a match proves the human UI item linked. */
  readonly cliSteps?: readonly CliEvidenceLinkStep[];
}

/**
 * Return human criteria that use UI language but have no related
 * click / assert / screenshot in the evidence plan (or run results),
 * and no matching PASSED CLI evidence step.
 *
 * Soft signal only — callers must warn, never hard-fail Approve.
 */
export function findUnprovenUiCriteria(
  input: FindUnprovenUiInput,
): readonly UnprovenUiCriterion[] {
  const plan = input.evidencePlanSteps;
  const results = input.evidenceResults ?? [];
  const cliSteps = input.cliSteps ?? [];
  const proofSteps = plan.filter(isUiProofStep);
  const out: UnprovenUiCriterion[] = [];

  for (const raw of input.humanCriteria) {
    const text = raw.trim();
    if (text.length === 0) continue;
    if (!isUiHumanCriterion(text)) continue;

    // CLI evidence linkage (scenario id / recording artifacts) proves the item.
    if (matchCliEvidenceForHuman(text, cliSteps) !== null) continue;

    const acTokens = criterionTokens(text);
    let related = false;

    for (let i = 0; i < plan.length; i += 1) {
      const step = plan[i]!;
      if (!isUiProofStep(step)) continue;
      const result = results.find(
        (r) =>
          r.step === step ||
          (r.step.kind === step.kind &&
            r.step.raw === step.raw &&
            r.step.name === step.name &&
            r.step.selector === step.selector),
      );
      if (sharesTokens(acTokens, stepTokens(step, result))) {
        related = true;
        break;
      }
      // Also scan result-only detail when step is sparse
      if (result && sharesTokens(acTokens, stepTokens(step, result))) {
        related = true;
        break;
      }
    }

    const displayText = parseScenarioBinding(text).cleanText || text;

    // No proof steps at all → unproven
    if (proofSteps.length === 0) {
      out.push({
        text: displayText,
        warning: UNPROVEN_UI_AC_WARNING,
        reason: describeMissing(text, plan),
      });
      continue;
    }

    if (!related) {
      out.push({
        text: displayText,
        warning: UNPROVEN_UI_AC_WARNING,
        reason: describeMissing(text, plan),
      });
    }
  }

  return out;
}

/**
 * True when body has human UI-language ACs but no `## Evidence` section.
 * Used by draft-from-intent to attach a reminder (not a hard error).
 */
export function needsUiEvidenceReminder(body: string): boolean {
  if (/^##\s+Evidence\s*$/im.test(body)) return false;
  const cut = /^##\s+Review packet\b/im.exec(body);
  const source = cut && cut.index !== undefined ? body.slice(0, cut.index) : body;
  const sec =
    /^##\s+(?:Acceptance criteria|Definition of Done|验收标准|完成定义|DoD)\s*$/im.exec(
      source,
    );
  if (!sec || sec.index === undefined) {
    return isUiHumanCriterion(source);
  }
  const after = source.slice(sec.index + sec[0].length);
  const next = /^##\s+/m.exec(after);
  const block = (next ? after.slice(0, next.index) : after).trim();
  const kindPrefix =
    /^(?:`+)?(?:[[(【（]\s*(mechanical|reviewer|human|机检|审稿|人工|l1|l3)\s*[)\]】）]|((?:mechanical|reviewer|human|机检|审稿|人工))\s*[:：])(?:`+)?\s*/i;

  for (const line of block.split('\n')) {
    const m = /^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (!m) continue;
    const rest = m[1]!.trim();
    const kindMatch = kindPrefix.exec(rest);
    let kind = 'human';
    let text = rest;
    if (kindMatch) {
      const raw = (kindMatch[1] ?? kindMatch[2] ?? '').toLowerCase();
      if (raw === 'mechanical' || raw === '机检' || raw === 'l1') kind = 'mechanical';
      else if (raw === 'reviewer' || raw === '审稿' || raw === 'l3') kind = 'reviewer';
      else kind = 'human';
      text = rest.slice(kindMatch[0].length).trim();
    }
    if (kind !== 'human') continue;
    if (isUiHumanCriterion(text)) return true;
  }
  return false;
}
