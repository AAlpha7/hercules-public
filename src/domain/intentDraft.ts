/**
 * Domain — draft a structured task from free-form human intent (quality gap G5).
 *
 * Pure heuristics (no LLM). Output is a plan for human edit/approve before
 * dispatch (`plan_pending: true` until the human confirms).
 *
 * Vague intent is a clarification flow (where / what / done-when slots), not a
 * dead-end warning label. Feature typing lives in `featureType.ts`.
 */
import {
  classifyFeature,
  evidenceMarkdownForFeature,
  isUiFeature,
  appShellBudgetCriterion,
  mechanicalHooksCriterion,
  reviewerCriterion,
  type FeatureKind,
} from './featureType.js';
import {
  needsUiEvidenceReminder,
  UI_AC_EVIDENCE_REMINDER,
} from './uiAcEvidence.js';
import { shortSlug } from './taskSlug.js';

export type IntentSlot = 'where' | 'what' | 'done_when';

export interface IntentQuestion {
  readonly slot: IntentSlot;
  readonly text: string;
  readonly options?: readonly string[];
}

export interface IntentSlots {
  readonly where: string | null;
  readonly what: string | null;
  readonly doneWhen: string | null;
}

export interface IntentDraft {
  readonly title: string;
  /**
   * Short English slug for the generated task id (`<n>-<slug>`), ≤ TASK_SLUG_MAX,
   * lowercase words joined by '-'. Absent when nothing usable could be derived.
   */
  readonly slug?: string;
  readonly body: string;
  readonly priority: number;
  /** Suggested labels (e.g. needs-plan is applied by the caller). */
  readonly labels: readonly string[];
  /**
   * True when open clarification questions remain (`questions.length > 0`).
   * Kept for compatibility — dispatch is never blocked by this flag.
   */
  readonly vague: boolean;
  readonly warnings: readonly string[];
  /** One question per missing slot (≤ 3). */
  readonly questions: readonly IntentQuestion[];
  /** Zh one-liners of what the drafter filled. */
  readonly filled: readonly string[];
}

/** Hercules SPA surfaces offered as where-option chips. */
export const HERCULES_WHERE_OPTIONS = [
  'Tasks',
  'Chat',
  'Repos',
  'Releases',
  'Settings',
] as const;

const SLOT_QUESTION_TEXT: Record<IntentSlot, string> = {
  where: '改的是哪个页面／入口？',
  what: '具体要改成什么样？',
  done_when: '怎样算做完？',
};

/** @deprecated Prefer evidenceMarkdownForFeature(classifyFeature(intent)). */
export function uiEvidenceSection(intent: string): string {
  const kind = classifyFeature(intent);
  if (!isUiFeature(kind)) {
    // Preserve prior generic-UI fallback for callers that force UI evidence.
    return evidenceMarkdownForFeature('ui_generic');
  }
  return evidenceMarkdownForFeature(kind);
}

