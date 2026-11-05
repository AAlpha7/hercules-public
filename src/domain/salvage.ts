/**
 * Domain — salvage brief when attempts are exhausted (quality gap G7/P2),
 * plus pure validation/provenance for explicit clean-salvage forks.
 *
 * Pure text + predicates — no IO / git / fs / network.
 */
import type { DodDimensions } from './acceptance.js';
import { ADAPTER_KINDS, isAdapterKind, type AdapterKind } from './agents.js';
import type { TaskState } from './task.js';
import { isValidIdentifier } from './task.js';
import { isCriticalCheatKind, type CheatFinding } from './verification.js';
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';

export function buildSalvageBrief(input: {
  readonly taskId: string;
  readonly maxAttempts: number;
  readonly dimensions: DodDimensions;
  readonly cheatFindings?: readonly CheatFinding[];
  readonly behavioralFailed?: boolean;
  readonly deliveryFailed?: boolean;
}): string {
  const lines: string[] = [
    '## Salvage brief',
    '',
    `Reached **max attempts (${input.maxAttempts})**. Branch \`hercules/${input.taskId}\` is preserved.`,
    '',
    '### What failed',
  ];

  const d = input.dimensions;
  lines.push(`- mechanical: \`${d.mechanical}\``);
  lines.push(`- reviewer: \`${d.reviewer}\``);
  lines.push(`- human: \`${d.human}\``);
  if (input.behavioralFailed) lines.push('- L2 behavioral / evidence plan: **failed**');
  if (input.deliveryFailed) lines.push('- delivery honesty: **empty diff or false shipped claim**');

  const critical = (input.cheatFindings ?? []).filter((f) => isCriticalCheatKind(f.kind));
  if (critical.length > 0) {
    lines.push(`- critical L5: ${critical.map((f) => f.kind).join(', ')}`);
  }

  if (d.warnings.length > 0) {
    lines.push('');
    lines.push('### Warnings');
    for (const w of d.warnings.slice(0, 8)) {
      lines.push(`- ${neutralizeUntrustedPacketText(w)}`);
    }
  }

  lines.push('');
  lines.push('### Suggested next actions');
  lines.push(
    '1. **Retry** — primary recovery: reset attempts; reuses the preserved ' +
      `\`hercules/${input.taskId}\` branch (same task; no manual diff apply)`,
  );
  lines.push('2. **Steer** — open live session with a narrower fix instruction on that branch');
  lines.push('3. **Switch agent** — try a different adapter on the preserved branch');
  lines.push(
    '4. **Clean salvage fork** — phone/API action that opens a fresh task ' +
      'seeded from the preserved tip (audited; not automatic cross-task adoption)',
  );
  lines.push(
    '5. **Offline finish** — only if you must leave Hercules: checkout ' +
      `\`hercules/${input.taskId}\` yourself`,
  );
  lines.push('');
  return lines.join('\n');
}

/** Full 40-char hex commit SHA (durable provenance stamp). */
export function isFullCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/** Operator input bounds for POST /salvage-fork (fail closed on junk). */
export const SALVAGE_FORK_TITLE_MAX = 500;
export const SALVAGE_FORK_BODY_MAX = 100_000;
export const SALVAGE_FORK_LABELS_MAX = 32;
export const SALVAGE_FORK_LABEL_MAX = 64;
export const SALVAGE_FORK_PRIORITY_MIN = 0;
export const SALVAGE_FORK_PRIORITY_MAX = 10_000;

/** Parsed body for an explicit clean-salvage fork (API → action). */
export interface SalvageForkInput {
  readonly id?: string;
  readonly title?: string;
  readonly body?: string;
  readonly priority?: number;
  readonly labels?: readonly string[];
  readonly adapter?: AdapterKind | null;
}

export type SalvageForkParseResult =
  | { readonly ok: true; readonly value: SalvageForkInput }
  | { readonly ok: false; readonly reason: string };

/**
 * Strict JSON body parse for salvage-fork. Empty/null/undefined → {}.
 * Never casts arbitrary objects; wrong types and oversize fields fail closed.
 */
