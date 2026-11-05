/**
 * Domain — feature-type classifier for intent drafts and L2 evidence repair.
 *
 * One vocabulary for "what is this task about?" so Create-form Evidence and
 * resolveEvidencePlan never drift (task-5 greenwash: Settings chrome on a
 * pull-to-refresh task). Pure heuristics — no LLM.
 */
import type { EvidenceStep } from './evidence.js';
import { extractProductBrief } from './taskBrief.js';
import { hasAuthUiIntent } from './authIntent.js';
import { hasBugIntent } from './bugIntent.js';
export { hasAuthUiIntent } from './authIntent.js';

export type FeatureKind =
  | 'settings'
  | 'pull_to_refresh'
  | 'form'
  | 'list'
  | 'auth'
  | 'docs'
  | 'onboarding'
  | 'bug'
  | 'refactor'
  | 'ui_generic'
  | 'general';

const PTR_RE =
  /下拉\s*刷新|pull[\s-]?to[\s-]?refresh|(刷新).{0,16}(列表|list)|(列表|list).{0,16}(刷新|refresh)/i;
// 语言 alone matches 自然语言 / 用语 noise; require settings-ish language.
// settings? = setting(s) — still intentional for Settings chrome tasks.
const SETTINGS_RE =
  /设置|settings?|logout|sign[\s-]?out|signout|登出|(?<!自然)语言(?!用)|language|agent\s*选择|default\s*agent|self-?update|\bdeploy\b/i;
// Bare 提交 matches git commits ("涉及哪些提交"). Prefer form-submit phrases;
// English `submit` stays (form vocabulary).
// Bare 校验 / validat is too broad (存在性校验, path validation, cache checks) —
// browser-resolve-at-use 2026-07-30 was misclassified as form and L2 required
// data-evidence=form. Keep form-scoped validation only.
// form alone with only a trailing boundary still matches perform/platform suffixes.
const FORM_RE =
  /表单|\bform\b|input\b|字段|field|提交表单|提交按钮|点击提交|点提交|可提交|(?<!哪些)(?<!相关)提交|submit|表单校验|字段校验|校验字段|校验表单|\bform\s*validat|field\s*validat|validat(?:e|ion|or)?\s+(?:the\s+)?(?:form|field|input)/i;
// Prefer explicit list/feed vocabulary — bare "card" is too common in generic UI.
// Bare 列表 alone is too broad (备选列表 / fallback chain prose misclassified
// adapter-failover as list and forced non-existent data-evidence=list on L2).
const LIST_RE =
  /任务列表|列表页|列表视图|列表组件|task\s*list|list\s*(view|page|feed)\b|\bfeed\b|infinite\s*scroll|分页|paginat/i;
const ONBOARD_RE =
  /onboard|readiness|就绪|WORKFLOW\.md|AGENTS\.md|repo\s*ready/i;
const DOCS_RE = /docs?|readme|文档|说明/i;
const REFACTOR_RE = /重构|refactor|清理|cleanup|类型|type.?safe/i;
// Short UI nouns must be lexical tokens: `nav` in unavailable and `card` in
// discard are backend prose, while nav/navigation/card remain UI vocabulary.
const UI_RE =
  /设置|settings?|页面|ui\b|logout|登录|底栏|\bnav(?:igation)?\b|sheet|表单|\bform\b|i18n|(?<!自然)语言(?!用)|agent\s*选择|下拉|刷新|refresh|pull.?to.?refresh|列表|list\b|feed|screen|layout|\bcard\b/i;

/** More-specific kinds win; order is load-bearing. */
export function classifyFeature(text: string): FeatureKind {
  // Shared task-brief boundary: harness audit after the product brief must not
  // change classification (Review packet / Human steer / Run failure).
  const t = extractProductBrief(text).trim();
  if (!t) return 'general';
  if (ONBOARD_RE.test(t)) return 'onboarding';
  if (PTR_RE.test(t)) return 'pull_to_refresh';
  // Auth before settings (deploy-key permission UI) and before forms.
  if (hasAuthUiIntent(t)) return 'auth';
  if (SETTINGS_RE.test(t) && UI_RE.test(t)) return 'settings';
  if (SETTINGS_RE.test(t) && !hasBugIntent(t)) return 'settings';
  if (FORM_RE.test(t) && UI_RE.test(t)) return 'form';
  if (LIST_RE.test(t) && UI_RE.test(t) && !PTR_RE.test(t)) return 'list';
  if (DOCS_RE.test(t) && !ONBOARD_RE.test(t)) return 'docs';
  if (hasBugIntent(t)) return 'bug';
  if (REFACTOR_RE.test(t)) return 'refactor';
  if (UI_RE.test(t)) return 'ui_generic';
  return 'general';
}

function stepMentions(steps: readonly EvidenceStep[], needle: string): boolean {
  const n = needle.toLowerCase();
  return steps.some(
    (s) =>
      (s.selector ?? '').toLowerCase().includes(n) ||
      (s.name ?? '').toLowerCase().includes(n) ||
      (s.raw ?? '').toLowerCase().includes(n),
  );
}

