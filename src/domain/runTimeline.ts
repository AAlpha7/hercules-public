/**
 * Domain — structured run timeline for phone diagnosis without SSH.
 *
 * Case study: orbit-class onboard failures (stall / provision / agent_exit)
 * left only `state: failed` or a free-form mini-packet; humans could not see
 * where the run died. Timeline reuses activity log lines + failure/packet
 * signals — no external observability stack.
 *
 * Pure: build, render, parse, resolve. Orchestrator appends the section;
 * UI derives events for display (explicit section preferred, else from body).
 */
import {
  parseLatestRunFailure,
  type RunFailureKind,
} from './runFailure.js';

/** Structured lifecycle kinds (task: dispatch→gates→packet + onboard deaths). */
export type RunTimelineKind =
  | 'dispatch'
  | 'agent_activity'
  | 'stall'
  | 'provision'
  | 'agent_exit'
  | 'l1'
  | 'l2'
  | 'l3'
  | 'packet_finalize'
  /** Mirror branch policy: skip-rewind / not-propagated (2026-07-30 clobber). */
  | 'mirror';

export interface RunTimelineEvent {
  readonly at: string;
  readonly kind: RunTimelineKind;
  readonly summary: string;
  readonly detail?: string;
  /** true = ok, false = fail/error, undefined = neutral milestone */
  readonly ok?: boolean;
}