export function parseSalvageForkInput(raw: unknown): SalvageForkParseResult {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'body must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const out: {
    id?: string;
    title?: string;
    body?: string;
    priority?: number;
    labels?: string[];
    adapter?: AdapterKind | null;
  } = {};

  if ('id' in obj && obj['id'] !== undefined) {
    if (typeof obj['id'] !== 'string') {
      return { ok: false, reason: 'id must be a string' };
    }
    if (!isValidIdentifier(obj['id'])) {
      return { ok: false, reason: `unsafe target task id '${obj['id']}'` };
    }
    out.id = obj['id'];
  }

  if ('title' in obj && obj['title'] !== undefined) {
    if (typeof obj['title'] !== 'string') {
      return { ok: false, reason: 'title must be a string' };
    }
    if (obj['title'].length > SALVAGE_FORK_TITLE_MAX) {
      return {
        ok: false,
        reason: `title too long (max ${SALVAGE_FORK_TITLE_MAX} chars)`,
      };
    }
    out.title = obj['title'];
  }

  if ('body' in obj && obj['body'] !== undefined) {
    if (typeof obj['body'] !== 'string') {
      return { ok: false, reason: 'body must be a string' };
    }
    if (obj['body'].length > SALVAGE_FORK_BODY_MAX) {
      return {
        ok: false,
        reason: `body too long (max ${SALVAGE_FORK_BODY_MAX} chars)`,
      };
    }
    out.body = obj['body'];
  }

  if ('priority' in obj && obj['priority'] !== undefined) {
    if (
      typeof obj['priority'] !== 'number' ||
      !Number.isInteger(obj['priority']) ||
      obj['priority'] < SALVAGE_FORK_PRIORITY_MIN ||
      obj['priority'] > SALVAGE_FORK_PRIORITY_MAX
    ) {
      return {
        ok: false,
        reason: `priority must be an integer ${SALVAGE_FORK_PRIORITY_MIN}–${SALVAGE_FORK_PRIORITY_MAX}`,
      };
    }
    out.priority = obj['priority'];
  }

  if ('labels' in obj && obj['labels'] !== undefined) {
    if (!Array.isArray(obj['labels'])) {
      return { ok: false, reason: 'labels must be an array of strings' };
    }
    if (obj['labels'].length > SALVAGE_FORK_LABELS_MAX) {
      return {
        ok: false,
        reason: `labels too many (max ${SALVAGE_FORK_LABELS_MAX})`,
      };
    }
    const labels: string[] = [];
    for (const item of obj['labels']) {
      if (typeof item !== 'string') {
        return { ok: false, reason: 'every labels entry must be a string' };
      }
      if (item.length === 0 || item.length > SALVAGE_FORK_LABEL_MAX) {
        return {
          ok: false,
          reason: `each label must be 1–${SALVAGE_FORK_LABEL_MAX} chars`,
        };
      }
      labels.push(item);
    }
    out.labels = labels;
  }

  if ('adapter' in obj && obj['adapter'] !== undefined) {
    const a = obj['adapter'];
    if (a === null) {
      out.adapter = null;
    } else if (typeof a === 'string' && isAdapterKind(a)) {
      out.adapter = a;
    } else {
      return {
        ok: false,
        reason: `unknown adapter '${String(a)}' (want ${ADAPTER_KINDS.join('|')}|null)`,
      };
    }
  }

  return { ok: true, value: out };
}

export interface SalvageForkValidationInput {
  readonly sourceId: string;
  readonly targetId: string;
  readonly sourceRepo: string;
  readonly targetRepo: string;
  readonly sourceState: TaskState;
  readonly targetExists: boolean;
  /**
   * From isolation resolve (truthful). Omit only for pre-IO id/state checks;
   * never hardcode `true` without a real branch probe.
   */
  readonly sourceBranchPresent?: boolean;
}

