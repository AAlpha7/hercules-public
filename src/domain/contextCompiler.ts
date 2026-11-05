/**
 * Domain — traceable context compiler (shadow mode only).
 *
 * Assembles a bounded working packet from core rules, project/module facts,
 * DAG dependency contracts, and a small set of verified analogues.
 * See docs/autonomy/evidence-memory.md.
 *
 * Shadow stage: records retrieval + usefulness slots for evaluation, but
 * NEVER injects into live agent prompts, NEVER alters routing/permissions/
 * scheduling/source. Pure types + deterministic selection.
 */
import { createHash } from 'node:crypto';
import {
  redactEvidenceText,
  type EvidenceMemoryContradictionState,
  type EvidenceMemoryProvenance,
  type EvidenceMemoryRecord,
  type EvidenceMemoryScope,
  type EvidenceMemoryStore,
} from './evidenceMemory.js';
import {
  evaluatePlaybookKnowledgeStatus,
  mayReusePlaybookKnowledge,
} from './playbookAdvisory.js';
import { isValidIdentifier } from './task.js';

export const CONTEXT_COMPILER_SCHEMA_VERSION = 1 as const;

export const CONTEXT_ITEM_KINDS = [
  'core_rule',
  'project_fact',
  'dependency_contract',
  'verified_analogue',
  'raw_evidence_link',
] as const;
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number];

/** Actions this shadow compiler never authorizes. */
export const CONTEXT_COMPILER_FORBIDDEN_ACTIONS = [
  'alter_prompt',
  'inject_into_prompt',
  'alter_routing',
  'alter_permissions',
  'alter_scheduling',
  'alter_source_code',
] as const;
export type ContextCompilerForbiddenAction =
  (typeof CONTEXT_COMPILER_FORBIDDEN_ACTIONS)[number];

export type ContextUsefulnessSignal = 'unobserved' | 'useful' | 'not_useful' | 'harmful';

export const MAX_CONTEXT_ITEM_CONTENT_LEN = 800;
export const MAX_CONTEXT_ITEMS_PER_BUCKET = 64;
export const MAX_CONTEXT_RATIONALE_LEN = 400;
export const MAX_CONTEXT_ID_LEN = 128;
export const MIN_ANALOGUE_SIMILARITY = 0.5;
/** Credential-shaped content — keep narrow to avoid false-positive hex digests. */
export const SECRETISH_CONTENT_RE =
  /(?:\b(?:token|password|passwd|secret|api[_-]?key|authorization|bearer|credential)\b\s*[:=]\s*\S+)|(?:\b(?:sk|xai|ghp|gho|ghu|ghs)[-_][A-Za-z0-9_-]{8,}\b)/i;

export class ContextCompilerError extends Error {
  override readonly name = 'ContextCompilerError';
  readonly code: string;
  constructor(message: string, code = 'budget') {
    super(message);
    this.code = code;
  }
}

/** Declared token budget. Reserved capacity is never spent on retrieval. */
export interface ContextBudget {
  readonly totalTokens: number;
  readonly reservedForCodeReading: number;
  readonly maxCoreRules: number;
  readonly maxProjectFacts: number;
  readonly maxDependencyContracts: number;
  readonly maxAnalogues: number;
  readonly maxRawEvidenceLinks: number;
  /** Drop candidates older than nowMs - staleAfterMs. */
  readonly staleAfterMs: number;
}

export interface ResolvedContextBudget extends ContextBudget {
  /** totalTokens - reservedForCodeReading */
  readonly availableForRetrieval: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalTokens: 8_000,
  reservedForCodeReading: 4_000,
  maxCoreRules: 8,
  maxProjectFacts: 12,
  maxDependencyContracts: 8,
  maxAnalogues: 3,
  maxRawEvidenceLinks: 4,
  staleAfterMs: 90 * 24 * 60 * 60 * 1000,
};

export interface ContextSourceItem {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly provenance: EvidenceMemoryProvenance;
  readonly scope: EvidenceMemoryScope;
  readonly recencyMs: number;
  readonly contradictionState: EvidenceMemoryContradictionState;
  readonly verified: boolean;
  readonly similarityScore?: number;
  readonly featureKind?: string;
  /** This item supersedes another record. */
  readonly supersedesRecordId?: string;
  /** Another record supersedes this item — treat as superseded. */
  readonly supersededByRecordId?: string;
  /** Optional raw-evidence receipt link (digest / id only). */
  readonly evidenceLinkId?: string;
}