/** Case-folded heading prefix — mirror parseLatestRunFailure lastIndexOf. */
const TIMELINE_HEADING_PREFIX = '## run timeline';
const EVENT_LINE =
  /^-\s+`([^`]+)`\s+\*\*([a-z0-9_]+)\*\*(?:\s+(✅|❌))?\s*[—-]\s*(.+?)(?:\s*\|\s*(.+))?$/;

/** Max agent_activity rows kept on the timeline (activity log may be long). */
export const TIMELINE_ACTIVITY_CAP = 5;

const KIND_SET: ReadonlySet<string> = new Set([
  'dispatch',
  'agent_activity',
  'stall',
  'provision',
  'agent_exit',
  'l1',
  'l2',
  'l3',
  'packet_finalize',
  'mirror',
]);

function isKind(s: string): s is RunTimelineKind {
  return KIND_SET.has(s);
}

function cleanLine(s: string): string {
  return s.trim().replace(/\s+/g, ' ').slice(0, 200);
}

/** Pick a short, high-signal tail of activity lines for the timeline. */
export function activityMilestones(
  activityTail: readonly string[] | undefined,
  at: string,
): RunTimelineEvent[] {
  const raw = (activityTail ?? [])
    .map((l) => cleanLine(l))
    .filter((l) => l.length > 0);
  if (raw.length === 0) return [];
  // Prefer last N unique-ish lines (drop pure duplicates).
  const picked: string[] = [];
  for (let i = raw.length - 1; i >= 0 && picked.length < TIMELINE_ACTIVITY_CAP; i--) {
    const line = raw[i]!;
    if (picked.includes(line)) continue;
    // Skip lines that are pure stall/provision terminal markers — those become
    // dedicated terminal events.
    if (/^stall\b/i.test(line) || /^provision error\b/i.test(line)) continue;
    picked.unshift(line);
  }
  return picked.map((summary) => ({
    at,
    kind: 'agent_activity' as const,
    summary,
  }));
}

export interface OnboardFailureTimelineInput {
  readonly stamp: string;
  readonly kind: RunFailureKind;
  readonly startedAt?: string | null;
  readonly adapter?: string;
  readonly activityTail?: readonly string[];
  readonly exitCode?: number | null;
  readonly exitSignal?: string | null;
  /** One-line death cause (e.g. xAI 502 mid-stream) — preferred over bare exit. */
  readonly deathCause?: string;
  /** Extra terminal detail (e.g. stall reason already in activity). */
  readonly detail?: string;
  /**
   * Adapter failover note from dispatch (e.g. "adapter 降级: grok 不健康…").
   * Attached as dispatch event detail so phone timeline shows the switch.
   */
  readonly failoverNote?: string;
}

/**
 * Timeline for runs that die before / without a review packet
 * (provision, stall, agent_exit).
 */
export function buildOnboardFailureTimeline(
  input: OnboardFailureTimelineInput,
): RunTimelineEvent[] {
  const stamp = input.stamp;
  const start = input.startedAt?.trim() || stamp;
  const events: RunTimelineEvent[] = [];

  const adapterBit = input.adapter?.trim()
    ? ` adapter \`${input.adapter.trim()}\``
    : '';
  const failoverDetail = input.failoverNote?.trim()
    ? cleanLine(input.failoverNote)
    : undefined;
  events.push({
    at: start,
    kind: 'dispatch',
    summary:
      input.kind === 'provision'
        ? `dispatch attempted${adapterBit}`
        : `dispatched${adapterBit}`,
    ...(failoverDetail ? { detail: failoverDetail } : {}),
  });

  // Provision dies before the agent — no activity milestones.
  if (input.kind !== 'provision') {
    events.push(...activityMilestones(input.activityTail, stamp));
  }

  if (input.kind === 'provision') {
    const fromActivity = (input.activityTail ?? [])
      .map((l) => cleanLine(l))
      .find((l) => /provision/i.test(l));
    const summary =
      fromActivity ??
      cleanLine(input.detail ?? 'worktree / repo provisioning failed');
    events.push({
      at: stamp,
      kind: 'provision',
      summary,
      ok: false,
      ...(input.detail ? { detail: cleanLine(input.detail) } : {}),
    });
    return events;
  }

  if (input.kind === 'stall') {
    const fromActivity = (input.activityTail ?? [])
      .map((l) => cleanLine(l))
      .reverse()
      .find((l) => /stall|max.?run|hard.?kill|timeout/i.test(l));
    events.push({
      at: stamp,
      kind: 'stall',
      summary: fromActivity ?? cleanLine(input.detail ?? 'stalled — no agent events'),
      ok: false,
      ...(input.detail ? { detail: cleanLine(input.detail) } : {}),
    });
    return events;
  }

  // agent_exit — prefer explicit deathCause over bare "exit unknown".
  const cause = input.deathCause?.trim();
  const fromActivity = (input.activityTail ?? [])
    .map((l) => cleanLine(l))
    .reverse()
    .find((l) => /error|exit|crash|fail/i.test(l));
  const exitBits: string[] = [];
  if (input.exitCode !== undefined && input.exitCode !== null) {
    exitBits.push(`exit ${input.exitCode}`);
  } else if (input.exitCode === null && !input.exitSignal) {
    // Only mention unknown when we have no signal either.
    exitBits.push('exit code unknown');
  }
  if (input.exitSignal?.trim()) {
    exitBits.push(`signal ${input.exitSignal.trim()}`);
  }
  const summary =
    (cause && cause.length > 0 ? cause : undefined) ??
    fromActivity ??
    'agent exited without done event';
  events.push({
    at: stamp,
    kind: 'agent_exit',
    summary,
    ok: false,
    ...(exitBits.length > 0 || input.detail
      ? {
          detail: cleanLine(
            [...exitBits, input.detail].filter(Boolean).join(' · '),
          ),
        }
      : {}),
  });
  return events;
}

export interface VerifyTimelineInput {
  readonly stamp: string;
  readonly startedAt?: string | null;
  readonly adapter?: string;
  readonly activityTail?: readonly string[];
  /** Adapter failover note from dispatch — dispatch event detail. */
  readonly failoverNote?: string;
  readonly gates: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly output: string;
  }[];
  readonly evidenceRun?: { readonly ok: boolean } | undefined;
  readonly reviewerRan?: boolean;
  readonly reviewerVerdict?: {
    readonly approved: boolean;
    readonly summary: string;
  } | null;
  readonly reviewerSkipReason?: string | null;
  readonly green: boolean;
  readonly autoRework: boolean;
}

