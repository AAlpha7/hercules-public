import type { JSX } from 'react';
import { Disclosure, type DisclosureTone } from './Disclosure.js';
import { Markdown } from './Markdown.js';
import { stripDecisionCardBlocks } from '../domain/decisionCard.js';
import {
  antiCheatBadge,
  antiCheatSectionTone,
  bodyHasPriorRunFailures,
  bodyHasReviewPacket,
  bodyHasSuccessfulPacket,
  isPriorAuditTitle,
  isSteerTrail,
  partitionSectionsForDisplay,
  sectionDefaultOpen,
  splitTaskBody,
  type BodySection,
  type SectionOpenContext,
} from './taskBodySplit.js';

export {
  packetCostChip,
  packetStatusChip,
  parseHumanCriteria,
  areHumanCriteriaChecked,
  isVerificationInfraFailure,
  thrashBrakeStillActive,
  splitTaskBody,
  bodyHasReviewPacket,
  bodyHasPriorRunFailures,
  bodyHasSuccessfulPacket,
  extractEvidenceMedia,
  buildCredibilityChips,
  evidenceEmptyNote,
  extractAgentReport,
  latestReviewPacketSlice,
  packetProvenance,
  packetScanText,
} from './taskBodySplit.js';

export {
  countDodCriteria,
  extractTaskSummary,
  formatDodChip,
} from '../domain/taskBrief.js';

function toneFor(
  section: BodySection,
  ctx: { hasReviewPacket: boolean; hasSuccessfulPacket: boolean; isPrior: boolean },
): DisclosureTone {
  const t = section.title.toLowerCase();
  if (t.includes('definition of done') || t.includes('gates')) return 'accent';
  if (t.includes('evidence matrix')) return 'accent';
  if (t.startsWith('reviewer') || t === 'l3 report') return 'success';
  if (t.includes('self-assessment')) return 'muted';
  if (t.startsWith('steer result')) return 'success';
  if (t.startsWith('human steer')) return 'steer';
  if (t.includes('cost (steer') || t === 'cost (steer resume)') return 'steer';
  if (t.includes('cost (full') || t.includes('cost (full implementer)')) return 'full';
  if (t.startsWith('cost')) return 'warn';
  if (t.includes('anti-cheat')) return antiCheatSectionTone(section.text);

  // Prior audit under a green (or any) packet: muted archive.
  if (ctx.isPrior || (ctx.hasSuccessfulPacket && isPriorAuditTitle(section.title))) {
    return 'muted';
  }
  if (t.startsWith('auto-rework')) return 'warn';
  if (
    t.startsWith('run failure') ||
    t.startsWith('merge failure') ||
    t.startsWith('run timeline') ||
    t.startsWith('salvage brief') ||
    t.startsWith('thrash brake')
  ) {
    return 'danger';
  }
  if (t.startsWith('clean salvage provenance')) return 'accent';
  if (t.includes('cli behavioral evidence')) {
    if (/not-run|\bSKIP\b/i.test(section.text)) return 'muted';
    if (/\bFAIL\b|\bfailed\b/i.test(section.text)) return 'danger';
    return 'success';
  }
  if (t.includes('behavioral evidence')) return 'success';
  if (section.kind === 'harness' || t.includes('system recovery')) return 'muted';
  if (section.kind === 'evidence') return 'muted';
  return 'default';
}

function badgeFor(
  section: BodySection,
  ctx: { hasReviewPacket: boolean; hasSuccessfulPacket: boolean; isPrior: boolean },
): string | undefined {
  const t = section.title.toLowerCase();
  if (ctx.isPrior || (ctx.hasSuccessfulPacket && isPriorAuditTitle(section.title))) {
    return 'prior attempt';
  }
  if (section.kind === 'harness' || t.includes('system recovery')) return 'harness';
  if (
    t.startsWith('run failure') ||
    t.startsWith('merge failure') ||
    t.startsWith('run timeline') ||
    t.startsWith('salvage brief') ||
    t.startsWith('thrash brake')
  ) {
    return t.startsWith('run timeline') ? 'timeline' : 'crash';
  }
  if (t.startsWith('auto-rework')) return 'rework';
  if (t.startsWith('steer result')) return 'reply';
  if (t.startsWith('human steer')) return 'you asked';
  if (t.includes('cost (steer')) return 'steer';
  if (t.includes('cost (full')) return 'full run';
  if (t.includes('anti-cheat')) return antiCheatBadge(section.text);
  if (t.includes('evidence matrix')) {
    const rows = section.text.split('\n').filter((l) => l.includes('|')).length;
    return rows > 2 ? `${Math.max(0, rows - 2)} rows` : undefined;
  }
  if (t.includes('cli behavioral evidence')) {
    if (/not-run|\bSKIP\b/i.test(section.text)) return 'not run';
    if (/\bFAIL\b|\bfailed\b/i.test(section.text)) return 'failed';
    if (/\bOK\b|\bpassed\b/i.test(section.text)) return 'passed';
  }
  if (section.kind === 'evidence') {
    const n = section.text.split('\n').filter((l) => l.trim()).length;
    return n > 3 ? `${n} lines` : undefined;
  }
  if (/diff/i.test(section.title)) return 'code';
  return undefined;
}

