/** Control-layer parse/serialize helpers for repos.yaml execution_policy. */
import { z } from 'zod';
import {
  effectiveRepoExecutionPolicy,
  isExecutionPolicyProfile,
  isNetworkPosture,
  isSandboxMode,
  validateEnvAllowlist,
  type ExecutionPolicyProfile,
  type NetworkPosture,
  type RepoExecutionPolicyInput,
  type SandboxMode,
} from '../domain/repoExecutionPolicy.js';

const boolish = z.union([z.boolean(), z.string()]).optional().transform((v, ctx) => {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v !== 'string') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid boolean' });
    return z.NEVER;
  }
  const t = v.trim().toLowerCase();
  if (t === 'true' || t === 'yes' || t === '1') return true;
  if (t === 'false' || t === 'no' || t === '0') return false;
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid boolean' });
  return z.NEVER;
});

export function serializeExecutionPolicy(policy: RepoExecutionPolicyInput): Record<string, unknown> | null {
  const ep: Record<string, unknown> = {};
  if (policy.profile !== undefined) ep['profile'] = policy.profile;
  if (policy.sandbox !== undefined) ep['sandbox'] = policy.sandbox;
  if (policy.network !== undefined) ep['network'] = policy.network;
  if (policy.envAllowlist !== undefined) ep['env_allowlist'] = [...policy.envAllowlist];
  if (policy.forbidProductionSecrets !== undefined) {
    ep['forbid_production_secrets'] = policy.forbidProductionSecrets;
  }
  if (policy.forbidConnectorCredentials !== undefined) {
    ep['forbid_connector_credentials'] = policy.forbidConnectorCredentials;
  }
  if (policy.forbidLivePersonalData !== undefined) {
    ep['forbid_live_personal_data'] = policy.forbidLivePersonalData;
  }
  if (policy.workspaceWrite !== undefined) ep['workspace_write'] = policy.workspaceWrite;
  return Object.keys(ep).length > 0 ? ep : null;
}

/** Zod schema for optional execution_policy block (snake_case on disk). */
export const executionPolicySchema = z
  .object({
    profile: z.string().optional(),
    sandbox: z.string().optional(),
    network: z.string().optional(),
    env_allowlist: z.array(z.string()).optional(),
    forbid_production_secrets: boolish,
    forbid_connector_credentials: boolish,
    forbid_live_personal_data: boolish,
    workspace_write: boolish,
  })
  .strict()
  .optional()
  .nullable()
  .transform((raw, ctx): RepoExecutionPolicyInput | null => {
    if (raw === undefined || raw === null) return null;
    const profile = parseProfile(raw.profile, ctx);
    if (profile === FAIL) return z.NEVER;
    const sandbox = parseSandbox(raw.sandbox, ctx);
    if (sandbox === FAIL) return z.NEVER;
    const network = parseNetwork(raw.network, ctx);
    if (network === FAIL) return z.NEVER;
    const envAllowlist = parseEnvList(raw.env_allowlist, ctx);
    if (envAllowlist === FAIL) return z.NEVER;
    const assembled = assemblePolicy(profile, sandbox, network, envAllowlist, raw);
    const err = assembledPolicyError(assembled);
    if (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
      return z.NEVER;
    }
    return assembled;
  });

const FAIL = Symbol('execution-policy-fail');
type Fail = typeof FAIL;

function parseProfile(
  value: string | undefined,
  ctx: z.RefinementCtx,
): ExecutionPolicyProfile | undefined | Fail {
  if (value === undefined) return undefined;
  const p = value.trim().toLowerCase();
  if (!isExecutionPolicyProfile(p)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unknown execution_policy.profile' });
    return FAIL;
  }
  return p;
}

function parseSandbox(
  value: string | undefined,
  ctx: z.RefinementCtx,
): SandboxMode | undefined | Fail {
  if (value === undefined) return undefined;
  const s = value.trim().toLowerCase();
  if (!isSandboxMode(s)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unknown execution_policy.sandbox' });
    return FAIL;
  }
  return s;
}

function parseNetwork(
  value: string | undefined,
  ctx: z.RefinementCtx,
): NetworkPosture | undefined | Fail {
  if (value === undefined) return undefined;
  const n = value.trim().toLowerCase();
  if (!isNetworkPosture(n)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unknown execution_policy.network' });
    return FAIL;
  }
  return n;
}

function parseEnvList(
  value: string[] | undefined,
  ctx: z.RefinementCtx,
): readonly string[] | undefined | Fail {
  if (value === undefined) return undefined;
  const v = validateEnvAllowlist(value);
  if (!v.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: v.reason });
    return FAIL;
  }
  return v.names;
}

function assembledPolicyError(a: RepoExecutionPolicyInput): string | null {
  if (a.profile === 'guardian' && (a.forbidProductionSecrets === false || a.forbidConnectorCredentials === false || a.forbidLivePersonalData === false)) {
    return 'profile guardian cannot set forbid_* to false';
  }
  // Judge the resolved posture, not the raw partial, so profile defaults and
  // field overrides are checked consistently with runtime enforcement.
  const effective = effectiveRepoExecutionPolicy(a);
  if (
    effective.profile === 'guardian' &&
    (effective.sandbox !== 'workspace' ||
      effective.network !== 'off' ||
      !effective.workspaceWrite)
  ) {
    return 'profile guardian cannot relax sandbox/network/workspace_write posture';
  }
  if (effective.workspaceWrite && effective.sandbox !== 'workspace') {
    return 'workspace_write requires sandbox workspace';
  }
  return null;
}

function assemblePolicy(
  profile: ExecutionPolicyProfile | undefined,
  sandbox: SandboxMode | undefined,
  network: NetworkPosture | undefined,
  envAllowlist: readonly string[] | undefined,
  raw: {
    forbid_production_secrets?: boolean | undefined;
    forbid_connector_credentials?: boolean | undefined;
    forbid_live_personal_data?: boolean | undefined;
    workspace_write?: boolean | undefined;
  },
): RepoExecutionPolicyInput {
  return {
    ...(profile !== undefined ? { profile } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    ...(network !== undefined ? { network } : {}),
    ...(envAllowlist !== undefined ? { envAllowlist } : {}),
    ...(raw.forbid_production_secrets !== undefined
      ? { forbidProductionSecrets: raw.forbid_production_secrets }
      : {}),
    ...(raw.forbid_connector_credentials !== undefined
      ? { forbidConnectorCredentials: raw.forbid_connector_credentials }
      : {}),
    ...(raw.forbid_live_personal_data !== undefined
      ? { forbidLivePersonalData: raw.forbid_live_personal_data }
      : {}),
    ...(raw.workspace_write !== undefined ? { workspaceWrite: raw.workspace_write } : {}),
  };
}
