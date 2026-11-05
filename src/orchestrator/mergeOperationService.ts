/** Merge Selected as an idempotent long-running operation. */
import { randomBytes } from 'node:crypto';
import { isValidIdentifier } from '../domain/task.js';
import {
  canTransitionMergeOperationStatus,
  classifyMergeFailureReason,
  isMergeOperationTerminal,
  makeMergeOperationId,
  MERGE_OPERATION_RECORD_VERSION,
  redactMergeFailureReason,
  safePublicMergeReceipt,
  sameOrderedTaskIds,
  type MergeGateProgress,
  type MergeOperationFailure,
  type MergeOperationFailureKind,
  type MergeOperationPhase,
  type MergeOperationReceipt,
  type MergeOperationRecord,
  type MergeOperationStatus,
} from '../domain/mergeOperation.js';
import { MergeOperationStore } from '../isolation/mergeOperationStore.js';
import { MergeError, MergeService, type MergeServiceDeps } from './mergeService.js';

export class MergeOperationError extends Error {
  override readonly name = 'MergeOperationError';
}

export interface MergeOperationServiceDeps {
  readonly store: MergeOperationStore;
  readonly mergeDeps: MergeServiceDeps;
  readonly clock?: () => number;
  readonly pid?: number;
  /** Test seam for a crash after push + durable task stamps, before receipt finalization. */
  readonly afterMergeBeforeSuccessPatch?: () => Promise<void>;
}

export interface StartMergeInput {
  readonly repoKey: string;
  readonly taskIds: readonly string[];
  readonly idempotencyKey?: string | null;
}

type PatchInput = {
  readonly status?: MergeOperationStatus;
  readonly phase?: MergeOperationPhase;
  readonly mergedSha?: string | null;
  readonly failures?: readonly MergeOperationFailure[];
  readonly gateProgress?: MergeGateProgress | null;
  /** C3.57: set on success when the merge inherited L1 from the verified sha. */
  readonly gatesInheritedFromSha?: string | null;
  readonly failureKind?: MergeOperationFailureKind | null;
};

/**
 * Task stamps can prove completion only after this operation durably recorded
 * that its own push completed. Earlier task provenance may belong to a prior
 * Merge Selected operation for the same tasks.
 */
const PROVENANCE_RECONCILABLE_PHASES: ReadonlySet<MergeOperationPhase> = new Set([
  'pushed',
  'stamping',
  'stamped',
]);

const MAX_UNCERTAIN_ACCEPTANCES = 128;

export class MergeOperationService {
  private readonly store: MergeOperationStore;
  private readonly mergeDeps: MergeServiceDeps;
  private readonly clock: () => number;
  private readonly pid: number;
  private readonly afterMergeBeforeSuccessPatch: (() => Promise<void>) | undefined;
  private seq = 0;
  private readonly liveByRepo = new Map<string, string>();
  private readonly livePromises = new Map<string, Promise<void>>();
  private readonly uncertainAcceptances = new Map<string, MergeOperationRecord>();
  private startChain: Promise<unknown> = Promise.resolve();
  private patchChain: Promise<unknown> = Promise.resolve();

  constructor(deps: MergeOperationServiceDeps) {
    this.store = deps.store;
    this.mergeDeps = deps.mergeDeps;
    this.clock = deps.clock ?? (() => Date.now());
    this.pid = deps.pid ?? process.pid;
    this.afterMergeBeforeSuccessPatch = deps.afterMergeBeforeSuccessPatch;
  }

  async get(operationId: string): Promise<MergeOperationReceipt | null> {
    if (!isValidIdentifier(operationId)) throw new MergeOperationError('unsafe operation id');
    const record = await this.store.get(operationId);
    return record ? safePublicMergeReceipt(record) : null;
  }

  async waitFor(operationId: string): Promise<MergeOperationReceipt | null> {
    const p = this.livePromises.get(operationId);
    if (p) await p;
    return this.get(operationId);
  }

