import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalClone,
  canonicalSerialize,
  hashCanonicalJson,
} from '../../../src/domain/canonicalJson.js';
import { compileLegacyTaskContract } from '../../../src/domain/contractCompiler.js';
import { isValidIdentifier } from '../../../src/domain/task.js';
import { isRecord } from '../../../src/domain/v2Invariant.js';
import {
  ENVELOPE_CACHE_MAX,
  ENVELOPE_MISS_QUERY_CHUNK,
  SqliteStateStore,
} from '../../../src/control/state/sqliteStateStore.js';
import {
  StateStoreError,
  type ProjectionEnvelopeInput,
  type ProjectionEnvelopeState,
  type ShadowCommitCommand,
} from '../../../src/control/state/stateStore.js';
import {
  boundedText,
  commandDigest,
  exactGitRevision,
  SHA256_RE,
} from '../../../src/control/state/stateStoreValidation.js';

interface Paths {
  readonly parent: string;
  readonly root: string;
  readonly database: string;
}

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function paths(): Paths {
  const parent = mkdtempSync(join(tmpdir(), 'hercules-envelope-cache-'));
  cleanup.push(parent);
  const root = join(parent, 'state');
  return { parent, root, database: join(root, 'shadow.sqlite') };
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

function rootCommand(id: string, taskId: string): ShadowCommitCommand {
  return command(id, {
    kind: 'insert_contract_root',
    contract: compileLegacyTaskContract({
      taskId,
      objective: `Persist ${taskId}`,
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
    }).contract,
  });
}

// ---------------------------------------------------------------------------
// Verbatim copy of the pre-C3.14 envelope read path (parse + validate + digest
// re-check + canonicalClone per row). Kept here so warm/cached reads stay
// pinned byte-identical to the old uncached algorithm.
// ---------------------------------------------------------------------------

const ENVELOPE_SELECT = `SELECT e.delivery_id, e.authority_revision, e.authority_input_json,
  e.manifest_json,
  e.gap_codes_json, e.manifest_digest, e.command_count,
  CASE WHEN c.delivery_id IS NULL THEN 0 ELSE 1 END AS completed,
  c.manifest_digest AS completion_manifest_digest,
  c.command_count AS completion_command_count,
  COALESCE((SELECT MAX(a.end_index) FROM projection_batch_acknowledgements a
    WHERE a.delivery_id = e.delivery_id), 0) AS acknowledged_commands
  FROM projection_envelopes e
  LEFT JOIN projection_completion_receipts c ON c.delivery_id = e.delivery_id`;

interface EnvelopeRow {
  readonly delivery_id: string;
  readonly authority_revision: string;
  readonly authority_input_json: string;
  readonly manifest_json: string;
  readonly gap_codes_json: string;
  readonly manifest_digest: string;
  readonly command_count: number;
  readonly completed: number;
  readonly completion_manifest_digest: string | null;
  readonly completion_command_count: number | null;
  readonly acknowledged_commands: number;
}

function failReference(message: string): never {
  throw new StateStoreError('integrity', message);
}

function exactKeys(value: Readonly<Record<PropertyKey, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseCanonical<T>(text: string, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new StateStoreError('integrity', `${label} is not JSON`, error);
  }
  let canonical: string;
  try {
    canonical = canonicalSerialize(value);
  } catch (error) {
    throw new StateStoreError('integrity', `${label} is outside canonical JSON`, error);
  }
  if (canonical !== text) failReference(`${label} bytes are not canonical`);
  return value as T;
}

function validateEnvelopeInputReference(value: ProjectionEnvelopeInput): ProjectionEnvelopeInput {
  if (!isRecord(value) || !exactKeys(value, [
    'deliveryId', 'authorityRevision', 'authorityInput', 'manifest', 'gapCodes',
  ])) {
    throw new StateStoreError('invalid_input', 'projection envelope must use the exact schema');
  }
  boundedText(value.deliveryId, 'delivery id');
  exactGitRevision(value.authorityRevision, 'authority revision');
  if (!isRecord(value.authorityInput) ||
      !exactKeys(value.authorityInput, ['writes', 'retiredTaskIds']) ||
      !Array.isArray(value.authorityInput.writes) ||
      !Array.isArray(value.authorityInput.retiredTaskIds) ||
      !Array.isArray(value.manifest) || !Array.isArray(value.gapCodes)) {
    throw new StateStoreError(
      'invalid_input',
      'projection envelope authority input, manifest, and gaps are invalid',
    );
  }
  const writeIds: string[] = [];
  for (const task of value.authorityInput.writes) {
    if (!isRecord(task) || typeof task['id'] !== 'string' || !isValidIdentifier(task['id']) ||
        Buffer.byteLength(canonicalSerialize(task), 'utf8') > 1024 * 1024) {
      throw new StateStoreError('invalid_input', 'projection authority task is invalid or too large');
    }
    writeIds.push(task['id']);
  }
  const retiredTaskIds = value.authorityInput.retiredTaskIds;
  if (retiredTaskIds.some((taskId) => typeof taskId !== 'string' || !isValidIdentifier(taskId)) ||
      new Set(writeIds).size !== writeIds.length ||
      new Set(retiredTaskIds).size !== retiredTaskIds.length ||
      retiredTaskIds.some((taskId) => writeIds.includes(taskId)) ||
      writeIds.some((taskId, index) => index > 0 && writeIds[index - 1]! >= taskId) ||
      retiredTaskIds.some((taskId, index) => index > 0 && retiredTaskIds[index - 1]! >= taskId)) {
    throw new StateStoreError(
      'invalid_input',
      'projection authority input must have sorted disjoint task identities',
    );
  }
  const keys = new Set<string>();
  for (const entry of value.manifest) {
    if (!isRecord(entry) || !exactKeys(entry, ['idempotencyKey', 'commandDigest'])) {
      throw new StateStoreError('invalid_input', 'projection manifest entry must use the exact schema');
    }
    const key = entry['idempotencyKey'];
    const digest = entry['commandDigest'];
    boundedText(key, 'manifest idempotency key');
    if (typeof digest !== 'string' || !SHA256_RE.test(digest)) {
      throw new StateStoreError('invalid_input', 'manifest digest is invalid');
    }
    if (keys.has(key)) {
      throw new StateStoreError('invalid_input', 'projection manifest keys must be unique');
    }
    keys.add(key);
  }
  const gaps = [...value.gapCodes];
  for (const gap of gaps) boundedText(gap, 'projection gap code');
  if (new Set(gaps).size !== gaps.length || gaps.some((gap, index) => index > 0 && gaps[index - 1]! >= gap)) {
    throw new StateStoreError('invalid_input', 'projection gap codes must be unique and sorted');
  }
  return canonicalClone(value);
}

function envelopeDigestReference(value: ProjectionEnvelopeInput): string {
  return hashCanonicalJson({ schema: 'shadow-envelope-v2', ...value });
}

function envelopeRowToStateReference(row: EnvelopeRow): ProjectionEnvelopeState {
  const input = validateEnvelopeInputReference({
    deliveryId: row.delivery_id,
    authorityRevision: row.authority_revision,
    authorityInput: parseCanonical(
      row.authority_input_json, `projection envelope ${row.delivery_id} authority input`,
    ),
    manifest: parseCanonical(row.manifest_json, `projection envelope ${row.delivery_id} manifest`),
    gapCodes: parseCanonical(row.gap_codes_json, `projection envelope ${row.delivery_id} gaps`),
  } as ProjectionEnvelopeInput);
  if (row.command_count !== input.manifest.length || row.manifest_digest !== envelopeDigestReference(input) ||
      !Number.isSafeInteger(row.acknowledged_commands) || row.acknowledged_commands < 0 ||
      row.acknowledged_commands > row.command_count) {
    failReference('projection envelope row is inconsistent');
  }
  if (row.completed === 1 && (row.completion_manifest_digest !== row.manifest_digest ||
      row.completion_command_count !== row.command_count)) {
    failReference('projection completion receipt is inconsistent');
  }
  return {
    ...input,
    manifestDigest: row.manifest_digest,
    completed: row.completed === 1,
    acknowledgedCommands: row.acknowledged_commands,
  };
}

/** Pre-C3.14 read path: parse + validate + digest + clone per row. */
function listProjectionEnvelopesReference(databasePath: string): ProjectionEnvelopeState[] {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`${ENVELOPE_SELECT}
      ORDER BY e.rowid`).all() as EnvelopeRow[];
    return rows.map((row) => canonicalClone(envelopeRowToStateReference(row)));
  } finally {
    db.close();
  }
}