export interface ContextCompileRequest {
  readonly taskId: string;
  readonly project: string;
  readonly module?: string;
  readonly repoKey: string;
  readonly featureKind?: string;
  readonly bodyDigest: string;
  readonly nowMs: number;
  /** Only shadow is supported in this stage. */
  readonly mode: 'shadow';
  readonly budget?: ContextBudget;
  readonly coreRules: readonly ContextSourceItem[];
  readonly projectFacts: readonly ContextSourceItem[];
  readonly dependencyContracts: readonly ContextSourceItem[];
  /** Candidate analogues / raw links from evidence memory. */
  readonly candidates: readonly ContextSourceItem[];
}

export interface ContextSupersessionState {
  readonly superseded: boolean;
  readonly supersedesRecordId?: string;
  readonly supersededByRecordId?: string;
}

export interface RetrievedContextItem {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly content: string;
  readonly tokenEstimate: number;
  readonly provenance: EvidenceMemoryProvenance;
  readonly scope: EvidenceMemoryScope;
  readonly recencyMs: number;
  readonly contradictionState: EvidenceMemoryContradictionState;
  readonly supersession: ContextSupersessionState;
  readonly retrievalRationale: string;
  readonly usefulnessSignal: ContextUsefulnessSignal;
  readonly similarityScore?: number;
  readonly featureKind?: string;
}

export interface ContextDroppedItem {
  readonly id: string;
  readonly kind: ContextItemKind;
  readonly reason: string;
}

export interface ContextUsefulnessRecord {
  readonly itemId: string;
  readonly signal: ContextUsefulnessSignal;
}

/**
 * Shadow compiler output. Always advisory: injectedIntoPrompt is false and
 * there is no promptFragment field for live injection.
 */
export interface ContextCompilerShadowOutput {
  readonly version: typeof CONTEXT_COMPILER_SCHEMA_VERSION;
  readonly mode: 'shadow';
  readonly injectedIntoPrompt: false;
  readonly taskId: string;
  readonly project: string;
  readonly repoKey: string;
  readonly bodyDigest: string;
  readonly compiledAtMs: number;
  readonly budget: ResolvedContextBudget;
  readonly usedTokens: number;
  readonly remainingReservedForCodeReading: number;
  readonly items: readonly RetrievedContextItem[];
  readonly dropped: readonly ContextDroppedItem[];
  readonly usefulnessSignals: readonly ContextUsefulnessRecord[];
  readonly digest: string;
}

/** Rough token estimate: ~4 chars per token, ceil, min 1 for non-empty. */
export function estimateContextTokens(text: string): number {
  const t = text.trim();
  if (t.length === 0) return 0;
  return Math.max(1, Math.ceil(t.length / 4));
}

export function isContextItemKind(v: unknown): v is ContextItemKind {
  return typeof v === 'string' && (CONTEXT_ITEM_KINDS as readonly string[]).includes(v);
}

export function resolveContextBudget(budget: ContextBudget): ResolvedContextBudget {
  if (
    !Number.isInteger(budget.totalTokens) ||
    !Number.isInteger(budget.reservedForCodeReading) ||
    budget.totalTokens <= 0 ||
    budget.reservedForCodeReading <= 0
  ) {
    throw new ContextCompilerError(
      'context budget requires positive integer totalTokens and reservedForCodeReading',
      'budget',
    );
  }
  if (budget.reservedForCodeReading >= budget.totalTokens) {
    throw new ContextCompilerError(
      'reservedForCodeReading must leave retrieval capacity (reserved < total)',
      'budget',
    );
  }
  for (const key of [
    'maxCoreRules',
    'maxProjectFacts',
    'maxDependencyContracts',
    'maxAnalogues',
    'maxRawEvidenceLinks',
  ] as const) {
    const n = budget[key];
    if (!Number.isInteger(n) || n < 0 || n > MAX_CONTEXT_ITEMS_PER_BUCKET) {
      throw new ContextCompilerError(`context budget ${key} out of range`, 'budget');
    }
  }
  if (!Number.isInteger(budget.staleAfterMs) || budget.staleAfterMs <= 0) {
    throw new ContextCompilerError('staleAfterMs must be a positive integer', 'budget');
  }
  return {
    ...budget,
    availableForRetrieval: budget.totalTokens - budget.reservedForCodeReading,
  };
}