  async reconcileInterrupted(): Promise<readonly MergeOperationReceipt[]> {
    const all = await this.store.listAll();
    let tasksById = new Map<string, Awaited<ReturnType<MergeServiceDeps['control']['read']>>['tasks'][number]>();
    try {
      const snapshot = await this.mergeDeps.control.read();
      tasksById = new Map(snapshot.tasks.map((task) => [task.id, task]));
    } catch {
      // An unavailable control plane cannot prove success. Active records are
      // still bounded below as interrupted instead of remaining ambiguous.
    }
    const out: MergeOperationReceipt[] = [];
    for (const rec of all) {
      if (isMergeOperationTerminal(rec.status)) continue;
      if (this.liveByRepo.get(rec.repoKey) === rec.operationId) continue;
      if (this.livePromises.has(rec.operationId)) continue;
      const selected = rec.taskIds.map((taskId) => tasksById.get(taskId));
      const commonMergedSha = selected[0]?.mergedSha ?? null;
      const provenanceComplete =
        PROVENANCE_RECONCILABLE_PHASES.has(rec.phase) &&
        typeof commonMergedSha === 'string' &&
        /^[0-9a-f]{40}$/i.test(commonMergedSha) &&
        selected.every(
          (task) =>
            task !== undefined &&
            task.repo === rec.repoKey &&
            task.mergedVia === 'gate' &&
            task.mergedSha === commonMergedSha,
        );
      const next = provenanceComplete
        ? await this.patch(rec.operationId, {
            status: 'succeeded',
            phase: 'stamped',
            mergedSha: commonMergedSha,
            failureKind: null,
            failures: [],
            gateProgress: null,
          })
        : await this.patch(rec.operationId, {
            status: 'interrupted',
            phase: 'interrupted',
            mergedSha: null,
            failureKind: 'interrupted',
            failures: [{
              taskId: rec.taskIds[0] ?? rec.repoKey,
              reason: 'daemon restart interrupted merge - re-run Merge Selected',
              kind: 'interrupted',
            }],
          });
      if (next) out.push(safePublicMergeReceipt(next));
    }
    return out;
  }

