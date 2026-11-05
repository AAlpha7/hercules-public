/**
 * Domain — Guardian B-022 onboarding readiness gate (pure).
 *
 * Machine-readable preflight for repositories that declare Guardian-grade
 * execution policy. Fail closed when any required B-022 control is missing,
 * implicit, stale, unsupported, or unverified. A green receipt grants only
 * harness-readiness — never merge, deploy, promotion, live-data access,
 * connector mutation, or Guardian registration.
 *
 * No IO / git / fs / network. Outer layers inject lease status, adapter kind,
 * and harness capability flags.
 */
import type { AdapterKind } from './agents.js';
import {
  type EffectiveRepoExecutionPolicy,
  resolvePolicyAgainstAdapter,
  type PolicyEnforceCode,
} from './repoExecutionPolicy.js';
import {
  effectivePathWriterLimit,
  pathLeasePolicyFor,
} from './taskPathLease.js';

/** Receipt schema version (bounded, stable). */
export const GUARDIAN_READINESS_VERSION = 1 as const;

/** Stable control ids — order is the receipt order. */
export const GUARDIAN_READINESS_CONTROL_IDS = [
  'harness_build_attestation',
  'daemon_workroot_lease',
  'execution_policy',
  'execution_policy_enforceable',
  'repo_serialization',
  'one_writer',
  'task_branch_exact_lease',
  'task_path_leases',
  'protected_path_drift',
  'cli_behavioral_evidence',
] as const;

export type GuardianReadinessControlId =
  (typeof GUARDIAN_READINESS_CONTROL_IDS)[number];

/** Stable machine-readable reason codes (kebab / snake, no free prose). */
export const GUARDIAN_READINESS_CODES = [
  'ok',
  'not_applicable',
  'harness_build_unverified',
  'daemon_lease_unsupported',
  'daemon_lease_absent',
  'daemon_lease_stale',
  'daemon_lease_foreign',
  'daemon_lease_invalid',
  'daemon_lease_unknown',
  'execution_policy_implicit',
  'execution_policy_not_guardian',
  'execution_policy_relaxed',
  'execution_policy_unsupported',
  'sandbox_unsupported',
  'network_unsupported',
  'workspace_write_unsupported',
  'env_allowlist_unsupported',
  'workspace_write_inconsistent',
  'repo_serialization_multi_writer',
  'one_writer_violated',
  'branch_lease_unsupported',
  'path_lease_unsupported',
  'path_lease_declarations_not_required',
  'protected_path_drift_unsupported',
  'cli_evidence_unsupported',
  'cli_evidence_absent',
  'cli_evidence_invalid',
  'cli_build_missing',
  'cli_build_failed',
  'cli_workspace_mutated',
  'cli_evidence_failed',
  'cli_evidence_stale',
  'cli_evidence_unverified',
  'cli_evidence_unknown',
] as const;

export type GuardianReadinessCode = (typeof GUARDIAN_READINESS_CODES)[number];

export type DaemonLeaseReadinessStatus =
  | 'ours'
  | 'absent'
  | 'stale'
  | 'live_foreign'
  | 'invalid'
  | 'unknown';

export type WorkflowCliEvidenceStatus =
  | 'verified'
  | 'absent'
  | 'invalid'
  | 'build_missing'
  | 'build_failed'
  | 'workspace_mutated'
  | 'failed'
  | 'stale'
  | 'unverified'
  | 'unknown';

/** Structural harness capabilities (composition root / fixtures inject these). */
export interface GuardianHarnessCapabilities {
  /** Runtime build is clean and descends from the merged B-022 control baseline. */
  readonly buildAttested: boolean;
  readonly daemonWorkrootLease: boolean;
  readonly taskBranchExactLease: boolean;
  readonly taskPathLeases: boolean;
  readonly protectedPathDrift: boolean;
  readonly cliBehavioralEvidence: boolean;
}

/**
 * Hercules-in-tree B-022 capabilities. True when this binary ships the
 * exclusive lease, exact branch CAS, path leases + drift, and trusted CLI
 * evidence runner. Fixtures may override to prove fail-closed paths.
 */
export const UNVERIFIED_B022_CAPABILITIES: GuardianHarnessCapabilities = {
  buildAttested: false,
  daemonWorkrootLease: false,
  taskBranchExactLease: false,
  taskPathLeases: false,
  protectedPathDrift: false,
  cliBehavioralEvidence: false,
};

