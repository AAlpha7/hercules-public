/** Policy-aware child env boundary. */
import {
  effectiveRepoExecutionPolicy,
  filterChildEnv,
  HERCULES_RUNTIME_ENV_NAMES,
  modelAuthNamesFor,
  type EffectiveRepoExecutionPolicy,
  type EnvFilterDecision,
  type RepoExecutionPolicyInput,
} from '../domain/repoExecutionPolicy.js';

export type PolicyChildEnvResult = {
  readonly env: NodeJS.ProcessEnv;
  readonly decision: EnvFilterDecision;
};

function resolvePolicy(
  policy?: EffectiveRepoExecutionPolicy | RepoExecutionPolicyInput | null,
): EffectiveRepoExecutionPolicy {
  if (policy && typeof policy === 'object' && 'explicit' in policy) {
    return policy as EffectiveRepoExecutionPolicy;
  }
  return effectiveRepoExecutionPolicy(policy ?? null);
}

export function codingChildEnv(input: {
  readonly policy?: EffectiveRepoExecutionPolicy | RepoExecutionPolicyInput | null;
  readonly source?: NodeJS.ProcessEnv;
  /** Provider-scoped auth names only; empty for Grok (uses GROK_HOME). */
  readonly modelAuthNames?: readonly string[];
  readonly includeModelAuth?: boolean;
  readonly extraAllowNames?: readonly string[];
  /** Merged into source and filtered — cannot re-add prohibited names. */
  readonly extras?: Readonly<Record<string, string | undefined>>;
}): PolicyChildEnvResult {
  const policy = resolvePolicy(input.policy);
  const source: Record<string, string | undefined> = {
    ...(input.source ?? process.env),
  };
  for (const [k, v] of Object.entries(input.extras ?? {})) {
    if (v !== undefined) source[k] = v;
  }
  const extraAllow = [...HERCULES_RUNTIME_ENV_NAMES, ...(input.extraAllowNames ?? [])];
  const filtered = filterChildEnv({
    policy,
    role: 'coding',
    source,
    extraAllowNames: extraAllow,
    ...(input.modelAuthNames !== undefined
      ? { modelAuthNames: input.modelAuthNames }
      : input.includeModelAuth === true
        ? { includeModelAuth: true }
        : { modelAuthNames: [] }),
  });
  return { env: { ...filtered.env }, decision: filtered.decision };
}

export function verificationChildEnv(input: {
  readonly policy?: EffectiveRepoExecutionPolicy | RepoExecutionPolicyInput | null;
  readonly source?: NodeJS.ProcessEnv;
}): PolicyChildEnvResult {
  const filtered = filterChildEnv({
    policy: resolvePolicy(input.policy),
    role: 'verification',
    source: input.source ?? process.env,
    modelAuthNames: [],
  });
  return { env: { ...filtered.env }, decision: filtered.decision };
}

export function reviewChildEnv(input: {
  readonly policy?: EffectiveRepoExecutionPolicy | RepoExecutionPolicyInput | null;
  readonly source?: NodeJS.ProcessEnv;
  /** Default: Grok/xAI reviewer auth only. */
  readonly modelAuthNames?: readonly string[];
}): PolicyChildEnvResult {
  const filtered = filterChildEnv({
    policy: resolvePolicy(input.policy),
    role: 'review',
    source: input.source ?? process.env,
    modelAuthNames: input.modelAuthNames ?? modelAuthNamesFor('xai'),
    allowDefaultPrefixes: false,
  });
  return { env: { ...filtered.env }, decision: filtered.decision };
}

/**
 * L2 boot / health children (the app under test). Never model-auth. Explicit
 * policy allowlists are authoritative; compatible (omitted) policy keeps the
 * documented toolchain-prefix inheritance minus always-blocked names.
 */
export function bootChildEnv(input: {
  readonly policy?: EffectiveRepoExecutionPolicy | RepoExecutionPolicyInput | null;
  readonly source?: NodeJS.ProcessEnv;
}): PolicyChildEnvResult {
  const filtered = filterChildEnv({
    policy: resolvePolicy(input.policy),
    role: 'boot',
    source: input.source ?? process.env,
    modelAuthNames: [],
  });
  return { env: { ...filtered.env }, decision: filtered.decision };
}