  async start(input: StartMergeInput): Promise<MergeOperationReceipt> {
    const run = this.startChain.then(
      () => this.startInner(input),
      () => this.startInner(input),
    );
    this.startChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startInner(input: StartMergeInput): Promise<MergeOperationReceipt> {
    const repoKey = input.repoKey;
    if (!isValidIdentifier(repoKey)) throw new MergeOperationError('unsafe repo key');
    const ordered = this.normalizeTaskIds(input.taskIds);
    const idem = input.idempotencyKey ?? null;
    if (idem) {
      const existing = await this.store.getByIdempotencyKey(repoKey, idem);
      if (existing) {
        if (!sameOrderedTaskIds(existing.taskIds, ordered)) {
          throw new MergeOperationError('idempotencyKey reuse with different task selection');
        }
        const expected = this.consumeUncertainAcceptance(repoKey, idem);
        if (await this.canAdoptAccepted(existing, expected)) {
          return this.launchAccepted(existing);
        }
        return safePublicMergeReceipt(existing);
      }
    }
    if (this.liveByRepo.has(repoKey) || (await this.store.findActiveForRepo(repoKey))) {
      throw new MergeOperationError("merge already in flight for repo '" + repoKey + "'");
    }
    const now = this.clock();
    this.seq += 1;
    const operationId = makeMergeOperationId(now, this.seq, randomBytes(4).toString('hex'));
    const record: MergeOperationRecord = {
      version: MERGE_OPERATION_RECORD_VERSION,
      operationId,
      repoKey,
      taskIds: ordered,
      idempotencyKey: idem,
      status: 'accepted',
      phase: 'accepted',
      mergedSha: null,
      failures: [],
      createdAtMs: now,
      updatedAtMs: now,
      gateProgress: null,
      failureKind: null,
      ownerPid: this.pid,
    };
    try {
      await this.store.put(record);
    } catch (putError) {
      let durable: MergeOperationRecord | null = null;
      try {
        durable = await this.store.get(operationId);
      } catch {
        if (idem !== null) this.rememberUncertainAcceptance(record);
        throw putError;
      }
      if (!this.isExactAcceptedRecord(durable, record)) throw putError;
      return this.launchAccepted(durable);
    }
    return this.launchAccepted(record);
  }

  private isExactAcceptedRecord(
    actual: MergeOperationRecord | null,
    expected: MergeOperationRecord,
  ): actual is MergeOperationRecord {
    return (
      actual !== null &&
      actual.operationId === expected.operationId &&
      actual.repoKey === expected.repoKey &&
      sameOrderedTaskIds(actual.taskIds, expected.taskIds) &&
      actual.idempotencyKey === expected.idempotencyKey &&
      actual.status === 'accepted' &&
      actual.phase === 'accepted' &&
      actual.mergedSha === null &&
      actual.failures.length === 0 &&
      actual.createdAtMs === expected.createdAtMs &&
      actual.updatedAtMs === expected.updatedAtMs &&
      actual.gateProgress === null &&
      actual.failureKind === null &&
      actual.ownerPid === expected.ownerPid
    );
  }

  private uncertaintyKey(repoKey: string, idempotencyKey: string): string {
    return `${repoKey}\0${idempotencyKey}`;
  }

  private rememberUncertainAcceptance(record: MergeOperationRecord): void {
    if (record.idempotencyKey === null) return;
    const key = this.uncertaintyKey(record.repoKey, record.idempotencyKey);
    this.uncertainAcceptances.delete(key);
    this.uncertainAcceptances.set(key, record);
    while (this.uncertainAcceptances.size > MAX_UNCERTAIN_ACCEPTANCES) {
      const oldest = this.uncertainAcceptances.keys().next().value;
      if (oldest === undefined) break;
      this.uncertainAcceptances.delete(oldest);
    }
  }

  private consumeUncertainAcceptance(
    repoKey: string,
    idempotencyKey: string,
  ): MergeOperationRecord | null {
    const key = this.uncertaintyKey(repoKey, idempotencyKey);
    const expected = this.uncertainAcceptances.get(key) ?? null;
    this.uncertainAcceptances.delete(key);
    return expected;
  }

  /** Recover only the exact acceptance whose put and immediate reread were
   * uncertain in this service instance. A restarted service has no marker and
   * therefore leaves durable accepted records to fail-closed reconciliation. */
  private async canAdoptAccepted(
    record: MergeOperationRecord,
    expected: MergeOperationRecord | null,
  ): Promise<boolean> {
    if (
      expected === null ||
      !this.isExactAcceptedRecord(record, expected) ||
      this.liveByRepo.has(record.repoKey) ||
      this.livePromises.has(record.operationId)
    ) {
      return false;
    }
    const active = (await this.store.listAll()).filter(
      (candidate) =>
        candidate.repoKey === record.repoKey &&
        (candidate.status === 'accepted' || candidate.status === 'running'),
    );
    return (
      active.length === 1 &&
      this.isExactAcceptedRecord(active[0] ?? null, expected) &&
      !this.liveByRepo.has(record.repoKey) &&
      !this.livePromises.has(record.operationId)
    );
  }

  private launchAccepted(record: MergeOperationRecord): MergeOperationReceipt {
    const { operationId, repoKey } = record;
    this.liveByRepo.set(repoKey, operationId);
    const run = this.runInBackground(record);
    this.livePromises.set(operationId, run);
    const cleanup = (): void => {
      this.livePromises.delete(operationId);
      if (this.liveByRepo.get(repoKey) === operationId) this.liveByRepo.delete(repoKey);
    };
    // Attach both branches directly. Promise.finally() creates a new rejected
    // promise when `run` rejects, which would otherwise escape as an
    // unhandledRejection during the recovery path.
    void run.then(cleanup, cleanup);
    return safePublicMergeReceipt(record);
  }

  private normalizeTaskIds(taskIds: readonly string[]): string[] {
    if (taskIds.length === 0) throw new MergeOperationError('taskIds must be a non-empty array');
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of taskIds) {
      if (!isValidIdentifier(id)) throw new MergeOperationError('unsafe task id');
      if (seen.has(id)) continue;
      seen.add(id);
      ordered.push(id);
    }
    if (ordered.length === 0) throw new MergeOperationError('taskIds must be a non-empty array');
    return ordered;
  }

  private async failOp(
    operationId: string,
    taskId: string,
    message: string,
  ): Promise<void> {
    const kind = classifyMergeFailureReason(message);
    await this.patch(operationId, {
      status: 'failed',
      phase: 'failed',
      failureKind: kind,
      failures: [{ taskId, reason: redactMergeFailureReason(message), kind }],
    });
  }

  private async runInBackground(initial: MergeOperationRecord): Promise<void> {
    await this.executeMerge(initial);
  }