function boundText(text: string, max: number): string {
  const one = text.split(/\s+/).join(' ').trim();
  if (one.length <= max) return one;
  return one.slice(0, max - 1) + '…';
}

function isSafeId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_CONTEXT_ID_LEN &&
    (isValidIdentifier(value) || /^[A-Za-z0-9._-]+$/.test(value))
  );
}

function contentLooksSecret(content: string): boolean {
  return SECRETISH_CONTENT_RE.test(content);
}

function sameProject(scope: EvidenceMemoryScope, project: string): boolean {
  return scope.project === project;
}

function isStale(item: ContextSourceItem, nowMs: number, staleAfterMs: number): boolean {
  if (!Number.isFinite(item.recencyMs) || item.recencyMs < 0) return true;
  return nowMs - item.recencyMs > staleAfterMs;
}

function isSuperseded(item: ContextSourceItem): boolean {
  return typeof item.supersededByRecordId === 'string' && item.supersededByRecordId.length > 0;
}

function isContradicted(item: ContextSourceItem): boolean {
  return item.contradictionState === 'confirmed' || item.contradictionState === 'suspected';
}

function kindPriority(kind: ContextItemKind): number {
  switch (kind) {
    case 'core_rule':
      return 0;
    case 'project_fact':
      return 1;
    case 'dependency_contract':
      return 2;
    case 'verified_analogue':
      return 3;
    case 'raw_evidence_link':
      return 4;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function maxForKind(kind: ContextItemKind, budget: ResolvedContextBudget): number {
  switch (kind) {
    case 'core_rule':
      return budget.maxCoreRules;
    case 'project_fact':
      return budget.maxProjectFacts;
    case 'dependency_contract':
      return budget.maxDependencyContracts;
    case 'verified_analogue':
      return budget.maxAnalogues;
    case 'raw_evidence_link':
      return budget.maxRawEvidenceLinks;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

interface RankedCandidate {
  readonly item: ContextSourceItem;
  readonly content: string;
  readonly tokens: number;
  readonly rationale: string;
  readonly rankKey: readonly (number | string)[];
}

function moduleBoost(item: ContextSourceItem, module: string | undefined): number {
  if (!module) return 0;
  return item.scope.module === module ? 1 : 0;
}

function sanitizeContent(raw: string): string {
  return boundText(redactEvidenceText(raw, MAX_CONTEXT_ITEM_CONTENT_LEN), MAX_CONTEXT_ITEM_CONTENT_LEN);
}

/**
 * Filter + explain why a source item is eligible (or not) for retrieval.
 * Returns null when dropped, with reason.
 */
function evaluateSource(
  item: ContextSourceItem,
  req: ContextCompileRequest,
  budget: ResolvedContextBudget,
): { ok: true; ranked: RankedCandidate } | { ok: false; reason: string } {
  if (!isSafeId(item.id)) {
    return { ok: false, reason: 'invalid id' };
  }
  if (!isContextItemKind(item.kind)) {
    return { ok: false, reason: 'invalid kind' };
  }
  if (typeof item.content !== 'string' || item.content.trim().length === 0) {
    return { ok: false, reason: 'empty content' };
  }
  if (!sameProject(item.scope, req.project)) {
    return { ok: false, reason: 'cross-project leakage blocked' };
  }
  // Core rules are trusted invariants; still project-scoped above.
  if (item.kind !== 'core_rule') {
    if (isStale(item, req.nowMs, budget.staleAfterMs)) {
      return { ok: false, reason: 'stale evidence beyond recency budget' };
    }
    if (isContradicted(item)) {
      return { ok: false, reason: `contradiction state ${item.contradictionState}` };
    }
    if (isSuperseded(item)) {
      return { ok: false, reason: 'superseded by newer evidence' };
    }
  }

  if (item.kind === 'verified_analogue') {
    if (!item.verified) {
      return { ok: false, reason: 'poisoned similarity: unverified analogue' };
    }
    if (
      req.featureKind !== undefined &&
      item.featureKind !== undefined &&
      item.featureKind !== req.featureKind
    ) {
      return {
        ok: false,
        reason: 'poisoned similarity: featureKind mismatch',
      };
    }
    const sim = item.similarityScore;
    if (sim === undefined || !Number.isFinite(sim) || sim < MIN_ANALOGUE_SIMILARITY || sim > 1) {
      return { ok: false, reason: 'poisoned similarity: score out of range' };
    }
    if (contentLooksSecret(item.content)) {
      return { ok: false, reason: 'poisoned similarity: secret-bearing content' };
    }
  }

  if (item.kind === 'raw_evidence_link') {
    // Links only — no raw log bodies. Secret-looking bodies are dropped.
    if (contentLooksSecret(item.content)) {
      return { ok: false, reason: 'raw evidence link content looks secret-bearing' };
    }
  }

  if (contentLooksSecret(item.content) && item.kind !== 'core_rule') {
    // Project facts / deps must not carry credential material either.
    if (item.kind === 'project_fact' || item.kind === 'dependency_contract') {
      return { ok: false, reason: 'secret-bearing content blocked' };
    }
  }

  const content = sanitizeContent(item.content);
  // Post-redaction: if secrets remain as literal secret-looking tokens, drop analogues.
  if (item.kind === 'verified_analogue' && contentLooksSecret(content)) {
    return { ok: false, reason: 'poisoned similarity: secret-bearing content' };
  }

  const tokens =
    Number.isInteger(item.tokenEstimate) && item.tokenEstimate > 0
      ? item.tokenEstimate
      : estimateContextTokens(content);

  const rationale = buildRationale(item, req);
  const rankKey = buildRankKey(item, req);

  return {
    ok: true,
    ranked: { item, content, tokens, rationale, rankKey },
  };
}

function buildRationale(item: ContextSourceItem, req: ContextCompileRequest): string {
  const parts: string[] = [];
  switch (item.kind) {
    case 'core_rule':
      parts.push('core safety/permission invariant');
      break;
    case 'project_fact':
      parts.push('direct project/module fact');
      break;
    case 'dependency_contract':
      parts.push('direct DAG dependency contract');
      break;
    case 'verified_analogue':
      parts.push('verified analogue');
      parts.push('same-project');
      if (item.featureKind && item.featureKind === req.featureKind) {
        parts.push('feature match');
      }
      if (item.similarityScore !== undefined) {
        parts.push(`similarity ${item.similarityScore.toFixed(2)}`);
      }
      break;
    case 'raw_evidence_link':
      parts.push('raw evidence link on demand');
      break;
  }
  if (item.scope.module && item.scope.module === req.module) {
    parts.push('same-module');
  }
  parts.push(`recency ${item.recencyMs}`);
  if (item.provenance.gateId) {
    parts.push(`gate ${item.provenance.gateId}`);
  }
  return boundText(parts.join('; '), MAX_CONTEXT_RATIONALE_LEN);
}

function buildRankKey(
  item: ContextSourceItem,
  req: ContextCompileRequest,
): readonly (number | string)[] {
  // Lower is better for numeric slots we negate where higher-is-better.
  const sim = item.similarityScore ?? 0;
  return [
    kindPriority(item.kind),
    // same module first
    moduleBoost(item, req.module) === 1 ? 0 : 1,
    // higher similarity first for analogues
    item.kind === 'verified_analogue' ? -sim : 0,
    // more recent first
    -item.recencyMs,
    item.id,
  ];
}

function compareRankKeys(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function toRetrieved(ranked: RankedCandidate): RetrievedContextItem {
  const { item, content, tokens, rationale } = ranked;
  const supersession: ContextSupersessionState = {
    superseded: isSuperseded(item),
    ...(item.supersedesRecordId !== undefined
      ? { supersedesRecordId: item.supersedesRecordId }
      : {}),
    ...(item.supersededByRecordId !== undefined
      ? { supersededByRecordId: item.supersededByRecordId }
      : {}),
  };
  const base: RetrievedContextItem = {
    id: item.id,
    kind: item.kind,
    content,
    tokenEstimate: tokens,
    provenance: item.provenance,
    scope: item.scope,
    recencyMs: item.recencyMs,
    contradictionState: item.contradictionState,
    supersession,
    retrievalRationale: rationale,
    usefulnessSignal: 'unobserved',
  };
  if (item.similarityScore !== undefined) {
    return {
      ...base,
      similarityScore: item.similarityScore,
      ...(item.featureKind !== undefined ? { featureKind: item.featureKind } : {}),
    };
  }
  if (item.featureKind !== undefined) {
    return { ...base, featureKind: item.featureKind };
  }
  return base;
}

function collectBucket(
  sources: readonly ContextSourceItem[],
  expectedKind: ContextItemKind | null,
  req: ContextCompileRequest,
  budget: ResolvedContextBudget,
  dropped: ContextDroppedItem[],
): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const src of sources) {
    if (expectedKind !== null && src.kind !== expectedKind) {
      dropped.push({
        id: src.id,
        kind: src.kind,
        reason: `kind mismatch for bucket (expected ${expectedKind})`,
      });
      continue;
    }
    const result = evaluateSource(src, req, budget);
    if (!result.ok) {
      dropped.push({ id: src.id, kind: src.kind, reason: result.reason });
      continue;
    }
    ranked.push(result.ranked);
  }
  ranked.sort((a, b) => compareRankKeys(a.rankKey, b.rankKey));
  return ranked;
}

/**
 * Compile a shadow-mode context packet.
 * Deterministic for the same request; never sets injectedIntoPrompt.
 */
export function compileContextShadow(req: ContextCompileRequest): ContextCompilerShadowOutput {
  if (req.mode !== 'shadow') {
    throw new ContextCompilerError('only shadow mode is supported', 'mode');
  }
  if (!isSafeId(req.taskId) || !isSafeId(req.project) || !isSafeId(req.repoKey)) {
    throw new ContextCompilerError('taskId/project/repoKey must be safe identifiers', 'schema');
  }
  if (typeof req.bodyDigest !== 'string' || !/^[0-9a-f]{7,64}$/i.test(req.bodyDigest)) {
    throw new ContextCompilerError('bodyDigest must be a hex digest', 'schema');
  }
  if (!Number.isInteger(req.nowMs) || req.nowMs < 0) {
    throw new ContextCompilerError('nowMs must be a non-negative integer', 'schema');
  }

  const budget = resolveContextBudget(req.budget ?? DEFAULT_CONTEXT_BUDGET);
  const dropped: ContextDroppedItem[] = [];

  const buckets: RankedCandidate[][] = [
    collectBucket(req.coreRules, 'core_rule', req, budget, dropped),
    collectBucket(req.projectFacts, 'project_fact', req, budget, dropped),
    collectBucket(req.dependencyContracts, 'dependency_contract', req, budget, dropped),
    collectBucket(
      req.candidates.filter((c) => c.kind === 'verified_analogue'),
      'verified_analogue',
      req,
      budget,
      dropped,
    ),
    collectBucket(
      req.candidates.filter((c) => c.kind === 'raw_evidence_link'),
      'raw_evidence_link',
      req,
      budget,
      dropped,
    ),
  ];

  // Drop non-analogue/non-link candidates that were not considered.
  for (const c of req.candidates) {
    if (c.kind !== 'verified_analogue' && c.kind !== 'raw_evidence_link') {
      dropped.push({
        id: c.id,
        kind: c.kind,
        reason: 'candidate kind not eligible for analogue/link retrieval',
      });
    }
  }

  const selected: RankedCandidate[] = [];
  let usedTokens = 0;
  const perKindCount: Record<ContextItemKind, number> = {
    core_rule: 0,
    project_fact: 0,
    dependency_contract: 0,
    verified_analogue: 0,
    raw_evidence_link: 0,
  };

  for (const bucket of buckets) {
    for (const candidate of bucket) {
      const kind = candidate.item.kind;
      const max = maxForKind(kind, budget);
      if (perKindCount[kind] >= max) {
        dropped.push({
          id: candidate.item.id,
          kind,
          reason: `bucket cap exhausted for ${kind}`,
        });
        continue;
      }
      if (usedTokens + candidate.tokens > budget.availableForRetrieval) {
        dropped.push({
          id: candidate.item.id,
          kind,
          reason: 'budget exhausted (reserved capacity held for code reading)',
        });
        continue;
      }
      selected.push(candidate);
      usedTokens += candidate.tokens;
      perKindCount[kind] += 1;
    }
  }

  // Stable final order: kind priority, then rank key (already bucket-sorted).
  selected.sort((a, b) => compareRankKeys(a.rankKey, b.rankKey));

  const items = selected.map(toRetrieved);
  const usefulnessSignals: ContextUsefulnessRecord[] = items.map((i) => ({
    itemId: i.id,
    signal: 'unobserved' as const,
  }));

  // Stable dropped order for deterministic replay.
  dropped.sort((a, b) => {
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    if (a.reason < b.reason) return -1;
    if (a.reason > b.reason) return 1;
    return 0;
  });

  const outputWithoutDigest = {
    version: CONTEXT_COMPILER_SCHEMA_VERSION,
    mode: 'shadow' as const,
    injectedIntoPrompt: false as const,
    taskId: req.taskId,
    project: req.project,
    repoKey: req.repoKey,
    bodyDigest: req.bodyDigest.toLowerCase(),
    compiledAtMs: req.nowMs,
    budget,
    usedTokens,
    remainingReservedForCodeReading: budget.reservedForCodeReading,
    items,
    dropped,
    usefulnessSignals,
  };

  const digest = createHash('sha256')
    .update(stableStringify(outputWithoutDigest), 'utf8')
    .digest('hex');

  return { ...outputWithoutDigest, digest };
}

/**
 * Bridge: only verified_outcome / playbook_knowledge become analogue candidates.
 * Raw receipts stay out of default analogue retrieval.
 * Playbook reuse is fail-closed: requires store-aware mayReuse status.
 * Contradicted, stale, superseded, expired, low-confidence, and forbidden are blocked.
 */
export function contextCandidateFromEvidenceRecord(
  record: EvidenceMemoryRecord,
  opts: {
    readonly similarityScore: number;
    readonly nowMs?: number;
    readonly store?: EvidenceMemoryStore;
    readonly staleAfterMs?: number;
    readonly ttlMs?: number;
    readonly minReuseConfidence?: number;
  },
): ContextSourceItem | null {
  if (record.kind !== 'verified_outcome' && record.kind !== 'playbook_knowledge') {
    return null;
  }
  if (record.contradictionState === 'confirmed') {
    return null;
  }
  if (record.kind === 'playbook_knowledge') {
    if (opts.store === undefined || opts.nowMs === undefined) {
      return null;
    }
    const status = evaluatePlaybookKnowledgeStatus(record, opts.store, {
      nowMs: opts.nowMs,
      ...(opts.staleAfterMs !== undefined ? { staleAfterMs: opts.staleAfterMs } : {}),
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(opts.minReuseConfidence !== undefined
        ? { minReuseConfidence: opts.minReuseConfidence }
        : {}),
    });
    if (!mayReusePlaybookKnowledge(status)) {
      return null;
    }
  }
  const content = record.summary;
  const item: ContextSourceItem = {
    id: record.id,
    kind: 'verified_analogue',
    content,
    tokenEstimate: estimateContextTokens(content),
    provenance: record.provenance,
    scope: record.scope,
    recencyMs: record.recencyMs,
    contradictionState: record.contradictionState,
    verified: true,
    similarityScore: opts.similarityScore,
    ...(record.fingerprint.featureKind !== undefined
      ? { featureKind: record.fingerprint.featureKind }
      : {}),
    ...(record.supersedesRecordId !== undefined
      ? { supersedesRecordId: record.supersedesRecordId }
      : {}),
  };
  return item;
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = sortKeys(obj[k]);
  }
  return out;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function contextCompilerShadowCanonical(output: ContextCompilerShadowOutput): string {
  return stableStringify(output);
}

export function contextCompilerShadowDigest(output: ContextCompilerShadowOutput): string {
  return createHash('sha256').update(contextCompilerShadowCanonical(output), 'utf8').digest('hex');
}

/** Shadow output must never be treated as live prompt material. */
export function contextCompilerMayInjectIntoPrompt(
  _output: ContextCompilerShadowOutput,
): false {
  return false;
}

export function contextCompilerMayMutateRuntime(_output: ContextCompilerShadowOutput): false {
  return false;
}

export function contextCompilerAuthorizes(
  _output: ContextCompilerShadowOutput,
  _action: ContextCompilerForbiddenAction | string,
): false {
  return false;
}