export interface GuardianReadinessProvenance {
  readonly defaultRevision: string | null;
  readonly workflowSha256: string | null;
  readonly policySha256: string;
}

export interface GuardianReadinessFacts {
  readonly policy: EffectiveRepoExecutionPolicy;
  /** Effective adapter for this repo (task chain not known at mark-ready). */
  readonly adapterKind: AdapterKind;
  readonly maxConcurrent: number;
  readonly daemonLease: { readonly status: DaemonLeaseReadinessStatus };
  readonly capabilities: GuardianHarnessCapabilities;
  readonly workflowCliEvidence: WorkflowCliEvidenceStatus;
  readonly provenance: GuardianReadinessProvenance;
}

export interface GuardianReadinessControl {
  readonly id: GuardianReadinessControlId;
  readonly ok: boolean;
  readonly code: GuardianReadinessCode;
  readonly label: string;
  readonly detail: string;
  /** Operator remediation when not ok; null when green. Never secrets/paths. */
  readonly remediation: string | null;
}

export interface GuardianReadinessReceipt {
  readonly version: typeof GUARDIAN_READINESS_VERSION;
  /** False when the repo is not Guardian-grade — soft onboarding only. */
  readonly applicable: boolean;
  readonly ok: boolean;
  readonly profile: EffectiveRepoExecutionPolicy['profile'];
  readonly controls: readonly GuardianReadinessControl[];
  readonly failedCodes: readonly GuardianReadinessCode[];
  readonly summary: string;
  /**
   * Explicit grant boundary: green receipt never authorizes merge, deploy,
   * promotion, live data, connector mutation, or Guardian registration.
   */
  readonly grantsOnly: 'harness_readiness';
  /** Exact inputs the decision was bound to; no free-form or secret values. */
  readonly provenance: GuardianReadinessProvenance;
}

/** True when repos.yaml effective policy is Guardian-grade (hard gate). */
export function requiresGuardianReadiness(
  policy: Pick<EffectiveRepoExecutionPolicy, 'profile'>,
): boolean {
  return policy.profile === 'guardian';
}

function control(
  id: GuardianReadinessControlId,
  ok: boolean,
  code: GuardianReadinessCode,
  label: string,
  detail: string,
  remediation: string | null,
): GuardianReadinessControl {
  return { id, ok, code, label, detail, remediation: ok ? null : remediation };
}

function mapPolicyEnforceCode(code: PolicyEnforceCode): GuardianReadinessCode {
  switch (code) {
    case 'guardian_requires_explicit':
      return 'execution_policy_implicit';
    case 'guardian_relaxed':
      return 'execution_policy_relaxed';
    case 'sandbox_unsupported':
      return 'sandbox_unsupported';
    case 'network_unsupported':
      return 'network_unsupported';
    case 'workspace_write_unsupported':
      return 'workspace_write_unsupported';
    case 'env_allowlist_unsupported':
      return 'env_allowlist_unsupported';
    case 'workspace_write_inconsistent':
      return 'workspace_write_inconsistent';
    default: {
      const _exhaustive: never = code;
      return _exhaustive;
    }
  }
}

/**
 * Evaluate Guardian B-022 readiness from injected facts (no I/O).
 * Non-guardian policies return applicable:false, ok:true (soft path only).
 */
