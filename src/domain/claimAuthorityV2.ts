import {
  assertCandidateRef,
  type CandidateRef,
} from './artifact.js';
import {
  canonicalSerialize,
  hashCanonicalJson,
} from './canonicalJson.js';
import type { EvaluationAuthorityContext } from './evaluationVerdict.js';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export const ASSERTION_KINDS = ['fact', 'inference', 'opinion'] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export interface DecisionAssertion {
  readonly id: string;
  readonly subjectKey: string;
  readonly kind: AssertionKind;
  readonly canonicalPayload: CanonicalJsonValue;
  readonly payloadHash: string;
  readonly advisoryText: string | null;
}

export interface AssertionVerificationReceipt {
  readonly schema: 'hercules-assertion-verification/v1';
  readonly id: string;
  readonly assertionId: string;
  readonly assertionPayloadHash: string;
  readonly subjectKey: string;
  readonly valueHash: string;
  readonly taskId: string;
  readonly contractVersion: number;
  readonly contractHash: string;
  readonly iterationId: string;
  readonly candidateRef: CandidateRef;
  readonly evidenceManifestId: string;
  readonly evidenceManifestHash: string;
  readonly evidenceEntryArtifactIds: readonly string[];
  readonly criterionIds: readonly string[];
  readonly verifierRunId: string;
  readonly verifierImplementation: string;
  readonly observationSurface: string;
  readonly observedAt: string;
  readonly receiptHash: string;
}

export interface ClaimAuthorityContext {
  readonly trustedVerifierRunIds: readonly string[];
  readonly implementerRunIds: readonly string[];
  readonly reviewerRunIds: readonly string[];
  readonly evaluatorRunIds: readonly string[];
  readonly agentClaimProducerRunIds: readonly string[];
  readonly evaluationAuthority: EvaluationAuthorityContext;
}

export interface EvidenceIntegrityArtifact {
  readonly artifactRefId: string;
  readonly sha256: string;
}

export interface EvidenceIntegrityAttestation {
  readonly schema: 'hercules-evidence-integrity-attestation/v1';
  readonly result: 'intact' | 'missing' | 'tampered' | 'unavailable';
  readonly evidenceManifestId: string | null;
  readonly evidenceManifestHash: string | null;
  readonly candidateRef: CandidateRef | null;
  readonly checkedArtifacts: readonly EvidenceIntegrityArtifact[];
  readonly verifierImplementation: string;
  readonly checkedAt: string;
  readonly attestationHash: string;
}

export type ClaimAuthorityV2ErrorCode =
  | 'invalid_assertion'
  | 'invalid_receipt'
  | 'invalid_authority_context'
  | 'invalid_integrity_attestation';

export class ClaimAuthorityV2Error extends Error {
  override readonly name = 'ClaimAuthorityV2Error';