function renderSection(
  s: BodySection,
  ctx: {
    hasReviewPacket: boolean;
    hasSuccessfulPacket: boolean;
    isPrior: boolean;
    openCtx: SectionOpenContext;
  },
): JSX.Element {
  const disclosure = (
    <Disclosure
      key={s.key}
      title={s.title}
      tone={toneFor(s, ctx)}
      defaultOpen={sectionDefaultOpen(s, ctx.openCtx)}
      badge={badgeFor(s, ctx)}
    >
      <div className="disc-md">
        <Markdown text={s.text} />
      </div>
    </Disclosure>
  );
  if (s.title.toLowerCase().includes('cli behavioral evidence')) {
    return (
      <div key={s.key} data-evidence="cli-evidence-receipt">
        {disclosure}
      </div>
    );
  }
  if (s.title.toLowerCase() === 'l3 report') {
    return (
      <div key={s.key} data-evidence="l3-report">
        {disclosure}
      </div>
    );
  }
  return disclosure;
}

/** Render task body with collapsible evidence hierarchy for the detail sheet. */
export function TaskBodyView({
  body,
  packetNonce,
}: {
  readonly body: string;
  /** Hercules-owned packet nonce from the task DTO when available. */
  readonly packetNonce?: string | null;
}): JSX.Element {
  // Machine blocks (structured decision card) are for the Decide panel, not prose.
  const raw = stripDecisionCardBlocks(body || '');
  const packetOpts = { nonce: packetNonce ?? null };
  const { brief, sections } = splitTaskBody(raw);
  const hasPacket = bodyHasReviewPacket(raw);
  const success = bodyHasSuccessfulPacket(raw, packetOpts);
  const hasPrior = bodyHasPriorRunFailures(raw, packetOpts);
  const { live, prior } = partitionSectionsForDisplay(sections, {
    hasReviewPacket: hasPacket,
    hasSuccessfulPacket: success,
  });

  // Steer index among live sections only (older RC turns stay collapsed).
  const steerTitles = live.filter((s) => isSteerTrail(s.title));
  const steerCount = steerTitles.length;
  const steerIndexByKey = new Map<string, number>();
  let si = 0;
  for (const s of live) {
    if (isSteerTrail(s.title)) {
      steerIndexByKey.set(s.key, si);
      si += 1;
    }
  }

  const baseOpen: SectionOpenContext = {
    hasReviewPacket: hasPacket,
    hasSuccessfulPacket: success,
  };

  if (!brief && sections.length === 0) {
    return (
      <div className="body body-empty">
        <Markdown text="_(no description)_" />
      </div>
    );
  }

  return (
    <div className="task-body-stack">
      {brief ? (
        <div className="body body-brief">
          <div className="body-label">Task</div>
          <Markdown text={brief} />
        </div>
      ) : null}

      {hasPacket && hasPrior ? (
        <div className="banner banner-muted" data-evidence="prior-run-failures">
          <strong>Earlier failures / reworks are historical.</strong> Judge the{' '}
          <em>Review packet</em> below; prior attempts are collapsed for audit.
        </div>
      ) : null}

      {live.length > 0 ? (
        <div className="body-sections">
          <div className="body-label">Verification & evidence</div>
          {groupSteerTrail(live).map((group) =>
            group.kind === 'pair' ? (
              <div key={group.key} className="steer-pair">
                <div className="steer-pair-label">Remote Control turn</div>
                {group.sections.map((s) =>
                  renderSection(s, {
                    hasReviewPacket: hasPacket,
                    hasSuccessfulPacket: success,
                    isPrior: false,
                    openCtx: {
                      ...baseOpen,
                      steerIndex: steerIndexByKey.get(s.key) ?? 0,
                      steerCount,
                    },
                  }),
                )}
              </div>
            ) : (
              group.sections.map((s) =>
                renderSection(s, {
                  hasReviewPacket: hasPacket,
                  hasSuccessfulPacket: success,
                  isPrior: false,
                  openCtx: {
                    ...baseOpen,
                    steerIndex: steerIndexByKey.get(s.key) ?? 0,
                    steerCount,
                  },
                }),
              )
            ),
          )}
        </div>
      ) : null}

      {prior.length > 0 ? (
        <div className="body-sections body-sections-prior">
          <div className="body-label">Prior attempts (audit)</div>
          {prior.map((s) =>
            renderSection(s, {
              hasReviewPacket: hasPacket,
              hasSuccessfulPacket: success,
              isPrior: true,
              openCtx: { ...baseOpen, hasReviewPacket: true, hasSuccessfulPacket: true },
            }),
          )}
        </div>
      ) : null}
    </div>
  );
}

export type { BodySection };

/**
 * Group consecutive Human steer + Steer result sections so the phone UI shows
 * "you asked → agent replied" as one turn (instead of disconnected trail dumps).
 */
function groupSteerTrail(
  sections: readonly BodySection[],
): Array<
  | { kind: 'single'; key: string; sections: BodySection[] }
  | { kind: 'pair'; key: string; sections: BodySection[] }
> {
  const out: Array<
    | { kind: 'single'; key: string; sections: BodySection[] }
    | { kind: 'pair'; key: string; sections: BodySection[] }
  > = [];
  let i = 0;
  while (i < sections.length) {
    const s = sections[i]!;
    const t = s.title.toLowerCase();
    const next = sections[i + 1];
    const nextT = next?.title.toLowerCase() ?? '';
    if (t.startsWith('human steer') && next && nextT.startsWith('steer result')) {
      out.push({ kind: 'pair', key: `pair-${s.key}`, sections: [s, next] });
      i += 2;
      continue;
    }
    if (t.startsWith('steer result') || t.startsWith('human steer')) {
      out.push({ kind: 'pair', key: `pair-${s.key}`, sections: [s] });
      i += 1;
      continue;
    }
    out.push({ kind: 'single', key: s.key, sections: [s] });
    i += 1;
  }
  return out;
}