function assertDeepFrozen(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value), `expected frozen at ${path}`).toBe(true);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertDeepFrozen(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    assertDeepFrozen(nested, `${path}.${key}`);
  }
}

/**
 * Build a store with one completed envelope and one incomplete envelope that
 * stopped after a full 256-command batch (the live interruption shape).
 */
function seedCompletedAndIncomplete256(target: Paths, onEnvelopeParse?: (id: string) => void): {
  store: SqliteStateStore;
  completedId: string;
  incompleteId: string;
  remaining: ShadowCommitCommand[];
} {
  const store = new SqliteStateStore({
    trustedRoot: target.root,
    databasePath: target.database,
    busyTimeoutMs: 100,
    ...(onEnvelopeParse === undefined ? {} : { onEnvelopeParse }),
  });
  store.initialize();

  const completedCommands = [
    rootCommand('done-a', 'task-done-a'),
    rootCommand('done-b', 'task-done-b'),
  ];
  const completedId = 'delivery-completed';
  store.beginEnvelope({
    deliveryId: completedId,
    authorityRevision: 'a'.repeat(40),
    authorityInput: { writes: [], retiredTaskIds: [] },
    manifest: completedCommands.map((item) => ({
      idempotencyKey: item.idempotencyKey,
      commandDigest: commandDigest(item),
    })),
    gapCodes: [],
  });
  store.commitBatch(completedId, 0, completedCommands);
  store.completeEnvelope(completedId);

  const incompleteCommands = Array.from({ length: 258 }, (_, index) =>
    rootCommand(`inc-${String(index).padStart(3, '0')}`, `task-inc-${String(index).padStart(3, '0')}`));
  const incompleteId = 'delivery-incomplete-256';
  store.beginEnvelope({
    deliveryId: incompleteId,
    authorityRevision: 'b'.repeat(40),
    authorityInput: { writes: [], retiredTaskIds: [] },
    manifest: incompleteCommands.map((item) => ({
      idempotencyKey: item.idempotencyKey,
      commandDigest: commandDigest(item),
    })),
    gapCodes: [],
  });
  store.commitBatch(incompleteId, 0, incompleteCommands.slice(0, 256));

  return {
    store,
    completedId,
    incompleteId,
    remaining: incompleteCommands.slice(256),
  };
}

