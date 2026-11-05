/**
 * Domain — pure remote task-ref ownership observation and park receipts.
 *
 * Agents must not publish remote hercules task refs. Hercules exact-CAS is
 * the only normal remote task-ref writer. When a foreign tip appears mid-run,
 * park without burning an implement attempt and without adopting the tip.
 *
 * Pure: no IO. Isolation reads remote tips; orchestrator parks.
 */
import { isFullCommitSha, shortLeaseSha } from './taskBranchLease.js';
import { redactHostOutput } from './hostExecutor.js';

export const TASK_REF_PUBLICATION_RECEIPT_VERSION = 1 as const;
export const TASK_REF_OWNERSHIP_HEADING = '## Task-ref ownership';
export const TASK_REF_PUBLICATION_DETAIL_MAX = 400;

export type TaskRefOwnershipStatus =
  | 'held'
  | 'absent'
  | 'foreign_moved'
  | 'missing'
  | 'unexpected'
  | 'invalid';

export interface TaskRefOwnershipObservation {
  readonly status: TaskRefOwnershipStatus;
  readonly expectedRemoteTip: string | null;
  readonly actualRemoteTip: string | null;
  readonly held: boolean;
  readonly parkWithoutAttemptBurn: boolean;
  readonly adoptRemoteTip: false;
}

export interface TaskRefOwnershipReceipt {
  readonly version: typeof TASK_REF_PUBLICATION_RECEIPT_VERSION;
  readonly kind: 'task_ref_ownership';
  readonly stamp: string;
  readonly taskId: string;
  readonly branch: string;
  readonly status: TaskRefOwnershipStatus;
  readonly expectedRemoteTip: string | null;
  readonly actualRemoteTip: string | null;
  readonly detail: string;
  readonly nextAction: string;
  readonly burnedAttempt: false;
  readonly adoptRemoteTip: false;
}

function normalizeTip(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const tip = value.trim().toLowerCase();
  return tip.length === 0 ? null : tip;
}

export function observeTaskRefOwnership(input: {
  readonly expectedRemoteTip: string | null | undefined;
  readonly actualRemoteTip: string | null;
}): TaskRefOwnershipObservation {
  if (input.expectedRemoteTip === undefined) {
    return {
      status: 'held',
      expectedRemoteTip: null,
      actualRemoteTip: normalizeTip(input.actualRemoteTip),
      held: true,
      parkWithoutAttemptBurn: false,
      adoptRemoteTip: false,
    };
  }

  const expected = normalizeTip(input.expectedRemoteTip);
  const actual = normalizeTip(input.actualRemoteTip);

  if (expected !== null && !isFullCommitSha(expected)) {
    return {
      status: 'invalid',
      expectedRemoteTip: expected,
      actualRemoteTip: actual,
      held: false,
      parkWithoutAttemptBurn: true,
      adoptRemoteTip: false,
    };
  }
  if (actual !== null && !isFullCommitSha(actual)) {
    return {
      status: 'invalid',
      expectedRemoteTip: expected,
      actualRemoteTip: actual,
      held: false,
      parkWithoutAttemptBurn: true,
      adoptRemoteTip: false,
    };
  }

  if (expected === null && actual === null) {
    return {
      status: 'absent',
      expectedRemoteTip: null,
      actualRemoteTip: null,
      held: true,
      parkWithoutAttemptBurn: false,
      adoptRemoteTip: false,
    };
  }
  if (expected === null && actual !== null) {
    return {
      status: 'unexpected',
      expectedRemoteTip: null,
      actualRemoteTip: actual,
      held: false,
      parkWithoutAttemptBurn: true,
      adoptRemoteTip: false,
    };
  }
  if (expected !== null && actual === null) {
    return {
      status: 'missing',
      expectedRemoteTip: expected,
      actualRemoteTip: null,
      held: false,
      parkWithoutAttemptBurn: true,
      adoptRemoteTip: false,
    };
  }
  if (expected !== actual) {
    return {
      status: 'foreign_moved',
      expectedRemoteTip: expected,
      actualRemoteTip: actual,
      held: false,
      parkWithoutAttemptBurn: true,
      adoptRemoteTip: false,
    };
  }
  return {
    status: 'held',
    expectedRemoteTip: expected,
    actualRemoteTip: actual,
    held: true,
    parkWithoutAttemptBurn: false,
    adoptRemoteTip: false,
  };
}

