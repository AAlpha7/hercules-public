/**
 * Domain — Remote Control chat delivery idempotency.
 *
 * Pure helpers so the same client submission cannot create a second Human
 * steer / pendingChat entry across todo|retrying → in_progress races, live
 * queue retries, or L3 auto-rework finalization. No I/O.
 *
 * Contract:
 *   - Prefer stable `clientMessageId` (phone-generated per tap).
 *   - Persist id in the audit section (`<!-- client-message-id: … -->`) so
 *     retries survive daemon restarts without relying on mutable UI state.
 *   - Legacy callers without an id get a *bounded* normalized-text guard
 *     only for the immediate dispatch window (consumed steer of the live run).
 *   - A deliberate later / new-id message with identical text is accepted.
 */

import { combinePendingChatMessages } from './runFinalize.js';
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';

/** Max length for a client-supplied idempotency key. */
export const MAX_CLIENT_MESSAGE_ID_LEN = 128;

/** Bound the per-task in-memory delivered-id ring (auditable + restart-safe via body). */
export const MAX_DELIVERED_IDS_PER_TASK = 64;

/** Safe client id: alphanumeric + common URL-safe punctuation (no path/control). */
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9._:*-]{1,128}$/;

/** Marker written into `## Human steer` sections for durable idempotency. */
export const CLIENT_MESSAGE_ID_MARKER_RE =
  /<!--\s*client-message-id:\s*([A-Za-z0-9._:*-]{1,128})\s*-->/gi;

/**
 * Stable internal delivery-instance id embedded in the audit section so a
 * specific live queue entry is exactly-once across partial commit recovery.
 * Must NOT be derived from message text (identical deliberate later messages
 * get distinct delivery ids).
 */
export const CHAT_DELIVERY_ID_MARKER_RE =
  /<!--\s*chat-delivery-id:\s*([A-Za-z0-9._:-]{1,64})\s*-->/gi;

/** @deprecated Prefer chat-delivery-id; kept only for reading older task bodies. */
export const CHAT_QUEUE_FP_MARKER_RE =
  /<!--\s*chat-queue-fp:\s*([a-f0-9]{8,16})\s*-->/gi;

export type ChatDeliveryMode = 'steer' | 'pending' | 'queued' | 'duplicate';

export type ChatPriorMode = 'pending' | 'steer' | 'queued' | 'delivered';

export interface PendingChatEntry {
  readonly text: string;
  readonly clientMessageId: string | null;
  /**
   * Stable internal id assigned at enqueue. Keys body exactly-once recovery
   * for this queue instance (not normalized text).
   */
  readonly deliveryId: string;
}

/** Max length for an internal chat delivery id. */
export const MAX_CHAT_DELIVERY_ID_LEN = 64;

const CHAT_DELIVERY_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/** Validate / normalize an internal delivery id; null when unsafe. */
export function normalizeChatDeliveryId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (id.length === 0 || id.length > MAX_CHAT_DELIVERY_ID_LEN) return null;
  if (!CHAT_DELIVERY_ID_RE.test(id)) return null;
  return id;
}

/**
 * Build a stable internal delivery id from clock + sequence (pure; caller
 * supplies monotonic seq so domain stays free of global state).
 */
export function makeChatDeliveryId(nowMs: number, seq: number): string {
  const t = Math.max(0, Math.floor(nowMs)).toString(36);
  const s = Math.max(0, Math.floor(seq)).toString(36);
  return `d${t}-${s}`;
}

export type ChatIdempotencyDecision =
  | { readonly action: 'accept' }
  | {
      readonly action: 'duplicate';
      readonly reason: string;
      readonly priorMode: ChatPriorMode;
    };

/** Normalize optional client message id; null when absent or unsafe. */
export function normalizeClientMessageId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  if (id.length === 0 || id.length > MAX_CLIENT_MESSAGE_ID_LEN) return null;
  if (!CLIENT_MESSAGE_ID_RE.test(id)) return null;
  return id;
}

/**
 * Parse an optional API/client field. Absent/null → legacy path.
 * Present non-null that fails validation → invalid (callers return HTTP 400).
 * Never silently downgrade a malformed key to legacy.
 */
export type ClientMessageIdParse =
  | { readonly status: 'absent'; readonly id: null }
  | { readonly status: 'ok'; readonly id: string }
  | { readonly status: 'invalid'; readonly reason: string };