function hasSettingsChrome(steps: readonly EvidenceStep[]): boolean {
  return (
    stepMentions(steps, 'nav-settings') ||
    stepMentions(steps, 'settings-panel') ||
    stepMentions(steps, 'settings')
  );
}

function hasPtrChrome(steps: readonly EvidenceStep[]): boolean {
  // Only the PTR hook — task-list is shared by decide-card / list chrome and
  // must not mark a non-PTR plan as "PTR chrome" (false off-topic repair).
  return stepMentions(steps, 'pull-to-refresh');
}

function hasTaskListChrome(steps: readonly EvidenceStep[]): boolean {
  return stepMentions(steps, 'task-list');
}

function hasFormChrome(steps: readonly EvidenceStep[]): boolean {
  return (
    stepMentions(steps, 'form') ||
    stepMentions(steps, 'submit') ||
    stepMentions(steps, 'input')
  );
}

function hasAuthChrome(steps: readonly EvidenceStep[]): boolean {
  return (
    stepMentions(steps, 'login') ||
    stepMentions(steps, 'auth') ||
    stepMentions(steps, 'sign-in')
  );
}

function hasListChrome(steps: readonly EvidenceStep[]): boolean {
  return (
    stepMentions(steps, 'list') ||
    stepMentions(steps, 'feed') ||
    stepMentions(steps, 'task-list')
  );
}

/**
 * True when ## Evidence chrome does not match the classified feature
 * (e.g. Settings shots for a form/list/PTR task).
 */
export function isEvidenceOffTopicForKind(
  kind: FeatureKind,
  steps: readonly EvidenceStep[],
): boolean {
  if (steps.length === 0) return false;
  switch (kind) {
    case 'pull_to_refresh':
      // Settings-only (or any plan missing both PTR hook and task-list) is off-topic.
      return (
        (hasSettingsChrome(steps) || hasFormChrome(steps) || hasAuthChrome(steps)) &&
        !hasPtrChrome(steps) &&
        !hasTaskListChrome(steps)
      );
    case 'form':
      return (hasSettingsChrome(steps) || hasPtrChrome(steps)) && !hasFormChrome(steps);
    case 'auth':
      return (hasSettingsChrome(steps) || hasPtrChrome(steps)) && !hasAuthChrome(steps);
    case 'list':
      return hasSettingsChrome(steps) && !hasListChrome(steps) && !hasPtrChrome(steps);
    case 'settings':
      // Wrong direction less common; only flag pure PTR chrome on a settings task.
      return hasPtrChrome(steps) && !hasSettingsChrome(steps);
    default:
      return false;
  }
}

/** Canonical required evidence steps for a feature kind (null = no L2 template). */
export function evidenceStepsForFeature(kind: FeatureKind): EvidenceStep[] | null {
  switch (kind) {
    case 'settings':
      return [
        { kind: 'unlock', raw: 'unlock' },
        { kind: 'screenshot', name: 'shell', raw: 'screenshot shell' },
        {
          kind: 'click',
          selector: '[data-evidence=nav-settings]',
          raw: 'click [data-evidence=nav-settings]',
        },
        {
          kind: 'assert',
          selector: '[data-evidence=settings-panel]',
          raw: 'assert sel=[data-evidence=settings-panel]',
        },
        { kind: 'screenshot', name: 'settings', raw: 'screenshot settings' },
      ];
    case 'pull_to_refresh':
      return [
        { kind: 'unlock', raw: 'unlock' },
        { kind: 'screenshot', name: 'shell', raw: 'screenshot shell' },
        {
          kind: 'assert',
          selector: '[data-evidence=task-list]',
          raw: 'assert sel=[data-evidence=task-list]',
        },
        {
          kind: 'assert',
          selector: '[data-evidence=pull-to-refresh]',
          raw: 'assert sel=[data-evidence=pull-to-refresh]',
        },
        { kind: 'screenshot', name: 'task-list', raw: 'screenshot task-list' },
      ];
    case 'form':
      return [
        { kind: 'unlock', raw: 'unlock' },
        { kind: 'screenshot', name: 'shell', raw: 'screenshot shell' },
        {
          kind: 'assert',
          selector: '[data-evidence=form]',
          raw: 'assert sel=[data-evidence=form]',
        },
        { kind: 'screenshot', name: 'form', raw: 'screenshot form' },
      ];
    case 'auth':
      return [
        { kind: 'screenshot', name: 'shell', raw: 'screenshot shell' },
        {
          kind: 'assert',
          selector: '[data-evidence=login]',
          raw: 'assert sel=[data-evidence=login]',
        },
        { kind: 'screenshot', name: 'auth', raw: 'screenshot auth' },
      ];
    case 'list':
      // Real chrome is task-list (PullToRefresh), not a fictional data-evidence=list.
      return [
        { kind: 'unlock', raw: 'unlock' },
        { kind: 'screenshot', name: 'shell', raw: 'screenshot shell' },
        {
          kind: 'assert',
          selector: '[data-evidence=task-list]',
          raw: 'assert sel=[data-evidence=task-list]',
        },
        { kind: 'screenshot', name: 'list', raw: 'screenshot list' },
      ];
    case 'ui_generic':
      return [
        { kind: 'unlock', raw: 'unlock' },
        { kind: 'screenshot', name: 'shell', raw: 'screenshot shell' },
      ];
    default:
      return null;
  }
}

