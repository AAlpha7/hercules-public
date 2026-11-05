/**
 * C3.5 decision-effect driver — post-commit bridge from a V2 decision receipt
 * to the legacy ActionService path (approve / reject / steer).
 *
 * Human-axis acknowledgement policy (pinned): the operator attested each human
 * criterion on the control surface (`human:<criterionId>` codes in
 * `acknowledgedRiskCodes`); the engine refused otherwise
 * (`src/controlapi/requestPolicy.ts` step 5). The driver maps those codes
 * through the committed package's human criteria and the legacy body texts
 * (match by criterion text after `parseMechProofBinding(...).cleanText`) and
 * passes exactly the matched texts as `humanAcknowledged`. It never fabricates
 * acknowledgements from the body alone — an extra body criterion added after
 * the decision, or any unacknowledged package human criterion, yields
 * `pending action_refused`.
 *
 * Failure semantics: never throw out of driveCommitted/redriveAll/detectDivergence;
 * never clear a marker on failure; never drive when legacy state is not `review`
 * (except the already-moved short-circuit). Loud `[hercules] decision effect:`
 * lines for every non-applied outcome.
 */
import { missingHumanAcknowledgements } from '../domain/acceptance.js';
import { parseMechProofBinding } from '../domain/mechProof.js';
import { compileM4LegacyContract } from '../domain/shadowProjection.js';
import type { TaskState } from '../domain/task.js';
import type { V2PendingEffectRow } from './state/stateStore.js';

export type { V2PendingEffectRow };

export interface DecisionEventView {
  readonly aggregateId: string;
  readonly action: V2PendingEffectRow['action'];
  readonly reason: string;
  readonly actorId: string;
  readonly actorIssuer: string;
  readonly decidedAt: string;
  readonly keyHash: string;
  readonly acknowledgedRiskCodes: readonly string[];
}

export interface DecisionEffectPackageCriterion {
  readonly criterionId: string;
  readonly authority: string;
  readonly required: boolean;
  readonly text?: string;
}

export interface DecisionEffectStorePort {
  readPendingEffect(keyHash: string): V2PendingEffectRow | null;
  listPendingEffects(): readonly V2PendingEffectRow[];
  markEffectApplied(keyHash: string, appliedAtSequence: number): V2PendingEffectRow;
  readDecisionEvent(eventSequence: number): DecisionEventView | null;
  readV2Aggregate(aggregateId: string): {
    readonly taskStatus: TaskState;
    readonly updatedAtMs: number;
    readonly reviewPackage: {
      readonly criteria: readonly DecisionEffectPackageCriterion[];
    } | null;
  } | null;
  latestEventSequence(): number;
}

export interface DecisionEffectActionPort {
  approve(id: string, opts?: { readonly humanAcknowledged?: readonly string[] }): Promise<unknown>;
  reject(id: string): Promise<unknown>;
  steer(id: string, comment: string): Promise<unknown>;
}

export interface DecisionEffectLegacyPort {
  read(): Promise<{
    readonly tasks: readonly {
      readonly id: string;
      readonly state: TaskState;
      readonly body: string;
      readonly title?: string;
      readonly repo?: string;
      readonly createdAt?: string | null;
    }[];
  }>;
}

export const DECISION_EFFECT_EXPECTED_STATE: Readonly<
  Record<V2PendingEffectRow['action'], TaskState>
> = {
  approve_outcome: 'done',
  reject_outcome: 'todo',
  request_changes: 'todo',
};

export type DecisionEffectOutcome =
  | {
      readonly kind: 'applied';
      readonly keyHash: string;
      readonly aggregateId: string;
      readonly action: V2PendingEffectRow['action'];
      readonly via: 'drove' | 'already_moved';
    }
  | {
      readonly kind: 'pending';
      readonly keyHash: string;
      readonly aggregateId: string;
      readonly action: V2PendingEffectRow['action'];
      readonly reason: 'legacy_task_missing' | 'action_refused' | 'legacy_state_unexpected';
      readonly detail: string;
    }
  | {
      readonly kind: 'skipped';
      readonly keyHash: string;
      readonly reason: 'not_pending' | 'unknown_marker';
    };