export function parseClientMessageIdInput(raw: unknown): ClientMessageIdParse {
  if (raw === undefined || raw === null) {
    return { status: 'absent', id: null };
  }
  if (typeof raw !== 'string') {
    return { status: 'invalid', reason: 'clientMessageId must be a string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { status: 'invalid', reason: 'clientMessageId must not be empty' };
  }
  if (trimmed.length > MAX_CLIENT_MESSAGE_ID_LEN) {
    return {
      status: 'invalid',
      reason: `clientMessageId too long (max ${MAX_CLIENT_MESSAGE_ID_LEN})`,
    };
  }
  if (!CLIENT_MESSAGE_ID_RE.test(trimmed)) {
    return {
      status: 'invalid',
      reason:
        'clientMessageId must be alphanumeric with . _ : * - only (no path/control chars)',
    };
  }
  return { status: 'ok', id: trimmed };
}

/** Collapse whitespace + case for legacy exact-text duplicate compare. */
export function normalizeChatText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Format a durable Human steer audit section. When `clientMessageId` is set,
 * embed an HTML comment marker so retries can detect prior delivery from body.
 */
export function formatHumanSteerSection(input: {
  readonly stamp: string;
  readonly text: string;
  readonly clientMessageId?: string | null;
  /** Optional footer note (e.g. auto-from-queue). */
  readonly note?: string | null;
  /** When set, also break `### <taskId>` heading look-alikes in steer text. */
  readonly taskId?: string | null;
}): string {
  const id = normalizeClientMessageId(input.clientMessageId ?? null);
  const neutOpts =
    typeof input.taskId === 'string' && input.taskId.length > 0
      ? { taskId: input.taskId }
      : undefined;
  const lines = [`## Human steer (${input.stamp})`, ''];
  if (id) {
    lines.push(`<!-- client-message-id: ${id} -->`, '');
  }
  // Steer text is caller-controlled and may sit after a review packet —
  // neutralize fence/heading look-alikes so they cannot re-anchor parsers.
  lines.push(neutralizeUntrustedPacketText(input.text.trim(), neutOpts));
  const note = input.note?.trim() ?? '';
  if (note.length > 0) {
    lines.push('', neutralizeUntrustedPacketText(note, neutOpts));
  }
  lines.push('');
  return lines.join('\n');
}

/** True when any Human steer section in `body` carries this client id. */
export function bodyHasClientMessageId(body: string, clientMessageId: string): boolean {
  const id = normalizeClientMessageId(clientMessageId);
  if (!id) return false;
  for (const found of extractClientMessageIdsFromBody(body)) {
    if (found === id) return true;
  }
  return false;
}

/** All client-message-id markers present in a task body (audit trail). */
export function extractClientMessageIdsFromBody(body: string): string[] {
  if (!body) return [];
  const out: string[] = [];
  const re = new RegExp(CLIENT_MESSAGE_ID_MARKER_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const id = normalizeClientMessageId(m[1] ?? '');
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * @deprecated Text-only fingerprint aliases deliberate later identical messages.
 * Prefer {@link makeChatDeliveryId} + {@link bodyHasChatDeliveryId}.
 */
export function chatQueueFingerprint(text: string): string {
  const s = normalizeChatText(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** @deprecated Prefer {@link bodyHasChatDeliveryId}. */
export function bodyHasChatQueueFingerprint(body: string, fingerprint: string): boolean {
  const fp = fingerprint.trim().toLowerCase();
  if (!/^[a-f0-9]{8,16}$/.test(fp)) return false;
  const re = new RegExp(CHAT_QUEUE_FP_MARKER_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if ((m[1] ?? '').toLowerCase() === fp) return true;
  }
  return false;
}

/** All chat-delivery-id markers present in a task body (audit trail). */
export function extractChatDeliveryIdsFromBody(body: string): string[] {
  if (!body) return [];
  const out: string[] = [];
  const re = new RegExp(CHAT_DELIVERY_ID_MARKER_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const id = normalizeChatDeliveryId(m[1] ?? '');
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** True when body already carries this delivery-instance marker. */
export function bodyHasChatDeliveryId(body: string, deliveryId: string): boolean {
  const id = normalizeChatDeliveryId(deliveryId);
  if (!id) return false;
  return extractChatDeliveryIdsFromBody(body).includes(id);
}

/**
 * True when this queue entry is already durable on the task body (by delivery
 * instance id, or client message id for older partial writes).
 */
export function bodyHasPendingChatEntry(
  body: string,
  entry: PendingChatEntry,
): boolean {
  const did = normalizeChatDeliveryId(entry.deliveryId);
  if (did && bodyHasChatDeliveryId(body, did)) return true;
  const cid = normalizeClientMessageId(entry.clientMessageId);
  if (cid && bodyHasClientMessageId(body, cid)) return true;
  return false;
}

/**
 * True when pending_steer already holds this submission (by id marker or
 * exact normalized text for legacy).
 */
export function pendingSteerMatchesMessage(input: {
  readonly pendingSteer: string | null | undefined;
  readonly text: string;
  readonly clientMessageId?: string | null;
}): boolean {
  const pending = input.pendingSteer?.trim() ?? '';
  if (pending.length === 0) return false;
  const id = normalizeClientMessageId(input.clientMessageId ?? null);
  if (id && bodyHasClientMessageId(pending, id)) return true;
  if (id) return false; // id present but not in pending — not a pending match
  return normalizeChatText(pending) === normalizeChatText(input.text);
}

/**
 * Decide whether to accept a chat submission or treat it as a duplicate of
 * something already pending, queued, or delivered into the current run.
 */
export function decideChatIdempotency(input: {
  readonly text: string;
  readonly clientMessageId?: string | null;
  readonly deliveredIds: readonly string[];
  readonly queue: readonly PendingChatEntry[];
  readonly pendingSteer: string | null | undefined;
  readonly body: string;
  /** Steer text consumed into the live run at dispatch (cleared from pendingSteer). */
  readonly consumedSteerText?: string | null;
  /** Client ids consumed into the live run at dispatch. */
  readonly consumedClientMessageIds?: readonly string[];
  /**
   * When true, legacy (no id) exact-text matches against the just-consumed
   * steer are suppressed. Must only be set for the immediate dispatch window.
   */
  readonly legacyTextGuard?: boolean;
}): ChatIdempotencyDecision {
  const text = input.text.trim();
  if (text.length === 0) {
    // Caller validates empty; treat as accept so upper layers surface "required".
    return { action: 'accept' };
  }
  const id = normalizeClientMessageId(input.clientMessageId ?? null);
  const norm = normalizeChatText(text);

  if (id) {
    if (input.deliveredIds.includes(id)) {
      return {
        action: 'duplicate',
        reason: 'client message id already delivered',
        priorMode: 'delivered',
      };
    }
    if (input.consumedClientMessageIds?.includes(id)) {
      return {
        action: 'duplicate',
        reason: 'client message id already included in current run',
        priorMode: 'delivered',
      };
    }
    // Still sitting in pending_steer (pre-dispatch) wins over body audit —
    // body already has the section while the steer has not been consumed yet.
    if (
      pendingSteerMatchesMessage({
        pendingSteer: input.pendingSteer,
        text,
        clientMessageId: id,
      })
    ) {
      return {
        action: 'duplicate',
        reason: 'client message id already pending for next dispatch',
        priorMode: 'pending',
      };
    }
    // actions.chat stores plain text in pendingSteer (id only on body). Same-id
    // retry while todo/retrying is still pending, not delivered.
    const pendingPlain = input.pendingSteer?.trim() ?? '';
    if (
      pendingPlain.length > 0 &&
      normalizeChatText(pendingPlain) === norm &&
      bodyHasClientMessageId(input.body, id)
    ) {
      return {
        action: 'duplicate',
        reason: 'client message id already pending for next dispatch',
        priorMode: 'pending',
      };
    }
    if (input.queue.some((e) => e.clientMessageId === id)) {
      return {
        action: 'duplicate',
        reason: 'client message id already in live queue',
        priorMode: 'queued',
      };
    }
    if (bodyHasClientMessageId(input.body, id)) {
      return {
        action: 'duplicate',
        reason: 'client message id already in task audit trail',
        priorMode: 'delivered',
      };
    }
    // Distinct id always accepted even when text matches a prior message.
    return { action: 'accept' };
  }

  // ── Legacy path (no client id): conservative, bounded ─────────────────
  if (
    pendingSteerMatchesMessage({
      pendingSteer: input.pendingSteer,
      text,
      clientMessageId: null,
    })
  ) {
    return {
      action: 'duplicate',
      reason: 'identical message already pending for next dispatch',
      priorMode: 'pending',
    };
  }
  if (input.queue.some((e) => normalizeChatText(e.text) === norm)) {
    return {
      action: 'duplicate',
      reason: 'identical message already in live queue',
      priorMode: 'queued',
    };
  }
  if (input.legacyTextGuard) {
    const consumed = input.consumedSteerText?.trim() ?? '';
    if (consumed.length > 0 && normalizeChatText(consumed) === norm) {
      return {
        action: 'duplicate',
        reason: 'identical message already included in current run',
        priorMode: 'delivered',
      };
    }
  }
  return { action: 'accept' };
}

/** Push onto a queue with exact-id / exact-text dedupe; preserves order. */
export function dedupeQueuePush(
  queue: readonly PendingChatEntry[],
  entry: PendingChatEntry,
): { readonly queue: PendingChatEntry[]; readonly duplicate: boolean } {
  const text = entry.text.trim();
  if (text.length === 0) return { queue: [...queue], duplicate: true };
  const id = normalizeClientMessageId(entry.clientMessageId);
  const deliveryId =
    normalizeChatDeliveryId(entry.deliveryId) ?? entry.deliveryId.trim();
  if (!deliveryId || !CHAT_DELIVERY_ID_RE.test(deliveryId)) {
    // Caller must supply a valid delivery id; treat as duplicate to avoid
    // undeliverable entries without an instance key.
    return { queue: [...queue], duplicate: true };
  }
  const norm = normalizeChatText(text);
  for (const existing of queue) {
    if (existing.deliveryId === deliveryId) {
      return { queue: [...queue], duplicate: true };
    }
    if (id && existing.clientMessageId === id) {
      return { queue: [...queue], duplicate: true };
    }
    if (!id && normalizeChatText(existing.text) === norm) {
      return { queue: [...queue], duplicate: true };
    }
  }
  return {
    queue: [...queue, { text, clientMessageId: id, deliveryId }],
    duplicate: false,
  };
}

/** Append id to a bounded ring (drop oldest when over cap). */
export function rememberDeliveredId(
  ids: readonly string[],
  id: string,
  max: number = MAX_DELIVERED_IDS_PER_TASK,
): string[] {
  const clean = normalizeClientMessageId(id);
  if (!clean) return [...ids];
  const next = ids.filter((x) => x !== clean);
  next.push(clean);
  const cap = max > 0 ? max : MAX_DELIVERED_IDS_PER_TASK;
  if (next.length > cap) return next.slice(next.length - cap);
  return next;
}

/**
 * Merge L3/auto-rework pending_steer with drained Remote Control queue text.
 * Distinct human feedback must reach the next prompt; only exact normalized
 * whole-message equality may suppress a double. Substring containment must
 * NOT drop a shorter queued phrase that merely appears inside auto-steer.
 * Empty sides collapse cleanly.
 */
export function mergeSteerWithQueuedFeedback(
  autoSteer: string | null | undefined,
  queueText: string,
): string {
  const auto = autoSteer?.trim() ?? '';
  const queued = queueText.trim();
  if (queued.length === 0) return auto;
  if (auto.length === 0) return queued;
  // Exact whole-message equality only — never substring suppression.
  if (normalizeChatText(auto) === normalizeChatText(queued)) return auto;
  return `${auto}\n\n---\n\n**Remote Control (queued during run):**\n\n${queued}`;
}

/**
 * When finalizing with both an auto-rework pending_steer and a drained chat
 * queue, produce the durable body section + next pending_steer.
 *
 * Exactly-once is keyed by `deliveryIds` (live queue instances), never by
 * normalized text alone — deliberate later identical messages must each land.
 */
export function applyQueuedChatOnFinalize(input: {
  readonly stamp: string;
  readonly body: string;
  readonly autoPendingSteer: string | null;
  readonly queueText: string;
  readonly queueCount: number;
  /** When true, next dispatch should resume with merged pending_steer. */
  readonly setPendingSteer: boolean;
  /**
   * Delivery-instance ids for this fold. When every id is already on body,
   * skip re-append (partial-write recovery) without suppressing a later
   * distinct instance that shares the same text.
   */
  readonly deliveryIds?: readonly string[];
  readonly clientMessageIds?: readonly string[];
  /** When set, forwarded into {@link formatHumanSteerSection} neutralization. */
  readonly taskId?: string | null;
}): { readonly body: string; readonly pendingSteer: string | null } {
  const queueText = input.queueText.trim();
  if (queueText.length === 0) {
    return {
      body: input.body,
      pendingSteer: input.setPendingSteer ? input.autoPendingSteer : null,
    };
  }
  const pendingSteer = input.setPendingSteer
    ? mergeSteerWithQueuedFeedback(input.autoPendingSteer, queueText)
    : null;
  const deliveryIds = (input.deliveryIds ?? [])
    .map((id) => normalizeChatDeliveryId(id))
    .filter((x): x is string => x !== null);
  // Recovery: every delivery instance already audited → do not re-append.
  if (
    deliveryIds.length > 0 &&
    deliveryIds.every((id) => bodyHasChatDeliveryId(input.body, id))
  ) {
    return { body: input.body, pendingSteer };
  }
  const countNote =
    input.queueCount === 1
      ? '_(auto from Remote Control queue)_'
      : `_(auto from Remote Control queue; ${input.queueCount} messages drained)_`;
  const section = formatHumanSteerSection({
    stamp: input.stamp,
    text: queueText,
    note: countNote,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
  });
  const clientIds = (input.clientMessageIds ?? [])
    .map((id) => normalizeClientMessageId(id))
    .filter((x): x is string => x !== null);
  const markers = [
    ...deliveryIds.map((id) => `<!-- chat-delivery-id: ${id} -->`),
    ...clientIds.map((id) => `<!-- client-message-id: ${id} -->`),
  ].join('\n');
  const stamped =
    markers.length > 0
      ? section.replace(
          `## Human steer (${input.stamp})`,
          `## Human steer (${input.stamp})\n\n${markers}`,
        )
      : section;
  const body = `${input.body.trimEnd()}\n\n${stamped}\n`;
  return { body, pendingSteer };
}

/**
 * Fold drained Remote Control queue into body + optional pending_steer.
 *
 * Body exactly-once: skip re-append for entries already durable via
 * `chat-delivery-id` (or client-message-id for older partial writes).
 *
 * pendingSteer always merges the **full** drained human text when requested —
 * never empty queueText just because instances are already audited
 * (partial-write recovery must still feed operator notes into the next L3
 * auto-rework prompt). Callers that must not requeue later runs should key
 * requeue on body growth / fresh entries, not pendingSteer alone.
 */
export function foldDrainedChatDelivery(input: {
  readonly body: string;
  readonly stamp: string;
  readonly autoPendingSteer: string | null;
  readonly setPendingSteer: boolean;
  readonly entries: readonly PendingChatEntry[];
  /** Pre-combined full drained text (order-preserving). */
  readonly fullText: string;
  readonly fullCount: number;
  /** When set, forwarded into steer-section neutralization. */
  readonly taskId?: string | null;
}): {
  readonly body: string;
  readonly pendingSteer: string | null;
  /** True when at least one drained entry was not yet durable on body. */
  readonly hasFreshBodyContent: boolean;
} {
  const fullText = input.fullText.trim();
  // Body exactly-once: omit entries already durable via delivery/client id.
  const bodyEntries = input.entries.filter((e) => !bodyHasPendingChatEntry(input.body, e));
  const bodyCombined =
    bodyEntries.length === input.entries.length
      ? { text: fullText, count: input.fullCount }
      : combinePendingChatMessages(bodyEntries.map((e) => e.text));
  const bodyText = bodyCombined.text;
  const bodyCount = bodyCombined.count;
  const deliveryIds = bodyEntries
    .map((e) => normalizeChatDeliveryId(e.deliveryId))
    .filter((x): x is string => x !== null);
  const clientIds = bodyEntries
    .map((e) => e.clientMessageId)
    .filter((x): x is string => typeof x === 'string' && x.length > 0);

  // pendingSteer from FULL drained text even when bodyEntries is empty.
  const pendingSteer = input.setPendingSteer
    ? mergeSteerWithQueuedFeedback(input.autoPendingSteer, fullText)
    : null;

  if (bodyEntries.length === 0 || bodyText.length === 0) {
    return {
      body: input.body,
      pendingSteer,
      hasFreshBodyContent: false,
    };
  }

  const folded = applyQueuedChatOnFinalize({
    stamp: input.stamp,
    body: input.body,
    autoPendingSteer: input.autoPendingSteer,
    queueText: bodyText,
    queueCount: bodyCount > 0 ? bodyCount : input.fullCount,
    setPendingSteer: false, // pendingSteer set from full text above
    deliveryIds,
    clientMessageIds: clientIds,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
  });

  return {
    body: folded.body,
    pendingSteer,
    hasFreshBodyContent: folded.body.length > input.body.length,
  };
}