export type SalvageForkValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Pure fail-closed checks for an explicit clean-salvage fork.
 * Branch presence is a boolean from the isolation layer (not probed here).
 * Omit {@link SalvageForkValidationInput.sourceBranchPresent} for pre-IO
 * validation; set it from a real resolve before dispatch stamping.
 */
export function validateSalvageForkRequest(
  input: SalvageForkValidationInput,
): SalvageForkValidationResult {
  if (!isValidIdentifier(input.sourceId)) {
    return { ok: false, reason: `unsafe source task id '${input.sourceId}'` };
  }
  if (!isValidIdentifier(input.targetId)) {
    return { ok: false, reason: `unsafe target task id '${input.targetId}'` };
  }
  if (input.sourceId === input.targetId) {
    return { ok: false, reason: 'source and target task ids must be different' };
  }
  if (!isValidIdentifier(input.sourceRepo) || !isValidIdentifier(input.targetRepo)) {
    return { ok: false, reason: 'unsafe repo key' };
  }
  if (input.sourceRepo !== input.targetRepo) {
    return {
      ok: false,
      reason: `repo mismatch: source is '${input.sourceRepo}', target would be '${input.targetRepo}'`,
    };
  }
  if (input.sourceState !== 'failed' && input.sourceState !== 'cancelled') {
    return {
      ok: false,
      reason: `source task must be terminal failed or cancelled (got '${input.sourceState}')`,
    };
  }
  if (input.sourceBranchPresent === false) {
    return {
      ok: false,
      reason:
        `preserved branch hercules/${input.sourceId} missing on mirror and origin — ` +
        'cannot seed a clean salvage fork',
    };
  }
  if (input.targetExists) {
    return {
      ok: false,
      reason: `target task '${input.targetId}' already exists (collision)`,
    };
  }
  return { ok: true };
}

export function buildSalvageForkProvenanceSection(input: {
  readonly sourceTaskId: string;
  readonly sourceSha: string;
  readonly stampedAt: string;
}): string {
  return [
    '## Clean salvage provenance',
    '',
    'Explicit operator action — **not** automatic cross-task adoption.',
    '',
    `- **Source task:** \`${input.sourceTaskId}\``,
    `- **Source branch:** \`hercules/${input.sourceTaskId}\` (immutable; not moved/deleted)`,
    `- **Source tip SHA:** \`${input.sourceSha}\``,
    `- **Stamped at:** ${input.stampedAt}`,
    '',
    'Target branch `hercules/<this-id>` is created at first provision from this tip. ' +
      'Re-provision continues from this stamped SHA even after the source ' +
      'worktree is reclaimed; the implementer does not need git/shell access.',
    '',
  ].join('\n');
}

/**
 * Product brief only — strip harness sections so the new task does not inherit
 * crash/packet noise from the failed source.
 */
export function productBriefForSalvage(taskBody: string): string {
  const at = taskBody.search(
    /\n#{1,6}\s+(Review packet|System recovery|Auto-rework|Attempts exhausted|Salvage brief|Run failure|Run timeline|Thrash brake|Teardown|Switch stop|Agent switch|Re-verify|Human steer|Steer result|Cost cap|Clean salvage provenance)\b/i,
  );
  return (at === -1 ? taskBody : taskBody.slice(0, at)).trim();
}

export function buildSalvageForkBody(input: {
  readonly sourceTaskId: string;
  readonly sourceSha: string;
  readonly stampedAt: string;
  readonly sourceBody: string;
  readonly operatorBody?: string | undefined;
}): string {
  const provenance = buildSalvageForkProvenanceSection({
    sourceTaskId: input.sourceTaskId,
    sourceSha: input.sourceSha,
    stampedAt: input.stampedAt,
  });
  const brief =
    input.operatorBody !== undefined && input.operatorBody.trim().length > 0
      ? input.operatorBody.trim()
      : productBriefForSalvage(input.sourceBody);
  // Product brief first so phone extractProductBrief / DoD counting still work;
  // provenance is a harness section (auditable, collapsible) after the brief.
  if (brief.length === 0) return provenance;
  return `${brief}\n\n${provenance}`;
}