function isL1Gate(name: string): boolean {
  const n = name.toLowerCase();
  // Synthetic / non-L1 axes
  return (
    n !== 'behavioral' &&
    n !== 'delivery' &&
    n !== 'report-hygiene' &&
    !n.startsWith('hercules:') &&
    n !== 'anti-cheat' &&
    n !== 'pr-mergeable'
  );
}

/**
 * Timeline after agent done + verify: dispatch → activity → L1/L2/L3 → packet.
 */
export function buildVerifyTimeline(input: VerifyTimelineInput): RunTimelineEvent[] {
  const stamp = input.stamp;
  const start = input.startedAt?.trim() || stamp;
  const events: RunTimelineEvent[] = [];

  const adapterBit = input.adapter?.trim()
    ? ` adapter \`${input.adapter.trim()}\``
    : '';
  const failoverDetail = input.failoverNote?.trim()
    ? cleanLine(input.failoverNote)
    : undefined;
  events.push({
    at: start,
    kind: 'dispatch',
    summary: `dispatched${adapterBit}`,
    ...(failoverDetail ? { detail: failoverDetail } : {}),
  });
  events.push(...activityMilestones(input.activityTail, stamp));

  const l1Gates = input.gates.filter((g) => isL1Gate(g.name));
  const l1Failed = l1Gates.filter((g) => !g.passed);
  const l1Ran = l1Gates.length > 0;
  if (l1Ran) {
    if (l1Failed.length > 0) {
      const names = l1Failed.map((g) => g.name).join(', ');
      const out = cleanLine(l1Failed[0]?.output ?? '');
      events.push({
        at: stamp,
        kind: 'l1',
        summary: `L1 failed: ${names}`,
        ok: false,
        ...(out ? { detail: out.slice(0, 160) } : {}),
      });
    } else {
      events.push({
        at: stamp,
        kind: 'l1',
        summary: `L1 passed (${l1Gates.length} gate${l1Gates.length === 1 ? '' : 's'})`,
        ok: true,
      });
    }
  }

  const behavioral = input.gates.find((g) => g.name === 'behavioral');
  const evidenceOk =
    typeof input.evidenceRun?.ok === 'boolean'
      ? input.evidenceRun.ok
      : typeof behavioral?.passed === 'boolean'
        ? behavioral.passed
        : undefined;
  if (evidenceOk !== undefined) {
    events.push({
      at: stamp,
      kind: 'l2',
      summary: evidenceOk ? 'L2 behavioral evidence ok' : 'L2 behavioral evidence failed',
      ok: evidenceOk,
      ...(!evidenceOk && behavioral?.output
        ? { detail: cleanLine(behavioral.output).slice(0, 160) }
        : {}),
    });
  }

  if (input.reviewerRan === true || input.reviewerVerdict) {
    const v = input.reviewerVerdict;
    const ok = v ? v.approved : false;
    events.push({
      at: stamp,
      kind: 'l3',
      summary: v
        ? ok
          ? 'L3 reviewer approved'
          : `L3 changes requested: ${cleanLine(v.summary).slice(0, 120)}`
        : 'L3 ran (no parseable verdict)',
      ok,
    });
  } else if (input.reviewerSkipReason) {
    events.push({
      at: stamp,
      kind: 'l3',
      summary: `L3 skipped: ${cleanLine(input.reviewerSkipReason).slice(0, 140)}`,
    });
  }

  const finalizeSummary = input.autoRework
    ? 'packet finalized — auto-rework'
    : input.green
      ? 'packet finalized — automated proof green'
      : 'packet finalized — parked for human review';
  events.push({
    at: stamp,
    kind: 'packet_finalize',
    summary: finalizeSummary,
    ok: input.green && !input.autoRework,
  });

  return events;
}

