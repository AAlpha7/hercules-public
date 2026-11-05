/**
 * Domain — advisory playbook learning from verified evidence.
 * Fail-closed reuse and promotion against confirmed contradictions.
 * Pure domain: no IO; advisory recommendations only.
 *
 * Learning lifecycle stage after record-only evidence memory
 * (docs/autonomy/evidence-memory.md):
 *   record → advisory recommendation → (later) shadow → adoption
 *
 * Promote to local playbook knowledge only after repeated verified success;
 * promote across projects only after repeated cross-project proof.
 * Contradicted, stale, superseded, or low-confidence knowledge is downgraded
 * and never silently reused. Recommendations remain advisory and never alter
 * prompts, adapters, concurrency, permissions, or gates.
 * Human decisions and security policy are forbidden learning targets.
 * Confirmed contradictions refuse promotion; demoted knowledge is not bridge-reused.
 */
import { createHash } from 'node:crypto';
import {
  appendEvidenceMemoryRecord,
  makeEvidenceRecordId,
  redactEvidenceText,
  type EvidenceMemoryProvenance,
  type EvidenceMemoryRecord,
  type EvidenceMemoryScope,
  type EvidenceMemoryStore,
} from './evidenceMemory.js';
import { isValidIdentifier } from './task.js';

export const PLAYBOOK_ADVISORY_SCHEMA_VERSION = 1 as const;
export const PLAYBOOK_ADVISORY_MODE = 'advisory' as const;

/** Local promotion requires at least this many distinct successful outcomes. */
export const MIN_LOCAL_PROMOTION_SUCCESSES = 2 as const;
/** Cross-project promotion requires at least this many distinct successful outcomes. */
export const MIN_CROSS_PROJECT_PROMOTION_SUCCESSES = 3 as const;
/** Cross-project promotion requires successes in at least this many projects. */
export const MIN_CROSS_PROJECT_COUNT = 2 as const;
/** Minimum confidence required to promote knowledge. */
export const MIN_PROMOTION_CONFIDENCE = 0.6 as const;
/** Below this confidence, knowledge is downgraded and not reused. */
export const MIN_REUSE_CONFIDENCE = 0.5 as const;
/** Default staleness window (90 days). */
export const DEFAULT_PLAYBOOK_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
/** Default time-to-live from last supporting observation. */
export const DEFAULT_PLAYBOOK_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export const MAX_PLAYBOOK_EVIDENCE_REFS = 8;
export const MAX_PLAYBOOK_TEXT_LEN = 400;
export const MAX_PLAYBOOK_REASONS = 16;

export const PLAYBOOK_KNOWLEDGE_GRADES = [
  'active',
  'downgraded',
  'expired',
  'blocked',
] as const;
export type PlaybookKnowledgeGrade = (typeof PLAYBOOK_KNOWLEDGE_GRADES)[number];

export const PLAYBOOK_DEMOTION_REASONS = [
  'contradicted',
  'stale',
  'superseded',
  'low_confidence',
  'expired',
  'forbidden_target',
] as const;
export type PlaybookDemotionReason = (typeof PLAYBOOK_DEMOTION_REASONS)[number];

export const PLAYBOOK_SCOPE_LEVELS = ['local', 'cross_project'] as const;
export type PlaybookScopeLevel = (typeof PLAYBOOK_SCOPE_LEVELS)[number];

/** Actions this advisory stage never authorizes. */
export const PLAYBOOK_ADVISORY_FORBIDDEN_ACTIONS = [
  'alter_prompt',
  'alter_adapter',
  'alter_routing',
  'alter_concurrency',
  'alter_permissions',
  'alter_gates',
  'weaken_gates',
  'alter_scheduling',
  'alter_source_code',
] as const;
export type PlaybookAdvisoryForbiddenAction =
  (typeof PLAYBOOK_ADVISORY_FORBIDDEN_ACTIONS)[number];