describe('C3.14 projection envelope verified-once read cache', () => {
  it('listProjectionEnvelopes is byte-identical to the pre-cache reference path', () => {
    const target = paths();
    const { store } = seedCompletedAndIncomplete256(target);
    const cached = store.listProjectionEnvelopes();
    const reference = listProjectionEnvelopesReference(target.database);
    expect(hashCanonicalJson(cached)).toBe(hashCanonicalJson(reference));
    expect(cached).toHaveLength(2);
    expect(cached.map((envelope) => ({
      deliveryId: envelope.deliveryId,
      completed: envelope.completed,
      acknowledgedCommands: envelope.acknowledgedCommands,
    }))).toEqual([
      { deliveryId: 'delivery-completed', completed: true, acknowledgedCommands: 2 },
      { deliveryId: 'delivery-incomplete-256', completed: false, acknowledgedCommands: 256 },
    ]);
    store.close();
  });

  it('returns deep-frozen shared identities on warm reads and re-parses only stamp changes', () => {
    const target = paths();
    const parsed: string[] = [];
    const { store, incompleteId, remaining } = seedCompletedAndIncomplete256(
      target,
      (deliveryId) => { parsed.push(deliveryId); },
    );
    // Writes invalidate; first public list populates the cache (2 parses).
    parsed.length = 0;
    const first = store.listProjectionEnvelopes();
    expect(parsed.sort()).toEqual(['delivery-completed', 'delivery-incomplete-256']);
    for (const envelope of first) assertDeepFrozen(envelope);
    expect(() => {
      (first[0] as { completed: boolean }).completed = false;
    }).toThrow();
    expect(() => {
      (first[0]!.manifest as unknown as unknown[]).push({
        idempotencyKey: 'x',
        commandDigest: 'sha256:' + '0'.repeat(64),
      });
    }).toThrow();

    parsed.length = 0;
    const second = store.listProjectionEnvelopes();
    expect(parsed).toEqual([]);
    expect(second).toHaveLength(first.length);
    for (let index = 0; index < first.length; index += 1) {
      expect(second[index]).toBe(first[index]);
    }
    expect(store.readEnvelope(incompleteId)).toBe(first[1]);
    expect(store.listIncompleteEnvelopes()).toEqual([first[1]]);
    expect(store.listIncompleteEnvelopes()[0]).toBe(first[1]);

    // commitBatch changes acknowledged_commands stamp → only that row re-parses.
    parsed.length = 0;
    store.commitBatch(incompleteId, 1, remaining);
    expect(store.listProjectionEnvelopes().map((envelope) => envelope.deliveryId))
      .toEqual(['delivery-completed', incompleteId]);
    expect(parsed).toEqual([incompleteId]);
    const afterBatch = store.listProjectionEnvelopes();
    expect(afterBatch[0]).toBe(first[0]);
    expect(afterBatch[1]).not.toBe(first[1]);
    expect(afterBatch[1]!.acknowledgedCommands).toBe(258);

    parsed.length = 0;
    store.completeEnvelope(incompleteId);
    const afterComplete = store.listProjectionEnvelopes();
    expect(parsed).toEqual([incompleteId]);
    expect(afterComplete[0]).toBe(first[0]);
    expect(afterComplete[1]!.completed).toBe(true);
    expect(store.listIncompleteEnvelopes()).toEqual([]);
    expect(hashCanonicalJson(afterComplete))
      .toBe(hashCanonicalJson(listProjectionEnvelopesReference(target.database)));
    store.close();
  });

  it('tampered manifest_json fails closed on a fresh instance', () => {
    const target = paths();
    const { store, completedId } = seedCompletedAndIncomplete256(target);
    store.close();

    const raw = new Database(target.database);
    const triggerSql = raw.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'projection_envelopes_no_update'",
    ).pluck().get() as string;
    raw.exec('DROP TRIGGER projection_envelopes_no_update');
    raw.prepare(
      `UPDATE projection_envelopes SET manifest_json = ? WHERE delivery_id = ?`,
    ).run(canonicalSerialize([{
      idempotencyKey: 'tampered',
      commandDigest: 'sha256:' + 'f'.repeat(64),
    }]), completedId);
    raw.exec(triggerSql);
    raw.close();

    const reopened = new SqliteStateStore({
      trustedRoot: target.root,
      databasePath: target.database,
      busyTimeoutMs: 100,
    });
    expect(() => reopened.initialize()).toThrow(/projection envelope row is inconsistent/);
  });

  it('cold list with more misses than the bound-variable chunk stays byte-identical (Codex round-6 B1)', () => {
    const target = paths();
    const count = ENVELOPE_MISS_QUERY_CHUNK + 3;
    const seed = new SqliteStateStore({ trustedRoot: target.root, databasePath: target.database, busyTimeoutMs: 100 });
    seed.initialize();
    for (let index = 0; index < count; index += 1) {
      const tag = String(index).padStart(5, '0');
      const commands = [rootCommand(`many-${tag}`, `task-many-${tag}`)];
      const deliveryId = `delivery-many-${tag}`;
      seed.beginEnvelope({
        deliveryId,
        authorityRevision: 'c'.repeat(40),
        authorityInput: { writes: [], retiredTaskIds: [] },
        manifest: commands.map((item) => ({ idempotencyKey: item.idempotencyKey, commandDigest: commandDigest(item) })),
        gapCodes: [],
      });
      seed.commitBatch(deliveryId, 0, commands);
      seed.completeEnvelope(deliveryId);
    }
    seed.close();

    // Fresh instance: every row is a cache miss on the first list.
    const parsed: string[] = [];
    const store = new SqliteStateStore({
      trustedRoot: target.root, databasePath: target.database, busyTimeoutMs: 100,
      onEnvelopeParse: (id) => { parsed.push(id); },
    });
    store.initialize();
    const cold = store.listProjectionEnvelopes();
    expect(cold).toHaveLength(count);
    expect(parsed).toHaveLength(count);
    expect(hashCanonicalJson(cold)).toBe(hashCanonicalJson(listProjectionEnvelopesReference(target.database)));
    // The parsed-envelope cache is bounded (2026-09-09 production OOM): a warm
    // full listing re-parses every row beyond the newest ENVELOPE_CACHE_MAX,
    // and the newest rows are still served from cache with shared identity.
    const warm = store.listProjectionEnvelopes();
    expect(parsed).toHaveLength(count + (count - ENVELOPE_CACHE_MAX));
    expect(warm[count - 1]).toBe(cold[count - 1]);
    expect(hashCanonicalJson(warm)).toBe(hashCanonicalJson(cold));
    // Identity keys never parse a JSON blob, whatever the history size.
    const before = parsed.length;
    const keys = store.listProjectionEnvelopeKeys();
    expect(keys).toHaveLength(count);
    expect(keys.map((key) => key.deliveryId)).toEqual(cold.map((envelope) => envelope.deliveryId));
    expect(keys[count - 1]).toEqual({
      deliveryId: cold[count - 1]!.deliveryId,
      authorityRevision: cold[count - 1]!.authorityRevision,
      manifestDigest: cold[count - 1]!.manifestDigest,
      commandCount: cold[count - 1]!.manifest.length,
      completed: true,
      acknowledgedCommands: cold[count - 1]!.acknowledgedCommands,
    });
    expect(parsed).toHaveLength(before);
    // Manifest reads of an evicted row parse only the manifest + gaps columns
    // and agree with the full envelope.
    const evicted = store.readEnvelopeManifest(cold[0]!.deliveryId);
    expect(evicted).toEqual({
      deliveryId: cold[0]!.deliveryId,
      authorityRevision: cold[0]!.authorityRevision,
      manifest: cold[0]!.manifest,
      gapCodes: cold[0]!.gapCodes,
      manifestDigest: cold[0]!.manifestDigest,
    });
    expect(parsed).toHaveLength(before);
    expect(store.readEnvelopeManifest('delivery-none')).toBeNull();
    store.close();
  }, 120_000);

  it('latestProjectionEnvelopeRevision reads the last row without listing envelopes', () => {
    const target = paths();
    const { store } = seedCompletedAndIncomplete256(target);
    expect(store.latestProjectionEnvelopeRevision()).toBe('b'.repeat(40));
    expect(store.latestProjectionEnvelopeRevision()).toBe(
      store.listProjectionEnvelopes().at(-1)?.authorityRevision,
    );
    store.close();

    const empty = paths();
    const emptyStore = new SqliteStateStore({
      trustedRoot: empty.root,
      databasePath: empty.database,
      busyTimeoutMs: 100,
    });
    emptyStore.initialize();
    expect(emptyStore.latestProjectionEnvelopeRevision()).toBeNull();
    emptyStore.close();
  });
});