/** Redact credentials and URLs from ownership receipt free text. */
export function redactTaskRefPublicationText(
  raw: string,
  max = TASK_REF_PUBLICATION_DETAIL_MAX,
): string {
  let safe = redactHostOutput(raw, Math.max(max * 3, 900));
  safe = safe.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>`]+/gi, '[url]');
  safe = safe.replace(/[`\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (safe.length === 0) {
    return 'ownership observation failed without a safe diagnostic';
  }
  return safe.length > max ? safe.slice(0, Math.max(0, max - 1)) + '…' : safe;
}

function defaultDetail(
  status: TaskRefOwnershipStatus,
  expected: string | null,
  actual: string | null,
): string {
  switch (status) {
    case 'held':
      return 'remote task ref held at ' + shortLeaseSha(expected);
    case 'absent':
      return 'remote task ref absent as expected (creation lease)';
    case 'foreign_moved':
      return (
        'foreign remote tip movement (expected ' +
        shortLeaseSha(expected) +
        ', actual ' +
        shortLeaseSha(actual) +
        ')'
      );
    case 'missing':
      return 'remote task ref missing (expected ' + shortLeaseSha(expected) + ')';
    case 'unexpected':
      return 'unexpected remote task ref appeared at ' + shortLeaseSha(actual);
    case 'invalid':
      return (
        'invalid task-ref ownership tips (expected ' +
        shortLeaseSha(expected) +
        ', actual ' +
        shortLeaseSha(actual) +
        ')'
      );
  }
}

function defaultNextAction(status: TaskRefOwnershipStatus): string {
  switch (status) {
    case 'held':
    case 'absent':
      return 'Hercules remains the sole remote task-ref writer for this branch.';
    case 'foreign_moved':
    case 'unexpected':
      return (
        'Inspect who advanced the remote task ref. Do not adopt the foreign tip. ' +
        'Salvage or reset ownership explicitly before re-dispatch.'
      );
    case 'missing':
      return (
        'Inspect why the remote task ref disappeared; restore ownership via Hercules CAS only.'
      );
    case 'invalid':
      return 'Inspect lease metadata and remote tip shape before retrying.';
  }
}

export function buildTaskRefOwnershipReceipt(input: {
  readonly stamp: string;
  readonly taskId: string;
  readonly branch: string;
  readonly observation: TaskRefOwnershipObservation;
  readonly detail?: string;
}): TaskRefOwnershipReceipt {
  const detailRaw =
    input.detail?.trim() ||
    defaultDetail(
      input.observation.status,
      input.observation.expectedRemoteTip,
      input.observation.actualRemoteTip,
    );
  return {
    version: TASK_REF_PUBLICATION_RECEIPT_VERSION,
    kind: 'task_ref_ownership',
    stamp: input.stamp.trim(),
    taskId: input.taskId.trim(),
    branch: input.branch.trim(),
    status: input.observation.status,
    expectedRemoteTip: input.observation.expectedRemoteTip,
    actualRemoteTip: input.observation.actualRemoteTip,
    detail: redactTaskRefPublicationText(detailRaw),
    nextAction: defaultNextAction(input.observation.status),
    burnedAttempt: false,
    adoptRemoteTip: false,
  };
}

/** Markdown section for task body / phone packet. */
export function formatTaskRefOwnershipSection(receipt: TaskRefOwnershipReceipt): string {
  return [
    TASK_REF_OWNERSHIP_HEADING + ' (' + receipt.stamp + ')',
    '',
    '**Status:** `' + receipt.status + '`',
    '**Branch:** `' + receipt.branch + '`',
    '**Expected tip:** `' + shortLeaseSha(receipt.expectedRemoteTip) + '`',
    '**Actual tip:** `' + shortLeaseSha(receipt.actualRemoteTip) + '`',
    '**Attempt accounting:** soft (no burn)',
    '**Adopt remote tip:** no',
    '**Detail:** ' + receipt.detail,
    '**Next action:** ' + receipt.nextAction,
    '',
  ].join('\n');
}

/** Append ownership park receipt; leaves attempts unchanged. */
export function appendTaskRefOwnershipPark(
  body: string,
  receipt: TaskRefOwnershipReceipt,
): string {
  return body.trimEnd() + '\n\n' + formatTaskRefOwnershipSection(receipt);
}