/** Markdown section for task body (durable, phone-parseable). */
export function renderRunTimelineSection(
  events: readonly RunTimelineEvent[],
): string {
  if (events.length === 0) return '';
  const lines: string[] = ['## Run timeline', ''];
  for (const e of events) {
    const mark =
      e.ok === true ? ' ✅' : e.ok === false ? ' ❌' : '';
    const detail = e.detail?.trim() ? ` | ${cleanLine(e.detail)}` : '';
    lines.push(
      `- \`${e.at}\` **${e.kind}**${mark} — ${cleanLine(e.summary)}${detail}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Parse the **latest** `## Run timeline` section from a task body.
 * Multi-attempt bodies may accumulate one section per attempt; phone diagnosis
 * must show the newest (mirror parseLatestRunFailure / lastIndexOf).
 */
export function parseRunTimeline(body: string): RunTimelineEvent[] {
  const idx = body.toLowerCase().lastIndexOf(TIMELINE_HEADING_PREFIX);
  if (idx < 0) return [];
  // Slice until next ## heading or end
  const from = body.slice(idx);
  const next = from.slice(1).search(/^##\s+/m);
  const section = next >= 0 ? from.slice(0, next + 1) : from;
  const events: RunTimelineEvent[] = [];
  for (const line of section.split('\n')) {
    const m = EVENT_LINE.exec(line.trim());
    if (!m) continue;
    const at = m[1]!.trim();
    const kindRaw = m[2]!.trim();
    if (!isKind(kindRaw)) continue;
    const mark = m[3];
    const summary = cleanLine(m[4] ?? '');
    const detail = m[5] ? cleanLine(m[5]) : undefined;
    if (!summary) continue;
    const event: RunTimelineEvent = {
      at,
      kind: kindRaw,
      summary,
      ...(detail ? { detail } : {}),
      ...(mark === '✅' ? { ok: true } : mark === '❌' ? { ok: false } : {}),
    };
    events.push(event);
  }
  return events;
}

/**
 * Derive a minimal timeline from a Run failure mini-packet when no explicit
 * ## Run timeline section exists (older failed tasks / salvage sheets).
 */
export function deriveTimelineFromRunFailure(body: string): RunTimelineEvent[] {
  const parsed = parseLatestRunFailure(body);
  if (!parsed.kind) return [];

  const idx = body.toLowerCase().lastIndexOf('## run failure');
  const slice = idx >= 0 ? body.slice(idx, idx + 3500) : body;
  const stampM = /##\s+Run failure\s*\(([^)]+)\)/i.exec(slice);
  const stamp = stampM?.[1]?.trim() || new Date(0).toISOString();
  const adapterM = /\*\*Adapter:\*\*\s*`([^`]+)`/i.exec(slice);
  const exitM = /\*\*Exit code:\*\*\s*(\S+)/i.exec(slice);
  let exitCode: number | null | undefined;
  if (exitM) {
    const raw = exitM[1]!.trim();
    if (raw === 'unknown') exitCode = null;
    else if (/^-?\d+$/.test(raw)) exitCode = Number(raw);
  }

  // Pull fenced activity block if present
  const activity: string[] = [];
  const actIdx = slice.search(/###\s+Last agent activity/i);
  if (actIdx >= 0) {
    const fence = slice.slice(actIdx).match(/```[\s\S]*?```/);
    if (fence) {
      for (const line of fence[0].split('\n')) {
        if (line.startsWith('```')) continue;
        const t = line.trim();
        if (t) activity.push(t);
      }
    }
  }

  return buildOnboardFailureTimeline({
    stamp,
    kind: parsed.kind,
    ...(adapterM ? { adapter: adapterM[1]!.trim() } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(activity.length > 0 ? { activityTail: activity } : {}),
  });
}

/**
 * Phone UI entry: explicit section wins; else derive from latest Run failure.
 */
export function resolveRunTimeline(body: string): RunTimelineEvent[] {
  const explicit = parseRunTimeline(body);
  if (explicit.length > 0) return explicit;
  return deriveTimelineFromRunFailure(body);
}
