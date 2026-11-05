/**
 * Shadow-mode context compiler — budgets, provenance, isolation, replay.
 * Covers docs/autonomy/evidence-memory.md context compiler stage (shadow only).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_COMPILER_SCHEMA_VERSION,
  CONTEXT_COMPILER_FORBIDDEN_ACTIONS,
  CONTEXT_ITEM_KINDS,
  DEFAULT_CONTEXT_BUDGET,
  ContextCompilerError,
  compileContextShadow,
  contextCandidateFromEvidenceRecord,
  contextCompilerAuthorizes,
  contextCompilerMayInjectIntoPrompt,
  contextCompilerMayMutateRuntime,
  contextCompilerShadowCanonical,
  contextCompilerShadowDigest,
  estimateContextTokens,
  resolveContextBudget,
  type ContextBudget,
  type ContextCompileRequest,
  type ContextSourceItem,
} from '../../src/domain/contextCompiler.js';
import {
  makeEvidenceRecordId,
  type EvidenceMemoryProvenance,
  type EvidenceMemoryRecord,
} from '../../src/domain/evidenceMemory.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const NOW = Date.UTC(2026, 7, 7, 12);
const DAY = 24 * 60 * 60 * 1000;

function prov(over: Partial<EvidenceMemoryProvenance> = {}): EvidenceMemoryProvenance {
  return {
    taskId: 'task-ctx-1',
    candidateSha: 'a'.repeat(40),
    gateId: 'l1-typecheck',
    durableRunId: 'run-ctx-aaaa-bbbb-cccc',
    ...over,
  };
}

function source(
  over: Partial<ContextSourceItem> & Pick<ContextSourceItem, 'id' | 'kind' | 'content'>,
): ContextSourceItem {
  return {
    tokenEstimate: estimateContextTokens(over.content),
    provenance: prov({ taskId: over.provenance?.taskId ?? 'task-src-1' }),
    scope: { project: 'hercules', module: 'domain', repoKey: 'hercules' },
    recencyMs: NOW,
    contradictionState: 'none',
    verified: over.kind === 'verified_analogue' || over.kind === 'core_rule',
    ...over,
  };
}

function request(over: Partial<ContextCompileRequest> = {}): ContextCompileRequest {
  return {
    taskId: 'task-ctx-1',
    project: 'hercules',
    module: 'domain',
    repoKey: 'hercules',
    featureKind: 'domain_model',
    bodyDigest: createHash('sha256').update('brief').digest('hex'),
    nowMs: NOW,
    mode: 'shadow',
    coreRules: [
      source({
        id: 'rule-safety',
        kind: 'core_rule',
        content: 'Never expand permissions without human review.',
        verified: true,
      }),
    ],
    projectFacts: [
      source({
        id: 'fact-domain-pure',
        kind: 'project_fact',
        content: 'src/domain is pure: no io/git/fs/network.',
      }),
    ],
    dependencyContracts: [
      source({
        id: 'dep-task-graph',
        kind: 'dependency_contract',
        content: 'taskGraph validates DAG edges before advisory packets.',
      }),
    ],
    candidates: [],
    ...over,
  };
}

describe('contextCompiler vocabulary and budget', () => {
  it('exposes item kinds and forbids runtime mutation actions', () => {
    expect([...CONTEXT_ITEM_KINDS]).toEqual([
      'core_rule',
      'project_fact',
      'dependency_contract',
      'verified_analogue',
      'raw_evidence_link',
    ]);
    expect([...CONTEXT_COMPILER_FORBIDDEN_ACTIONS]).toEqual(
      expect.arrayContaining([
        'alter_prompt',
        'inject_into_prompt',
        'alter_routing',
        'alter_permissions',
        'alter_scheduling',
        'alter_source_code',
      ]),
    );
    expect(CONTEXT_COMPILER_SCHEMA_VERSION).toBe(1);
  });

  it('enforces explicit budgets and reserves capacity for code reading/reasoning', () => {
    const budget = resolveContextBudget(DEFAULT_CONTEXT_BUDGET);
    expect(budget.totalTokens).toBeGreaterThan(0);
    expect(budget.reservedForCodeReading).toBeGreaterThan(0);
    expect(budget.reservedForCodeReading).toBeLessThan(budget.totalTokens);
    expect(budget.availableForRetrieval).toBe(
      budget.totalTokens - budget.reservedForCodeReading,
    );
    expect(budget.maxAnalogues).toBeLessThanOrEqual(5);

    const tight: ContextBudget = {
      totalTokens: 200,
      reservedForCodeReading: 150,
      maxCoreRules: 2,
      maxProjectFacts: 2,
      maxDependencyContracts: 2,
      maxAnalogues: 2,
      maxRawEvidenceLinks: 1,
      staleAfterMs: 30 * DAY,
    };
    const resolved = resolveContextBudget(tight);
    expect(resolved.availableForRetrieval).toBe(50);
  });

  it('rejects budgets that leave no reserved capacity for code reading', () => {
    expect(() =>
      resolveContextBudget({
        totalTokens: 100,
        reservedForCodeReading: 0,
        maxCoreRules: 1,
        maxProjectFacts: 1,
        maxDependencyContracts: 1,
        maxAnalogues: 1,
        maxRawEvidenceLinks: 0,
        staleAfterMs: DAY,
      }),
    ).toThrow(ContextCompilerError);

    expect(() =>
      resolveContextBudget({
        totalTokens: 100,
        reservedForCodeReading: 100,
        maxCoreRules: 1,
        maxProjectFacts: 1,
        maxDependencyContracts: 1,
        maxAnalogues: 1,
        maxRawEvidenceLinks: 0,
        staleAfterMs: DAY,
      }),
    ).toThrow(ContextCompilerError);
  });
});

describe('contextCompiler retrieval provenance', () => {
  it('tags every retrieved item with provenance, scope, recency, supersession, rationale', () => {
    const out = compileContextShadow(
      request({
        candidates: [
          source({
            id: 'analogue-ok',
            kind: 'verified_analogue',
            content: 'Similar domain schema task passed L1+L2 with pure types.',
            verified: true,
            similarityScore: 0.82,
            featureKind: 'domain_model',
            provenance: prov({ taskId: 'task-prior-1' }),
            recencyMs: NOW - DAY,
          }),
        ],
      }),
    );

    expect(out.mode).toBe('shadow');
    expect(out.items.length).toBeGreaterThan(0);
    for (const item of out.items) {
      expect(item.provenance.taskId).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(item.scope.project).toBe('hercules');
      expect(typeof item.recencyMs).toBe('number');
      expect(item.contradictionState).toBeDefined();
      expect(item.supersession).toEqual(
        expect.objectContaining({
          superseded: expect.any(Boolean),
        }),
      );
      expect(item.retrievalRationale.length).toBeGreaterThan(0);
      expect(item.usefulnessSignal).toBe('unobserved');
    }

    const analogue = out.items.find((i) => i.kind === 'verified_analogue');
    expect(analogue).toBeDefined();
    expect(analogue?.retrievalRationale).toMatch(/same-project|verified|feature/i);
  });
});

describe('contextCompiler shadow boundary', () => {
  it('records usefulness signals but never injects into live agent prompts', () => {
    const out = compileContextShadow(request());
    expect(out.injectedIntoPrompt).toBe(false);
    expect(out.mode).toBe('shadow');
    expect(out.usefulnessSignals).toEqual(
      out.items.map((i) => ({
        itemId: i.id,
        signal: 'unobserved',
      })),
    );
    expect(contextCompilerMayInjectIntoPrompt(out)).toBe(false);
    expect(contextCompilerMayMutateRuntime(out)).toBe(false);
    for (const action of CONTEXT_COMPILER_FORBIDDEN_ACTIONS) {
      expect(contextCompilerAuthorizes(out, action)).toBe(false);
    }
    // Live prompt assembly must not receive shadow packet text.
    expect(out).not.toHaveProperty('promptFragment');
    expect(JSON.stringify(out)).not.toMatch(/injectIntoLivePrompt\s*:\s*true/);
  });

  it('is not wired into live prompt assembly or adapter dispatch', async () => {
    const promptSrc = await readFile(join(REPO_ROOT, 'src/orchestrator/prompt.ts'), 'utf8');
    const adapterSrc = await readFile(join(REPO_ROOT, 'src/orchestrator/adapter.ts'), 'utf8');
    const actionsSrc = await readFile(join(REPO_ROOT, 'src/orchestrator/actions.ts'), 'utf8');
    for (const src of [promptSrc, adapterSrc, actionsSrc]) {
      expect(src).not.toMatch(/contextCompiler/);
      expect(src).not.toMatch(/compileContextShadow/);
    }
  });
});

describe('contextCompiler isolation and ranking defenses', () => {
  it('blocks cross-project leakage into compiled context', () => {
    const out = compileContextShadow(
      request({
        projectFacts: [
          source({
            id: 'fact-foreign',
            kind: 'project_fact',
            content: 'Foreign project architecture secret map.',
            scope: { project: 'other-app', module: 'billing', repoKey: 'other-app' },
          }),
          source({
            id: 'fact-local',
            kind: 'project_fact',
            content: 'Local domain purity invariant.',
          }),
        ],
        candidates: [
          source({
            id: 'analogue-foreign',
            kind: 'verified_analogue',
            content: 'Verified outcome from another product line.',
            verified: true,
            similarityScore: 0.99,
            featureKind: 'domain_model',
            scope: { project: 'other-app', module: 'billing', repoKey: 'other-app' },
          }),
        ],
      }),
    );

    expect(out.items.map((i) => i.id)).toContain('fact-local');
    expect(out.items.map((i) => i.id)).not.toContain('fact-foreign');
    expect(out.items.map((i) => i.id)).not.toContain('analogue-foreign');
    expect(out.dropped.some((d) => d.id === 'fact-foreign' && /cross-project/i.test(d.reason))).toBe(
      true,
    );
    expect(
      out.dropped.some((d) => d.id === 'analogue-foreign' && /cross-project/i.test(d.reason)),
    ).toBe(true);
  });

  it('downgrades stale and contradicted or superseded evidence', () => {
    const out = compileContextShadow(
      request({
        budget: {
          ...DEFAULT_CONTEXT_BUDGET,
          staleAfterMs: 14 * DAY,
        },
        candidates: [
          source({
            id: 'analogue-stale',
            kind: 'verified_analogue',
            content: 'Old verified case from last year.',
            verified: true,
            similarityScore: 0.9,
            featureKind: 'domain_model',
            recencyMs: NOW - 60 * DAY,
          }),
          source({
            id: 'analogue-contradicted',
            kind: 'verified_analogue',
            content: 'Contradicted recommendation still circulating.',
            verified: true,
            similarityScore: 0.91,
            featureKind: 'domain_model',
            contradictionState: 'confirmed',
            recencyMs: NOW - DAY,
          }),
          source({
            id: 'analogue-superseded',
            kind: 'verified_analogue',
            content: 'Superseded playbook entry.',
            verified: true,
            similarityScore: 0.88,
            featureKind: 'domain_model',
            supersededByRecordId: 'analogue-newer',
            recencyMs: NOW - DAY,
          }),
          source({
            id: 'analogue-fresh',
            kind: 'verified_analogue',
            content: 'Fresh same-module verified analogue.',
            verified: true,
            similarityScore: 0.8,
            featureKind: 'domain_model',
            recencyMs: NOW - DAY,
          }),
        ],
      }),
    );

    const ids = out.items.map((i) => i.id);
    expect(ids).toContain('analogue-fresh');
    expect(ids).not.toContain('analogue-stale');
    expect(ids).not.toContain('analogue-contradicted');
    expect(ids).not.toContain('analogue-superseded');
    expect(out.dropped.some((d) => d.id === 'analogue-stale' && /stale/i.test(d.reason))).toBe(true);
    expect(
      out.dropped.some((d) => d.id === 'analogue-contradicted' && /contradict/i.test(d.reason)),
    ).toBe(true);
    expect(
      out.dropped.some((d) => d.id === 'analogue-superseded' && /supersed/i.test(d.reason)),
    ).toBe(true);
  });

  it('rejects poisoned similarity (unverified, feature-mismatch, secret-bearing)', () => {
    const out = compileContextShadow(
      request({
        candidates: [
          source({
            id: 'poison-unverified',
            kind: 'verified_analogue',
            content: 'Looks similar but never verified.',
            verified: false,
            similarityScore: 0.99,
            featureKind: 'domain_model',
          }),
          source({
            id: 'poison-feature',
            kind: 'verified_analogue',
            content: 'High similarity but wrong feature class.',
            verified: true,
            similarityScore: 0.97,
            featureKind: 'voice_avatar',
          }),
          source({
            id: 'poison-secret',
            kind: 'verified_analogue',
            content: 'Use token=supersecret-api-key for auth.',
            verified: true,
            similarityScore: 0.95,
            featureKind: 'domain_model',
          }),
          source({
            id: 'analogue-clean',
            kind: 'verified_analogue',
            content: 'Clean verified domain model analogue.',
            verified: true,
            similarityScore: 0.75,
            featureKind: 'domain_model',
          }),
        ],
      }),
    );

    const ids = out.items.map((i) => i.id);
    expect(ids).toContain('analogue-clean');
    expect(ids).not.toContain('poison-unverified');
    expect(ids).not.toContain('poison-feature');
    expect(ids).not.toContain('poison-secret');
    // Even if content slipped in, redaction must strip secret material.
    for (const item of out.items) {
      expect(item.content).not.toMatch(/supersecret/i);
    }
  });

  it('exhausts budget deterministically and keeps reserved code-reading capacity', () => {
    const long = 'word '.repeat(80).trim(); // ~400 chars ~100 tokens
    const facts: ContextSourceItem[] = Array.from({ length: 8 }, (_, i) =>
      source({
        id: `fact-${i}`,
        kind: 'project_fact',
        content: `${long} fact-${i}`,
      }),
    );
    const analogues: ContextSourceItem[] = Array.from({ length: 6 }, (_, i) =>
      source({
        id: `analogue-${i}`,
        kind: 'verified_analogue',
        content: `${long} analogue-${i}`,
        verified: true,
        similarityScore: 0.9 - i * 0.01,
        featureKind: 'domain_model',
        recencyMs: NOW - i * DAY,
      }),
    );

    const budget: ContextBudget = {
      totalTokens: 260,
      reservedForCodeReading: 120,
      maxCoreRules: 1,
      maxProjectFacts: 8,
      maxDependencyContracts: 1,
      maxAnalogues: 6,
      maxRawEvidenceLinks: 0,
      staleAfterMs: 90 * DAY,
    };

    const out = compileContextShadow(
      request({
        budget,
        projectFacts: facts,
        dependencyContracts: [],
        candidates: analogues,
      }),
    );

    expect(out.budget.reservedForCodeReading).toBe(120);
    expect(out.usedTokens).toBeLessThanOrEqual(out.budget.availableForRetrieval);
    expect(out.usedTokens + out.budget.reservedForCodeReading).toBeLessThanOrEqual(
      out.budget.totalTokens,
    );
    expect(out.dropped.some((d) => /budget/i.test(d.reason))).toBe(true);
    // Reserved capacity is never consumed by retrieval.
    expect(out.remainingReservedForCodeReading).toBe(120);
  });
});

describe('contextCompiler deterministic replay', () => {
  it('replays the same inputs to the same digest and item order', () => {
    const candidates = [
      source({
        id: 'analogue-b',
        kind: 'verified_analogue',
        content: 'Second verified analogue.',
        verified: true,
        similarityScore: 0.7,
        featureKind: 'domain_model',
        recencyMs: NOW - 2 * DAY,
      }),
      source({
        id: 'analogue-a',
        kind: 'verified_analogue',
        content: 'First verified analogue.',
        verified: true,
        similarityScore: 0.85,
        featureKind: 'domain_model',
        recencyMs: NOW - DAY,
      }),
    ];
    const req = request({ candidates });
    const a = compileContextShadow(req);
    const b = compileContextShadow(req);
    expect(contextCompilerShadowDigest(a)).toBe(contextCompilerShadowDigest(b));
    expect(contextCompilerShadowCanonical(a)).toBe(contextCompilerShadowCanonical(b));
    expect(a.items.map((i) => i.id)).toEqual(b.items.map((i) => i.id));
    expect(a.dropped.map((d) => d.id)).toEqual(b.dropped.map((d) => d.id));

    // Higher similarity ranks first among analogues (stable).
    const analogueIds = a.items.filter((i) => i.kind === 'verified_analogue').map((i) => i.id);
    expect(analogueIds[0]).toBe('analogue-a');
  });
});

describe('contextCompiler evidence-memory bridge', () => {
  it('builds analogue candidates only from verified reusable evidence records', () => {
    const verified: EvidenceMemoryRecord = {
      id: makeEvidenceRecordId({
        kind: 'verified_outcome',
        provenance: prov({ taskId: 'task-prior-9' }),
        observedAtMs: NOW - DAY,
        payloadDigest: 'v9',
      }),
      kind: 'verified_outcome',
      observedAtMs: NOW - DAY,
      scope: { project: 'hercules', module: 'domain', repoKey: 'hercules' },
      recencyMs: NOW - DAY,
      contradictionState: 'none',
      provenance: prov({ taskId: 'task-prior-9' }),
      fingerprint: {
        taskId: 'task-prior-9',
        repoKey: 'hercules',
        featureKind: 'domain_model',
        bodyDigest: createHash('sha256').update('prior').digest('hex'),
      },
      summary: 'Verified domain outcome suitable as analogue.',
      gates: [{ gateId: 'l1-typecheck', level: 'l1', ok: true }],
    };

    const raw: EvidenceMemoryRecord = {
      ...verified,
      id: makeEvidenceRecordId({
        kind: 'raw_event',
        provenance: prov({ taskId: 'task-raw-1' }),
        observedAtMs: NOW,
        payloadDigest: 'raw1',
      }),
      kind: 'raw_event',
      provenance: prov({ taskId: 'task-raw-1' }),
      fingerprint: {
        taskId: 'task-raw-1',
        repoKey: 'hercules',
        bodyDigest: createHash('sha256').update('raw').digest('hex'),
      },
      summary: 'Raw receipt must not become an analogue by default.',
    };

    const fromVerified = contextCandidateFromEvidenceRecord(verified, { similarityScore: 0.8 });
    const fromRaw = contextCandidateFromEvidenceRecord(raw, { similarityScore: 0.8 });
    expect(fromVerified).not.toBeNull();
    expect(fromVerified?.kind).toBe('verified_analogue');
    expect(fromVerified?.verified).toBe(true);
    expect(fromRaw).toBeNull();

    const out = compileContextShadow(
      request({
        candidates: fromVerified ? [fromVerified] : [],
      }),
    );
    expect(out.items.some((i) => i.kind === 'verified_analogue')).toBe(true);
  });
});