function firstLineTitle(intent: string): string {
  const line = intent
    .trim()
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return 'Untitled task';
  const cleaned = line.replace(/^[-*•\d.)\]]+\s*/, '').trim();
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}…` : cleaned;
}

function priorityFor(kind: FeatureKind): number {
  switch (kind) {
    case 'bug':
      return 30;
    case 'settings':
    case 'pull_to_refresh':
    case 'form':
    case 'auth':
    case 'list':
    case 'ui_generic':
      return 40;
    case 'refactor':
      return 60;
    case 'docs':
    case 'onboarding':
      return 80;
    default:
      return 50;
  }
}

function labelFor(kind: FeatureKind): string | null {
  if (isUiFeature(kind)) return 'ui';
  if (kind === 'bug') return 'bug';
  if (kind === 'docs') return 'docs';
  if (kind === 'onboarding') return 'docs';
  if (kind === 'refactor') return 'refactor';
  return null;
}

function criteriaFor(kind: FeatureKind): string[] {
  if (isUiFeature(kind)) {
    return [
      '- [ ] (mechanical) Feature matches intent; structure gates green @gate:test',
      mechanicalHooksCriterion(kind),
      appShellBudgetCriterion(),
      reviewerCriterion(kind),
    ];
  }
  if (kind === 'bug') {
    return [
      '- [ ] (mechanical) Regression test or gate proves the fix @gate:test',
      reviewerCriterion(kind),
    ];
  }
  if (kind === 'docs') {
    return [
      '- [ ] (mechanical) Docs/README structure checks pass @gate:test',
      reviewerCriterion(kind),
    ];
  }
  if (kind === 'onboarding') {
    return [
      '- [ ] (mechanical) `AGENTS.md` (or thin `CLAUDE.md` → AGENTS) exists as a map @gate:test',
      '- [ ] (mechanical) `WORKFLOW.md` has install/boot/gates; Layer-1 gates green @gate:test',
      reviewerCriterion(kind),
      '- [ ] (human) Set repo readiness to **ready** in Repos when the map is trustworthy',
    ];
  }
  if (kind === 'refactor') {
    return [
      '- [ ] (mechanical) Full gate suite green (no behavior change) @gate:test',
      reviewerCriterion(kind),
    ];
  }
  return [
    '- [ ] (mechanical) Implementation complete; gates green @gate:test',
    reviewerCriterion(kind),
  ];
}

/** Match first capture group or the whole match; trim and bound. */
function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text);
  if (!m) return null;
  const raw = (m[1] ?? m[0]).trim();
  if (raw.length === 0) return null;
  return raw.length > 48 ? `${raw.slice(0, 45)}…` : raw;
}

/**
 * Pure heuristics (zh + en) for the three clarification slots.
 * `where` = page/route/file/component/setting; `what` = observable change;
 * `doneWhen` = a check / acceptance cue.
 */
export function detectIntentSlots(intent: string): IntentSlots {
  const t = intent.trim();
  if (!t) return { where: null, what: null, doneWhen: null };

  // Explicit answers appended by the clarify UI: 「where: Tasks」 / where: …
  const explicitWhere = firstMatch(
    t,
    /(?:^|\n|「|\[)\s*where\s*[:：]\s*([^」\]\n]+)(?:」|\])?/i,
  );
  const explicitWhat = firstMatch(
    t,
    /(?:^|\n|「|\[)\s*what\s*[:：]\s*([^」\]\n]+)(?:」|\])?/i,
  );
  const explicitDone = firstMatch(
    t,
    /(?:^|\n|「|\[)\s*done_when\s*[:：]\s*([^」\]\n]+)(?:」|\])?/i,
  );

  const where =
    explicitWhere ??
    firstMatch(
      t,
      /\b(Tasks|Chat|Repos|Releases|Settings)\b/i,
    ) ??
    firstMatch(t, /(设置页|任务页|会话页|仓库页|发布页|登录页|首页|列表页|详情页|底栏|顶栏|导航)/) ??
    firstMatch(t, /(src\/[A-Za-z0-9_./-]+)/) ??
    firstMatch(t, /(https?:\/\/\S+)/i) ??
    firstMatch(t, /([A-Z][A-Za-z0-9]+(?:Panel|Form|Sheet|Page|View|Card|Button))/);

  const what =
    explicitWhat ??
    firstMatch(
      t,
      /((?:显示|隐藏|新增|去掉|删除|改成|改为|不再|替换|添加|增加|加一个|加个|加上|去除|支持|修复|修正|打开|关闭|启用|禁用)[^\n「]{0,32})/,
    ) ??
    firstMatch(
      t,
      /\b((?:should|must|add|remove|show|hide|fix|change|replace|enable|disable|update|create|delete)\b[^\n「]{0,40})/i,
    );

  const doneWhen =
    explicitDone ??
    firstMatch(
      t,
      /(@(?:gate|test|scenario|evidence)\s*:\s*\S+)/i,
    ) ??
    firstMatch(
      t,
      /((?:(?:测试|门禁|检查|验收|用例)\s*通过|通过\s*(?:测试|门禁|检查|验收)|断言|截图|录像|验收标准)[^\n「]{0,24})/,
    ) ??
    firstMatch(
      t,
      /\b((?:when\b[^\n]{0,40}\bthen\b[^\n]{0,40})|(?:assert|screenshot|recording|regression\s+tests?|tests?\s+(?:must\s+)?(?:pass|green)|gates?\s+green|must\s+pass)[^\n「]{0,24})/i,
    );

  return { where, what, doneWhen };
}

export function questionTextForSlot(slot: IntentSlot): string {
  return SLOT_QUESTION_TEXT[slot];
}

/** Infer clarification slot from analyst `question:` note text (default `what`). */
export function inferSlotFromQuestionText(text: string): IntentSlot {
  const t = text.toLowerCase();
  if (
    /where|哪个页面|哪页|哪个入口|哪[个里]面|页面|入口|screen|page|route|settings|tasks|chat|repos|releases|设置|任务页/.test(
      t,
    )
  ) {
    return 'where';
  }
  if (
    /done|完成|怎样算|怎么算|验收|测试|断言|截图|录像|@gate|@test|@scenario|when.+then|通过/.test(
      t,
    )
  ) {
    return 'done_when';
  }
  return 'what';
}

/**
 * Map analyst `question:` notes to IntentQuestion[] (≤ 3). Non-question notes
 * are ignored. Empty question bodies fall back to the slot's default zh text.
 */
export function questionsFromAnalystNotes(
  notes: readonly string[],
  repoKey: string,
): IntentQuestion[] {
  const out: IntentQuestion[] = [];
  const seen = new Set<IntentSlot>();
  for (const note of notes) {
    if (!note.toLowerCase().startsWith('question:')) continue;
    const text = note.slice(note.indexOf(':') + 1).trim();
    const slot = inferSlotFromQuestionText(text);
    if (seen.has(slot)) continue;
    seen.add(slot);
    const qText = text.length > 0 ? text : SLOT_QUESTION_TEXT[slot];
    if (slot === 'where' && repoKey === 'hercules') {
      out.push({ slot, text: qText, options: [...HERCULES_WHERE_OPTIONS] });
    } else {
      out.push({ slot, text: qText });
    }
    if (out.length >= 3) break;
  }
  return out;
}

/** Filled summaries from a drafted body that already carries bindings. */
export function filledFromBoundBody(body: string): string[] {
  const filled: string[] = [];
  if (/@gate\s*:/i.test(body)) filled.push('已补验收标准：门禁绿 @gate:test');
  else if (/@test\s*:/i.test(body)) filled.push('已补验收标准：绑定 @test');
  else if (/@scenario\s*:/i.test(body)) filled.push('已补验收标准：绑定 @scenario');
  else if (/@evidence\s*:/i.test(body)) filled.push('已补验收标准：绑定 @evidence');
  else if (/\(human\)/i.test(body) && /data-evidence|截图|录像|手机/.test(body)) {
    filled.push('已补验收标准：人工证据项');
  }
  return filled;
}

/**
 * ONE question per missing slot. `where` offers Hercules SPA surfaces when
 * `repoKey === 'hercules'`; other repos get free-text only.
 */
export function questionsForMissingSlots(
  slots: IntentSlots,
  repoKey: string,
): IntentQuestion[] {
  const out: IntentQuestion[] = [];
  if (slots.where === null) {
    const q: IntentQuestion =
      repoKey === 'hercules'
        ? {
            slot: 'where',
            text: SLOT_QUESTION_TEXT.where,
            options: [...HERCULES_WHERE_OPTIONS],
          }
        : { slot: 'where', text: SLOT_QUESTION_TEXT.where };
    out.push(q);
  }
  if (slots.what === null) {
    out.push({ slot: 'what', text: SLOT_QUESTION_TEXT.what });
  }
  if (slots.doneWhen === null) {
    out.push({ slot: 'done_when', text: SLOT_QUESTION_TEXT.done_when });
  }
  return out;
}

/** Summaries of what the heuristic drafter filled into the plan. */
export function filledSummariesForDraft(input: {
  readonly slots: IntentSlots;
  readonly kind: FeatureKind;
  readonly body: string;
}): string[] {
  const filled: string[] = [];
  if (input.slots.where) filled.push(`已识别位置：${input.slots.where}`);
  if (input.slots.what) filled.push(`已识别改动：${input.slots.what}`);
  if (input.slots.doneWhen) filled.push(`已识别完成条件：${input.slots.doneWhen}`);
  if (/@gate\s*:/i.test(input.body)) {
    filled.push('已补验收标准：门禁绿 @gate:test');
  } else if (/@(?:test|scenario|evidence)\s*:/i.test(input.body)) {
    filled.push('已补验收标准：绑定测试／证据');
  }
  if (isUiFeature(input.kind) && /##\s*Evidence/i.test(input.body)) {
    filled.push('已补 Evidence 模板');
  }
  return filled;
}

/**
 * Build a typed DoD + task body from free-form intent.
 */
export function draftTaskFromIntent(intent: string, repoKey: string): IntentDraft {
  const raw = intent.trim();
  const warnings: string[] = [];
  const slots = detectIntentSlots(raw);
  const questions = questionsForMissingSlots(slots, repoKey);

  if (!raw) {
    const emptyTitle = 'Untitled task';
    const emptySlug = shortSlug(emptyTitle);
    return {
      title: emptyTitle,
      ...(emptySlug ? { slug: emptySlug } : {}),
      body: [
        '## Task',
        '(empty intent)',
        '',
        '## Definition of Done',
        '- [ ] (human) Clarify what to build',
      ].join('\n'),
      priority: 100,
      labels: ['needs-plan'],
      vague: true,
      warnings: ['Empty intent'],
      questions,
      filled: [],
    };
  }

  const kind = classifyFeature(raw);
  const title = firstLineTitle(raw);
  const criteria = criteriaFor(kind);
  const evidence = isUiFeature(kind) ? evidenceMarkdownForFeature(kind) : '';
  const priority = priorityFor(kind);
  const labels: string[] = ['needs-plan'];
  const lab = labelFor(kind);
  if (lab) labels.push(lab);
  if (kind === 'onboarding') labels.push('onboarding', 'readiness');

  const notes: string[] = [
    '- Generated from human intent — edit DoD before **Approve plan**.',
    '- Untyped criteria are treated as human; prefer (mechanical|reviewer|human) tags.',
    `- Feature kind: \`${kind}\` (drives Evidence template).`,
  ];

  let body = [
    '## Task',
    raw,
    '',
    `## Repo`,
    repoKey,
    '',
    '## Definition of Done',
    ...criteria,
    evidence,
    '',
    '## Notes',
    ...notes,
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  // If UI-language human ACs exist without ## Evidence, surface a draft reminder
  // (e.g. generic/non-UI kind that still got a "点开…看到" human line, or a
  // future path that omits the Evidence template). Soft — not a dispatch block.
  if (needsUiEvidenceReminder(body)) {
    warnings.push(UI_AC_EVIDENCE_REMINDER);
    body = `${body}\n- ${UI_AC_EVIDENCE_REMINDER}`;
  }

  const filled = filledSummariesForDraft({ slots, kind, body });
  const slug = shortSlug(title);
  return {
    title,
    ...(slug ? { slug } : {}),
    body,
    priority,
    labels,
    vague: questions.length > 0,
    warnings,
    questions,
    filled,
  };
}
