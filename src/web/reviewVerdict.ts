/**
 * Operator-first review verdict — one headline + one action + only the items
 * that need a human. Pure: no IO / React / DOM.
 */
import type { DecisionCard } from '../domain/decisionCard.js';
import { formatCliEvidenceCell } from '../domain/uiAcEvidence.js';
import { failingGatesZh } from './decideCard.js';
import type { EvidenceMedia } from './taskBodySplit.js';

export type ReviewPrimaryActionKind =
  | 'approve'
  | 'watch_then_approve'
  | 'confirm_items'
  | 'reverify'
  | 'reject_or_override'
  | 'wait';

export type ReviewNeedsYouKind = 'human' | 'unverified' | 'override';

export type ReviewNeedsYouEvidenceKind = 'video' | 'image' | 'cli' | 'l2';

export interface ReviewNeedsYouEvidence {
  readonly kind: ReviewNeedsYouEvidenceKind;
  readonly label: string;
  readonly mediaIndex?: number;
}

export interface ReviewNeedsYouItem {
  readonly id: string;
  readonly kind: ReviewNeedsYouKind;
  readonly text: string;
  readonly why: string;
  readonly recommendation: string;
  readonly evidence?: ReviewNeedsYouEvidence;
}

export interface ReviewVerdictAction {
  readonly kind: ReviewPrimaryActionKind;
  readonly label: string;
}

export interface ReviewVerdict {
  readonly headline: string;
  readonly action: ReviewVerdictAction;
  readonly needsYou: readonly ReviewNeedsYouItem[];
}

export interface ReviewHumanAc {
  readonly id: string;
  readonly text: string;
}

export interface BuildReviewVerdictInput {
  readonly task: { readonly body: string; readonly state?: string };
  readonly decisionCard: DecisionCard | null;
  readonly autoOk: boolean;
  readonly verifyCrashed: boolean;
  readonly humanACs: readonly ReviewHumanAc[];
  readonly media: readonly EvidenceMedia[];
  /** Texts that are after-deploy only (never block Approve). */
  readonly afterDeployTexts?: readonly string[];
  /** UI language; default zh keeps existing copy. */
  readonly lang?: 'en' | 'zh';
}

const VIDEO_LANG_RE = /video|recording|录像|录屏|视频|screen\s*recording/i;
const IMAGE_LANG_RE = /screenshot|截图/i;
const CLI_CELL_RE = /CLI 步骤\s+(\S+)\s+✓\s*·\s*(\d+)\s*张截图\s*·\s*(\d+)\s*段录像/;

