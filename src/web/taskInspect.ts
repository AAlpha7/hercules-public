/**
 * Structured task inspection for Voice Control (and any future clients).
 *
 * Root cause fix: task content is a multi-section document. Callers must
 *   1) list the index (complete), then
 *   2) read named parts with offset/limit,
 *   3) treat FRAGMENT responses as incomplete and continue with nextOffset.
 *
 * Never dump "a bit of everything" and pretend it's the task.
 */
import { splitTaskBody, type BodySection } from './taskBodySplit.js';
import { FRAGMENT_BANNER } from './voiceFragments.js';

export type TaskPartKind = 'meta' | 'brief' | 'evidence' | 'packet' | 'other';

export interface TaskPartRef {
  /** Stable id within this body snapshot, e.g. "brief", "s0", "s3". */
  readonly id: string;
  readonly title: string;
  readonly kind: TaskPartKind;
  readonly chars: number;
  readonly lines: number;
}

export interface TaskInspectMeta {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly repo: string;
  readonly attempts: number;
  readonly adapter: string | null;
  readonly prUrl: string | null;
  readonly prStatus: string | null;
  readonly bodyChars: number;
  readonly partCount: number;
  readonly parts: readonly TaskPartRef[];
}

export interface TaskReadResult {
  readonly partId: string;
  readonly title: string;
  readonly kind: TaskPartKind;
  readonly totalChars: number;
  readonly offset: number;
  readonly length: number;
  /** True when this slice is the entire part. */
  readonly complete: boolean;
  /** When !complete, pass this as offset on the next read. */
  readonly nextOffset: number | null;
  readonly text: string;
}

export interface TaskLike {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly repo: string;
  readonly attempts: number;
  readonly adapter: string | null;
  readonly prUrl: string | null;
  readonly prStatus: string | null;
  readonly body: string;
}

const DEFAULT_MAX = 3000;
const HARD_MAX = 12_000;

export function buildTaskParts(body: string): {
  readonly brief: string;
  readonly sections: readonly BodySection[];
  readonly parts: readonly { ref: TaskPartRef; text: string }[];
} {
  const { brief, sections } = splitTaskBody(body || '');
  const parts: { ref: TaskPartRef; text: string }[] = [];
  if (brief.trim()) {
    parts.push({
      ref: {
        id: 'brief',
        title: 'Task brief',
        kind: 'brief',
        chars: brief.length,
        lines: brief.split('\n').length,
      },
      text: brief,
    });
  }
  for (const s of sections) {
    const kind = mapKind(s);
    parts.push({
      ref: {
        id: s.key,
        title: s.title,
        kind,
        chars: s.text.length,
        lines: s.text.split('\n').length,
      },
      text: s.text,
    });
  }
  return { brief, sections, parts };
}

function mapKind(s: BodySection): TaskPartKind {
  const t = s.title.toLowerCase();
  if (s.kind === 'evidence' || /evidence|diff|files|cost|anti-cheat|activity|report/i.test(t)) {
    return 'evidence';
  }
  if (/review packet|teardown|gates|definition of done|self-assessment|reviewer/i.test(t)) {
    return 'packet';
  }
  if (s.kind === 'brief') return 'brief';
  return 'other';
}

export function taskInspectMeta(task: TaskLike): TaskInspectMeta {
  const { parts } = buildTaskParts(task.body);
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    repo: task.repo,
    attempts: task.attempts,
    adapter: task.adapter,
    prUrl: task.prUrl,
    prStatus: task.prStatus,
    bodyChars: (task.body || '').length,
    partCount: parts.length,
    parts: parts.map((p) => p.ref),
  };
}

export function formatTaskIndex(task: TaskLike): string {
  const meta = taskInspectMeta(task);
  const lines = [
    `TASK INDEX (complete catalog — not body content)`,
    `id=${meta.id} state=${meta.state} repo=${meta.repo} attempts=${meta.attempts}`,
    `title=${meta.title}`,
    meta.prUrl ? `pr=${meta.prUrl} (${meta.prStatus ?? '?'})` : 'pr=(none)',
    `bodyChars=${meta.bodyChars} parts=${meta.partCount}`,
    `To answer content questions: inspect_task action=read part=<id|title> [offset=0].`,
    `If a read returns ${FRAGMENT_BANNER.split('—')[0]?.trim()}, continue with nextOffset until complete=true.`,
    '',
    'parts:',
  ];
  for (const p of meta.parts) {
    lines.push(`  - ${p.id}  [${p.kind}]  "${p.title}"  ${p.chars} chars / ${p.lines} lines`);
  }
  if (meta.parts.length === 0) {
    lines.push('  (no body parts yet — task may still be empty or running)');
  }
  return lines.join('\n');
}

export function formatTaskMeta(task: TaskLike): string {
  const meta = taskInspectMeta(task);
  return [
    `TASK META (no body text — use action=index then action=read for content)`,
    `id=${meta.id}`,
    `state=${meta.state}`,
    `repo=${meta.repo}`,
    `title=${meta.title}`,
    `attempts=${meta.attempts}`,
    `adapter=${meta.adapter ?? '(inherit)'}`,
    meta.prUrl ? `pr=${meta.prUrl} (${meta.prStatus ?? '?'})` : 'pr=(none)',
    `bodyChars=${meta.bodyChars}`,
    `partCount=${meta.partCount}`,
    `partIds=${meta.parts.map((p) => p.id).join(', ') || '(none)'}`,
  ].join('\n');
}