  private async executeMerge(initial: MergeOperationRecord): Promise<void> {
    const { operationId, repoKey, taskIds } = initial;
    try {
      await this.patch(operationId, { status: 'running', phase: 'precheck' });
      const merge = new MergeService({
        control: this.mergeDeps.control,
        workspaces: this.mergeDeps.workspaces,
        ...(this.mergeDeps.commandRunner
          ? { commandRunner: this.mergeDeps.commandRunner }
          : {}),
        ...(this.mergeDeps.succession ? { succession: this.mergeDeps.succession } : {}),
        ...(this.mergeDeps.receiptStore
          ? { receiptStore: this.mergeDeps.receiptStore }
          : {}),
        ...(this.mergeDeps.now ? { now: this.mergeDeps.now } : {}),
        onProgress: (ev) => {
          const progressPatch = this.patch(operationId, {
            phase: ev.phase,
            status: 'running',
            gateProgress: ev.gateProgress ?? null,
          });
          void progressPatch.then(
            () => undefined,
            () => undefined,
          );
        },
      });
      try {
        const result = await merge.mergeBatch(repoKey, taskIds);
        if (result.ok && result.mergedSha) {
          await this.afterMergeBeforeSuccessPatch?.();
          await this.patch(operationId, {
            status: 'succeeded',
            // `stamped` is the public terminal phase: MergeService returns
            // success only after every selected task has durable gate provenance.
            phase: 'stamped',
            mergedSha: result.mergedSha,
            failures: [],
            failureKind: null,
            gateProgress: null,
            gatesInheritedFromSha: result.gatesInheritedFromSha ?? null,
          });
          return;
        }
        const failures: MergeOperationFailure[] = result.failures.map((f) => {
          const kind = classifyMergeFailureReason(f.reason);
          return { taskId: f.taskId, reason: redactMergeFailureReason(f.reason), kind };
        });
        await this.patch(operationId, {
          status: 'failed',
          phase: 'failed',
          mergedSha: null,
          failures,
          failureKind: failures[0]?.kind ?? 'unknown',
          gateProgress: null,
        });
      } catch (err) {
        const message =
          err instanceof MergeError || err instanceof Error ? err.message : String(err);
        await this.failOp(operationId, taskIds[0] ?? repoKey, message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failOp(operationId, taskIds[0] ?? repoKey, message);
    }
  }

  private async patch(
    operationId: string,
    patch: PatchInput,
  ): Promise<MergeOperationRecord | null> {
    const run = this.patchChain.then(
      () => this.patchInner(operationId, patch),
      () => this.patchInner(operationId, patch),
    );
    this.patchChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async patchInner(
    operationId: string,
    patch: PatchInput,
  ): Promise<MergeOperationRecord | null> {
    const cur = await this.store.get(operationId);
    if (!cur) return null;
    if (
      isMergeOperationTerminal(cur.status) &&
      patch.status !== undefined &&
      patch.status !== cur.status
    ) {
      return cur;
    }
    const nextStatus = patch.status ?? cur.status;
    if (!canTransitionMergeOperationStatus(cur.status, nextStatus)) return cur;
    const phase = patch.phase ?? cur.phase;
    const phaseOrder: readonly MergeOperationPhase[] = [
      'accepted',
      'precheck',
      'merging',
      'gating',
      'pushing',
      'pushed',
      'stamping',
      'stamped',
      'succeeded',
      'failed',
      'interrupted',
    ];
    if (
      !isMergeOperationTerminal(nextStatus) &&
      phaseOrder.indexOf(phase) < phaseOrder.indexOf(cur.phase)
    ) {
      return cur;
    }
    let status = nextStatus;
    if (status === 'accepted' && phase !== 'accepted') status = 'running';
    if (
      (status === 'accepted' || status === 'running') &&
      (phase === 'succeeded' || phase === 'failed' || phase === 'interrupted')
    ) {
      status = phase;
    }
    return this.writePatch(cur, status, phase, patch);
  }

  private async writePatch(
    cur: MergeOperationRecord,
    status: MergeOperationStatus,
    phase: MergeOperationPhase,
    patch: PatchInput,
  ): Promise<MergeOperationRecord> {
    const next: MergeOperationRecord = {
      ...cur,
      status,
      phase,
      mergedSha: patch.mergedSha !== undefined ? patch.mergedSha : cur.mergedSha,
      failures: patch.failures !== undefined ? [...patch.failures] : cur.failures,
      gateProgress: patch.gateProgress !== undefined ? patch.gateProgress : cur.gateProgress,
      failureKind: patch.failureKind !== undefined ? patch.failureKind : cur.failureKind,
      ...(patch.gatesInheritedFromSha !== undefined
        ? { gatesInheritedFromSha: patch.gatesInheritedFromSha }
        : cur.gatesInheritedFromSha !== undefined
          ? { gatesInheritedFromSha: cur.gatesInheritedFromSha }
          : {}),
      updatedAtMs: this.clock(),
    };
    await this.store.put(next);
    return next;
  }
}
