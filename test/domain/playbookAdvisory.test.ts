/**
 * Playbook advisory learning — promotion / demotion / recommendations.
 * Covers docs/autonomy/evidence-memory.md learning lifecycle (advisory stage).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  appendEvidenceMemoryRecord,
  emptyEvidenceMemoryStore,
  makeEvidenceRecordId,
  makeOutcomeIdentity,
  type EvidenceMemoryProvenance,
  type EvidenceMemoryRecord,
  type EvidenceMemoryStore,
} from '../../src/domain/evidenceMemory.js';
import {
  MIN_LOCAL_PROMOTION_SUCCESSES,
  MIN_CROSS_PROJECT_COUNT,
  MIN_CROSS_PROJECT_PROMOTION_SUCCESSES,
  PLAYBOOK_ADVISORY_FORBIDDEN_ACTIONS,
  PLAYBOOK_FORBIDDEN_LEARNING_TARGETS,
  buildPlaybookRecommendation,
  evaluatePlaybookKnowledgeStatus,
  evaluatePlaybookPromotion,
  isForbiddenPlaybookLearningTarget,
  mayReusePlaybookKnowledge,
  playbookAdvisoryAuthorizes,
  playbookAdvisoryMayMutateRuntime,
  tryPromotePlaybookKnowledge,
} from '../../src/domain/playbookAdvisory.js';
import { contextCandidateFromEvidenceRecord } from '../../src/domain/contextCompiler.js';

const NOW = Date.UTC(2026, 8, 8, 12);
const DAY = 24 * 60 * 60 * 1000;

function provenance(over: Partial<EvidenceMemoryProvenance> = {}): EvidenceMemoryProvenance {
  return {
    taskId: 'task-playbook-1',
    candidateSha: 'a'.repeat(40),
    gateId: 'l1-typecheck',
    durableRunId: 'run-playbook-aaaa',
    ...over,
  };
}

function vo(p: {
  idSuffix: string;
  project: string;
  recommendationKey: string;
  ok?: boolean;
  contradictionState?: EvidenceMemoryRecord['contradictionState'];
  observedAtMs?: number;
  taskId?: string;
  summary?: string;
}): EvidenceMemoryRecord {
  const taskId = p.taskId ?? `task-${p.idSuffix}`;
  const observedAtMs = p.observedAtMs ?? NOW - DAY;
  const ok = p.ok ?? true;
  const prov = provenance({ taskId, durableRunId: `run-${p.idSuffix}` });
  return {
    id: makeEvidenceRecordId({
      kind: 'verified_outcome',
      provenance: prov,
      observedAtMs,
      payloadDigest: p.idSuffix,
    }),
    kind: 'verified_outcome',
    observedAtMs,
    recencyMs: observedAtMs,
    scope: { project: p.project, module: 'domain', repoKey: p.project },
    contradictionState: p.contradictionState ?? 'none',
    provenance: prov,
    fingerprint: {
      taskId,
      repoKey: p.project,
      featureKind: 'domain_model',
      bodyDigest: createHash('sha256').update(p.idSuffix).digest('hex'),
    },
    routing: { adapter: 'grok', permissionClass: 'workspace_confined' },
    gates: [
      { gateId: 'l1-typecheck', level: 'l1', ok },
      { gateId: 'l2-browser', level: 'l2', ok },
    ],
    diagnosed: { cause: p.recommendationKey, confidence: ok ? 0.9 : 0.2 },
    summary: p.summary ?? `verified ${p.recommendationKey}`,
    outcomeIdentity: makeOutcomeIdentity({
      taskId,
      durableRunId: `run-${p.idSuffix}`,
      gateId: 'l1-typecheck',
    }),
    payload: { recommendationKey: p.recommendationKey },
  };
}

function seed(records: EvidenceMemoryRecord[]): EvidenceMemoryStore {
  let store = emptyEvidenceMemoryStore();
  for (const rec of records) {
    const r = appendEvidenceMemoryRecord(store, rec);
    expect(r.applied).toBe(true);
    store = r.store;
  }
  return store;
}

function promoteReq(key: string, project: string, nowMs = NOW) {
  return {
    recommendationKey: key,
    conditions: 'domain schema tasks in hercules/domain',
    recommendation: 'prefer workspace-confined mutations',
    project,
    featureKind: 'domain_model',
    module: 'domain',
    nowMs,
  };
}

describe('playbookAdvisory promotion', () => {
  it('requires repeated local successes; cross-project needs multi-project proof', () => {
    const key = 'prefer_workspace_confined';
    expect(MIN_LOCAL_PROMOTION_SUCCESSES).toBeGreaterThan(1);
    expect(MIN_CROSS_PROJECT_COUNT).toBeGreaterThanOrEqual(2);
    expect(MIN_CROSS_PROJECT_PROMOTION_SUCCESSES).toBeGreaterThanOrEqual(3);

    const one = seed([vo({ idSuffix: 'l1', project: 'hercules', recommendationKey: key })]);
    const denied = evaluatePlaybookPromotion(one, promoteReq(key, 'hercules'));
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(denied.reasons.some((r) => /repeat|insufficient/i.test(r))).toBe(true);

    const two = seed([
      vo({ idSuffix: 'l1', project: 'hercules', recommendationKey: key }),
      vo({ idSuffix: 'l2', project: 'hercules', recommendationKey: key, taskId: 'task-l2' }),
    ]);
    const allowed = evaluatePlaybookPromotion(two, promoteReq(key, 'hercules'));
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.scopeLevel).toBe('local');

    const written = tryPromotePlaybookKnowledge(
      two,
      promoteReq(key, 'hercules'),
      provenance({ taskId: 'task-l2', durableRunId: 'run-prom' }),
    );
    expect(written.applied).toBe(true);
    const pk = written.store.records.find((r) => r.kind === 'playbook_knowledge');
    expect(pk?.payload?.['scopeLevel']).toBe('local');
    expect(typeof pk?.payload?.['confidence']).toBe('number');
    expect(typeof pk?.payload?.['expiryMs']).toBe('number');
    expect(playbookAdvisoryMayMutateRuntime(written.store)).toBe(false);

    const xp = 'split_integration_contract';
    const sameProject = seed([
      vo({ idSuffix: 'a1', project: 'alpha', recommendationKey: xp }),
      vo({ idSuffix: 'a2', project: 'alpha', recommendationKey: xp, taskId: 'task-a2' }),
      vo({ idSuffix: 'a3', project: 'alpha', recommendationKey: xp, taskId: 'task-a3' }),
    ]);
    const xpDenied = evaluatePlaybookPromotion(sameProject, {
      recommendationKey: xp,
      conditions: 'integration nodes',
      recommendation: 'split integration contracts',
      allowCrossProject: true,
      featureKind: 'domain_model',
      module: 'domain',
      nowMs: NOW,
    });
    expect(xpDenied.ok).toBe(false);
    if (xpDenied.ok) return;
    expect(xpDenied.projectCount).toBe(1);

    const multi = seed([
      vo({ idSuffix: 'a1', project: 'alpha', recommendationKey: xp }),
      vo({ idSuffix: 'a2', project: 'alpha', recommendationKey: xp, taskId: 'task-a2' }),
      vo({ idSuffix: 'b1', project: 'beta', recommendationKey: xp }),
      vo({ idSuffix: 'b2', project: 'beta', recommendationKey: xp, taskId: 'task-b2' }),
    ]);
    const xpOk = evaluatePlaybookPromotion(multi, {
      recommendationKey: xp,
      conditions: 'integration nodes',
      recommendation: 'split integration contracts',
      allowCrossProject: true,
      featureKind: 'domain_model',
      module: 'domain',
      nowMs: NOW,
    });
    expect(xpOk.ok).toBe(true);
    if (!xpOk.ok) return;
    expect(xpOk.scopeLevel).toBe('cross_project');
    expect(xpOk.projectCount).toBeGreaterThanOrEqual(MIN_CROSS_PROJECT_COUNT);
  });

  it('blocks human decisions and security policy as learned automation targets', () => {
    expect([...PLAYBOOK_FORBIDDEN_LEARNING_TARGETS]).toEqual(
      expect.arrayContaining(['human_decision', 'security_policy']),
    );
    expect(isForbiddenPlaybookLearningTarget('human_decision')).toBe(true);
    expect(isForbiddenPlaybookLearningTarget('security_policy')).toBe(true);
    expect(isForbiddenPlaybookLearningTarget('auto-approve production deploy')).toBe(true);
    expect(isForbiddenPlaybookLearningTarget('prefer_workspace_confined')).toBe(false);

    const store = seed([
      vo({ idSuffix: 'h1', project: 'hercules', recommendationKey: 'human_decision' }),
      vo({
        idSuffix: 'h2',
        project: 'hercules',
        recommendationKey: 'human_decision',
        taskId: 'task-h2',
      }),
    ]);
    const decision = evaluatePlaybookPromotion(store, {
      recommendationKey: 'human_decision',
      conditions: 'operator approvals',
      recommendation: 'automate human merge decisions',
      project: 'hercules',
      nowMs: NOW,
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reasons.some((r) => /human|security|forbidden/i.test(r))).toBe(true);
    expect(
      evaluatePlaybookPromotion(store, {
        recommendationKey: 'security_policy',
        conditions: 'policy changes',
        recommendation: 'learn security policy from past approvals',
        project: 'hercules',
        nowMs: NOW,
      }).ok,
    ).toBe(false);

    for (const action of PLAYBOOK_ADVISORY_FORBIDDEN_ACTIONS) {
      expect(playbookAdvisoryAuthorizes(emptyEvidenceMemoryStore(), action)).toBe(false);
    }
    expect(playbookAdvisoryAuthorizes(emptyEvidenceMemoryStore(), 'alter_prompt')).toBe(false);
    expect(playbookAdvisoryAuthorizes(emptyEvidenceMemoryStore(), 'alter_adapter')).toBe(false);
    expect(playbookAdvisoryAuthorizes(emptyEvidenceMemoryStore(), 'alter_concurrency')).toBe(
      false,
    );
    expect(playbookAdvisoryAuthorizes(emptyEvidenceMemoryStore(), 'alter_permissions')).toBe(
      false,
    );
    expect(playbookAdvisoryAuthorizes(emptyEvidenceMemoryStore(), 'alter_gates')).toBe(false);
  });

  it('refuses promotion when confirmed contradiction already exists in scope', () => {
    const key = 'prefer_workspace_confined';
    const store = seed([
      vo({ idSuffix: 'p1', project: 'hercules', recommendationKey: key }),
      vo({ idSuffix: 'p2', project: 'hercules', recommendationKey: key, taskId: 'task-p2' }),
      vo({ idSuffix: 'p3', project: 'hercules', recommendationKey: key, taskId: 'task-p3' }),
      vo({
        idSuffix: 'p-bad',
        project: 'hercules',
        recommendationKey: key,
        taskId: 'task-p-bad',
        ok: false,
        contradictionState: 'confirmed',
        summary: 'confirmed contradiction blocks promote',
      }),
    ]);
    const decision = evaluatePlaybookPromotion(store, promoteReq(key, 'hercules'));
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reasons.some((r) => /contradict/i.test(r))).toBe(true);
    expect(decision.supportingCount).toBeGreaterThanOrEqual(MIN_LOCAL_PROMOTION_SUCCESSES);
    expect(
      tryPromotePlaybookKnowledge(
        store,
        promoteReq(key, 'hercules'),
        provenance({ taskId: 'task-p3', durableRunId: 'run-p-refuse' }),
      ).applied,
    ).toBe(false);
  });
});

describe('playbookAdvisory demotion and fail-closed reuse', () => {
  it('downgrades bad knowledge, surfaces evidence, never silently reuses via bridge', () => {
    const key = 'prefer_workspace_confined';
    const base = seed([
      vo({ idSuffix: 'd1', project: 'hercules', recommendationKey: key }),
      vo({ idSuffix: 'd2', project: 'hercules', recommendationKey: key, taskId: 'task-d2' }),
    ]);
    const promoted = tryPromotePlaybookKnowledge(
      base,
      promoteReq(key, 'hercules'),
      provenance({ taskId: 'task-d2', durableRunId: 'run-d' }),
    );
    expect(promoted.applied).toBe(true);
    const knowledge = promoted.store.records.find((r) => r.kind === 'playbook_knowledge');
    expect(knowledge).toBeDefined();
    if (!knowledge) return;

    // Active knowledge with store is bridge-eligible.
    expect(
      contextCandidateFromEvidenceRecord(knowledge, {
        similarityScore: 0.9,
        nowMs: NOW,
        store: promoted.store,
      }),
    ).not.toBeNull();
    // Fail-closed without store: cannot evaluate demotion.
    expect(
      contextCandidateFromEvidenceRecord(knowledge, {
        similarityScore: 0.9,
        nowMs: NOW,
      }),
    ).toBeNull();

    const contradicted = appendEvidenceMemoryRecord(
      promoted.store,
      vo({
        idSuffix: 'd-bad',
        project: 'hercules',
        recommendationKey: key,
        taskId: 'task-d-bad',
        ok: false,
        contradictionState: 'confirmed',
        summary: 'later run contradicted the playbook claim',
      }),
    ).store;
    const cStatus = evaluatePlaybookKnowledgeStatus(knowledge, contradicted, { nowMs: NOW });
    expect(cStatus.grade).toBe('downgraded');
    expect(cStatus.demotionReasons).toContain('contradicted');
    expect(mayReusePlaybookKnowledge(cStatus)).toBe(false);
    expect(cStatus.contradictingEvidence.length).toBeGreaterThan(0);
    // High stored payload confidence must not bypass demotion-aware bridge.
    expect(typeof knowledge.payload?.['confidence']).toBe('number');
    expect(Number(knowledge.payload?.['confidence'])).toBeGreaterThanOrEqual(0.5);
    expect(
      contextCandidateFromEvidenceRecord(knowledge, {
        similarityScore: 0.9,
        nowMs: NOW,
        store: contradicted,
      }),
    ).toBeNull();

    const withFlaky = appendEvidenceMemoryRecord(
      promoted.store,
      vo({
        idSuffix: 'd-flaky',
        project: 'hercules',
        recommendationKey: key,
        taskId: 'task-d-flaky',
        ok: false,
        contradictionState: 'suspected',
        summary: 'one flaky contradiction',
      }),
    ).store;
    const rec = buildPlaybookRecommendation(knowledge, withFlaky, { nowMs: NOW });
    expect(rec).not.toBeNull();
    if (!rec) return;
    expect(rec.mode).toBe('advisory');
    expect(rec.conditions).toMatch(/domain schema/i);
    expect(rec.recommendation).toMatch(/workspace-confined/i);
    expect(rec.confidence).toBeGreaterThan(0);
    expect(rec.scope.project).toBe('hercules');
    expect(rec.scope.module).toBe('domain');
    expect(rec.expiryMs).toBeGreaterThan(NOW);
    expect(rec.supportingEvidence.length).toBeGreaterThan(0);
    expect(rec.contradictingEvidence.length).toBeGreaterThan(0);

    const superseded: EvidenceMemoryRecord = {
      id: makeEvidenceRecordId({
        kind: 'superseded_evidence',
        provenance: knowledge.provenance,
        observedAtMs: NOW,
        payloadDigest: 'sup-old',
      }),
      kind: 'superseded_evidence',
      observedAtMs: NOW,
      recencyMs: NOW,
      scope: knowledge.scope,
      contradictionState: 'confirmed',
      provenance: knowledge.provenance,
      fingerprint: knowledge.fingerprint,
      summary: 'prior playbook entry superseded',
      supersedesRecordId: knowledge.id,
      payload: { recommendationKey: key },
    };
    const withSup = appendEvidenceMemoryRecord(promoted.store, superseded).store;
    const supStatus = evaluatePlaybookKnowledgeStatus(knowledge, withSup, { nowMs: NOW });
    expect(supStatus.demotionReasons).toContain('superseded');
    expect(mayReusePlaybookKnowledge(supStatus)).toBe(false);
    expect(
      contextCandidateFromEvidenceRecord(knowledge, {
        similarityScore: 0.9,
        nowMs: NOW,
        store: withSup,
      }),
    ).toBeNull();

    const old = NOW - 120 * DAY;
    const stalePromoted = tryPromotePlaybookKnowledge(
      seed([
        vo({ idSuffix: 'st1', project: 'hercules', recommendationKey: key, observedAtMs: old }),
        vo({
          idSuffix: 'st2',
          project: 'hercules',
          recommendationKey: key,
          taskId: 'task-st2',
          observedAtMs: old + DAY,
        }),
      ]),
      {
        ...promoteReq(key, 'hercules', old + 2 * DAY),
        staleAfterMs: 90 * DAY,
        ttlMs: 90 * DAY,
      },
      provenance({ taskId: 'task-st2', durableRunId: 'run-stale' }),
    );
    const stalePk = stalePromoted.store.records.find((r) => r.kind === 'playbook_knowledge');
    expect(stalePk).toBeDefined();
    if (!stalePk) return;
    const sStatus = evaluatePlaybookKnowledgeStatus(stalePk, stalePromoted.store, {
      nowMs: NOW,
      staleAfterMs: 90 * DAY,
    });
    expect(sStatus.demotionReasons.some((r) => r === 'stale' || r === 'expired')).toBe(true);
    expect(mayReusePlaybookKnowledge(sStatus)).toBe(false);
    expect(
      contextCandidateFromEvidenceRecord(stalePk, {
        similarityScore: 0.9,
        nowMs: NOW,
        store: stalePromoted.store,
        staleAfterMs: 90 * DAY,
      }),
    ).toBeNull();

    const noisy = seed([
      vo({ idSuffix: 'n1', project: 'hercules', recommendationKey: 'noisy_key' }),
      vo({ idSuffix: 'n2', project: 'hercules', recommendationKey: 'noisy_key', taskId: 'task-n2' }),
      vo({
        idSuffix: 'nb1',
        project: 'hercules',
        recommendationKey: 'noisy_key',
        taskId: 'task-nb1',
        ok: false,
        contradictionState: 'suspected',
      }),
      vo({
        idSuffix: 'nb2',
        project: 'hercules',
        recommendationKey: 'noisy_key',
        taskId: 'task-nb2',
        ok: false,
        contradictionState: 'suspected',
      }),
      vo({
        idSuffix: 'nb3',
        project: 'hercules',
        recommendationKey: 'noisy_key',
        taskId: 'task-nb3',
        ok: false,
        contradictionState: 'confirmed',
      }),
    ]);
    // Cannot promote when confirmed contradiction already in scope.
    const lowOnly = tryPromotePlaybookKnowledge(
      noisy,
      {
        recommendationKey: 'noisy_key',
        conditions: 'noisy conditions',
        recommendation: 'noisy recommendation',
        project: 'hercules',
        featureKind: 'domain_model',
        module: 'domain',
        nowMs: NOW,
      },
      provenance({ taskId: 'task-n2', durableRunId: 'run-low' }),
    );
    expect(lowOnly.applied).toBe(false);

    // Build low-confidence status path with suspected-only noise (no confirmed).
    const suspectedOnly = seed([
      vo({ idSuffix: 'n1', project: 'hercules', recommendationKey: 'noisy_key' }),
      vo({ idSuffix: 'n2', project: 'hercules', recommendationKey: 'noisy_key', taskId: 'task-n2' }),
      vo({
        idSuffix: 'nb1',
        project: 'hercules',
        recommendationKey: 'noisy_key',
        taskId: 'task-nb1',
        ok: false,
        contradictionState: 'suspected',
      }),
      vo({
        idSuffix: 'nb2',
        project: 'hercules',
        recommendationKey: 'noisy_key',
        taskId: 'task-nb2',
        ok: false,
        contradictionState: 'suspected',
      }),
      vo({
        idSuffix: 'nb3',
        project: 'hercules',
        recommendationKey: 'noisy_key',
        taskId: 'task-nb3',
        ok: false,
        contradictionState: 'suspected',
      }),
    ]);
    const lowPromoted = tryPromotePlaybookKnowledge(
      seed([
        vo({ idSuffix: 'n1', project: 'hercules', recommendationKey: 'noisy_key' }),
        vo({
          idSuffix: 'n2',
          project: 'hercules',
          recommendationKey: 'noisy_key',
          taskId: 'task-n2',
        }),
      ]),
      {
        recommendationKey: 'noisy_key',
        conditions: 'noisy conditions',
        recommendation: 'noisy recommendation',
        project: 'hercules',
        featureKind: 'domain_model',
        module: 'domain',
        nowMs: NOW,
      },
      provenance({ taskId: 'task-n2', durableRunId: 'run-low' }),
    );
    expect(lowPromoted.applied).toBe(true);
    const lowPk = lowPromoted.store.records.find((r) => r.kind === 'playbook_knowledge');
    expect(lowPk).toBeDefined();
    if (!lowPk) return;
    const lowStatus = evaluatePlaybookKnowledgeStatus(lowPk, suspectedOnly, { nowMs: NOW });
    expect(lowStatus.confidence).toBeLessThan(0.5);
    expect(lowStatus.demotionReasons).toContain('low_confidence');
    expect(mayReusePlaybookKnowledge(lowStatus)).toBe(false);
    expect(
      contextCandidateFromEvidenceRecord(lowPk, {
        similarityScore: 0.9,
        nowMs: NOW,
        store: suspectedOnly,
      }),
    ).toBeNull();
  });
});