/**
 * Resolve part by id (brief, s0, …), exact title, or case-insensitive substring.
 */
export function resolveTaskPart(
  task: TaskLike,
  partQuery: string | number | undefined,
): { ref: TaskPartRef; text: string } | { error: string } {
  const { parts } = buildTaskParts(task.body);
  if (parts.length === 0) {
    return { error: 'Task has no body parts yet' };
  }
  if (partQuery === undefined || partQuery === null || partQuery === '') {
    return {
      error:
        'part required for read. Call action=index first, then action=read with part=<id|title>.',
    };
  }
  if (typeof partQuery === 'number' && Number.isFinite(partQuery)) {
    const i = Math.floor(partQuery);
    if (i < 0 || i >= parts.length) {
      return { error: `part index ${i} out of range 0..${parts.length - 1}` };
    }
    return parts[i]!;
  }
  const q = String(partQuery).trim();
  const byId = parts.find((p) => p.ref.id === q);
  if (byId) return byId;
  const exact = parts.find((p) => p.ref.title.toLowerCase() === q.toLowerCase());
  if (exact) return exact;
  const sub = parts.filter((p) => p.ref.title.toLowerCase().includes(q.toLowerCase()));
  if (sub.length === 1) return sub[0]!;
  if (sub.length > 1) {
    return {
      error: `Ambiguous part "${q}". Matches: ${sub.map((p) => `${p.ref.id}:"${p.ref.title}"`).join(', ')}`,
    };
  }
  return {
    error: `Unknown part "${q}". Available: ${parts.map((p) => `${p.ref.id}:"${p.ref.title}"`).join(', ')}`,
  };
}

export function readTaskPart(
  task: TaskLike,
  partQuery: string | number | undefined,
  opts?: { offset?: number; maxChars?: number },
): TaskReadResult | { error: string } {
  const resolved = resolveTaskPart(task, partQuery);
  if ('error' in resolved) return resolved;

  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  let maxChars = Math.floor(opts?.maxChars ?? DEFAULT_MAX);
  if (!Number.isFinite(maxChars) || maxChars < 200) maxChars = DEFAULT_MAX;
  if (maxChars > HARD_MAX) maxChars = HARD_MAX;

  const full = resolved.text;
  const totalChars = full.length;
  if (offset >= totalChars) {
    return {
      partId: resolved.ref.id,
      title: resolved.ref.title,
      kind: resolved.ref.kind,
      totalChars,
      offset,
      length: 0,
      complete: true,
      nextOffset: null,
      text: `[COMPLETE] part=${resolved.ref.id} "${resolved.ref.title}" — offset ${offset} is past end (${totalChars} chars). Nothing more to read.`,
    };
  }

  const slice = full.slice(offset, offset + maxChars);
  const end = offset + slice.length;
  const complete = end >= totalChars;
  const nextOffset = complete ? null : end;

  const header = complete
    ? `[COMPLETE] part=${resolved.ref.id} "${resolved.ref.title}" kind=${resolved.ref.kind} ` +
      `chars=${totalChars} (full part, offset=${offset})`
    : `${FRAGMENT_BANNER} part=${resolved.ref.id} "${resolved.ref.title}" ` +
      `showing offset ${offset}..${end - 1} of ${totalChars} chars. ` +
      `NOT the full part. Continue with action=read part=${resolved.ref.id} offset=${end}.`;

  return {
    partId: resolved.ref.id,
    title: resolved.ref.title,
    kind: resolved.ref.kind,
    totalChars,
    offset,
    length: slice.length,
    complete,
    nextOffset,
    text: `${header}\n\n${slice}`,
  };
}

/** Filter part refs by loose topic (evidence, gates, …) for guided reads. */
export function filterPartIds(
  task: TaskLike,
  topic: string,
): readonly { id: string; title: string; kind: TaskPartKind }[] {
  const t = topic.toLowerCase().trim();
  const { parts } = buildTaskParts(task.body);
  if (!t || t === 'all') {
    return parts.map((p) => ({ id: p.ref.id, title: p.ref.title, kind: p.ref.kind }));
  }
  return parts
    .filter((p) => {
      const title = p.ref.title.toLowerCase();
      if (t === 'evidence') return p.ref.kind === 'evidence' || title.includes('evidence');
      if (t === 'matrix') return title.includes('evidence matrix');
      if (t === 'brief') return p.ref.id === 'brief' || p.ref.kind === 'brief';
      if (t === 'gates') return title.includes('gates') || title.includes('definition of done');
      if (t === 'reviewer') return title.startsWith('reviewer');
      if (t === 'self') return title.includes('self-assessment');
      if (t === 'diff') return title.includes('diff') || title.includes('files');
      if (t === 'cost') return title.includes('cost');
      return title.includes(t) || p.ref.id === t;
    })
    .map((p) => ({ id: p.ref.id, title: p.ref.title, kind: p.ref.kind }));
}

/** Format a multi-part read plan suggestion for the model. */
export function formatReadPlan(task: TaskLike, topic: string): string {
  const hits = filterPartIds(task, topic);
  if (hits.length === 0) {
    return formatTaskIndex(task) + `\n\n(No parts matched topic="${topic}". Use index titles above.)`;
  }
  const lines = [
    `READ PLAN for topic="${topic}" (${hits.length} part(s)) — this is an index, not content:`,
    ...hits.map((h) => `  - ${h.id} [${h.kind}] "${h.title}"`),
    `Call action=read for each needed part; continue with nextOffset until COMPLETE.`,
  ];
  return lines.join('\n');
}
