import { describe, expect, it } from 'vitest';
import {
  ClaimAuthorityV2Error,
  assertAssertionVerificationReceipt,
  assertClaimAuthorityContext,
  assertDecisionAssertion,
  assertEvidenceIntegrityAttestation,
  computeAssertionPayloadHash,
  computeEvidenceIntegrityAttestationHash,
  computeVerificationReceiptHash,
  type AssertionVerificationReceipt,
  type ClaimAuthorityContext,
  type DecisionAssertion,
  type EvidenceIntegrityAttestation,
} from '../../src/domain/claimAuthorityV2.js';

const assertion: DecisionAssertion = {
  id: 'assertion-1',
  subjectKey: 'tests.unit',
  kind: 'fact',
  canonicalPayload: { passed: true, total: 42 },
  payloadHash: computeAssertionPayloadHash({ passed: true, total: 42 }),
  advisoryText: 'Unit tests passed.',
};

function receipt(
  overrides: Partial<AssertionVerificationReceipt> = {},
): AssertionVerificationReceipt {
  const withoutHash = {
    schema: 'hercules-assertion-verification/v1' as const,
    id: 'receipt-1',
    assertionId: assertion.id,
    assertionPayloadHash: assertion.payloadHash,
    subjectKey: assertion.subjectKey,
    valueHash: assertion.payloadHash,
    taskId: 'task-1',
    contractVersion: 1,
    contractHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    iterationId: 'iteration-1',
    candidateRef: {
      kind: 'git' as const,
      repository: 'example-org/acme',
      revision: '0123456789abcdef0123456789abcdef01234567',
    },
    evidenceManifestId: 'manifest-1',
    evidenceManifestHash:
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    evidenceEntryArtifactIds: ['artifact-1'],
    criterionIds: ['criterion-1'],
    verifierRunId: 'verifier-1',
    verifierImplementation: 'fixture-verifier-v1',
    observationSurface: 'pnpm-test',
    observedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
  return {
    ...withoutHash,
    receiptHash: computeVerificationReceiptHash(withoutHash),
  };
}

function attestation(
  overrides: Partial<EvidenceIntegrityAttestation> = {},
): EvidenceIntegrityAttestation {
  const withoutHash = {
    schema: 'hercules-evidence-integrity-attestation/v1' as const,
    result: 'intact' as const,
    evidenceManifestId: 'manifest-1',
    evidenceManifestHash:
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    candidateRef: receipt().candidateRef,
    checkedArtifacts: [
      {
        artifactRefId: 'artifact-1',
        sha256:
          'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      },
    ],
    verifierImplementation: 'integrity-v1',
    checkedAt: '2026-08-29T00:00:01.000Z',
    ...overrides,
  };
  return {
    ...withoutHash,
    attestationHash: computeEvidenceIntegrityAttestationHash(withoutHash),
  };
}

const authorityContext: ClaimAuthorityContext = {
  trustedVerifierRunIds: ['verifier-1'],
  implementerRunIds: ['implementer-1'],
  reviewerRunIds: ['reviewer-1'],
  evaluatorRunIds: ['evaluator-1'],
  agentClaimProducerRunIds: ['agent-claim-1'],
  evaluationAuthority: {
    evaluatorAgentRunId: 'evaluator-1',
    implementerAgentRunIds: ['implementer-1'],
  },
};

describe('M6 claim authority records', () => {
  it('accepts exact canonical assertion, receipt, integrity, and authority records', () => {
    expect(() => assertDecisionAssertion(assertion)).not.toThrow();
    expect(() => assertAssertionVerificationReceipt(receipt())).not.toThrow();
    expect(() => assertEvidenceIntegrityAttestation(attestation())).not.toThrow();
    expect(() => assertClaimAuthorityContext(authorityContext)).not.toThrow();
  });

  it('rejects caller-injected assertion authority fields and payload hash mismatch', () => {
    expect(() =>
      assertDecisionAssertion({
        ...assertion,
        decisionEligible: true,
      } as unknown as DecisionAssertion),
    ).toThrow(ClaimAuthorityV2Error);
    expect(() =>
      assertDecisionAssertion({
        ...assertion,
        payloadHash:
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ).toThrow('payload hash');
  });

  it('recomputes receipt and attestation hashes and requires canonical M6 timestamps', () => {
    expect(() =>
      assertAssertionVerificationReceipt({
        ...receipt(),
        receiptHash:
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ).toThrow('receipt hash');
    expect(() =>
      assertAssertionVerificationReceipt(
        receipt({ observedAt: '2026-08-29T00:00:00Z' }),
      ),
    ).toThrow('timestamp');
    expect(() =>
      assertEvidenceIntegrityAttestation({
        ...attestation(),
        attestationHash:
          'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      }),
    ).toThrow('attestation hash');
  });

  it('rejects duplicate integrity identities and mutable authority-set ambiguity', () => {
    const artifact = attestation().checkedArtifacts[0]!;
    expect(() =>
      assertEvidenceIntegrityAttestation(
        attestation({ checkedArtifacts: [artifact, artifact] }),
      ),
    ).toThrow('unique');
    expect(() =>
      assertClaimAuthorityContext({
        ...authorityContext,
        trustedVerifierRunIds: ['evaluator-1'],
      }),
    ).toThrow('independent');
    expect(() =>
      assertClaimAuthorityContext({
        ...authorityContext,
        evaluatorRunIds: [],
      }),
    ).toThrow('evaluator');
  });

  it('uses UTF-8 byte bounds rather than JavaScript character counts', () => {
    expect(() =>
      assertDecisionAssertion({
        ...assertion,
        id: '界'.repeat(86),
      }),
    ).toThrow('UTF-8');
  });
});