/**
 * Topics that must never become learned automation targets.
 * Human decisions and security policy stay outside the learning loop.
 */
export const PLAYBOOK_FORBIDDEN_LEARNING_TARGETS = [
  'human_decision',
  'security_policy',
  'permission_policy',
  'production_promote',
  'gate_policy',
  'destructive_action',
] as const;
export type PlaybookForbiddenLearningTarget =
  (typeof PLAYBOOK_FORBIDDEN_LEARNING_TARGETS)[number];

const FORBIDDEN_TARGET_PATTERNS: readonly RegExp[] = [
  /\bhuman[_\s-]?decision/i,
  /\bsecurity[_\s-]?policy/i,
  /\bpermission[_\s-]?policy/i,
  /\bproduction[_\s-]?(?:promote|deploy|approval)/i,
  /\bgate[_\s-]?policy/i,
  /\bdestructive[_\s-]?action/i,
  /\bauto[-_\s]?approve\b/i,
  /\bautomate\s+human\b/i,
];

export interface PlaybookEvidenceRef {
  readonly recordId: string;
  readonly summary: string;
  readonly project?: string;
  readonly observedAtMs: number;
  readonly contradictionState: EvidenceMemoryRecord['contradictionState'];
}

export interface PlaybookPromotionRequest {
  readonly recommendationKey: string;
  readonly conditions: string;
  readonly recommendation: string;
  /** When set, evaluate local (same-project) promotion. */
  readonly project?: string;
  readonly module?: string;
  readonly featureKind?: string;
  /** When true and project is omitted, evaluate cross-project promotion. */
  readonly allowCrossProject?: boolean;
  readonly nowMs: number;
  readonly staleAfterMs?: number;
  readonly ttlMs?: number;
}

export type PlaybookPromotionDecision =
  | {
      readonly ok: true;
      readonly scopeLevel: PlaybookScopeLevel;
      readonly confidence: number;
      readonly supportingCount: number;
      readonly contradictingCount: number;
      readonly projectCount: number;
      readonly supportingOutcomeIds: readonly string[];
      readonly supportingEvidence: readonly PlaybookEvidenceRef[];
      readonly contradictingEvidence: readonly PlaybookEvidenceRef[];
      readonly expiryMs: number;
    }
  | {
      readonly ok: false;
      readonly reasons: readonly string[];
      readonly supportingCount: number;
      readonly contradictingCount: number;
      readonly projectCount: number;
      readonly supportingOutcomeIds: readonly string[];
      readonly supportingEvidence: readonly PlaybookEvidenceRef[];
      readonly contradictingEvidence: readonly PlaybookEvidenceRef[];
    };

export interface PlaybookKnowledgeStatus {
  readonly knowledgeId: string;
  readonly grade: PlaybookKnowledgeGrade;
  readonly mayReuse: boolean;
  readonly confidence: number;
  readonly scope: EvidenceMemoryScope;
  readonly scopeLevel: PlaybookScopeLevel;
  readonly expiryMs: number;
  readonly demotionReasons: readonly PlaybookDemotionReason[];
  readonly supportingEvidence: readonly PlaybookEvidenceRef[];
  readonly contradictingEvidence: readonly PlaybookEvidenceRef[];
}

export interface PlaybookRecommendation {
  readonly mode: typeof PLAYBOOK_ADVISORY_MODE;
  readonly knowledgeId: string;
  readonly recommendationKey: string;
  readonly conditions: string;
  readonly recommendation: string;
  readonly confidence: number;
  readonly scope: EvidenceMemoryScope;
  readonly scopeLevel: PlaybookScopeLevel;
  readonly expiryMs: number;
  readonly grade: PlaybookKnowledgeGrade;
  readonly mayReuse: boolean;
  readonly supportingEvidence: readonly PlaybookEvidenceRef[];
  readonly contradictingEvidence: readonly PlaybookEvidenceRef[];
  readonly demotionReasons: readonly PlaybookDemotionReason[];
}