function truncateOneSentence(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function plainFailReason(
  body: string,
  card: DecisionCard | null,
): string {
  const fails = failingGatesZh(body);
  if (fails.length > 0) {
    const first = fails[0]!;
    return truncateOneSentence(`${first.nameZh}${first.reasonZh ? ` — ${first.reasonZh}` : ''}`);
  }
  if (card) {
    const badGate = card.gates.find((g) => !g.outcome && !g.passed);
    if (badGate) {
      return truncateOneSentence(
        `${badGate.name}${badGate.reason ? ` — ${badGate.reason}` : ' 未通过'}`,
      );
    }
    if (card.evidence.ran && card.evidence.ok === false) {
      return '浏览器证据未通过';
    }
    if (card.reviewer.ran && card.reviewer.approved === false) {
      return '独立审稿未通过';
    }
  }
  return '自动证明未完成';
}

function findMediaIndex(
  media: readonly EvidenceMedia[],
  kind: 'video' | 'image',
  hint?: string,
): number | undefined {
  if (media.length === 0) return undefined;
  const hintLower = hint?.toLowerCase();
  if (hintLower) {
    const byHint = media.findIndex(
      (m) =>
        m.kind === kind &&
        (m.name.toLowerCase().includes(hintLower) ||
          m.label.toLowerCase().includes(hintLower)),
    );
    if (byHint >= 0) return byHint;
  }
  const first = media.findIndex((m) => m.kind === kind);
  return first >= 0 ? first : undefined;
}

function evidenceForHuman(
  text: string,
  card: DecisionCard | null,
  media: readonly EvidenceMedia[],
): ReviewNeedsYouEvidence | undefined {
  const fromCard = card?.criteria.find(
    (c) => (c.kind === 'human' || c.kind === 'checkpoint') && c.text === text,
  );
  const why = fromCard?.why ?? '';
  const cli = CLI_CELL_RE.exec(why);
  if (cli) {
    const stepId = cli[1]!;
    const videoCount = Number(cli[3] ?? 0);
    const imageCount = Number(cli[2] ?? 0);
    if (videoCount > 0) {
      const mediaIndex = findMediaIndex(media, 'video', stepId);
      return {
        kind: 'video',
        label: formatCliEvidenceCell({
          stepId,
          imageCount,
          videoCount,
        }),
        ...(mediaIndex !== undefined ? { mediaIndex } : {}),
      };
    }
    if (imageCount > 0) {
      const mediaIndex = findMediaIndex(media, 'image', stepId);
      return {
        kind: 'image',
        label: formatCliEvidenceCell({
          stepId,
          imageCount,
          videoCount,
        }),
        ...(mediaIndex !== undefined ? { mediaIndex } : {}),
      };
    }
    return {
      kind: 'cli',
      label: formatCliEvidenceCell({ stepId, imageCount, videoCount }),
    };
  }

  if (VIDEO_LANG_RE.test(text) || VIDEO_LANG_RE.test(why)) {
    const mediaIndex = findMediaIndex(media, 'video');
    if (mediaIndex !== undefined) {
      return { kind: 'video', label: media[mediaIndex]!.label || '录像', mediaIndex };
    }
    // Still prefer video recommendation even without a tile.
    return { kind: 'video', label: '录像' };
  }
  if (IMAGE_LANG_RE.test(text) || IMAGE_LANG_RE.test(why)) {
    const mediaIndex = findMediaIndex(media, 'image');
    if (mediaIndex !== undefined) {
      return { kind: 'image', label: media[mediaIndex]!.label || '截图', mediaIndex };
    }
    return { kind: 'image', label: '截图' };
  }
  return undefined;
}

function recommendationForHuman(
  _text: string,
  evidence: ReviewNeedsYouEvidence | undefined,
  afterDeploy: boolean,
  unproven: boolean,
): string {
  if (afterDeploy || unproven) {
    return '无法在部署前核验，部署后再看';
  }
  if (evidence?.kind === 'video') return '看完录像后勾选并批准';
  if (evidence?.kind === 'image' || evidence?.kind === 'l2') {
    return '打开截图确认后勾选';
  }
  if (evidence?.kind === 'cli') return '打开截图确认后勾选';
  return '确认后勾选并批准';
}

function whyForHuman(text: string, card: DecisionCard | null): string {
  const fromCard = card?.criteria.find(
    (c) => (c.kind === 'human' || c.kind === 'checkpoint') && c.text === text,
  );
  const detail = (fromCard?.how ?? fromCard?.why ?? text).trim();
  const core = detail.length > 0 ? detail : text;
  return `这项只有人能判断：${truncateOneSentence(core, 72)}`;
}

/**
 * Build the operator-facing review verdict for a review-state task sheet.
 */
export function buildReviewVerdict(input: BuildReviewVerdictInput): ReviewVerdict {
  const {
    task,
    decisionCard,
    autoOk,
    verifyCrashed,
    humanACs,
    media,
    afterDeployTexts = [],
  } = input;
  const afterDeploySet = new Set(afterDeployTexts);
  const humanNeedsForOverride: ReviewNeedsYouItem[] = humanACs.map((ac) => {
    const fromCard = decisionCard?.criteria.find(
      (c) => (c.kind === 'human' || c.kind === 'checkpoint') && c.text === ac.text,
    );
    const afterDeploy = afterDeploySet.has(ac.text);
    const unproven = Boolean(fromCard?.unprovenUiWarning);
    const evidence = evidenceForHuman(ac.text, decisionCard, media);
    return {
      id: ac.id,
      kind: 'human' as const,
      text: ac.text,
      why: whyForHuman(ac.text, decisionCard),
      recommendation: recommendationForHuman(ac.text, evidence, afterDeploy, unproven),
      ...(evidence ? { evidence } : {}),
    };
  });

  if (verifyCrashed) {
    return {
      headline: '验证未能运行（环境问题），请 Re-verify。',
      action: { kind: 'reverify', label: 'Re-verify' },
      needsYou: [
        {
          id: 'override-env',
          kind: 'override',
          text: '验证环境失败',
          why: '这次没有产出可审核的证明包（工作树或验证进程异常）。',
          recommendation: '先 Re-verify；若仍失败再打回或覆盖批准',
        },
        ...humanNeedsForOverride,
      ],
    };
  }

  if (!autoOk) {
    const reason = plainFailReason(task.body, decisionCard);
    const failedNeeds: ReviewNeedsYouItem[] = [];
    const gateFails = failingGatesZh(task.body);
    for (const g of gateFails) {
      failedNeeds.push({
        id: `gate-${g.name}`,
        kind: 'override',
        text: g.nameZh,
        why: g.reasonZh || '该项机器检查未通过',
        recommendation: '建议打回让 agent 修复，或确认无害后覆盖批准',
      });
    }
    if (failedNeeds.length === 0 && decisionCard) {
      for (const c of decisionCard.criteria) {
        if (c.status !== 'fail') continue;
        failedNeeds.push({
          id: `crit-fail-${c.text.slice(0, 24)}`,
          kind: 'override',
          text: c.text,
          why: c.why || '未满足',
          recommendation: '建议打回或覆盖批准',
        });
      }
    }
    if (failedNeeds.length === 0) {
      failedNeeds.push({
        id: 'auto-incomplete',
        kind: 'override',
        text: '机器证明未完成',
        why: reason,
        recommendation: '建议打回或 Re-verify',
      });
    }
    return {
      headline: `机器检查未通过：${reason}。建议打回或 Re-verify。`,
      action: { kind: 'reject_or_override', label: '打回' },
      needsYou: [...failedNeeds, ...humanNeedsForOverride],
    };
  }

  // Green machine packet.
  const unverified = decisionCard?.unverifiedCriteria ?? [];
  const humanNeeds: ReviewNeedsYouItem[] = humanACs.map((ac) => {
    const fromCard = decisionCard?.criteria.find(
      (c) => (c.kind === 'human' || c.kind === 'checkpoint') && c.text === ac.text,
    );
    const afterDeploy = afterDeploySet.has(ac.text);
    const unproven = Boolean(fromCard?.unprovenUiWarning);
    const evidence = evidenceForHuman(ac.text, decisionCard, media);
    const item: ReviewNeedsYouItem = {
      id: ac.id,
      kind: 'human',
      text: ac.text,
      why: whyForHuman(ac.text, decisionCard),
      recommendation: recommendationForHuman(ac.text, evidence, afterDeploy, unproven),
      ...(evidence ? { evidence } : {}),
    };
    return item;
  });

  const unverifiedNeeds: ReviewNeedsYouItem[] = unverified.map((u, i) => ({
    id: `unverified-${i}`,
    kind: 'unverified' as const,
    text: u.text,
    why: u.warning,
    recommendation: input.lang === 'en' ? 'Confirm, then approve' : '确认后可直接批准',
  }));

  const needsYou = [...humanNeeds, ...unverifiedNeeds];
  const hasVideoLink = humanNeeds.some((n) => n.evidence?.kind === 'video');

  const en = input.lang === 'en';

  if (needsYou.length === 0) {
    return {
      headline: en
        ? 'All machine checks passed — ready to approve.'
        : '机器检查全部通过，可以批准。',
      action: { kind: 'approve', label: en ? 'Approve' : '批准' },
      needsYou: [],
    };
  }

  const parts: string[] = [
    en ? 'All machine checks passed.' : '机器检查全部通过。',
  ];
  if (humanNeeds.length > 0) {
    parts.push(
      hasVideoLink
        ? en
          ? ' Watch the recording, then approve.'
          : '请看录像后批准。'
        : en
          ? ` Confirm ${humanNeeds.length} item(s), then approve.`
          : `请确认 ${humanNeeds.length} 项后批准。`,
    );
  }
  if (unverifiedNeeds.length > 0) {
    parts.push(
      en
        ? ` ${unverifiedNeeds.length} item(s) could not be auto-verified — please confirm.`
        : `其中 ${unverifiedNeeds.length} 项无法自动核验，请你确认。`,
    );
  }

  return {
    headline: parts.join(''),
    action: {
      kind: hasVideoLink && humanNeeds.length > 0 ? 'watch_then_approve' : 'confirm_items',
      label: hasVideoLink
        ? en
          ? 'Watch then approve'
          : '看录像后批准'
        : en
          ? 'Confirm then approve'
          : '确认后批准',
    },
    needsYou,
  };
}

/** Short disabled reason when human checkboxes block the primary CTA. */
export function reviewPrimaryDisabledReason(opts: {
  readonly actionKind: ReviewPrimaryActionKind;
  readonly humanAllChecked: boolean;
  readonly approveBlocked: boolean;
  readonly verifyCrashed: boolean;
  readonly autoOk: boolean;
  readonly lang?: 'en' | 'zh';
}): string | null {
  const en = opts.lang !== 'zh';
  if (!opts.approveBlocked) return null;
  if (
    (opts.actionKind === 'approve' ||
      opts.actionKind === 'watch_then_approve' ||
      opts.actionKind === 'confirm_items') &&
    !opts.humanAllChecked
  ) {
    return en ? 'Check human items first' : '先勾选人工项';
  }
  if (opts.verifyCrashed) return en ? 'Re-verify first' : '请先 Re-verify';
  if (!opts.autoOk) return en ? 'Machine checks not green' : '机器未全绿';
  return en ? 'Cannot approve yet' : '暂不可批准';
}
