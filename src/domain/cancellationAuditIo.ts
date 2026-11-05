/** Format and parse cancellation audit receipts (pure). */
import type { Task } from './task.js';
import {
  CANCELLATION_AUDIT_HEADING,
  buildCancellationAuditReceipt,
  isCancellationTimestamp,
  normalizeCancellationActorId,
  normalizeCancellationCorrelationId,
  normalizeCancellationOrigin,
  type CancellationActorCategory,
  type CancellationAuditDto,
  type CancellationAuditReceipt,
  type CancellationKind,
  type CancellationLifecyclePhase,
  type CancellationSource,
} from './cancellationAudit.js';
import { neutralizeUntrustedPacketText } from './packetNeutralize.js';

const NL = String.fromCharCode(10);
const TICK = String.fromCharCode(96);
const SOURCES = new Set(['human_ui', 'human_api', 'agent', 'daemon_safety', 'external_state', 'unknown']);
const KINDS = new Set(['cancel', 'force_abort']);
const PHASES = new Set(['pre_session', 'agent_running', 'verifying', 'stopping', 'terminal', 'unknown']);
const ACTORS = new Set(['operator', 'agent', 'daemon', 'integration', 'unavailable']);

function isSource(v: string): v is CancellationSource { return SOURCES.has(v); }
function isKind(v: string): v is CancellationKind { return KINDS.has(v); }
function isPhase(v: string): v is CancellationLifecyclePhase { return PHASES.has(v); }
function isActor(v: string): v is CancellationActorCategory { return ACTORS.has(v); }

export function formatCancellationAuditReceipt(r: CancellationAuditReceipt): string {
  const actorBit = r.actor.id ? ' / ' + TICK + r.actor.id + TICK : ' / (no id)';
  const corr = r.correlationId === null ? '(none)' : TICK + r.correlationId + TICK;
  const sess = r.hadActiveSession ? 'yes' : 'no';
  return CANCELLATION_AUDIT_HEADING + NL + NL +
    '- **At:** ' + r.at + NL +
    '- **Kind:** ' + r.kind + NL +
    '- **Source:** ' + r.source + NL +
    '- **Reason:** ' + r.reasonCode + NL +
    '- **Phase:** ' + r.lifecyclePhase + NL +
    '- **Active session:** ' + sess + NL +
    '- **Actor:** ' + r.actor.category + actorBit + NL +
    '- **Origin:** ' + r.origin + NL +
    '- **Correlation:** ' + corr + NL +
    '- **Message:** ' + neutralizeUntrustedPacketText(r.message) + NL;
}

export function appendCancellationAuditReceipt(body: string, receipt: CancellationAuditReceipt): string {
  const section = formatCancellationAuditReceipt(receipt);
  const base = body.trimEnd();
  return base.length === 0 ? section : base + NL + NL + section;
}

export function humanCancelMessage(kind: CancellationKind): string {
  return kind === 'force_abort' ? 'Operator requested force-abort.' : 'Operator requested cancellation.';
}

function field(section: string, label: string): string | null {
  const needle = '- **' + label + ':**';
  for (const line of section.split(NL)) {
    const t = line.trim();
    if (t.startsWith(needle)) return t.slice(needle.length).trim();
  }
  return null;
}

function stripTicks(v: string): string {
  const t = v.trim();
  if (t.startsWith(TICK) && t.endsWith(TICK) && t.length >= 2) return t.slice(1, -1);
  return t;
}

function parseActor(actorRaw: string): { category: CancellationActorCategory; id: string | null } | null {
  const slash = actorRaw.indexOf('/');
  if (slash < 0) {
    const cat = actorRaw.trim().toLowerCase();
    if (!isActor(cat)) return null;
    return { category: cat, id: null };
  }
  const cat = actorRaw.slice(0, slash).trim().toLowerCase();
  if (!isActor(cat)) return null;
  const rest = actorRaw.slice(slash + 1).trim();
  const id = (rest === '(no id)' || rest === '(none)') ? null : normalizeCancellationActorId(stripTicks(rest));
  return { category: cat, id };
}

export function parseCancellationAuditReceipts(body: string): readonly CancellationAuditReceipt[] {
  if (!body.includes(CANCELLATION_AUDIT_HEADING)) return [];
  const out: CancellationAuditReceipt[] = [];
  let from = 0;
  while (from < body.length) {
    const idx = body.indexOf(CANCELLATION_AUDIT_HEADING, from);
    if (idx < 0) break;
    const after = body.slice(idx + CANCELLATION_AUDIT_HEADING.length);
    const nextH2 = after.indexOf(NL + '## ');
    const section = (nextH2 >= 0 ? after.slice(0, nextH2) : after).trim();
    from = idx + CANCELLATION_AUDIT_HEADING.length + (nextH2 >= 0 ? nextH2 : after.length);
    const receipt = parseSection(section);
    if (receipt) out.push(receipt);
  }
  return out;
}

function parseSection(section: string): CancellationAuditReceipt | null {
  const at = field(section, 'At');
  const kindRaw = field(section, 'Kind');
  const sourceRaw = field(section, 'Source');
  const reasonRaw = field(section, 'Reason');
  const phaseRaw = field(section, 'Phase');
  const sessionRaw = field(section, 'Active session');
  const actorRaw = field(section, 'Actor');
  return finishParse(section, at, kindRaw, sourceRaw, reasonRaw, phaseRaw, sessionRaw, actorRaw);
}

function finishParse(
  section: string,
  at: string | null,
  kindRaw: string | null,
  sourceRaw: string | null,
  reasonRaw: string | null,
  phaseRaw: string | null,
  sessionRaw: string | null,
  actorRaw: string | null,
): CancellationAuditReceipt | null {
  if (!at || !kindRaw || !sourceRaw || !reasonRaw || !phaseRaw || !sessionRaw || !actorRaw) return null;
  if (!isCancellationTimestamp(at) || !isKind(kindRaw) || !isSource(sourceRaw) || !isPhase(phaseRaw)) return null;
  const actor = parseActor(actorRaw);
  if (!actor) return null;
  const origin = normalizeCancellationOrigin(field(section, 'Origin') ?? 'unknown');
  const corrField = field(section, 'Correlation');
  const corrStr = corrField ? stripTicks(corrField) : '';
  const correlationId = (!corrStr || corrStr === '(none)') ? null : normalizeCancellationCorrelationId(corrStr);
  const hadActiveSession = sessionRaw.trim().toLowerCase() === 'yes';
  try {
    return buildCancellationAuditReceipt({
      kind: kindRaw, source: sourceRaw, reasonCode: reasonRaw,
      message: field(section, 'Message') ?? '', at, lifecyclePhase: phaseRaw,
      hadActiveSession, actorCategory: actor.category, actorId: actor.id, origin, correlationId,
    });
  } catch {
    // Fail closed: malformed durable sections are skipped, not invented.
    return null;
  }
}

export function latestCancellationAudit(body: string): CancellationAuditReceipt | null {
  const all = parseCancellationAuditReceipts(body);
  return all.length > 0 ? all[all.length - 1]! : null;
}

export function cancellationAuditDtosFromTask(task: Pick<Task, 'body'>): readonly CancellationAuditDto[] {
  return parseCancellationAuditReceipts(task.body);
}
