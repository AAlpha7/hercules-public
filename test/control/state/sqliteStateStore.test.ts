import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGED_APPROVAL_POLICY,
  bridgeContractSuccessorCommand,
  bridgeDeliveryId,
} from '../../../src/domain/approvalPolicyBridge.js';
import { canonicalSerialize } from '../../../src/domain/canonicalJson.js';
import type {
  ContractChangeProvenance,
  ContractChangeRequest,
  TrustedContractChangeAuthority,
} from '../../../src/domain/contractChange.js';
import { compileLegacyTaskContract } from '../../../src/domain/contractCompiler.js';
import { transitionIteration, type Iteration } from '../../../src/domain/iteration.js';
import { transitionStageRun, type StageRun } from '../../../src/domain/stageRun.js';
import { compileM4LegacyContract } from '../../../src/domain/shadowProjection.js';
import type { Task } from '../../../src/domain/task.js';
import type { TaskContract } from '../../../src/domain/taskContract.js';
import {
  SqliteStateStore,
  type StateStoreFailurePoint,
} from '../../../src/control/state/sqliteStateStore.js';
import {
  StateStoreError,
  type ShadowCommitCommand,
} from '../../../src/control/state/stateStore.js';
import { commandDigest } from '../../../src/control/state/stateStoreValidation.js';

interface Paths {
  readonly parent: string;
  readonly root: string;
  readonly database: string;
}

const cleanup: string[] = [];

function paths(): Paths {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-state-store-'));
  cleanup.push(parent);
  const root = join(parent, 'state');
  return { parent, root, database: join(root, 'shadow.sqlite') };
}

function storeAt(
  target: Paths,
  failureInjector?: (point: StateStoreFailurePoint) => void,
  busyTimeoutMs = 100,
): SqliteStateStore {
  return new SqliteStateStore({
    trustedRoot: target.root,
    databasePath: target.database,
    busyTimeoutMs,
    ...(failureInjector === undefined ? {} : { failureInjector }),
  });
}

function rootContract(taskId = 'task-1'): TaskContract {
  return compileLegacyTaskContract({
    taskId,
    objective: 'Persist a shadow projection',
    body: '## DoD\n- [ ] (mechanical) state tests pass @gate:test',
    context: [],
    constraints: ['legacy control files remain authoritative'],
    forbiddenActions: ['deploy'],
    capabilityPolicy: { version: '1', grants: [] },
    verificationPolicy: {
      version: '1',
      requiredEvidence: ['test'],
      independentEvaluatorRequired: true,
    },
    approvalPolicy: { version: '1', requiredDecisions: [] },
    budgetPolicy: {
      version: '1',
      maxCostUsd: null,
      maxTokens: null,
      maxDurationMs: null,
    },
    createdBy: { kind: 'human', id: 'owner' },
    createdAt: '2026-08-28T00:00:00Z',
  }).contract;
}

function command(
  id: string,
  mutation: ShadowCommitCommand['mutation'],
  occurredAt = '2026-08-28T00:00:00Z',
): ShadowCommitCommand {
  return {
    idempotencyKey: `idem-${id}`,
    event: {
      eventId: `event-${id}`,
      actor: { kind: 'control_plane', id: 'shadow-projector' },
      occurredAt,
    },
    mutation,
  };
}

function rootCommand(id = 'root', taskId = 'task-1'): ShadowCommitCommand {
  return command(id, { kind: 'insert_contract_root', contract: rootContract(taskId) });
}

function successorParts(): {
  readonly request: ContractChangeRequest;
  readonly provenance: ContractChangeProvenance;
  readonly trustedAuthority: TrustedContractChangeAuthority;
} {
  return {
    request: {
      id: 'change-1',
      taskId: 'task-1',
      baseContractVersion: 1,
      requestedBy: { kind: 'human', id: 'owner' },
      reason: 'Clarify the shadow-state objective',
      proposedPatch: [{ op: 'replace', path: '/objective', value: 'Persist an audited shadow projection' }],
      meaningChange: true,
      riskChange: false,
      status: 'approved',
      policyDecisionId: 'policy-1',
      humanDecisionId: null,
    },
    provenance: {
      createdBy: { kind: 'control_plane', id: 'contract-change' },
      createdAt: '2026-08-28T00:01:00Z',
    },
    trustedAuthority: {
      approvedRequestId: 'change-1',
      policyDecisionId: 'policy-1',
      humanDecisionId: null,
    },
  };
}