export interface TryPromotePlaybookResult {
  readonly store: EvidenceMemoryStore;
  readonly applied: boolean;
  readonly decision: PlaybookPromotionDecision;
  readonly record?: EvidenceMemoryRecord;
}

function boundText(text: string, max = MAX_PLAYBOOK_TEXT_LEN): string {
  const one = text.split(/\s+/).join(' ').trim();
  if (one.length <= max) return one;
  return one.slice(0, max - 1) + '...';
}

function isSafeKey(value: string): boolean {
  return value.length > 0 && value.length <= 128 && isValidIdentifier(value);
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '_');
}

export function isForbiddenPlaybookLearningTarget(keyOrText: string): boolean {
  const raw = keyOrText.trim();
  if (!raw) return false;
  const norm = normalizeKey(raw);
  for (const target of PLAYBOOK_FORBIDDEN_LEARNING_TARGETS) {
    if (norm === target || norm.includes(target)) return true;
  }
  for (const re of FORBIDDEN_TARGET_PATTERNS) {
    if (re.test(raw)) return true;
  }
  return false;
}

function recommendationKeyOf(record: EvidenceMemoryRecord): string | undefined {
  const fromPayload = record.payload?.['recommendationKey'];
  if (typeof fromPayload === 'string' && fromPayload.trim().length > 0) {
    return normalizeKey(fromPayload);
  }
  if (record.diagnosed?.cause) {
    return normalizeKey(record.diagnosed.cause);
  }
  return undefined;
}

function isSuccessfulVerified(
  record: EvidenceMemoryRecord,
  nowMs: number,
  staleAfterMs: number,
): boolean {
  if (record.kind !== 'verified_outcome') return false;
  if (record.contradictionState === 'confirmed') return false;
  if (record.contradictionState === 'suspected') return false;
  if (!record.gates || record.gates.length === 0) return false;
  if (!record.gates.every((g) => g.ok)) return false;
  if (nowMs - record.recencyMs > staleAfterMs) return false;
  return true;
}

function toEvidenceRef(record: EvidenceMemoryRecord): PlaybookEvidenceRef {
  return {
    recordId: record.id,
    summary: boundText(record.summary),
    ...(record.scope.project !== undefined ? { project: record.scope.project } : {}),
    observedAtMs: record.observedAtMs,
    contradictionState: record.contradictionState,
  };
}