export interface DecisionEffectDivergence {
  readonly aggregateId: string;
  readonly v2Status: TaskState;
  readonly legacyState: TaskState | null;
  readonly pendingMarker: boolean;
}

export interface DecisionEffectDriver {
  /** Post-commit step: drive the effect for one committed decision; never throws; never changes the HTTP response. */
  driveCommitted(keyHash: string): Promise<DecisionEffectOutcome>;
  /** Boot + periodic re-drive over every pending marker; never throws. */
  redriveAll(): Promise<readonly DecisionEffectOutcome[]>;
  /**
   * Standing detector: for every aggregate, compare v2 task_status with the legacy
   * state; a mismatch WITHOUT a pending marker for that aggregate is reported
   * loudly (a mismatch WITH a pending marker is the marker's job). Grace: only
   * aggregates whose row is older than `graceMs` count. Purged tasks
   * (`v2=deleted` and legacy missing) are skipped.
   */
  detectDivergence(): Promise<readonly DecisionEffectDivergence[]>;
}

const STEER_COMMENT_MAX = 4000;
const DEFAULT_GRACE_MS = 60_000;
const HUMAN_CODE_PREFIX = 'human:';

export function createDecisionEffectDriver(ports: {
  readonly store: DecisionEffectStorePort;
  readonly actions: DecisionEffectActionPort;
  readonly legacy: DecisionEffectLegacyPort;
  readonly listAggregateIds: () => readonly string[];
  readonly log: (line: string) => void;
  readonly graceMs?: number;
  readonly now?: () => number;
}): DecisionEffectDriver {
  const graceMs = ports.graceMs ?? DEFAULT_GRACE_MS;
  const now = ports.now ?? (() => Date.now());
  const inFlight = new Map<string, Promise<DecisionEffectOutcome>>();

  async function driveOne(keyHash: string): Promise<DecisionEffectOutcome> {
    const marker = ports.store.readPendingEffect(keyHash);
    if (marker === null) {
      ports.log(`[hercules] decision effect: skipped ${keyHash} — unknown_marker`);
      return { kind: 'skipped', keyHash, reason: 'unknown_marker' };
    }
    if (marker.effectState !== 'pending') {
      ports.log(`[hercules] decision effect: skipped ${keyHash} — not_pending`);
      return { kind: 'skipped', keyHash, reason: 'not_pending' };
    }

    const expected = DECISION_EFFECT_EXPECTED_STATE[marker.action];
    let snapshot: Awaited<ReturnType<DecisionEffectLegacyPort['read']>>;
    try {
      snapshot = await ports.legacy.read();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ports.log(
        `[hercules] decision effect: aggregate ${marker.aggregateId} legacy read failed: ${detail}`,
      );
      return {
        kind: 'pending',
        keyHash,
        aggregateId: marker.aggregateId,
        action: marker.action,
        reason: 'action_refused',
        detail,
      };
    }

    const task = snapshot.tasks.find((entry) => entry.id === marker.aggregateId);
    if (task === undefined) {
      const detail = `legacy task '${marker.aggregateId}' missing`;
      ports.log(`[hercules] decision effect: ${detail}`);
      return {
        kind: 'pending',
        keyHash,
        aggregateId: marker.aggregateId,
        action: marker.action,
        reason: 'legacy_task_missing',
        detail,
      };
    }

    if (task.state === expected) {
      ports.store.markEffectApplied(keyHash, ports.store.latestEventSequence());
      return {
        kind: 'applied',
        keyHash,
        aggregateId: marker.aggregateId,
        action: marker.action,
        via: 'already_moved',
      };
    }

    if (task.state !== 'review') {
      const detail =
        `aggregate ${marker.aggregateId} legacy state ${task.state} — expected review or ${expected}`;
      ports.log(`[hercules] decision effect: ${detail}`);
      return {
        kind: 'pending',
        keyHash,
        aggregateId: marker.aggregateId,
        action: marker.action,
        reason: 'legacy_state_unexpected',
        detail,
      };
    }

    const decision = ports.store.readDecisionEvent(marker.eventSequence);
    if (decision === null) {
      const detail = `decision event at sequence ${marker.eventSequence} missing`;
      ports.log(`[hercules] decision effect: ${detail}`);
      return {
        kind: 'pending',
        keyHash,
        aggregateId: marker.aggregateId,
        action: marker.action,
        reason: 'action_refused',
        detail,
      };
    }

    try {
      if (marker.action === 'approve_outcome') {
        const resolved = resolveHumanAcknowledgedTexts({
          aggregateId: marker.aggregateId,
          body: task.body,
          title: task.title ?? marker.aggregateId,
          createdAt: task.createdAt ?? null,
          acknowledgedRiskCodes: decision.acknowledgedRiskCodes,
          packageCriteria: ports.store.readV2Aggregate(marker.aggregateId)?.reviewPackage?.criteria ?? [],
        });
        if (resolved.kind === 'refused') {
          ports.log(`[hercules] decision effect: ${resolved.detail}`);
          return {
            kind: 'pending',
            keyHash,
            aggregateId: marker.aggregateId,
            action: marker.action,
            reason: 'action_refused',
            detail: resolved.detail,
          };
        }
        const humanAcknowledged = resolved.texts;
        ports.log(
          `[hercules] decision effect: approve ${marker.aggregateId} via Control API V2 decision ${keyHash} by ${decision.actorIssuer}/${decision.actorId} at ${decision.decidedAt} acknowledging ${humanAcknowledged.length} human criteria`,
        );
        await ports.actions.approve(marker.aggregateId, { humanAcknowledged });
      } else if (marker.action === 'reject_outcome') {
        await ports.actions.reject(marker.aggregateId);
      } else {
        const comment = buildSteerComment(decision);
        await ports.actions.steer(marker.aggregateId, comment);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ports.log(
        `[hercules] decision effect: aggregate ${marker.aggregateId} ${marker.action} refused: ${detail}`,
      );
      return {
        kind: 'pending',
        keyHash,
        aggregateId: marker.aggregateId,
        action: marker.action,
        reason: 'action_refused',
        detail,
      };
    }

    let after: Awaited<ReturnType<DecisionEffectLegacyPort['read']>>;
    try {
      after = await ports.legacy.read();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ports.log(
        `[hercules] decision effect: aggregate ${marker.aggregateId} post-drive legacy read failed: ${detail}`,
      );
      return {
        kind: 'pending',
        keyHash,
        aggregateId: marker.aggregateId,
        action: marker.action,
        reason: 'action_refused',
        detail,
      };
    }
    const moved = after.tasks.find((entry) => entry.id === marker.aggregateId);
    if (moved === undefined || moved.state !== expected) {
      const detail =
        `post-drive legacy state ${moved?.state ?? 'missing'} — expected ${expected}`;
      ports.log(
        `[hercules] decision effect: aggregate ${marker.aggregateId} ${detail}`,
      );
      return {
        kind: 'pending',
        keyHash,
        aggregateId: marker.aggregateId,
        action: marker.action,
        reason: 'action_refused',
        detail,
      };
    }

    ports.store.markEffectApplied(keyHash, ports.store.latestEventSequence());
    return {
      kind: 'applied',
      keyHash,
      aggregateId: marker.aggregateId,
      action: marker.action,
      via: 'drove',
    };
  }

  async function driveCommitted(keyHash: string): Promise<DecisionEffectOutcome> {
    try {
      const existing = inFlight.get(keyHash);
      if (existing !== undefined) {
        return await existing;
      }
      const pending = driveOne(keyHash).finally(() => {
        inFlight.delete(keyHash);
      });
      inFlight.set(keyHash, pending);
      return await pending;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ports.log(`[hercules] decision effect: driveCommitted ${keyHash} failed: ${detail}`);
      return { kind: 'skipped', keyHash, reason: 'unknown_marker' };
    }
  }

  async function redriveAll(): Promise<readonly DecisionEffectOutcome[]> {
    const outcomes: DecisionEffectOutcome[] = [];
    try {
      const markers = ports.store.listPendingEffects();
      for (const marker of markers) {
        outcomes.push(await driveCommitted(marker.keyHash));
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ports.log(`[hercules] decision effect: redriveAll failed: ${detail}`);
    }
    return outcomes;
  }

  async function detectDivergence(): Promise<readonly DecisionEffectDivergence[]> {
    const reported: DecisionEffectDivergence[] = [];
    try {
      const snapshot = await ports.legacy.read();
      const legacyById = new Map(snapshot.tasks.map((task) => [task.id, task.state]));
      const pendingIds = new Set(
        ports.store.listPendingEffects().map((marker) => marker.aggregateId),
      );
      const nowMs = now();
      for (const aggregateId of ports.listAggregateIds()) {
        const row = ports.store.readV2Aggregate(aggregateId);
        if (row === null) continue;
        if (nowMs - row.updatedAtMs < graceMs) continue;
        const legacyState = legacyById.get(aggregateId) ?? null;
        // Purged tasks: v2 deleted and legacy gone — not a standing divergence.
        if (row.taskStatus === 'deleted' && legacyState === null) continue;
        const pendingMarker = pendingIds.has(aggregateId);
        if (legacyState === row.taskStatus) continue;
        if (pendingMarker) continue;
        const divergence: DecisionEffectDivergence = {
          aggregateId,
          v2Status: row.taskStatus,
          legacyState,
          pendingMarker: false,
        };
        reported.push(divergence);
        ports.log(
          `[hercules] decision effect: divergence aggregate ${aggregateId} v2=${row.taskStatus} legacy=${legacyState ?? 'missing'} (no pending marker)`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      ports.log(`[hercules] decision effect: detectDivergence failed: ${detail}`);
    }
    return reported;
  }

  return { driveCommitted, redriveAll, detectDivergence };
}

function criterionText(raw: string): string {
  const clean = parseMechProofBinding(raw).cleanText;
  return clean.length > 0 ? clean : raw;
}

function resolveHumanAcknowledgedTexts(input: {
  readonly aggregateId: string;
  readonly body: string;
  readonly title: string;
  readonly createdAt: string | null;
  readonly acknowledgedRiskCodes: readonly string[];
  readonly packageCriteria: readonly DecisionEffectPackageCriterion[];
}): { readonly kind: 'ok'; readonly texts: readonly string[] } | { readonly kind: 'refused'; readonly detail: string } {
  const packageHuman = input.packageCriteria.filter(
    (criterion) => criterion.authority === 'human',
  );
  const requiredHuman = packageHuman.some(
    (criterion) => typeof criterion.required === 'boolean',
  )
    ? packageHuman.filter((criterion) => criterion.required)
    : packageHuman;
  const packageHumanIds = new Set(packageHuman.map((criterion) => criterion.criterionId));
  const acknowledgedHumanIds = [
    ...new Set(
      input.acknowledgedRiskCodes
        .filter((code) => code.startsWith(HUMAN_CODE_PREFIX))
        .map((code) => code.slice(HUMAN_CODE_PREFIX.length)),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  for (const criterion of requiredHuman) {
    if (!acknowledgedHumanIds.includes(criterion.criterionId)) {
      return {
        kind: 'refused',
        detail:
          `aggregate ${input.aggregateId} missing human acknowledgement code ` +
          `human:${criterion.criterionId} — refusing approve (never fabricate)`,
      };
    }
  }
  for (const criterionId of acknowledgedHumanIds) {
    if (!packageHumanIds.has(criterionId)) {
      return {
        kind: 'refused',
        detail:
          `aggregate ${input.aggregateId} acknowledged human:${criterionId} is not a ` +
          'committed package human criterion — refusing approve',
      };
    }
  }

  const packageTextById = new Map<string, string>();
  for (const criterion of packageHuman) {
    if (typeof criterion.text === 'string' && criterion.text.length > 0) {
      packageTextById.set(criterion.criterionId, criterionText(criterion.text));
    }
  }

  // Resolve remaining ids through the legacy body compile (same id scheme as M4).
  const compiled = compileM4LegacyContract({
    id: input.aggregateId,
    title: input.title,
    repo: 'legacy',
    state: 'review',
    priority: 1,
    blockedBy: [],
    labels: [],
    adapter: null,
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: input.createdAt,
    startedAt: null,
    endedAt: null,
    prUrl: null,
    prStatus: null,
    planPending: false,
    verifiedSha: null,
    body: input.body,
  });
  for (const criterion of compiled.acceptanceCriteria) {
    if (criterion.authority !== 'human') continue;
    if (!packageTextById.has(criterion.id)) {
      packageTextById.set(criterion.id, criterionText(criterion.text));
    }
  }

  // Only REQUIRED human criteria gate the acknowledged-text equality check.
  // A known `human:` code for required:false (e.g. after-deploy) is accepted and ignored.
  const requiredHumanIds = new Set(requiredHuman.map((criterion) => criterion.criterionId));
  const acknowledgedTexts: string[] = [];
  for (const criterionId of acknowledgedHumanIds) {
    if (!requiredHumanIds.has(criterionId)) continue;
    const text = packageTextById.get(criterionId);
    if (text === undefined) {
      return {
        kind: 'refused',
        detail:
          `aggregate ${input.aggregateId} cannot resolve text for acknowledged ` +
          `human:${criterionId} against the committed package / legacy body — refusing approve`,
      };
    }
    acknowledgedTexts.push(text);
  }

  const bodyTexts = missingHumanAcknowledgements(input.body, []);
  const ackSet = new Set(acknowledgedTexts);
  const bodySet = new Set(bodyTexts);
  if (ackSet.size !== bodySet.size || [...bodySet].some((text) => !ackSet.has(text))) {
    return {
      kind: 'refused',
      detail:
        `aggregate ${input.aggregateId} legacy body human criteria do not equal the ` +
        'acknowledged committed-package human texts — refusing approve ' +
        `(body=${JSON.stringify(bodyTexts)} acknowledged=${JSON.stringify(acknowledgedTexts)})`,
    };
  }

  return { kind: 'ok', texts: bodyTexts };
}

function buildSteerComment(decision: DecisionEventView): string {
  const raw =
    `Control API V2 request_changes (${decision.actorIssuer}/${decision.actorId}, ${decision.decidedAt}): ${decision.reason}`;
  return raw.length <= STEER_COMMENT_MAX ? raw : raw.slice(0, STEER_COMMENT_MAX);
}

/**
 * Adapt a ControlStateStore-shaped object (+ aggregate updatedAt lookup) into
 * the narrower DecisionEffectStorePort. Callers supply `updatedAtMs` via the
 * aggregate row's control-event tip (`updatedAtSequence` → occurred_at).
 */
export function adaptDecisionEffectStore(store: {
  readPendingEffect(keyHash: string): V2PendingEffectRow | null;
  listPendingEffects(): readonly V2PendingEffectRow[];
  markEffectApplied(keyHash: string, appliedAtSequence: number): V2PendingEffectRow;
  readDecisionEvent(eventSequence: number): DecisionEventView | null;
  readV2Aggregate(aggregateId: string): {
    readonly taskStatus: TaskState;
    readonly updatedAtSequence: number;
    readonly reviewPackage: {
      readonly criteria: readonly DecisionEffectPackageCriterion[];
    } | null;
  } | null;
  readEvents(afterSequence: number, limit: number): readonly { readonly occurredAt: string }[];
  latestEventSequence(): number;
}): DecisionEffectStorePort {
  return {
    readPendingEffect: (keyHash) => store.readPendingEffect(keyHash),
    listPendingEffects: () => store.listPendingEffects(),
    markEffectApplied: (keyHash, appliedAtSequence) =>
      store.markEffectApplied(keyHash, appliedAtSequence),
    readDecisionEvent: (eventSequence) => store.readDecisionEvent(eventSequence),
    latestEventSequence: () => store.latestEventSequence(),
    readV2Aggregate: (aggregateId) => {
      const row = store.readV2Aggregate(aggregateId);
      if (row === null) return null;
      const events = store.readEvents(Math.max(0, row.updatedAtSequence - 1), 1);
      const tip = events[0];
      const updatedAtMs = tip === undefined ? 0 : Date.parse(tip.occurredAt);
      return {
        taskStatus: row.taskStatus,
        updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
        reviewPackage: row.reviewPackage === null
          ? null
          : { criteria: row.reviewPackage.criteria },
      };
    },
  };
}
