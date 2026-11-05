/**
 * Evidence-memory event schema — record-only foundation.
 * Covers docs/autonomy/evidence-memory.md stage: record only.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_MEMORY_SCHEMA_VERSION,
  EVIDENCE_MEMORY_RECORD_KINDS,
  EVIDENCE_MEMORY_FORBIDDEN_ACTIONS,
  EVIDENCE_MEMORY_CONTRADICTION_STATES,
  EvidenceMemoryValidationError,
  emptyEvidenceMemoryStore,
  makeEvidenceRecordId,
  makeOutcomeIdentity,
  appendEvidenceMemoryRecord,
  countVerifiedOutcomes,
  validateEvidenceMemoryRecord,
  parseEvidenceMemoryStore,
  serializeEvidenceMemoryStore,
  evidenceMemoryCanonical,
  evidenceMemoryDigest,
  evidenceMemoryAuthorizes,
  evidenceMemoryMayMutateRuntime,
  redactEvidenceText,
  sanitizeEvidencePayload,
  isEvidenceMemoryRecordKind,
  type EvidenceMemoryRecord,
  type EvidenceMemoryProvenance,
} from '../../src/domain/evidenceMemory.js';

const NOW = Date.UTC(2026, 7, 7, 12);

function provenance(over: Partial<EvidenceMemoryProvenance> = {}): EvidenceMemoryProvenance {
  return {
    taskId: 'task-sample-1',
    candidateSha: 'a'.repeat(40),
    gateId: 'l1-typecheck',
    durableRunId: 'run-aaaa-bbbb-cccc-dddd',
    ...over,
  };
}

function baseRecord(over: Partial<EvidenceMemoryRecord> = {}): EvidenceMemoryRecord {
  const kind = over.kind ?? 'raw_event';
  const prov = over.provenance ?? provenance();
  const id =
    over.id ??
    makeEvidenceRecordId({
      kind,
      provenance: prov,
      observedAtMs: over.observedAtMs ?? NOW,
      payloadDigest: 'payload-digest-1',
    });
  return {
    observedAtMs: NOW,
    scope: { project: 'hercules', module: 'domain', repoKey: 'hercules' },
    recencyMs: NOW,
    contradictionState: 'none',
    fingerprint: {
      taskId: prov.taskId,
      repoKey: 'hercules',
      featureKind: 'domain_model',
      bodyDigest: createHash('sha256').update('brief').digest('hex'),
    },
    graphFeatures: {
      nodeCount: 3,
      edgeCount: 2,
      decompositionDepth: 2,
      hasIntegrationContract: true,
    },
    routing: {
      adapter: 'grok',
      permissionClass: 'workspace_confined',
    },
    retries: {
      attempts: 1,
      failureKinds: [],
    },
    gates: [{ gateId: 'l1-typecheck', level: 'l1', ok: true }],
    conflicts: [],
    interventions: [],
    diagnosed: { cause: 'none', confidence: 1 },
    summary: 'normalized capture for sample task',
    ...over,
    id,
    kind,
    provenance: prov,
  };
}

function verified(over: Partial<EvidenceMemoryRecord> = {}): EvidenceMemoryRecord {
  return baseRecord({
    gates: [
      { gateId: 'l1-typecheck', level: 'l1', ok: true },
      { gateId: 'l2-browser', level: 'l2', ok: true },
    ],
    diagnosed: { cause: 'verified_green', confidence: 0.9 },
    summary: 'verified outcome for sample task',
    ...over,
    kind: 'verified_outcome',
  });
}

describe('evidenceMemory vocabulary', () => {
  it('distinguishes raw, verified, superseded, and playbook record kinds', () => {
    expect([...EVIDENCE_MEMORY_RECORD_KINDS]).toEqual([
      'raw_event',
      'verified_outcome',
      'superseded_evidence',
      'playbook_knowledge',
    ]);
    expect(isEvidenceMemoryRecordKind('raw_event')).toBe(true);
    expect(isEvidenceMemoryRecordKind('advisory_recommendation')).toBe(false);
  });

  it('names contradiction states used for reusable facts', () => {
    expect([...EVIDENCE_MEMORY_CONTRADICTION_STATES]).toEqual([
      'none',
      'suspected',
      'confirmed',
    ]);
  });

  it('reserves runtime mutation actions this stage must never authorize', () => {
    expect([...EVIDENCE_MEMORY_FORBIDDEN_ACTIONS]).toEqual(
      expect.arrayContaining([
        'alter_prompt',
        'alter_routing',
        'alter_permissions',
        'alter_scheduling',
        'alter_source_code',
      ]),
    );
  });
});

describe('evidenceMemory record validation', () => {
  it('accepts a bounded raw event with provenance and lifecycle fields', () => {
    const result = validateEvidenceMemoryRecord(baseRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.kind).toBe('raw_event');
    expect(result.record.provenance.taskId).toBe('task-sample-1');
    expect(result.record.provenance.candidateSha).toHaveLength(40);
    expect(result.record.provenance.gateId).toBe('l1-typecheck');
    expect(result.record.scope.module).toBe('domain');
    expect(result.record.contradictionState).toBe('none');
    expect(result.record.fingerprint.bodyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.record.graphFeatures?.nodeCount).toBe(3);
    expect(result.record.routing?.adapter).toBe('grok');
    expect(result.record.retries?.attempts).toBe(1);
    expect(result.record.gates?.[0]?.gateId).toBe('l1-typecheck');
  });

  it('requires exact task/candidate/gate provenance on reusable facts', () => {
    const missingCandidate = validateEvidenceMemoryRecord(
      verified({
        provenance: { taskId: 'task-sample-1', gateId: 'l1-typecheck' },
      }),
    );
    expect(missingCandidate.ok).toBe(false);

    const missingGate = validateEvidenceMemoryRecord(
      verified({
        provenance: { taskId: 'task-sample-1', candidateSha: 'b'.repeat(40) },
      }),
    );
    expect(missingGate.ok).toBe(false);

    const sourceId = makeEvidenceRecordId({
      kind: 'verified_outcome',
      provenance: provenance(),
      observedAtMs: NOW,
      payloadDigest: 'v1',
    });
    const playbook = validateEvidenceMemoryRecord(
      baseRecord({
        kind: 'playbook_knowledge',
        summary: 'conditions -> recommendation after verified repeats',
        sourceOutcomeIds: [sourceId],
      }),
    );
    expect(playbook.ok).toBe(true);
    if (!playbook.ok) return;
    expect(playbook.record.kind).toBe('playbook_knowledge');
    expect(playbook.record.provenance.taskId).toBeTruthy();
    expect(playbook.record.provenance.candidateSha).toBeTruthy();
    expect(playbook.record.provenance.gateId).toBeTruthy();
    expect(playbook.record.scope.project).toBe('hercules');
    expect(playbook.record.recencyMs).toBe(NOW);
    expect(playbook.record.contradictionState).toBe('none');
    expect(playbook.record.sourceOutcomeIds).toEqual([sourceId]);
  });

  it('rejects unsafe identifiers and unbounded summaries', () => {
    const badId = validateEvidenceMemoryRecord(
      baseRecord({ provenance: provenance({ taskId: '../evil' }) }),
    );
    expect(badId.ok).toBe(false);

    const huge = validateEvidenceMemoryRecord(baseRecord({ summary: 'x'.repeat(10_000) }));
    expect(huge.ok).toBe(false);
  });

  it('marks superseded evidence as a distinct non-promoted kind', () => {
    const priorId = makeEvidenceRecordId({
      kind: 'verified_outcome',
      provenance: provenance(),
      observedAtMs: NOW - 1000,
      payloadDigest: 'old',
    });
    const result = validateEvidenceMemoryRecord(
      baseRecord({
        kind: 'superseded_evidence',
        supersedesRecordId: priorId,
        contradictionState: 'confirmed',
        summary: 'prior evidence contradicted by later verified outcome',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.kind).toBe('superseded_evidence');
    expect(result.record.supersedesRecordId).toBe(priorId);
    expect(result.record.contradictionState).toBe('confirmed');
  });
});

describe('evidenceMemory secret and raw-log exclusion', () => {
  it('redacts credential-shaped text and bounds raw logs', () => {
    const redacted = redactEvidenceText(
      'Authorization: Bearer sk-abc123456789 token=supersecret API_KEY=xyz',
    );
    expect(redacted).not.toMatch(/sk-abc123456789/);
    expect(redacted).not.toMatch(/supersecret/);
    expect(redacted).toMatch(/REDACTED/i);

    const longLog = ('line\n').repeat(5000);
    const bounded = redactEvidenceText(longLog);
    expect(bounded.length).toBeLessThan(longLog.length);
    expect(bounded.length).toBeLessThanOrEqual(2_500);
  });

  it('strips secret, credential, personal-data, and raw-log fields from payloads', () => {
    const cleaned = sanitizeEvidencePayload({
      adapter: 'grok',
      password: 'hunter2',
      token: 'xai-secret-token-value',
      apiKey: 'k-123',
      credential: { user: 'a', pass: 'b' },
      authorization: 'Bearer abc',
      rawLog: 'huge stdout dump with SECRET=1',
      rawLogs: ['a', 'b'],
      stdout: 'out',
      stderr: 'err',
      email: 'user@example.com',
      phone: '+1-555-0100',
      personalData: { ssn: '123' },
      note: 'safe bounded note',
    });
    expect(cleaned).toEqual({ adapter: 'grok', note: 'safe bounded note' });
    expect(cleaned).not.toHaveProperty('password');
    expect(cleaned).not.toHaveProperty('token');
    expect(cleaned).not.toHaveProperty('rawLog');
    expect(cleaned).not.toHaveProperty('email');
  });

  it('rejects records that still carry forbidden field names after sanitize', () => {
    const dirty = {
      ...baseRecord(),
      payload: { token: 'still-here' },
    };
    const result = validateEvidenceMemoryRecord(dirty);
    expect(result.ok).toBe(false);
  });
});

describe('evidenceMemory idempotent append and double-count guard', () => {
  it('is restart/replay idempotent for the same record id', () => {
    const rec = verified();
    const first = appendEvidenceMemoryRecord(emptyEvidenceMemoryStore(), rec);
    expect(first.applied).toBe(true);
    expect(first.conflict).toBe(false);
    expect(first.store.records).toHaveLength(1);

    const replay = appendEvidenceMemoryRecord(first.store, rec);
    expect(replay.applied).toBe(false);
    expect(replay.conflict).toBe(false);
    expect(replay.store.records).toHaveLength(1);
    expect(countVerifiedOutcomes(replay.store)).toBe(1);
  });

  it('cannot double-count the same verified outcome identity', () => {
    const identity = makeOutcomeIdentity({
      taskId: 'task-sample-1',
      durableRunId: 'run-aaaa-bbbb-cccc-dddd',
      gateId: 'l1-typecheck',
    });
    const a = verified({
      id: makeEvidenceRecordId({
        kind: 'verified_outcome',
        provenance: provenance(),
        observedAtMs: NOW,
        payloadDigest: 'payload-a',
      }),
      outcomeIdentity: identity,
      summary: 'first observation',
    });
    const b = verified({
      id: makeEvidenceRecordId({
        kind: 'verified_outcome',
        provenance: provenance(),
        observedAtMs: NOW + 5_000,
        payloadDigest: 'payload-b',
      }),
      outcomeIdentity: identity,
      summary: 'replay with different packaging',
    });

    let store = emptyEvidenceMemoryStore();
    store = appendEvidenceMemoryRecord(store, a).store;
    const second = appendEvidenceMemoryRecord(store, b);
    expect(second.applied).toBe(false);
    expect(second.doubleCountPrevented).toBe(true);
    expect(second.store.records).toHaveLength(1);
    expect(countVerifiedOutcomes(second.store)).toBe(1);
  });

  it('conflicts when the same record id arrives with a different body', () => {
    const id = makeEvidenceRecordId({
      kind: 'raw_event',
      provenance: provenance(),
      observedAtMs: NOW,
      payloadDigest: 'same-id',
    });
    const a = baseRecord({ id, summary: 'alpha' });
    const b = baseRecord({ id, summary: 'beta' });
    const first = appendEvidenceMemoryRecord(emptyEvidenceMemoryStore(), a);
    const clash = appendEvidenceMemoryRecord(first.store, b);
    expect(clash.applied).toBe(false);
    expect(clash.conflict).toBe(true);
    expect(clash.store.records[0]?.summary).toBe('alpha');
  });

  it('round-trips serialize/parse without inventing extra outcomes', () => {
    const rec = verified();
    // Canonicalize through append so digest compares validated forms only.
    const store = appendEvidenceMemoryRecord(emptyEvidenceMemoryStore(), rec).store;
    expect(store.records).toHaveLength(1);
    const json = serializeEvidenceMemoryStore(store);
    const parsed = parseEvidenceMemoryStore(json);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.store.records).toHaveLength(1);
    expect(countVerifiedOutcomes(parsed.store)).toBe(1);
    expect(evidenceMemoryDigest(parsed.store)).toBe(evidenceMemoryDigest(store));
    const again = parseEvidenceMemoryStore(serializeEvidenceMemoryStore(parsed.store));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(evidenceMemoryCanonical(again.store)).toBe(evidenceMemoryCanonical(store));
    expect(EVIDENCE_MEMORY_SCHEMA_VERSION).toBe(1);
  });

  it('returns typed schema errors on corrupt documents', () => {
    const bad = parseEvidenceMemoryStore('{bad');
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors[0]?.code).toBe('schema');
    expect(() => {
      throw new EvidenceMemoryValidationError(bad.errors[0]?.message ?? 'bad', bad.errors);
    }).toThrow(EvidenceMemoryValidationError);
  });
});

describe('evidenceMemory authority boundary (record-only)', () => {
  it('cannot alter prompts, routing, permissions, scheduling, or source code', () => {
    const store = appendEvidenceMemoryRecord(emptyEvidenceMemoryStore(), verified()).store;
    expect(evidenceMemoryMayMutateRuntime(store)).toBe(false);
    for (const action of EVIDENCE_MEMORY_FORBIDDEN_ACTIONS) {
      expect(evidenceMemoryAuthorizes(store, action)).toBe(false);
    }
    expect(evidenceMemoryAuthorizes(store, 'alter_prompt')).toBe(false);
    expect(evidenceMemoryAuthorizes(store, 'alter_routing')).toBe(false);
    expect(evidenceMemoryAuthorizes(store, 'alter_permissions')).toBe(false);
    expect(evidenceMemoryAuthorizes(store, 'alter_scheduling')).toBe(false);
    expect(evidenceMemoryAuthorizes(store, 'alter_source_code')).toBe(false);
  });

  it('playbook knowledge remains advisory recording only', () => {
    const pk = baseRecord({
      kind: 'playbook_knowledge',
      summary: 'prefer workspace-confined mutations for domain schema tasks',
      sourceOutcomeIds: [
        makeEvidenceRecordId({
          kind: 'verified_outcome',
          provenance: provenance(),
          observedAtMs: NOW,
          payloadDigest: 'v-ok',
        }),
      ],
    });
    const store = appendEvidenceMemoryRecord(emptyEvidenceMemoryStore(), pk).store;
    expect(store.records[0]?.kind).toBe('playbook_knowledge');
    expect(evidenceMemoryMayMutateRuntime(store)).toBe(false);
    expect(evidenceMemoryAuthorizes(store, 'alter_routing')).toBe(false);
  });
});