/** Markdown ## Evidence section for intent drafts. */
export function evidenceMarkdownForFeature(kind: FeatureKind): string {
  const steps = evidenceStepsForFeature(kind);
  if (!steps) return '';
  const lines = ['', '## Evidence'];
  for (const s of steps) {
    if (s.kind === 'unlock') lines.push('- unlock');
    else if (s.kind === 'screenshot') lines.push(`- screenshot ${s.name ?? 'shot'}`);
    else if (s.kind === 'click' && s.selector) lines.push(`- click ${s.selector}`);
    else if (s.kind === 'assert' && s.selector) lines.push(`- assert sel=${s.selector}`);
    else if (s.kind === 'assert' && s.text) lines.push(`- assert text=${s.text}`);
  }
  if (kind === 'ui_generic') {
    lines.push(
      '',
      "# Add required clicks/asserts for this feature's data-evidence hooks",
      '# (optional: true only when the chrome may not exist).',
    );
  }
  return lines.join('\n');
}

export function mechanicalHooksCriterion(kind: FeatureKind): string {
  switch (kind) {
    case 'settings':
      return (
        '- [ ] (mechanical) UI hooks / L2 evidence pass when applicable ' +
        '(data-evidence=nav-settings / settings-panel) @evidence:nav-settings'
      );
    case 'pull_to_refresh':
      return (
        '- [ ] (mechanical) UI hooks / L2 evidence pass when applicable ' +
        '(data-evidence=task-list / pull-to-refresh) @evidence:pull-to-refresh'
      );
    case 'form':
      return (
        '- [ ] (mechanical) UI hooks / L2 evidence pass when applicable ' +
        '(data-evidence=form) @evidence:form'
      );
    case 'auth':
      return (
        '- [ ] (mechanical) UI hooks / L2 evidence pass when applicable ' +
        '(data-evidence=login) @evidence:login'
      );
    case 'list':
      return (
        '- [ ] (mechanical) UI hooks / L2 evidence pass when applicable ' +
        '(data-evidence=task-list) @evidence:task-list'
      );
    case 'ui_generic':
      // No known evidence anchor yet — reviewer, not unbound mechanical.
      return (
        '- [ ] (reviewer) UI hooks / L2 evidence declared and exercised ' +
        'for this feature (add data-evidence anchors)'
      );
    default:
      return '- [ ] (mechanical) Implementation complete; gates green @gate:test';
  }
}

/**
 * Mechanical AC for web UI / App shell work: keep App.tsx under the line
 * budget enforced by test/web/appSplit.test.ts. Prefer extracting modules
 * over raising the ceiling (do not weaken appSplit without an explicit task).
 */
export function appShellBudgetCriterion(): string {
  return (
    '- [ ] (mechanical) App.tsx stays under line budget; ' +
    '`test/web/appSplit.test.ts` green (prefer extract over raising ceiling) @gate:test'
  );
}

export function reviewerCriterion(kind: FeatureKind): string {
  switch (kind) {
    case 'settings':
      return '- [ ] (reviewer) No scope creep; spirit of the settings/UI change';
    case 'pull_to_refresh':
      return '- [ ] (reviewer) No scope creep; spirit of the list/pull-to-refresh UX';
    case 'form':
      return '- [ ] (reviewer) No scope creep; form UX and validation match intent';
    case 'auth':
      return '- [ ] (reviewer) Auth/session handling is correct; no secret leakage';
    case 'list':
      return '- [ ] (reviewer) No scope creep; list/feed UX matches intent';
    case 'onboarding':
      return '- [ ] (reviewer) "How to verify a change" is documented; first tasks can be crisp';
    case 'docs':
      return '- [ ] (reviewer) Writing is accurate and navigable';
    case 'bug':
      return '- [ ] (reviewer) Root cause addressed; not a symptom-only patch';
    case 'refactor':
      return '- [ ] (reviewer) Scope limited to stated refactor; no feature sneak-in';
    default:
      return '- [ ] (reviewer) Matches intent; no scope creep';
  }
}

export function isUiFeature(kind: FeatureKind): boolean {
  return (
    kind === 'settings' ||
    kind === 'pull_to_refresh' ||
    kind === 'form' ||
    kind === 'list' ||
    kind === 'auth' ||
    kind === 'ui_generic'
  );
}