export function evaluateGuardianReadiness(
  facts: GuardianReadinessFacts,
): GuardianReadinessReceipt {
  const grantsOnly = 'harness_readiness' as const;
  if (!requiresGuardianReadiness(facts.policy)) {
    return {
      version: GUARDIAN_READINESS_VERSION,
      applicable: false,
      ok: true,
      profile: facts.policy.profile,
      controls: [],
      failedCodes: [],
      summary: 'Guardian readiness not required (compatible / non-guardian profile)',
      grantsOnly,
      provenance: facts.provenance,
    };
  }

  const controls: GuardianReadinessControl[] = [];
  const caps = facts.capabilities;

  controls.push(
    caps.buildAttested
      ? control(
          'harness_build_attestation',
          true,
          'ok',
          'Trusted harness build',
          'Runtime build descends from the merged B-022 control baseline',
          null,
        )
      : control(
          'harness_build_attestation',
          false,
          'harness_build_unverified',
          'Trusted harness build',
          'Runtime build provenance is missing, dirty, or predates the merged B-022 baseline',
          'Run a clean Hercules build whose commit contains the merged B-022 control baseline',
        ),
  );

  // 1. Exclusive daemon / work-root lease
  if (!caps.daemonWorkrootLease) {
    controls.push(
      control(
        'daemon_workroot_lease',
        false,
        'daemon_lease_unsupported',
        'Exclusive daemon / work-root lease',
        'Harness does not expose exclusive daemon lease capability',
        'Upgrade Hercules to a build that holds an exclusive daemon/work-root lease',
      ),
    );
  } else {
    const st = facts.daemonLease.status;
    if (st === 'ours') {
      controls.push(
        control(
          'daemon_workroot_lease',
          true,
          'ok',
          'Exclusive daemon / work-root lease',
          'This daemon holds the exclusive control+work-root lease',
          null,
        ),
      );
    } else {
      const code: GuardianReadinessCode =
        st === 'absent'
          ? 'daemon_lease_absent'
          : st === 'stale'
            ? 'daemon_lease_stale'
            : st === 'live_foreign'
              ? 'daemon_lease_foreign'
              : st === 'invalid'
                ? 'daemon_lease_invalid'
                : 'daemon_lease_unknown';
      controls.push(
        control(
          'daemon_workroot_lease',
          false,
          code,
          'Exclusive daemon / work-root lease',
          'Lease status is ' + st + ' (required: ours)',
          'Ensure a single Hercules daemon holds the work-root lease; stop foreign instances and restart this daemon',
        ),
      );
    }
  }

  // 2. Explicit execution policy (guardian full posture)
  if (!facts.policy.explicit) {
    controls.push(
      control(
        'execution_policy',
        false,
        'execution_policy_implicit',
        'Explicit Guardian execution policy',
        'execution_policy is not explicit on the repository',
        'Set repos.yaml execution_policy.profile: guardian (explicit block required)',
      ),
    );
  } else if (facts.policy.profile !== 'guardian') {
    controls.push(
      control(
        'execution_policy',
        false,
        'execution_policy_not_guardian',
        'Explicit Guardian execution policy',
        'profile is ' + facts.policy.profile + ' (required: guardian)',
        'Set execution_policy.profile: guardian',
      ),
    );
  } else if (
    facts.policy.sandbox !== 'workspace' ||
    facts.policy.network !== 'off' ||
    !facts.policy.workspaceWrite ||
    !facts.policy.forbidProductionSecrets ||
    !facts.policy.forbidConnectorCredentials ||
    !facts.policy.forbidLivePersonalData
  ) {
    controls.push(
      control(
        'execution_policy',
        false,
        'execution_policy_relaxed',
        'Explicit Guardian execution policy',
        'Guardian posture is relaxed (sandbox/network/workspace_write/forbid flags)',
        'Restore full guardian posture: sandbox workspace, network off, workspace_write true, all forbid flags true',
      ),
    );
  } else {
    controls.push(
      control(
        'execution_policy',
        true,
        'ok',
        'Explicit Guardian execution policy',
        'profile guardian with full explicit posture',
        null,
      ),
    );
  }

  // 3. Enforceable against effective adapter
  const enforce = resolvePolicyAgainstAdapter(facts.adapterKind, facts.policy);
  if (enforce.ok) {
    controls.push(
      control(
        'execution_policy_enforceable',
        true,
        'ok',
        'Policy enforceable by adapter',
        'adapter ' + facts.adapterKind + ' can enforce required controls',
        null,
      ),
    );
  } else {
    controls.push(
      control(
        'execution_policy_enforceable',
        false,
        mapPolicyEnforceCode(enforce.code),
        'Policy enforceable by adapter',
        enforce.reason,
        'Use an adapter that can enforce guardian controls (e.g. grok) or relax is not allowed — fix policy/adapter',
      ),
    );
  }

  // 4–5. Per-repo serialization + one-writer
  const pathPolicy = pathLeasePolicyFor(facts.policy);
  const writerLimit = caps.taskPathLeases
    ? effectivePathWriterLimit(facts.maxConcurrent, pathPolicy)
    : Math.max(1, Math.floor(facts.maxConcurrent) || 1);
  const serialOk = writerLimit === 1;
  controls.push(
    control(
      'repo_serialization',
      serialOk,
      serialOk ? 'ok' : 'repo_serialization_multi_writer',
      'Per-repository serialization',
      serialOk
        ? 'Effective writer limit is 1 (serialized)'
        : 'Effective writer limit is ' + String(writerLimit) + ' (required: 1)',
      serialOk
        ? null
        : 'Set max_concurrent: 1 and ensure guardian path-lease one-writer cap is active',
    ),
  );
  controls.push(
    control(
      'one_writer',
      serialOk,
      serialOk ? 'ok' : 'one_writer_violated',
      'One-writer policy',
      serialOk
        ? 'One concurrent path-lease writer for this repository'
        : 'Multiple concurrent writers would be allowed',
      serialOk
        ? null
        : 'Guardian requires one-writer: enable path leases and keep writer cap at 1',
    ),
  );

  // 6. Exact task-branch leases
  controls.push(
    caps.taskBranchExactLease
      ? control(
          'task_branch_exact_lease',
          true,
          'ok',
          'Exact task-branch leases',
          'Harness enforces force-with-lease exact tip CAS on task branches',
          null,
        )
      : control(
          'task_branch_exact_lease',
          false,
          'branch_lease_unsupported',
          'Exact task-branch leases',
          'Harness lacks exact task-branch lease capability',
          'Upgrade Hercules to a build with exact branch leases (no bare force push)',
        ),
  );

  // 7. Base / affected-path writer leases
  if (!caps.taskPathLeases) {
    controls.push(
      control(
        'task_path_leases',
        false,
        'path_lease_unsupported',
        'Base / affected-path writer leases',
        'Harness lacks path-lease capability',
        'Upgrade Hercules to a build with base revision and affected-path writer leases',
      ),
    );
  } else if (!pathPolicy.requireDeclarations) {
    controls.push(
      control(
        'task_path_leases',
        false,
        'path_lease_declarations_not_required',
        'Base / affected-path writer leases',
        'Path-lease declarations are not required under current policy',
        'Guardian profile must require path-lease declarations (pathLeasePolicyFor)',
      ),
    );
  } else {
    controls.push(
      control(
        'task_path_leases',
        true,
        'ok',
        'Base / affected-path writer leases',
        'Path leases required with base revision and affected_paths declarations',
        null,
      ),
    );
  }

  // 8. Protected-path drift behavior
  controls.push(
    caps.protectedPathDrift
      ? control(
          'protected_path_drift',
          true,
          'ok',
          'Protected-path drift behavior',
          'Path-lease acquire rejects protected-path policy drift',
          null,
        )
      : control(
          'protected_path_drift',
          false,
          'protected_path_drift_unsupported',
          'Protected-path drift behavior',
          'Harness does not enforce protected-path drift on path leases',
          'Upgrade Hercules to a build that rejects protected-path drift at lease acquire',
        ),
  );

  // 9. Trusted CLI behavioral evidence
  if (!caps.cliBehavioralEvidence) {
    controls.push(
      control(
        'cli_behavioral_evidence',
        false,
        'cli_evidence_unsupported',
        'Trusted CLI behavioral evidence',
        'Harness lacks trusted WORKFLOW cli_evidence runner',
        'Upgrade Hercules to a build with trusted CLI behavioral evidence',
      ),
    );
  } else if (facts.workflowCliEvidence === 'verified') {
    controls.push(
      control(
        'cli_behavioral_evidence',
        true,
        'ok',
        'Trusted CLI behavioral evidence',
        'CLI evidence passed on the exact trusted default revision and policy digest',
        null,
      ),
    );
  } else if (facts.workflowCliEvidence === 'invalid') {
    controls.push(
      control(
        'cli_behavioral_evidence',
        false,
        'cli_evidence_invalid',
        'Trusted CLI behavioral evidence',
        'WORKFLOW cli_evidence is present but invalid',
        'Fix trusted WORKFLOW cli_evidence (argv-only steps, version 1)',
      ),
    );
  } else if (facts.workflowCliEvidence === 'absent') {
    controls.push(
      control(
        'cli_behavioral_evidence',
        false,
        'cli_evidence_absent',
        'Trusted CLI behavioral evidence',
        'WORKFLOW is missing/empty or omits cli_evidence (required for guardian-grade readiness)',
        'Add trusted WORKFLOW with cli_evidence steps (never task body argv); re-probe after the default branch updates',
      ),
    );
  } else if (facts.workflowCliEvidence === 'build_missing') {
    controls.push(
      control(
        'cli_behavioral_evidence', false, 'cli_build_missing',
        'Trusted CLI behavioral evidence',
        'WORKFLOW declares CLI evidence but has no trusted build gate',
        'Add a build gate to the trusted WORKFLOW so the exact revision can be prepared before CLI verification',
      ),
    );
  } else if (facts.workflowCliEvidence === 'build_failed') {
    controls.push(
      control(
        'cli_behavioral_evidence', false, 'cli_build_failed',
        'Trusted CLI behavioral evidence',
        'The trusted build gate failed, timed out, or could not run before CLI evidence',
        'Fix the trusted default-branch build gate, then explicitly retry readiness verification',
      ),
    );
  } else if (facts.workflowCliEvidence === 'workspace_mutated') {
    controls.push(
      control(
        'cli_behavioral_evidence', false, 'cli_workspace_mutated',
        'Trusted CLI behavioral evidence',
        'Build or CLI verification changed tracked or untracked workspace files',
        'Make build and CLI evidence leave tracked and untracked files clean; ignored build artifacts are allowed',
      ),
    );
  } else if (facts.workflowCliEvidence === 'failed') {
    controls.push(
      control(
        'cli_behavioral_evidence', false, 'cli_evidence_failed',
        'Trusted CLI behavioral evidence',
        'CLI evidence ran on the trusted default revision and failed',
        'Fix the failing CLI behavior, then rerun readiness verification',
      ),
    );
  } else if (facts.workflowCliEvidence === 'stale') {
    controls.push(
      control(
        'cli_behavioral_evidence', false, 'cli_evidence_stale',
        'Trusted CLI behavioral evidence',
        'CLI evidence result does not match the current default revision or policy',
        'Rerun readiness verification against the current trusted revision',
      ),
    );
  } else if (facts.workflowCliEvidence === 'unverified') {
    controls.push(
      control(
        'cli_behavioral_evidence', false, 'cli_evidence_unverified',
        'Trusted CLI behavioral evidence',
        'A valid CLI evidence plan exists but no passing execution receipt was produced',
        'Run the trusted CLI evidence plan in the isolated default-revision worktree',
      ),
    );
  } else {
    controls.push(
      control(
        'cli_behavioral_evidence',
        false,
        'cli_evidence_unknown',
        'Trusted CLI behavioral evidence',
        'Could not probe WORKFLOW cli_evidence on the trusted branch',
        'Ensure the mirror is reachable and WORKFLOW is parseable, then re-probe',
      ),
    );
  }

  const byId = new Map(controls.map((c) => [c.id, c]));
  const ordered: GuardianReadinessControl[] = [];
  for (const id of GUARDIAN_READINESS_CONTROL_IDS) {
    const c = byId.get(id);
    if (c) ordered.push(c);
  }

  const failedCodes = ordered.filter((c) => !c.ok).map((c) => c.code);
  const ok = failedCodes.length === 0;
  const passed = ordered.filter((c) => c.ok).length;
  const summary = ok
    ? 'Guardian readiness ' +
      String(passed) +
      '/' +
      String(ordered.length) +
      ' — all B-022 controls green (harness-readiness only)'
    : 'Guardian readiness ' +
      String(passed) +
      '/' +
      String(ordered.length) +
      ' — failed: ' +
      failedCodes.join(', ');

  return {
    version: GUARDIAN_READINESS_VERSION,
    applicable: true,
    ok,
    profile: facts.policy.profile,
    controls: ordered,
    failedCodes,
    summary,
    grantsOnly,
    provenance: facts.provenance,
  };
}

/** Concise ActionError / flash text — codes + short remediation, no secrets. */
export function formatGuardianReadinessFailure(
  receipt: GuardianReadinessReceipt,
): string {
  if (receipt.ok || !receipt.applicable) {
    return receipt.summary;
  }
  const parts: string[] = [];
  for (const c of receipt.controls) {
    if (c.ok) continue;
    const rem = c.remediation ? ' — ' + c.remediation : '';
    parts.push(c.code + rem);
    if (parts.length >= 6) break;
  }
  const more =
    receipt.failedCodes.length > parts.length
      ? ' (+' + String(receipt.failedCodes.length - parts.length) + ' more)'
      : '';
  return 'Guardian readiness blocked: ' + parts.join('; ') + more;
}