function uniqueById(records: readonly EvidenceMemoryRecord[]): EvidenceMemoryRecord[] {
  const seen = new Set<string>();
  const out: EvidenceMemoryRecord[] = [];
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/** Match outcomes to a promotion key; project filter only when local. */
function recordInPromotionScope(
  record: EvidenceMemoryRecord,
  req: PlaybookPromotionRequest,
): boolean {
  const key = recommendationKeyOf(record);
  if (!key || key !== normalizeKey(req.recommendationKey)) return false;
  if (req.featureKind !== undefined && record.fingerprint.featureKind !== req.featureKind) {
    return false;
  }
  if (req.module !== undefined && record.scope.module !== req.module) return false;
  if (req.project !== undefined && record.scope.project !== req.project) return false;
  return true;
}

function isAdverseRecord(record: EvidenceMemoryRecord): boolean {
  if (record.kind === 'superseded_evidence') return true;
  if (record.contradictionState === 'confirmed' || record.contradictionState === 'suspected') {
    return true;
  }
  if (record.kind === 'verified_outcome' && record.gates?.some((g) => !g.ok)) {
    return true;
  }
  return false;
}

function collectSupportAndContradict(
  store: EvidenceMemoryStore,
  req: PlaybookPromotionRequest,
  staleAfterMs: number,
): {
  support: EvidenceMemoryRecord[];
  contradict: EvidenceMemoryRecord[];
  projects: Set<string>;
} {
  const support: EvidenceMemoryRecord[] = [];
  const contradict: EvidenceMemoryRecord[] = [];
  const projects = new Set<string>();

  for (const record of store.records) {
    if (record.kind === 'playbook_knowledge') continue;
    if (!recordInPromotionScope(record, req)) continue;

    if (isSuccessfulVerified(record, req.nowMs, staleAfterMs)) {
      support.push(record);
      if (record.scope.project) projects.add(record.scope.project);
    } else if (isAdverseRecord(record)) {
      contradict.push(record);
    }
  }

  return {
    support: uniqueById(support),
    contradict: uniqueById(contradict),
    projects,
  };
}

function computeConfidence(supportCount: number, contradictCount: number): number {
  if (supportCount <= 0) return 0;
  const total = supportCount + contradictCount;
  const ratio = supportCount / total;
  const mass = Math.min(1, supportCount / (supportCount + 1));
  const raw = ratio * (0.55 + 0.45 * mass);
  return Math.max(0, Math.min(1, Number(raw.toFixed(4))));
}

function pushReason(reasons: string[], message: string): void {
  if (reasons.length >= MAX_PLAYBOOK_REASONS) return;
  reasons.push(boundText(message));
}

export function evaluatePlaybookPromotion(
  store: EvidenceMemoryStore,
  req: PlaybookPromotionRequest,
): PlaybookPromotionDecision {
  const reasons: string[] = [];
  if (!isSafeKey(req.recommendationKey)) {
    pushReason(reasons, 'recommendationKey is not a safe identifier');
  }
  if (!req.conditions.trim() || !req.recommendation.trim()) {
    pushReason(reasons, 'conditions and recommendation required');
  }
  if (
    isForbiddenPlaybookLearningTarget(req.recommendationKey) ||
    isForbiddenPlaybookLearningTarget(req.recommendation) ||
    isForbiddenPlaybookLearningTarget(req.conditions)
  ) {
    pushReason(
      reasons,
      'forbidden learning target: human decisions and security policy cannot become automation',
    );
  }

  const staleAfterMs = req.staleAfterMs ?? DEFAULT_PLAYBOOK_STALE_AFTER_MS;
  const ttlMs = req.ttlMs ?? DEFAULT_PLAYBOOK_TTL_MS;
  const collected = collectSupportAndContradict(store, req, staleAfterMs);
  const support = collected.support;
  const contradict = collected.contradict;
  const projectCount = collected.projects.size;
  const supportingOutcomeIds = support.map((r) => r.id);
  const supportingEvidence = support.slice(0, MAX_PLAYBOOK_EVIDENCE_REFS).map(toEvidenceRef);
  const contradictingEvidence = contradict.slice(0, MAX_PLAYBOOK_EVIDENCE_REFS).map(toEvidenceRef);
  const confidence = computeConfidence(support.length, contradict.length);

  const wantCross = req.allowCrossProject === true && req.project === undefined;
  const scopeLevel: PlaybookScopeLevel = wantCross ? 'cross_project' : 'local';

  if (!wantCross && req.project === undefined) {
    pushReason(reasons, 'local promotion requires project scope');
  }

  if (wantCross) {
    if (support.length < MIN_CROSS_PROJECT_PROMOTION_SUCCESSES) {
      pushReason(
        reasons,
        `insufficient cross-project verified successes (need ${MIN_CROSS_PROJECT_PROMOTION_SUCCESSES}, have ${support.length})`,
      );
    }
    if (projectCount < MIN_CROSS_PROJECT_COUNT) {
      pushReason(
        reasons,
        `cross-project promotion needs successes in at least ${MIN_CROSS_PROJECT_COUNT} projects (have ${projectCount})`,
      );
    }
  } else if (req.project !== undefined) {
    if (support.length < MIN_LOCAL_PROMOTION_SUCCESSES) {
      pushReason(
        reasons,
        `insufficient repeated local verified successes (need ${MIN_LOCAL_PROMOTION_SUCCESSES}, have ${support.length})`,
      );
    }
  }

  if (confidence < MIN_PROMOTION_CONFIDENCE) {
    pushReason(
      reasons,
      `confidence ${confidence} below promotion threshold ${MIN_PROMOTION_CONFIDENCE}`,
    );
  }
  // Fail-closed: never write knowledge that is immediately demoted yet still
  // bridge-eligible via a stale high payload confidence.
  const hasConfirmedContradiction = contradict.some(
    (r) => r.contradictionState === 'confirmed',
  );
  if (hasConfirmedContradiction) {
    pushReason(
      reasons,
      'confirmed contradicting evidence in scope; refuse promotion',
    );
  }

  if (reasons.length > 0) {
    return {
      ok: false,
      reasons,
      supportingCount: support.length,
      contradictingCount: contradict.length,
      projectCount,
      supportingOutcomeIds,
      supportingEvidence,
      contradictingEvidence,
    };
  }

  const lastSupportMs = support.reduce((max, r) => Math.max(max, r.recencyMs), 0);
  const expiryMs = lastSupportMs + ttlMs;

  return {
    ok: true,
    scopeLevel,
    confidence,
    supportingCount: support.length,
    contradictingCount: contradict.length,
    projectCount,
    supportingOutcomeIds,
    supportingEvidence,
    contradictingEvidence,
    expiryMs,
  };
}

export function tryPromotePlaybookKnowledge(
  store: EvidenceMemoryStore,
  req: PlaybookPromotionRequest,
  provenance: EvidenceMemoryProvenance,
): TryPromotePlaybookResult {
  const decision = evaluatePlaybookPromotion(store, req);
  if (!decision.ok) {
    return { store, applied: false, decision };
  }

  const payloadDigest = createHash('sha256')
    .update(
      [
        normalizeKey(req.recommendationKey),
        decision.scopeLevel,
        req.project ?? '',
        req.module ?? '',
        req.featureKind ?? '',
        ...decision.supportingOutcomeIds.slice().sort(),
      ].join('\0'),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32);

  const id = makeEvidenceRecordId({
    kind: 'playbook_knowledge',
    provenance,
    observedAtMs: req.nowMs,
    payloadDigest,
  });

  const lastSupportMs = decision.supportingEvidence.reduce(
    (max, e) => Math.max(max, e.observedAtMs),
    req.nowMs,
  );

  const scope: EvidenceMemoryScope = {
    ...(req.project !== undefined ? { project: req.project } : {}),
    ...(req.module !== undefined ? { module: req.module } : {}),
    ...(req.project !== undefined ? { repoKey: req.project } : {}),
  };

  const repoKey = req.project ?? 'cross-project';

  const record: EvidenceMemoryRecord = {
    id,
    kind: 'playbook_knowledge',
    observedAtMs: req.nowMs,
    recencyMs: lastSupportMs,
    scope,
    contradictionState: 'none',
    provenance,
    fingerprint: {
      taskId: provenance.taskId,
      repoKey,
      ...(req.featureKind !== undefined ? { featureKind: req.featureKind } : {}),
      bodyDigest: createHash('sha256')
        .update(`${req.recommendationKey}\0${req.conditions}\0${req.recommendation}`, 'utf8')
        .digest('hex'),
    },
    summary: boundText(
      redactEvidenceText(
        `playbook: ${req.conditions} -> ${req.recommendation}`,
        MAX_PLAYBOOK_TEXT_LEN,
      ),
      MAX_PLAYBOOK_TEXT_LEN,
    ),
    sourceOutcomeIds: decision.supportingOutcomeIds,
    payload: {
      recommendationKey: normalizeKey(req.recommendationKey),
      conditions: boundText(req.conditions),
      recommendation: boundText(req.recommendation),
      scopeLevel: decision.scopeLevel,
      confidence: decision.confidence,
      expiryMs: decision.expiryMs,
    },
  };

  const appended = appendEvidenceMemoryRecord(store, record);
  return {
    store: appended.store,
    applied: appended.applied,
    decision,
    ...(appended.applied ? { record } : {}),
  };
}

function knowledgeRequestFromRecord(
  knowledge: EvidenceMemoryRecord,
  nowMs: number,
  staleAfterMs: number,
  ttlMs: number,
): PlaybookPromotionRequest {
  const key =
    (typeof knowledge.payload?.['recommendationKey'] === 'string'
      ? knowledge.payload['recommendationKey']
      : recommendationKeyOf(knowledge)) ?? knowledge.id;
  const conditions =
    typeof knowledge.payload?.['conditions'] === 'string'
      ? String(knowledge.payload['conditions'])
      : knowledge.summary;
  const recommendation =
    typeof knowledge.payload?.['recommendation'] === 'string'
      ? String(knowledge.payload['recommendation'])
      : knowledge.summary;
  const scopeLevel = knowledge.payload?.['scopeLevel'];
  const allowCrossProject = scopeLevel === 'cross_project';
  return {
    recommendationKey: key,
    conditions,
    recommendation,
    ...(knowledge.scope.project !== undefined && !allowCrossProject
      ? { project: knowledge.scope.project }
      : {}),
    ...(knowledge.scope.module !== undefined ? { module: knowledge.scope.module } : {}),
    ...(knowledge.fingerprint.featureKind !== undefined
      ? { featureKind: knowledge.fingerprint.featureKind }
      : {}),
    ...(allowCrossProject ? { allowCrossProject: true } : {}),
    nowMs,
    staleAfterMs,
    ttlMs,
  };
}

function isSuperseded(knowledge: EvidenceMemoryRecord, store: EvidenceMemoryStore): boolean {
  if (knowledge.kind === 'superseded_evidence') return true;
  return store.records.some(
    (r) => r.kind === 'superseded_evidence' && r.supersedesRecordId === knowledge.id,
  );
}

function resolveGrade(
  demotionReasons: readonly PlaybookDemotionReason[],
): PlaybookKnowledgeGrade {
  if (demotionReasons.includes('forbidden_target')) return 'blocked';
  if (demotionReasons.length === 0) return 'active';
  if (
    demotionReasons.every((r) => r === 'expired' || r === 'stale') &&
    demotionReasons.includes('expired')
  ) {
    return 'expired';
  }
  return 'downgraded';
}

export function evaluatePlaybookKnowledgeStatus(
  knowledge: EvidenceMemoryRecord,
  store: EvidenceMemoryStore,
  opts: {
    readonly nowMs: number;
    readonly staleAfterMs?: number;
    readonly ttlMs?: number;
    readonly minReuseConfidence?: number;
  },
): PlaybookKnowledgeStatus {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_PLAYBOOK_STALE_AFTER_MS;
  const ttlMs = opts.ttlMs ?? DEFAULT_PLAYBOOK_TTL_MS;
  const minReuse = opts.minReuseConfidence ?? MIN_REUSE_CONFIDENCE;

  const req = knowledgeRequestFromRecord(knowledge, opts.nowMs, staleAfterMs, ttlMs);
  const collected = collectSupportAndContradict(store, req, staleAfterMs);
  const confidence = computeConfidence(collected.support.length, collected.contradict.length);

  const payloadExpiry =
    typeof knowledge.payload?.['expiryMs'] === 'number'
      ? knowledge.payload['expiryMs']
      : knowledge.recencyMs + ttlMs;
  const expiryMs = payloadExpiry;

  const scopeLevel: PlaybookScopeLevel =
    knowledge.payload?.['scopeLevel'] === 'cross_project' ? 'cross_project' : 'local';

  const demotionReasons: PlaybookDemotionReason[] = [];

  const keyText =
    typeof knowledge.payload?.['recommendationKey'] === 'string'
      ? String(knowledge.payload['recommendationKey'])
      : knowledge.summary;
  const recText =
    typeof knowledge.payload?.['recommendation'] === 'string'
      ? String(knowledge.payload['recommendation'])
      : knowledge.summary;
  if (isForbiddenPlaybookLearningTarget(keyText) || isForbiddenPlaybookLearningTarget(recText)) {
    demotionReasons.push('forbidden_target');
  }

  if (isSuperseded(knowledge, store)) {
    demotionReasons.push('superseded');
  }

  const hasConfirmedContradiction =
    knowledge.contradictionState === 'confirmed' ||
    collected.contradict.some((r) => r.contradictionState === 'confirmed');
  if (hasConfirmedContradiction) {
    demotionReasons.push('contradicted');
  }

  if (opts.nowMs - knowledge.recencyMs > staleAfterMs) {
    demotionReasons.push('stale');
  }

  if (opts.nowMs > expiryMs) {
    demotionReasons.push('expired');
  }

  if (confidence < minReuse) {
    demotionReasons.push('low_confidence');
  }

  const grade = resolveGrade(demotionReasons);
  const mayReuse = grade === 'active' && demotionReasons.length === 0 && confidence >= minReuse;

  return {
    knowledgeId: knowledge.id,
    grade,
    mayReuse,
    confidence,
    scope: knowledge.scope,
    scopeLevel,
    expiryMs,
    demotionReasons,
    supportingEvidence: collected.support.slice(0, MAX_PLAYBOOK_EVIDENCE_REFS).map(toEvidenceRef),
    contradictingEvidence: collected.contradict
      .slice(0, MAX_PLAYBOOK_EVIDENCE_REFS)
      .map(toEvidenceRef),
  };
}

export function mayReusePlaybookKnowledge(status: PlaybookKnowledgeStatus): boolean {
  return status.mayReuse === true && status.grade === 'active';
}

export function buildPlaybookRecommendation(
  knowledge: EvidenceMemoryRecord,
  store: EvidenceMemoryStore,
  opts: {
    readonly nowMs: number;
    readonly staleAfterMs?: number;
    readonly ttlMs?: number;
    readonly minReuseConfidence?: number;
  },
): PlaybookRecommendation | null {
  if (knowledge.kind !== 'playbook_knowledge') return null;

  const status = evaluatePlaybookKnowledgeStatus(knowledge, store, opts);
  const recommendationKey =
    typeof knowledge.payload?.['recommendationKey'] === 'string'
      ? String(knowledge.payload['recommendationKey'])
      : knowledge.id;
  const conditions =
    typeof knowledge.payload?.['conditions'] === 'string'
      ? String(knowledge.payload['conditions'])
      : knowledge.summary;
  const recommendation =
    typeof knowledge.payload?.['recommendation'] === 'string'
      ? String(knowledge.payload['recommendation'])
      : knowledge.summary;

  return {
    mode: PLAYBOOK_ADVISORY_MODE,
    knowledgeId: knowledge.id,
    recommendationKey,
    conditions: boundText(conditions),
    recommendation: boundText(recommendation),
    confidence: status.confidence,
    scope: status.scope,
    scopeLevel: status.scopeLevel,
    expiryMs: status.expiryMs,
    grade: status.grade,
    mayReuse: status.mayReuse,
    supportingEvidence: status.supportingEvidence,
    contradictingEvidence: status.contradictingEvidence,
    demotionReasons: status.demotionReasons,
  };
}

/** Advisory stage: never grants runtime mutation authority. */
export function playbookAdvisoryMayMutateRuntime(_store: EvidenceMemoryStore): false {
  return false;
}

export function playbookAdvisoryAuthorizes(
  _store: EvidenceMemoryStore,
  _action: PlaybookAdvisoryForbiddenAction | string,
): false {
  return false;
}

