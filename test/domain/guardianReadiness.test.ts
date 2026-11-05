import { describe, it, expect } from 'vitest';
import {
  evaluateGuardianReadiness,
  requiresGuardianReadiness,
  formatGuardianReadinessFailure,
  GUARDIAN_READINESS_VERSION,
  GUARDIAN_READINESS_CONTROL_IDS,
  UNVERIFIED_B022_CAPABILITIES,
  type GuardianReadinessFacts,
} from '../../src/domain/guardianReadiness.js';
import {
  guardianExecutionPolicyDefaults,
  compatibleExecutionPolicyDefaults,
  effectiveRepoExecutionPolicy,
} from '../../src/domain/repoExecutionPolicy.js';

describe('requiresGuardianReadiness', () => {
  it('true only for guardian profile', () => {
    expect(requiresGuardianReadiness(guardianExecutionPolicyDefaults())).toBe(true);
    expect(requiresGuardianReadiness(compatibleExecutionPolicyDefaults())).toBe(false);
    expect(GUARDIAN_READINESS_CONTROL_IDS.length).toBe(10);
    expect(GUARDIAN_READINESS_VERSION).toBe(1);
    expect(UNVERIFIED_B022_CAPABILITIES.daemonWorkrootLease).toBe(false);
    expect(effectiveRepoExecutionPolicy({ profile: 'compatible' }).profile).toBe('compatible');
  });
});

function greenFacts(over: Partial<GuardianReadinessFacts> = {}): GuardianReadinessFacts {
  return {
    policy: guardianExecutionPolicyDefaults(),
    adapterKind: 'grok',
    maxConcurrent: 1,
    daemonLease: { status: 'ours' },
    capabilities: {
      buildAttested: true,
      daemonWorkrootLease: true,
      taskBranchExactLease: true,
      taskPathLeases: true,
      protectedPathDrift: true,
      cliBehavioralEvidence: true,
    },
    workflowCliEvidence: 'verified',
    provenance: {
      defaultRevision: 'a'.repeat(40),
      workflowSha256: 'b'.repeat(64),
      policySha256: 'c'.repeat(64),
    },
    ...over,
  };
}

describe('evaluateGuardianReadiness', () => {
  it('non-guardian is not applicable', () => {
    const r = evaluateGuardianReadiness(
      greenFacts({ policy: compatibleExecutionPolicyDefaults() }),
    );
    expect(r.applicable).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.controls).toEqual([]);
    expect(r.grantsOnly).toBe('harness_readiness');
  });

  it('fully explicit fixture passes with all controls and one-writer', () => {
    const r = evaluateGuardianReadiness(greenFacts());
    expect(r.applicable).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.failedCodes).toEqual([]);
    expect(r.controls.map((c) => c.id)).toEqual([...GUARDIAN_READINESS_CONTROL_IDS]);
    expect(r.controls.every((c) => c.ok)).toBe(true);
    expect(r.controls.find((c) => c.id === 'one_writer')?.ok).toBe(true);
    expect(r.grantsOnly).toBe('harness_readiness');
  });

  it('fails closed on lease and policy gaps', () => {
    expect(
      evaluateGuardianReadiness(greenFacts({ daemonLease: { status: 'absent' } })).failedCodes,
    ).toContain('daemon_lease_absent');
    expect(
      evaluateGuardianReadiness(greenFacts({ daemonLease: { status: 'stale' } })).failedCodes,
    ).toContain('daemon_lease_stale');
    expect(
      evaluateGuardianReadiness(
        greenFacts({ policy: { ...guardianExecutionPolicyDefaults(), explicit: false } }),
      ).failedCodes,
    ).toContain('execution_policy_implicit');
    expect(
      evaluateGuardianReadiness(
        greenFacts({
          policy: { ...guardianExecutionPolicyDefaults(), network: 'unrestricted' },
        }),
      ).failedCodes,
    ).toContain('execution_policy_relaxed');
    expect(evaluateGuardianReadiness(greenFacts({ adapterKind: 'codex' })).ok).toBe(false);
    expect(
      evaluateGuardianReadiness(
        greenFacts({
          maxConcurrent: 4,
          capabilities: { ...greenFacts().capabilities, taskPathLeases: false },
        }),
      ).ok,
    ).toBe(false);
    expect(
      evaluateGuardianReadiness(greenFacts({ workflowCliEvidence: 'absent' })).failedCodes,
    ).toContain('cli_evidence_absent');
    const absent = evaluateGuardianReadiness(greenFacts({ workflowCliEvidence: 'absent' }));
    const absentCtrl = absent.controls.find((c) => c.id === 'cli_behavioral_evidence');
    expect(absentCtrl?.code).toBe('cli_evidence_absent');
    expect(absentCtrl?.remediation).toMatch(/WORKFLOW|cli_evidence/i);
    expect(absentCtrl?.remediation).not.toMatch(/mirror is reachable/i);
    expect(
      evaluateGuardianReadiness(greenFacts({ workflowCliEvidence: 'invalid' })).failedCodes,
    ).toContain('cli_evidence_invalid');
    for (const [status, code] of [
      ['build_missing', 'cli_build_missing'],
      ['build_failed', 'cli_build_failed'],
      ['workspace_mutated', 'cli_workspace_mutated'],
    ] as const) {
      const result = evaluateGuardianReadiness(greenFacts({ workflowCliEvidence: status }));
      expect(result.failedCodes).toContain(code);
      const diagnostic = result.controls.find((c) => c.id === 'cli_behavioral_evidence');
      expect(diagnostic?.remediation).toBeTruthy();
      expect(JSON.stringify(diagnostic)).not.toContain('command output');
    }
    expect(
      evaluateGuardianReadiness(greenFacts({ workflowCliEvidence: 'unverified' })).failedCodes,
    ).toContain('cli_evidence_unverified');
    expect(
      evaluateGuardianReadiness(greenFacts({ workflowCliEvidence: 'unknown' })).failedCodes,
    ).toContain('cli_evidence_unknown');
    const unknown = evaluateGuardianReadiness(greenFacts({ workflowCliEvidence: 'unknown' }));
    expect(
      unknown.controls.find((c) => c.id === 'cli_behavioral_evidence')?.remediation,
    ).toMatch(/mirror|re-probe/i);
    expect(
      evaluateGuardianReadiness(
        greenFacts({
          capabilities: { ...greenFacts().capabilities, taskBranchExactLease: false },
        }),
      ).failedCodes,
    ).toContain('branch_lease_unsupported');
  });

  it('formatGuardianReadinessFailure is concise and secret-free', () => {
    const r = evaluateGuardianReadiness(greenFacts({ daemonLease: { status: 'absent' } }));
    const msg = formatGuardianReadinessFailure(r);
    expect(msg).toMatch(/guardian readiness blocked/i);
    expect(msg).toMatch(/daemon_lease_/);
    expect(msg.length).toBeLessThan(2000);
  });
});