  constructor(
    readonly code: ClaimAuthorityV2ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_IDENTIFIER_BYTES = 256;
const MAX_ADVISORY_BYTES = 8 * 1024;
const MAX_ARRAY_ITEMS = 4_096;

const ASSERTION_KEYS = [
  'id',
  'subjectKey',
  'kind',
  'canonicalPayload',
  'payloadHash',
  'advisoryText',
] as const;

const RECEIPT_KEYS = [
  'schema',
  'id',
  'assertionId',
  'assertionPayloadHash',
  'subjectKey',
  'valueHash',
  'taskId',
  'contractVersion',
  'contractHash',
  'iterationId',
  'candidateRef',
  'evidenceManifestId',
  'evidenceManifestHash',
  'evidenceEntryArtifactIds',
  'criterionIds',
  'verifierRunId',
  'verifierImplementation',
  'observationSurface',
  'observedAt',
  'receiptHash',
] as const;

const AUTHORITY_KEYS = [
  'trustedVerifierRunIds',
  'implementerRunIds',
  'reviewerRunIds',
  'evaluatorRunIds',
  'agentClaimProducerRunIds',
  'evaluationAuthority',
] as const;

const EVALUATION_AUTHORITY_KEYS = [
  'evaluatorAgentRunId',
  'implementerAgentRunIds',
] as const;

const ATTESTATION_KEYS = [
  'schema',
  'result',
  'evidenceManifestId',
  'evidenceManifestHash',
  'candidateRef',
  'checkedArtifacts',
  'verifierImplementation',
  'checkedAt',
  'attestationHash',
] as const;

const INTEGRITY_ARTIFACT_KEYS = ['artifactRefId', 'sha256'] as const;

function fail(code: ClaimAuthorityV2ErrorCode, message: string): never {
  throw new ClaimAuthorityV2Error(code, message);
}

function assertExactRecord(
  value: unknown,
  keys: readonly string[],
  code: ClaimAuthorityV2ErrorCode,
  label: string,
): asserts value is Readonly<Record<string, unknown>> {
  try {
    canonicalSerialize(value);
  } catch (error) {
    fail(code, `${label} must be stable canonical JSON: ${String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, `${label} must be an object`);
  }
  const actual = Object.getOwnPropertyNames(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(code, `${label} must use the exact closed schema`);
  }
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    utf8Bytes(value) >= 1 &&
    utf8Bytes(value) <= MAX_IDENTIFIER_BYTES
  );
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && utf8Bytes(value) <= MAX_ADVISORY_BYTES;
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_RE.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || utf8Bytes(value) > MAX_IDENTIFIER_BYTES) {
    return false;
  }
  const time = new Date(value);
  return !Number.isNaN(time.valueOf()) && time.toISOString() === value;
}

function isNullableBoundedIdentifier(value: unknown): value is string | null {
  return value === null || isBoundedIdentifier(value);
}

function assertSortedUniqueIdentifiers(
  value: unknown,
  code: ClaimAuthorityV2ErrorCode,
  label: string,
  allowEmpty = true,
): asserts value is readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_ARRAY_ITEMS ||
    (!allowEmpty && value.length === 0)
  ) {
    fail(code, `${label} must be a bounded${allowEmpty ? '' : ' non-empty'} array`);
  }
  let previous: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value) || !isBoundedIdentifier(value[index])) {
      fail(code, `${label} must contain bounded UTF-8 identities`);
    }
    const current = value[index];
    if (previous !== null && previous >= current) {
      fail(code, `${label} must contain sorted unique identities`);
    }
    previous = current;
  }
}

function omitHash<T extends object>(
  value: T,
  keyToOmit: string,
): Readonly<Record<string, unknown>> {
  const record = value as unknown as Readonly<Record<string, unknown>>;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== keyToOmit),
  );
}

export function computeAssertionPayloadHash(payload: CanonicalJsonValue): string {
  return hashCanonicalJson(payload);
}

export function computeVerificationReceiptHash(
  receipt: Omit<AssertionVerificationReceipt, 'receiptHash'>,
): string {
  return hashCanonicalJson(receipt);
}

export function computeEvidenceIntegrityAttestationHash(
  attestation: Omit<EvidenceIntegrityAttestation, 'attestationHash'>,
): string {
  return hashCanonicalJson(attestation);
}

export function assertDecisionAssertion(
  assertion: DecisionAssertion,
): void {
  assertExactRecord(assertion, ASSERTION_KEYS, 'invalid_assertion', 'decision assertion');
  if (
    !isBoundedIdentifier(assertion.id) ||
    !isBoundedIdentifier(assertion.subjectKey) ||
    !(ASSERTION_KINDS as readonly unknown[]).includes(assertion.kind) ||
    !isHash(assertion.payloadHash) ||
    (assertion.advisoryText !== null && !isBoundedText(assertion.advisoryText))
  ) {
    fail(
      'invalid_assertion',
      'decision assertion identity must use bounded UTF-8 fields and valid kinds/hashes',
    );
  }
  let expected: string;
  try {
    expected = computeAssertionPayloadHash(assertion.canonicalPayload);
  } catch (error) {
    fail('invalid_assertion', `decision assertion payload is invalid: ${String(error)}`);
  }
  if (assertion.payloadHash !== expected) {
    fail('invalid_assertion', 'decision assertion payload hash does not match canonical payload');
  }
}

export function assertAssertionVerificationReceiptShape(
  receipt: AssertionVerificationReceipt,
): void {
  assertExactRecord(
    receipt,
    RECEIPT_KEYS,
    'invalid_receipt',
    'assertion verification receipt',
  );
  if (
    receipt.schema !== 'hercules-assertion-verification/v1' ||
    !isBoundedIdentifier(receipt.id) ||
    !isBoundedIdentifier(receipt.assertionId) ||
    !isHash(receipt.assertionPayloadHash) ||
    !isBoundedIdentifier(receipt.subjectKey) ||
    !isHash(receipt.valueHash) ||
    !isBoundedIdentifier(receipt.taskId) ||
    !Number.isSafeInteger(receipt.contractVersion) ||
    receipt.contractVersion < 1 ||
    !isHash(receipt.contractHash) ||
    !isBoundedIdentifier(receipt.iterationId) ||
    !isBoundedIdentifier(receipt.evidenceManifestId) ||
    !isHash(receipt.evidenceManifestHash) ||
    !isBoundedIdentifier(receipt.verifierRunId) ||
    !isBoundedIdentifier(receipt.verifierImplementation) ||
    !isBoundedIdentifier(receipt.observationSurface) ||
    !isCanonicalTimestamp(receipt.observedAt) ||
    !isHash(receipt.receiptHash)
  ) {
    fail(
      'invalid_receipt',
      'receipt identity, binding, timestamp, and hash fields must be valid bounded values',
    );
  }
  try {
    assertCandidateRef(receipt.candidateRef);
  } catch (error) {
    fail('invalid_receipt', `receipt candidate is invalid: ${String(error)}`);
  }
  assertSortedUniqueIdentifiers(
    receipt.evidenceEntryArtifactIds,
    'invalid_receipt',
    'receipt evidence artifact ids',
  );
  assertSortedUniqueIdentifiers(
    receipt.criterionIds,
    'invalid_receipt',
    'receipt criterion ids',
  );
}

export function assertAssertionVerificationReceipt(
  receipt: AssertionVerificationReceipt,
): void {
  assertAssertionVerificationReceiptShape(receipt);
  const expected = hashCanonicalJson(omitHash(receipt, 'receiptHash'));
  if (receipt.receiptHash !== expected) {
    fail('invalid_receipt', 'receipt hash does not match the exact receipt record');
  }
}

export function assertClaimAuthorityContext(
  context: ClaimAuthorityContext,
): void {
  assertExactRecord(
    context,
    AUTHORITY_KEYS,
    'invalid_authority_context',
    'claim authority context',
  );
  assertExactRecord(
    context.evaluationAuthority,
    EVALUATION_AUTHORITY_KEYS,
    'invalid_authority_context',
    'evaluation authority context',
  );
  assertSortedUniqueIdentifiers(
    context.trustedVerifierRunIds,
    'invalid_authority_context',
    'trusted verifier run ids',
  );
  assertSortedUniqueIdentifiers(
    context.implementerRunIds,
    'invalid_authority_context',
    'implementer run ids',
  );
  assertSortedUniqueIdentifiers(
    context.reviewerRunIds,
    'invalid_authority_context',
    'reviewer run ids',
  );
  assertSortedUniqueIdentifiers(
    context.evaluatorRunIds,
    'invalid_authority_context',
    'evaluator run ids',
  );
  assertSortedUniqueIdentifiers(
    context.agentClaimProducerRunIds,
    'invalid_authority_context',
    'agent claim producer run ids',
  );
  assertSortedUniqueIdentifiers(
    context.evaluationAuthority.implementerAgentRunIds,
    'invalid_authority_context',
    'nested implementer run ids',
  );
  if (
    !isNullableBoundedIdentifier(context.evaluationAuthority.evaluatorAgentRunId) ||
    canonicalSerialize(context.implementerRunIds) !==
      canonicalSerialize(context.evaluationAuthority.implementerAgentRunIds)
  ) {
    fail(
      'invalid_authority_context',
      'outer and nested implementer authority identities must agree exactly',
    );
  }
  const evaluator = context.evaluationAuthority.evaluatorAgentRunId;
  const expectedEvaluators = evaluator === null ? [] : [evaluator];
  if (canonicalSerialize(context.evaluatorRunIds) !== canonicalSerialize(expectedEvaluators)) {
    fail(
      'invalid_authority_context',
      'outer evaluator identities must equal the nested evaluator singleton',
    );
  }
  const prohibited = new Set([
    ...context.implementerRunIds,
    ...context.reviewerRunIds,
    ...context.evaluatorRunIds,
    ...context.agentClaimProducerRunIds,
    ...context.evaluationAuthority.implementerAgentRunIds,
    ...(evaluator === null ? [] : [evaluator]),
  ]);
  if (context.trustedVerifierRunIds.some((runId) => prohibited.has(runId))) {
    fail(
      'invalid_authority_context',
      'trusted verifier identities must be independent from implementer, reviewer, evaluator, and self-report identities',
    );
  }
}

export function assertEvidenceIntegrityAttestation(
  attestation: EvidenceIntegrityAttestation,
): void {
  assertExactRecord(
    attestation,
    ATTESTATION_KEYS,
    'invalid_integrity_attestation',
    'evidence integrity attestation',
  );
  if (
    attestation.schema !== 'hercules-evidence-integrity-attestation/v1' ||
    !(['intact', 'missing', 'tampered', 'unavailable'] as const).includes(
      attestation.result,
    ) ||
    !isNullableBoundedIdentifier(attestation.evidenceManifestId) ||
    (attestation.evidenceManifestHash !== null &&
      !isHash(attestation.evidenceManifestHash)) ||
    !isBoundedIdentifier(attestation.verifierImplementation) ||
    !isCanonicalTimestamp(attestation.checkedAt) ||
    !isHash(attestation.attestationHash) ||
    !Array.isArray(attestation.checkedArtifacts) ||
    attestation.checkedArtifacts.length > MAX_ARRAY_ITEMS
  ) {
    fail(
      'invalid_integrity_attestation',
      'integrity attestation identity, result, binding, timestamp, and hash fields must be valid',
    );
  }
  if (attestation.candidateRef !== null) {
    try {
      assertCandidateRef(attestation.candidateRef);
    } catch (error) {
      fail(
        'invalid_integrity_attestation',
        `integrity attestation candidate is invalid: ${String(error)}`,
      );
    }
  }
  const artifactIds = new Set<string>();
  for (const artifact of attestation.checkedArtifacts) {
    assertExactRecord(
      artifact,
      INTEGRITY_ARTIFACT_KEYS,
      'invalid_integrity_attestation',
      'integrity artifact',
    );
    const artifactRefId = artifact['artifactRefId'];
    const sha256 = artifact['sha256'];
    if (!isBoundedIdentifier(artifactRefId) || !isHash(sha256)) {
      fail(
        'invalid_integrity_attestation',
        'integrity artifacts must carry bounded identities and exact hashes',
      );
    }
    if (artifactIds.has(artifactRefId)) {
      fail('invalid_integrity_attestation', 'integrity artifact identities must be unique');
    }
    artifactIds.add(artifactRefId);
  }
  const expected = hashCanonicalJson(omitHash(attestation, 'attestationHash'));
  if (attestation.attestationHash !== expected) {
    fail(
      'invalid_integrity_attestation',
      'attestation hash does not match the exact integrity record',
    );
  }
}