function plannedIteration(): Iteration {
  return {
    id: 'iteration-1',
    taskId: 'task-1',
    contractVersion: 1,
    ordinal: 1,
    state: 'planned',
    candidateRef: null,
    evidenceManifestId: null,
    finalVerdictId: null,
    createdAt: '2026-08-28T00:02:00Z',
    endedAt: null,
    supersedesIterationId: null,
  };
}

function queuedStage(): StageRun {
  return {
    id: 'stage-1',
    iterationId: 'iteration-1',
    type: 'implement',
    attempt: 1,
    state: 'queued',
    jobSpecHash: 'sha256:job-1',
    workerId: null,
    agentRunIds: [],
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    structuredResult: null,
    startedAt: null,
    endedAt: null,
    failureClass: null,
  };
}

function expectCode(action: () => unknown, code: StateStoreError['code']): void {
  try {
    action();
    throw new Error(`expected StateStoreError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(StateStoreError);
    expect((error as StateStoreError).code).toBe(code);
  }
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('SQLite shadow state store', () => {
  it('initializes a private WAL/FULL/FK database and re-verifies it on restart', () => {
    const target = paths();
    const store = storeAt(target);
    expect(store.initialize()).toEqual({
      schemaVersion: 7,
      eventCount: 0,
      receiptCount: 0,
      lastEventHash: null,
      journalMode: 'wal',
      foreignKeys: true,
      synchronous: 'full',
    });
    expect(lstatSync(target.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(target.database).mode & 0o777).toBe(0o600);
    store.close();

    const reopened = storeAt(target);
    expect(reopened.initialize()).toMatchObject({ eventCount: 0, receiptCount: 0 });
    reopened.close();
  });

  it('commits root and approved successor atomically with durable idempotency', () => {
    const target = paths();
    const first = storeAt(target);
    first.initialize();
    const root = rootCommand();
    const receipt = first.commit(root);
    expect(first.commit(root)).toEqual(receipt);
    expectCode(() => first.commit({ ...root, event: { ...root.event, eventId: 'event-other' } }), 'idempotency_conflict');

    const successor = successorParts();
    first.commit(command('successor', { kind: 'append_contract_successor', ...successor }, '2026-08-28T00:01:00Z'));
    expect(first.readTask('task-1')?.contracts.map((item) => item.version)).toEqual([1, 2]);
    expect(first.readEvents(0, 10).map((event) => event.eventType)).toEqual([
      'ShadowContractRootProjected',
      'ShadowContractSuccessorProjected',
    ]);
    first.close();

    const reopened = storeAt(target);
    expect(reopened.initialize()).toMatchObject({ eventCount: 2, receiptCount: 2 });
    expect(reopened.commit(root)).toEqual(receipt);
    reopened.close();
  });

  it('rejects untrusted or stale successor authority without writing an event', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    store.commit(rootCommand());
    const successor = successorParts();
    const forged = {
      ...successor,
      trustedAuthority: { ...successor.trustedAuthority, policyDecisionId: 'other-policy' },
    };
    expectCode(
      () => store.commit(command('forged-successor', { kind: 'append_contract_successor', ...forged })),
      'constraint',
    );
    expect(store.readEvents(0, 10)).toHaveLength(1);
    expect(store.readTask('task-1')?.contracts).toHaveLength(1);
    store.close();
  });

  it('commits the C3 approvalPolicy bridge successor with riskChange + humanDecisionId', () => {
    const target = paths();
    const first = storeAt(target);
    first.initialize();
    const m4Task: Task = {
      id: 'task-bridge',
      title: 'Bridge locked contract',
      repo: 'app',
      state: 'todo',
      priority: 1,
      blockedBy: [],
      labels: [],
      adapter: null,
      agentSession: null,
      pendingSteer: null,
      attempts: 0,
      lastEventAt: null,
      createdAt: '2026-08-28T00:00:00Z',
      startedAt: null,
      endedAt: null,
      prUrl: null,
      prStatus: null,
      planPending: false,
      verifiedSha: null,
      body: '## Definition of Done\n- [ ] (mechanical) state tests pass @gate:test',
    };
    const root = compileM4LegacyContract(m4Task);
    first.commit(command('m4-root', { kind: 'insert_contract_root', contract: root }));
    const mutation = bridgeContractSuccessorCommand(bridgeDeliveryId('a'.repeat(40)), [root]);
    expect(mutation.request).toMatchObject({
      riskChange: true,
      humanDecisionId: expect.any(String),
    });
    expect(mutation.request.proposedPatch.map((operation) => operation.path)).toEqual([
      '/approvalPolicy',
      '/verificationPolicy',
      '/acceptanceCriteria',
    ]);
    expect(mutation.request.proposedPatch[0]).toMatchObject({
      path: '/approvalPolicy',
      value: {
        version: BRIDGED_APPROVAL_POLICY.version,
        requiredDecisions: [...BRIDGED_APPROVAL_POLICY.requiredDecisions],
      },
    });

    const forgedHuman = {
      ...mutation,
      trustedAuthority: {
        ...mutation.trustedAuthority,
        humanDecisionId: 'tampered-owner-decision',
      },
    };
    expectCode(
      () => first.commit(command('tampered-bridge', forgedHuman)),
      'constraint',
    );
    expect(first.readEvents(0, 10)).toHaveLength(1);
    expect(first.readTask('task-bridge')?.contracts).toHaveLength(1);

    first.commit(command('m4-bridge', mutation, '2026-09-01T00:00:00.000Z'));
    expect(first.readTask('task-bridge')?.contracts.map((item) => item.version)).toEqual([1, 2]);
    expect(first.readTask('task-bridge')?.contracts[1]).toMatchObject({
      supersedesVersion: 1,
      approvalPolicy: BRIDGED_APPROVAL_POLICY,
    });
    expect(first.readEvents(0, 10).map((event) => event.eventType)).toEqual([
      'ShadowContractRootProjected',
      'ShadowContractSuccessorProjected',
    ]);
    first.close();

    const reopened = storeAt(target);
    expect(reopened.initialize()).toMatchObject({ eventCount: 2, receiptCount: 2 });
    expect(reopened.readTask('task-bridge')?.contracts[1]).toMatchObject({
      version: 2,
      approvalPolicy: BRIDGED_APPROVAL_POLICY,
    });
    reopened.close();
  });

  it('persists only valid iteration and stage transitions', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    store.commit(rootCommand());
    const planned = plannedIteration();
    store.commit(command('iteration-planned', { kind: 'put_iteration', iteration: planned }));
    const executing = transitionIteration(planned, 'executing', null);
    store.commit(command('iteration-executing', { kind: 'put_iteration', iteration: executing }));
    const queued = queuedStage();
    store.commit(command('stage-queued', { kind: 'put_stage_run', stageRun: queued }));
    const leased = transitionStageRun(
      queued,
      'leased',
      { startedAt: null, endedAt: null },
      null,
      'worker-1',
    );
    store.commit(command('stage-leased', { kind: 'put_stage_run', stageRun: leased }));

    expectCode(
      () => store.commit(command('iteration-rewrite', {
        kind: 'put_iteration',
        iteration: { ...executing, createdAt: 'rewritten' },
      })),
      'constraint',
    );
    expect(store.readTask('task-1')).toMatchObject({
      iterations: [{ state: 'executing' }],
      stageRuns: [{ state: 'leased', workerId: 'worker-1' }],
    });
    store.close();
  });

  it('rejects artifact-kind iteration candidates through the general V3 mutation port', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    store.commit(rootCommand());
    const planned = plannedIteration();
    store.commit(command('artifact-candidate-planned', { kind: 'put_iteration', iteration: planned }));
    const executing = transitionIteration(planned, 'executing', null);
    store.commit(command('artifact-candidate-executing', { kind: 'put_iteration', iteration: executing }));
    const candidate: Iteration = {
      ...executing,
      state: 'verifying',
      candidateRef: {
        kind: 'artifact',
        artifactId: 'candidate-artifact',
        sha256: `sha256:${'a'.repeat(64)}`,
      },
    };
    expectCode(
      () => store.commit(command('artifact-candidate-verifying', {
        kind: 'put_iteration',
        iteration: candidate,
      })),
      'constraint',
    );
    expect(store.readTask('task-1')?.iterations[0]?.state).toBe('executing');
    store.close();
  });

  it.each([
    'after_projection',
    'after_event',
    'after_receipt',
    'before_commit',
  ] as const)('rolls back every table when failure is injected at %s', (selected) => {
    const target = paths();
    const store = storeAt(target, (point) => {
      if (point === selected) throw new Error(`injected ${point}`);
    });
    store.initialize();
    expectCode(() => store.commit(rootCommand()), 'integrity');
    expect(store.readTask('task-1')).toBeNull();
    expect(store.readEvents(0, 10)).toEqual([]);
    store.close();

    const reopened = storeAt(target);
    expect(reopened.initialize()).toMatchObject({ eventCount: 0, receiptCount: 0 });
    reopened.close();
  });

  it('fails closed when schema, events, or receipts are tampered', () => {
    for (const tamper of ['schema', 'event', 'receipt'] as const) {
      const target = paths();
      const store = storeAt(target);
      store.initialize();
      store.commit(rootCommand());
      store.close();
      const raw = new Database(target.database);
      if (tamper === 'schema') {
        raw.exec('DROP TRIGGER control_events_no_delete');
      } else {
        const trigger = tamper === 'event' ? 'control_events_no_update' : 'command_receipts_no_update';
        const table = tamper === 'event' ? 'control_events' : 'command_receipts';
        const column = tamper === 'event' ? 'payload_json' : 'result_json';
        const sql = (raw.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
        ).pluck().get(trigger)) as string;
        raw.exec(`DROP TRIGGER ${trigger}`);
        raw.prepare(`UPDATE ${table} SET ${column} = ?`).run('{}');
        raw.exec(sql);
      }
      raw.close();
      const reopened = storeAt(target);
      expectCode(() => reopened.initialize(), 'integrity');
      reopened.close();
    }
  });

  it.each([
    ['contract', 'contract_hash', `sha256:${'f'.repeat(64)}`],
    ['iteration', 'contract_version', 2],
    ['stage', 'attempt', 2],
  ] as const)('detects valid-SQLite %s projection-column tampering', (kind, column, value) => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    store.commit(rootCommand());
    if (kind === 'iteration') {
      const successor = successorParts();
      store.commit(command('successor', { kind: 'append_contract_successor', ...successor }));
      store.commit(command('iteration', { kind: 'put_iteration', iteration: plannedIteration() }));
    }
    if (kind === 'stage') {
      store.commit(command('iteration', { kind: 'put_iteration', iteration: plannedIteration() }));
      store.commit(command('stage', { kind: 'put_stage_run', stageRun: queuedStage() }));
    }
    store.close();

    const raw = new Database(target.database);
    if (kind === 'contract') {
      const triggerSql = raw.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'shadow_contracts_no_update'",
      ).pluck().get() as string;
      raw.exec('DROP TRIGGER shadow_contracts_no_update');
      raw.prepare(`UPDATE shadow_task_contracts SET ${column} = ?`).run(value);
      raw.exec(triggerSql);
    } else if (kind === 'iteration') {
      raw.prepare(`UPDATE shadow_iterations SET ${column} = ?`).run(value);
    } else {
      raw.prepare(`UPDATE shadow_stage_runs SET ${column} = ?`).run(value);
    }
    raw.close();

    const reopened = storeAt(target);
    expectCode(() => reopened.initialize(), 'integrity');
    reopened.close();
  });

  it('detects retirement revision column tampering during startup replay', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    store.commit(rootCommand());
    store.commit(command('retire-tamper', {
      kind: 'retire_task',
      taskId: 'task-1',
      revision: 'd'.repeat(40),
    }));
    store.close();

    const raw = new Database(target.database);
    const triggerSql = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'shadow_retirements_no_update'",
    ).pluck().get() as string;
    raw.exec('DROP TRIGGER shadow_retirements_no_update');
    raw.prepare('UPDATE shadow_task_retirements SET revision = ?').run('NOT-AN-EXACT-SHA');
    raw.exec(triggerSql);
    raw.close();

    const reopened = storeAt(target);
    expectCode(() => reopened.initialize(), 'integrity');
    reopened.close();
  });

  it('detects projection batch ordinal tampering during startup replay', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const root = rootCommand();
    store.beginEnvelope({
      deliveryId: 'delivery-ordinal-tamper',
      authorityRevision: 'a'.repeat(40),
      authorityInput: { writes: [], retiredTaskIds: [] },
      manifest: [{ idempotencyKey: root.idempotencyKey, commandDigest: commandDigest(root) }],
      gapCodes: [],
    });
    store.commitBatch('delivery-ordinal-tamper', 0, [root]);
    store.completeEnvelope('delivery-ordinal-tamper');
    store.close();

    const raw = new Database(target.database);
    const triggerSql = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'projection_batches_no_update'",
    ).pluck().get() as string;
    raw.exec('DROP TRIGGER projection_batches_no_update');
    raw.prepare('UPDATE projection_batch_acknowledgements SET batch_ordinal = 7').run();
    raw.exec(triggerSql);
    raw.close();

    const reopened = storeAt(target);
    expectCode(() => reopened.initialize(), 'integrity');
    reopened.close();
  });

  it('enforces append-only event, contract, and receipt tables below the API', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    store.commit(rootCommand());
    const raw = new Database(target.database);
    for (const statement of [
      'UPDATE control_events SET aggregate_id = aggregate_id',
      'DELETE FROM control_events',
      'UPDATE shadow_task_contracts SET task_id = task_id',
      'DELETE FROM shadow_task_contracts',
      'UPDATE command_receipts SET committed_at = committed_at',
      'DELETE FROM command_receipts',
      'UPDATE schema_migrations SET name = name',
      'DELETE FROM schema_migrations',
    ]) {
      expect(() => raw.exec(statement)).toThrow(/append-only|immutable/);
    }
    raw.close();
    store.close();
  });

  it('revalidates an existing receipt against its event on every idempotent retry', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const root = rootCommand();
    store.commit(root);
    const raw = new Database(target.database);
    const triggerSql = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'command_receipts_no_update'",
    ).pluck().get() as string;
    const result = JSON.parse(raw.prepare(
      'SELECT result_json FROM command_receipts WHERE idempotency_key = ?',
    ).pluck().get(root.idempotencyKey) as string) as Record<string, unknown>;
    raw.exec('DROP TRIGGER command_receipts_no_update');
    raw.prepare('UPDATE command_receipts SET result_json = ? WHERE idempotency_key = ?')
      .run(canonicalSerialize({ ...result, eventSequence: 99 }), root.idempotencyKey);
    raw.exec(triggerSql);
    raw.close();

    expectCode(() => store.commit(root), 'integrity');
    store.close();
  });

  it('exports a verified immutable bundle and cleans pre-rename failures', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    store.commit(rootCommand());
    const exportRoot = join(target.root, 'exports');
    const receipt = store.exportSnapshot(exportRoot, 'bundle-1');
    expect(readdirSync(receipt.bundlePath).sort()).toEqual(['manifest.json', 'state.sqlite']);
    const databaseBytes = readFileSync(join(receipt.bundlePath, 'state.sqlite'));
    expect(`sha256:${createHash('sha256').update(databaseBytes).digest('hex')}`)
      .toBe(receipt.databaseSha256);
    const copy = new Database(join(receipt.bundlePath, 'state.sqlite'), { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) FROM control_events').pluck().get()).toBe(1);
    copy.close();
    expectCode(() => store.exportSnapshot(exportRoot, 'bundle-1'), 'export');
    store.close();

    const failedTarget = paths();
    const failing = storeAt(failedTarget, (point) => {
      if (point === 'export_before_rename') throw new Error('injected export failure');
    });
    failing.initialize();
    failing.commit(rootCommand());
    const failedExportRoot = join(failedTarget.root, 'exports');
    expectCode(() => failing.exportSnapshot(failedExportRoot, 'bundle-failed'), 'export');
    expect(existsSync(join(failedExportRoot, 'bundle-failed'))).toBe(false);
    expect(readdirSync(failedExportRoot)).toEqual([]);
    failing.close();
  });

  it('binds export metadata to the snapshot despite a later concurrent commit', () => {
    const target = paths();
    const writer = storeAt(target);
    writer.initialize();
    let raced = false;
    const exporter = storeAt(target, (point) => {
      if (point === 'export_after_backup' && !raced) {
        raced = true;
        writer.commit(rootCommand('other-root', 'task-2'));
      }
    });
    exporter.initialize();
    exporter.commit(rootCommand());

    const receipt = exporter.exportSnapshot(join(target.root, 'exports'), 'raced-bundle');
    expect(receipt.eventCount).toBe(1);
    expect(exporter.readEvents(0, 10)).toHaveLength(2);
    const manifest = JSON.parse(
      readFileSync(join(receipt.bundlePath, 'manifest.json'), 'utf8'),
    ) as { readonly eventCount: number };
    expect(manifest.eventCount).toBe(1);
    const copy = new Database(join(receipt.bundlePath, 'state.sqlite'), { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) FROM control_events').pluck().get()).toBe(1);
    copy.close();
    exporter.close();
    writer.close();
  });

  it('performs snapshot integrity verification read-only without byte or sidecar changes', () => {
    const target = paths();
    let before: { readonly hash: string; readonly files: readonly string[] } | null = null;
    let after: { readonly hash: string; readonly files: readonly string[] } | null = null;
    const observe = (): { readonly hash: string; readonly files: readonly string[] } => {
      const staging = readdirSync(join(target.root, 'exports')).find(
        (name) => name.startsWith('.hercules-export-readonly-bundle-'),
      );
      if (staging === undefined) throw new Error('export staging directory is missing');
      const directory = join(target.root, 'exports', staging);
      const bytes = readFileSync(join(directory, 'state.sqlite'));
      return {
        hash: createHash('sha256').update(bytes).digest('hex'),
        files: readdirSync(directory).sort(),
      };
    };
    const store = storeAt(target, (point) => {
      if (point === 'export_before_readonly_verify') before = observe();
      if (point === 'export_after_readonly_verify') after = observe();
    });
    store.initialize();
    store.commit(rootCommand());
    store.exportSnapshot(join(target.root, 'exports'), 'readonly-bundle');
    expect(before).toEqual(after);
    expect(after).toEqual(expect.objectContaining({ files: ['.owner.json', 'state.sqlite'] }));
    store.close();
  });

  it('returns busy on lock contention and converges same-key writers', () => {
    const target = paths();
    const first = storeAt(target, undefined, 0);
    const second = storeAt(target, undefined, 0);
    first.initialize();
    second.initialize();
    const locker = new Database(target.database);
    locker.pragma('journal_mode = WAL');
    locker.exec('BEGIN IMMEDIATE');
    expectCode(() => second.commit(rootCommand()), 'busy');
    locker.exec('ROLLBACK');
    locker.close();

    const receipt = first.commit(rootCommand());
    expect(second.commit(rootCommand())).toEqual(receipt);
    expect(second.readEvents(0, 10)).toHaveLength(1);
    first.close();
    second.close();
  });

  it('rejects malformed decoded commands and unsafe paths before persistence', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const root = rootCommand() as ShadowCommitCommand & { extra?: boolean };
    root.extra = true;
    expectCode(() => store.commit(root), 'invalid_input');
    const nestedRoot = rootCommand();
    const forgedContract = { ...rootContract(), extra: true };
    expectCode(() => store.commit({
      ...nestedRoot,
      mutation: { kind: 'insert_contract_root', contract: forgedContract as TaskContract },
    }), 'invalid_input');
    const successor = successorParts();
    expectCode(() => store.commit(command('extra-request', {
      kind: 'append_contract_successor',
      ...successor,
      request: { ...successor.request, extra: true } as ContractChangeRequest,
    })), 'invalid_input');
    expectCode(() => store.commit(command('extra-iteration', {
      kind: 'put_iteration',
      iteration: { ...plannedIteration(), extra: true } as Iteration,
    })), 'invalid_input');
    expect(store.readEvents(0, 10)).toEqual([]);
    store.close();

    expectCode(
      () => new SqliteStateStore({
        trustedRoot: target.root,
        databasePath: join(target.parent, 'escaped.sqlite'),
      }),
      'unsafe_path',
    );

    const sharedRoot = join(target.parent, 'shared-root');
    mkdirSync(sharedRoot, { mode: 0o755 });
    chmodSync(sharedRoot, 0o755);
    expectCode(
      () => new SqliteStateStore({
        trustedRoot: sharedRoot,
        databasePath: join(sharedRoot, 'shadow.sqlite'),
      }),
      'unsafe_path',
    );
    expect(lstatSync(sharedRoot).mode & 0o777).toBe(0o755);
  });

  it('commits bounded envelope batches atomically and resumes exact retries', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const root = rootCommand();
    const iteration = command('iteration', { kind: 'put_iteration', iteration: plannedIteration() });
    const envelope = {
      deliveryId: 'delivery-1',
      authorityRevision: 'a'.repeat(40),
      authorityInput: { writes: [], retiredTaskIds: [] },
      manifest: [root, iteration].map((item) => ({
        idempotencyKey: item.idempotencyKey,
        commandDigest: commandDigest(item),
      })),
      gapCodes: [],
    };
    expect(store.beginEnvelope(envelope)).toMatchObject({
      completed: false,
      acknowledgedCommands: 0,
    });
    const receipts = store.commitBatch('delivery-1', 0, [root, iteration]);
    expect(store.commitBatch('delivery-1', 0, [root, iteration])).toEqual(receipts);
    expect(store.completeEnvelope('delivery-1')).toMatchObject({
      completed: true,
      acknowledgedCommands: 2,
    });
    expect(store.commitBatch('delivery-1', 0, [root, iteration])).toEqual(receipts);
    expect(store.listIncompleteEnvelopes()).toEqual([]);
    expect(store.listProjectionEnvelopes()).toMatchObject([
      { deliveryId: 'delivery-1', completed: true, acknowledgedCommands: 2 },
    ]);
    expect(store.readTask('task-1')).toMatchObject({ retirement: null });
    store.close();
  });

  it('rolls back an entire batch and rejects oversized or conflicting retries', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    const first = rootCommand('root-first');
    const conflict = rootCommand('root-conflict');
    store.beginEnvelope({
      deliveryId: 'delivery-rollback',
      authorityRevision: 'b'.repeat(40),
      authorityInput: { writes: [], retiredTaskIds: [] },
      manifest: [first, conflict].map((item) => ({
        idempotencyKey: item.idempotencyKey,
        commandDigest: commandDigest(item),
      })),
      gapCodes: [],
    });
    expectCode(() => store.commitBatch('delivery-rollback', 0, [first, conflict]), 'constraint');
    expect(store.readEvents(0, 10)).toEqual([]);
    expect(store.readTask('task-1')).toBeNull();
    expect(store.listIncompleteEnvelopes()).toHaveLength(1);
    expectCode(
      () => store.commitBatch('delivery-rollback', 0, Array.from({ length: 257 }, () => first)),
      'invalid_input',
    );
    expectCode(() => store.beginEnvelope({
      deliveryId: 'delivery-rollback',
      authorityRevision: 'e'.repeat(40),
      authorityInput: { writes: [], retiredTaskIds: [] },
      manifest: [],
      gapCodes: [],
    }), 'idempotency_conflict');
    expectCode(() => store.beginEnvelope({
      deliveryId: 'delivery-invalid-revision',
      authorityRevision: 'not-a-git-revision',
      authorityInput: { writes: [], retiredTaskIds: [] },
      manifest: [],
      gapCodes: ['candidate_missing'],
    }), 'invalid_input');
    store.close();
  });

  it('completes a zero-command coverage-gap envelope without claiming a batch', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    store.beginEnvelope({
      deliveryId: 'delivery-gap',
      authorityRevision: 'c'.repeat(40),
      authorityInput: { writes: [], retiredTaskIds: [] },
      manifest: [],
      gapCodes: ['candidate_missing'],
    });
    expect(store.completeEnvelope('delivery-gap')).toMatchObject({
      completed: true,
      acknowledgedCommands: 0,
      gapCodes: ['candidate_missing'],
    });
    expect(store.readEvents(0, 10)).toEqual([]);
    store.close();
  });

  it('persists an immutable retirement and blocks resurrection writes', () => {
    const target = paths();
    const store = storeAt(target);
    store.initialize();
    store.commit(rootCommand());
    const retirement = command('retire', {
      kind: 'retire_task',
      taskId: 'task-1',
      revision: 'd'.repeat(40),
    });
    expect(store.commit(retirement).mutationKind).toBe('retire_task');
    expect(store.readTask('task-1')?.retirement).toEqual({
      taskId: 'task-1',
      revision: 'd'.repeat(40),
    });
    expect(store.commit(retirement).eventSequence).toBe(2);
    expectCode(() => store.commit(command('invalid-retire-revision', {
      kind: 'retire_task',
      taskId: 'task-1',
      revision: 'not-a-git-revision',
    })), 'invalid_input');
    expectCode(() => store.commit(command('late-iteration', {
      kind: 'put_iteration',
      iteration: plannedIteration(),
    })), 'constraint');
    store.close();

    const reopened = storeAt(target);
    expect(reopened.initialize().eventCount).toBe(2);
    expect(reopened.readTask('task-1')?.retirement?.revision).toBe('d'.repeat(40));
    reopened.close();
  });
});
