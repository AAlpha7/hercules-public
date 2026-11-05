/**
 * Domain — per-repository agent execution policy (Guardian B-022).
 *
 * Typed sandbox / network / env-allowlist / prohibition controls that live on
 * repos.yaml. Pure: no IO. Orchestrator resolves adapter capability against the
 * effective policy before dispatch and fails closed when a required control
 * cannot be enforced. Env filtering returns **names and reasons only** for
 * diagnostics — never secret values.
 *
 * A worktree is isolation of git state, not an OS sandbox. Do not claim OS
 * sandbox strength beyond what the adapter can actually enforce.
 */
import type { AdapterKind } from './agents.js';

/** How the coding agent filesystem sandbox is configured. */
export const SANDBOX_MODES = ['workspace', 'read-only', 'off', 'none'] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/**
 * Network posture for agent-initiated network tools.
 * - `off` — no agent web/search/fetch tools (provider model-auth may still exist)
 * - `limited` — restricted network tools only
 * - `unrestricted` — no network-tool restrictions claimed
 * - `unspecified` — compatible default; do not claim enforcement
 */
export const NETWORK_POSTURES = ['off', 'limited', 'unrestricted', 'unspecified'] as const;
export type NetworkPosture = (typeof NETWORK_POSTURES)[number];

/** Policy profile shortcuts for repos.yaml. */
export const EXECUTION_POLICY_PROFILES = ['compatible', 'guardian'] as const;
export type ExecutionPolicyProfile = (typeof EXECUTION_POLICY_PROFILES)[number];

/** Child-process roles that honor the repo policy env boundary. */
export const EXECUTION_ENV_ROLES = [
  'coding',
  'verification',
  'review',
  'boot',
  'host',
] as const;
export type ExecutionEnvRole = (typeof EXECUTION_ENV_ROLES)[number];

/**
 * Raw on-disk / API partial (all fields optional). Absent fields resolve via
 * {@link effectiveRepoExecutionPolicy}.
 */
export interface RepoExecutionPolicyInput {
  readonly profile?: ExecutionPolicyProfile;
  readonly sandbox?: SandboxMode;
  readonly network?: NetworkPosture;
  /** Explicit env var **names** the coding/verification child may inherit. */
  readonly envAllowlist?: readonly string[];
  readonly forbidProductionSecrets?: boolean;
  readonly forbidConnectorCredentials?: boolean;
  readonly forbidLivePersonalData?: boolean;
  /**
   * When true, require an adapter that can enforce workspace-scoped writes
   * (no host-wide FS). Worktree alone is not sufficient.
   */
  readonly workspaceWrite?: boolean;
}

/** Fully resolved policy attached to a repo at runtime. */
export interface EffectiveRepoExecutionPolicy {
  /** Whether repos.yaml declared an `execution_policy` block. */
  readonly explicit: boolean;
  readonly profile: ExecutionPolicyProfile;
  readonly sandbox: SandboxMode;
  readonly network: NetworkPosture;
  readonly envAllowlist: readonly string[];
  readonly forbidProductionSecrets: boolean;
  readonly forbidConnectorCredentials: boolean;
  readonly forbidLivePersonalData: boolean;
  readonly workspaceWrite: boolean;
}

/**
 * Base infra names safe for coding / verification children (no secrets).
 * Model-auth keys are **not** here — they pass only via deliberate model-auth
 * plumbing ({@link MODEL_AUTH_ENV_NAMES}).
 */
export const DEFAULT_CODING_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'CI',
  'PWD',
  'OLDPWD',
  'NODE_ENV',
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
  // Toolchain homes needed for gates (pnpm/node); not NODE_OPTIONS / npm auth.
  'NODE_PATH',
  'PNPM_HOME',
  'COREPACK_HOME',
  'NVM_DIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
];

/** Prefixes allowed for coding/verification (locale + node/pnpm runtime). */
export const DEFAULT_CODING_ENV_ALLOW_PREFIXES: readonly string[] = [
  'LC_',
  'NODE_',
  'NPM_',
  'npm_',
  'PNPM_',
  'COREPACK_',
  'NVM_',
  'XDG_',
  'PYENV_',
];

/**
 * Provider model-auth names. Passed only when role needs them and policy does
 * not treat them as production secrets to strip from non-auth paths. Values
 * never appear in diagnostics.
 */
export const MODEL_AUTH_ENV_NAMES: readonly string[] = [
  'XAI_API_KEY',
  'GROK_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

/** Hercules allocation vars deliberately re-added by adapters (not daemon secrets). */
export type ModelAuthProvider = 'xai' | 'openai' | 'anthropic';

/** Provider-scoped model-auth names (never mixed across adapters). */
export function modelAuthNamesFor(provider: ModelAuthProvider | 'none'): readonly string[] {
  if (provider === 'none') return [];
  if (provider === 'xai') return ['XAI_API_KEY', 'GROK_API_KEY'];
  if (provider === 'openai') return ['OPENAI_API_KEY'];
  return ['ANTHROPIC_API_KEY'];
}

/** Runtime allocation names (slug) plus MCP workspace binding. */
export const HERCULES_ALLOCATION_ENV_NAMES: readonly string[] = [
  'HERCULES_SLUG',
  'HERCULES_WORKSPACE',
  'HERCULES_WORKSPACE_MCP_SERVER',
];

/** Small runtime set adapters may inject (must still pass filter). */
export const HERCULES_RUNTIME_ENV_NAMES: readonly string[] = [
  'HERCULES_SLUG',
  'HERCULES_TASK_ID',
  'PORT',
];

/** Grok isolated-home plumbing (not production secrets). */
export const GROK_HOME_ENV_NAMES: readonly string[] = [
  'GROK_HOME',
  'GROK_CLAUDE_MCPS_ENABLED',
  'GROK_CURSOR_MCPS_ENABLED',
];

export function isSandboxMode(v: unknown): v is SandboxMode {
  return typeof v === 'string' && (SANDBOX_MODES as readonly string[]).includes(v);
}

export function isNetworkPosture(v: unknown): v is NetworkPosture {
  return typeof v === 'string' && (NETWORK_POSTURES as readonly string[]).includes(v);
}

export function isExecutionPolicyProfile(v: unknown): v is ExecutionPolicyProfile {
  return typeof v === 'string' && (EXECUTION_POLICY_PROFILES as readonly string[]).includes(v);
}

/** Validate a single env var name (identifier form). */
export function isValidEnvVarName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export type EnvAllowlistValidation =
  | { readonly ok: true; readonly names: readonly string[] }
  | { readonly ok: false; readonly reason: string };

export function validateEnvAllowlist(raw: readonly unknown[]): EnvAllowlistValidation {
  if (raw.length > 256) {
    return { ok: false, reason: 'env_allowlist exceeds 256 entries' };
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      return { ok: false, reason: 'env_allowlist entries must be strings' };
    }
    const name = item.trim();
    if (name.length === 0) {
      return { ok: false, reason: 'env_allowlist contains a blank entry' };
    }
    if (!isValidEnvVarName(name)) {
      return { ok: false, reason: 'invalid env var name ' + JSON.stringify(name) };
    }
    if (seen.has(name)) {
      return { ok: false, reason: 'duplicate env allowlist entry ' + JSON.stringify(name) };
    }
    seen.add(name);
    names.push(name);
  }
  return { ok: true, names };
}

/** Compatible defaults when repos.yaml omits execution_policy entirely. */
export function compatibleExecutionPolicyDefaults(): EffectiveRepoExecutionPolicy {
  return {
    explicit: false,
    profile: 'compatible',
    // Do not claim OS sandbox; adapters may still pass workspace flags when able.
    sandbox: 'none',
    network: 'unspecified',
    envAllowlist: [...DEFAULT_CODING_ENV_ALLOWLIST],
    forbidProductionSecrets: true,
    forbidConnectorCredentials: true,
    forbidLivePersonalData: true,
    workspaceWrite: false,
  };
}

/** Guardian-grade defaults (must be explicit on the repo). */
export function guardianExecutionPolicyDefaults(): EffectiveRepoExecutionPolicy {
  return {
    explicit: true,
    profile: 'guardian',
    sandbox: 'workspace',
    network: 'off',
    envAllowlist: [...DEFAULT_CODING_ENV_ALLOWLIST],
    forbidProductionSecrets: true,
    forbidConnectorCredentials: true,
    forbidLivePersonalData: true,
    workspaceWrite: true,
  };
}

/**
 * Resolve one effective policy from an optional repos.yaml input.
 * Omitted input → documented compatible behavior (not Guardian).
 */
export function effectiveRepoExecutionPolicy(
  input?: RepoExecutionPolicyInput | null,
): EffectiveRepoExecutionPolicy {
  if (input == null) {
    return compatibleExecutionPolicyDefaults();
  }
  const profile = input.profile ?? 'compatible';
  const base =
    profile === 'guardian'
      ? guardianExecutionPolicyDefaults()
      : { ...compatibleExecutionPolicyDefaults(), explicit: true, profile: 'compatible' as const };

  const envAllow =
    input.envAllowlist !== undefined
      ? [...input.envAllowlist]
      : [...base.envAllowlist];

  return {
    explicit: true,
    profile,
    sandbox: input.sandbox ?? base.sandbox,
    network: input.network ?? base.network,
    envAllowlist: envAllow,
    forbidProductionSecrets: input.forbidProductionSecrets ?? base.forbidProductionSecrets,
    forbidConnectorCredentials:
      input.forbidConnectorCredentials ?? base.forbidConnectorCredentials,
    forbidLivePersonalData: input.forbidLivePersonalData ?? base.forbidLivePersonalData,
    workspaceWrite: input.workspaceWrite ?? base.workspaceWrite,
  };
}

// ── Prohibited name shapes (values never inspected) ──────────────────────────

const PROD_SECRET_EXACT = new Set([
  'DATABASE_URL',
  'HERCULES_TOKEN',
  'HERCULES_WORK_DIR',
  'STAGING_UI_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'CF_API_TOKEN',
]);

const CONNECTOR_CREDENTIAL_EXACT = new Set([
  'SLACK_BOT_TOKEN',
  'SLACK_TOKEN',
  'DISCORD_TOKEN',
  'NOTION_TOKEN',
  'LINEAR_API_KEY',
  'STRIPE_SECRET_KEY',
  'TWILIO_AUTH_TOKEN',
  'SENDGRID_API_KEY',
]);

const LIVE_PII_EXACT = new Set([
  'USER_EMAIL',
  'CUSTOMER_EMAIL',
  'CUSTOMER_SSN',
  'SSN',
  'PHONE_NUMBER',
  'CUSTOMER_PHONE',
  'HOME_ADDRESS',
  'MAILING_ADDRESS',
  'DATE_OF_BIRTH',
  'CREDIT_CARD_NUMBER',
]);

/**
 * Classify why a var name is blocked under the policy prohibitions.
 * Returns null when the name is not prohibited by shape.
 */
export function prohibitedEnvReason(
  name: string,
  policy: Pick<
    EffectiveRepoExecutionPolicy,
    'forbidProductionSecrets' | 'forbidConnectorCredentials' | 'forbidLivePersonalData'
  >,
): string | null {
  if (policy.forbidProductionSecrets) {
    if (PROD_SECRET_EXACT.has(name)) return 'production_secret';
    if (name.startsWith('HERCULES_') && !HERCULES_ALLOCATION_ENV_NAMES.includes(name)) {
      return 'production_secret';
    }
    if (
      /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY)$/i.test(
        name,
      )
    ) {
      // Model-auth keys are deliberate plumbing, not production secrets.
      if (!(MODEL_AUTH_ENV_NAMES as readonly string[]).includes(name)) {
        return 'production_secret';
      }
    }
    if (/^npm_config_.*auth/i.test(name) || /^NPM_CONFIG_.*AUTH/i.test(name)) {
      return 'production_secret';
    }
  }
  if (policy.forbidConnectorCredentials) {
    if (CONNECTOR_CREDENTIAL_EXACT.has(name)) return 'connector_credential';
    if (/^(?:SLACK|DISCORD|NOTION|LINEAR|STRIPE|TWILIO|SENDGRID)_/i.test(name)) {
      if (/(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL)/i.test(name)) {
        return 'connector_credential';
      }
    }
  }
  if (policy.forbidLivePersonalData) {
    if (LIVE_PII_EXACT.has(name)) return 'live_personal_data';
    if (
      /(?:EMAIL|SSN|PHONE|ADDRESS|BIRTH|CREDIT_CARD|PASSPORT)/i.test(name) &&
      /(?:USER|CUSTOMER|PERSON|CLIENT|PATIENT|EMPLOYEE)/i.test(name)
    ) {
      return 'live_personal_data';
    }
  }
  return null;
}

/** Always-blocked injection / loader / proxy shapes (defense in depth). */
export function isAlwaysBlockedEnvName(name: string): boolean {
  if (
    name === 'NODE_OPTIONS' ||
    name === 'BASH_ENV' ||
    name === 'ENV' ||
    name === 'LD_PRELOAD' ||
    name === 'LD_LIBRARY_PATH'
  ) {
    return true;
  }
  if (name.startsWith('DYLD_')) return true;
  if (/^(?:HTTP|HTTPS|ALL|NO)_?PROXY$/i.test(name)) return true;
  return false;
}

export interface EnvFilterDecision {
  /** Names that were kept (never values). */
  readonly kept: readonly string[];
  /** Dropped names with machine-readable reasons. */
  readonly dropped: readonly { readonly name: string; readonly reason: string }[];
  /** Model-auth names deliberately passed (separate from general allowlist). */
  readonly modelAuth: readonly string[];
}

export interface FilterChildEnvInput {
  readonly policy: EffectiveRepoExecutionPolicy;
  readonly role: ExecutionEnvRole;
  readonly source: Readonly<Record<string, string | undefined>>;
  /**
   * When true, pass model-auth names that exist in source (coding adapters that
   * need provider keys). Grok primarily uses GROK_HOME auth symlink instead.
   */
  readonly includeModelAuth?: boolean;
  /**
   * Deliberate provider-auth names for this consumer only (empty for Grok coding).
   * When set, takes precedence over includeModelAuth.
   */
  readonly modelAuthNames?: readonly string[];
  /** Extra exact names to keep (e.g. GROK_HOME after deliberate set). */
  readonly extraAllowNames?: readonly string[];
  /**
   * When true (default for coding/verification), also allow DEFAULT prefixes
   * for compatible toolchain inheritance. Guardian still blocks secrets.
   */
  readonly allowDefaultPrefixes?: boolean;
}

/**
 * Pure env filter: returns kept map + name/reason receipt. Values only flow into
 * the returned env map — never into the decision receipt.
 */
export function filterChildEnv(input: FilterChildEnvInput): {
  readonly env: Record<string, string>;
  readonly decision: EnvFilterDecision;
} {
  const allow = new Set(input.policy.envAllowlist);
  for (const n of input.extraAllowNames ?? []) allow.add(n);
  // Allocation / slug re-adds are always permitted by name when present.
  for (const n of HERCULES_ALLOCATION_ENV_NAMES) allow.add(n);
  for (const n of HERCULES_RUNTIME_ENV_NAMES) {
    // Task ownership markers belong only in coding-agent descendants. Review,
    // verification, and product boot processes must not gain this new channel.
    if (n === 'HERCULES_TASK_ID' && input.role !== 'coding') continue;
    allow.add(n);
  }

  const allowPrefixes =
    !input.policy.explicit &&
    input.allowDefaultPrefixes !== false &&
    (input.role === 'coding' || input.role === 'verification' || input.role === 'boot')
      ? DEFAULT_CODING_ENV_ALLOW_PREFIXES
      : [];

  const roleAllowsAuth = input.role === 'coding' || input.role === 'review';
  const requestedAuthNames = roleAllowsAuth
    ? input.modelAuthNames !== undefined
      ? input.modelAuthNames
      : input.includeModelAuth === true
        ? MODEL_AUTH_ENV_NAMES
        : []
    : [];
  // Canonical intersection: a caller-supplied name (e.g. DATABASE_URL) must
  // never bypass prohibitedEnvReason just because it rode in via modelAuthNames.
  const allowedAuthNames = new Set<string>(
    requestedAuthNames.filter((n) =>
      (MODEL_AUTH_ENV_NAMES as readonly string[]).includes(n),
    ),
  );

  const env: Record<string, string> = {};
  const kept: string[] = [];
  const dropped: { name: string; reason: string }[] = [];
  const modelAuth: string[] = [];

  for (const [name, value] of Object.entries(input.source)) {
    if (value === undefined) continue;

    if (isAlwaysBlockedEnvName(name)) {
      dropped.push({ name, reason: 'always_blocked' });
      continue;
    }

    const codingTaskOwnershipMarker =
      input.role === 'coding' && name === 'HERCULES_TASK_ID';
    const prohibited = codingTaskOwnershipMarker
      ? null
      : prohibitedEnvReason(name, input.policy);
    if (prohibited) {
      // Model-auth may still pass via deliberate plumbing.
      if (allowedAuthNames.has(name)) {
        env[name] = value;
        modelAuth.push(name);
        kept.push(name);
        continue;
      }
      dropped.push({ name, reason: prohibited });
      continue;
    }

    // Model-auth deliberate path (not production_secret shape for these names).
    if ((MODEL_AUTH_ENV_NAMES as readonly string[]).includes(name)) {
      if (allowedAuthNames.has(name)) {
        env[name] = value;
        modelAuth.push(name);
        kept.push(name);
      } else {
        dropped.push({ name, reason: 'model_auth_not_requested' });
      }
      continue;
    }

    const prefixOk = allowPrefixes.some((p) => name.startsWith(p));
    if (!allow.has(name) && !prefixOk) {
      dropped.push({ name, reason: 'not_in_allowlist' });
      continue;
    }

    // Prefix-allowed NODE_/NPM_ still must not carry auth (belt).
    if (prefixOk && (/auth/i.test(name) || /token/i.test(name) || /secret/i.test(name))) {
      dropped.push({ name, reason: 'production_secret' });
      continue;
    }

    env[name] = value;
    kept.push(name);
  }

  kept.sort();
  modelAuth.sort();
  dropped.sort((a, b) => a.name.localeCompare(b.name));
  return { env, decision: { kept, dropped, modelAuth } };
}

/** Render a diagnostics receipt (names/reasons only). */
export function formatEnvFilterReceipt(decision: EnvFilterDecision): string {
  const tick = String.fromCharCode(96);
  const code = (n: string): string => tick + n + tick;
  const keptList =
    decision.kept.length > 0 ? decision.kept.map(code).join(', ') : '(none)';
  const authList =
    decision.modelAuth.length > 0 ? decision.modelAuth.map(code).join(', ') : '(none)';
  const lines = [
    '## Execution env receipt',
    '',
    '- **Kept (' + String(decision.kept.length) + '):** ' + keptList,
    '- **Model-auth plumbing (' + String(decision.modelAuth.length) + '):** ' + authList,
  ];
  if (decision.dropped.length > 0) {
    lines.push('- **Dropped:**');
    for (const d of decision.dropped) {
      lines.push('  - ' + code(d.name) + ' — ' + d.reason);
    }
  } else {
    lines.push('- **Dropped:** (none)');
  }
  lines.push('');
  return lines.join('\n');
}

// ── Adapter capabilities + fail-closed resolve ───────────────────────────────

export interface AdapterExecutionCapabilities {
  readonly kind: AdapterKind | 'host-executor' | 'review-grok';
  /** Sandbox modes this adapter can enforce (not merely claim). */
  readonly sandboxModes: readonly SandboxMode[];
  /** Network postures this adapter can enforce. */
  readonly networkPostures: readonly NetworkPosture[];
  /** Whether workspace-scoped write can be enforced. */
  readonly workspaceWrite: boolean;
  /** Whether env allowlist filtering is applied at spawn. */
  readonly envAllowlist: boolean;
}

/**
 * Capability matrix. `none` / `unspecified` are always "enforceable" because
 * they make no positive isolation claim.
 */
export function adapterExecutionCapabilities(
  kind: AdapterKind | 'host-executor' | 'review-grok',
): AdapterExecutionCapabilities {
  switch (kind) {
    case 'grok':
      return {
        kind,
        sandboxModes: ['workspace', 'read-only', 'off', 'none'],
        // --disable-web-search enforces off/limited for agent network tools.
        networkPostures: ['off', 'limited', 'unrestricted', 'unspecified'],
        workspaceWrite: true,
        envAllowlist: true,
      };
    case 'codex':
      return {
        kind,
        // No reliable sandbox/network flags on this adapter surface yet.
        sandboxModes: ['none', 'off'],
        networkPostures: ['unspecified', 'unrestricted'],
        workspaceWrite: false,
        envAllowlist: true,
      };
    case 'claude':
      return {
        kind,
        sandboxModes: ['none', 'off'],
        networkPostures: ['unspecified', 'unrestricted'],
        workspaceWrite: false,
        envAllowlist: true,
      };
    case 'cursor':
      return {
        kind,
        // Remote Cloud Agent — cannot enforce a local OS sandbox.
        sandboxModes: ['none', 'off'],
        networkPostures: ['unspecified', 'unrestricted'],
        workspaceWrite: false,
        envAllowlist: true,
      };
    case 'fake':
      return {
        kind,
        sandboxModes: [...SANDBOX_MODES],
        networkPostures: [...NETWORK_POSTURES],
        workspaceWrite: true,
        envAllowlist: true,
      };
    case 'host-executor':
      return {
        kind,
        sandboxModes: ['off', 'none'],
        networkPostures: ['unspecified', 'unrestricted', 'limited', 'off'],
        workspaceWrite: false,
        envAllowlist: true,
      };
    case 'review-grok':
      return {
        kind,
        sandboxModes: ['read-only', 'none'],
        networkPostures: ['off', 'limited', 'unspecified'],
        workspaceWrite: false,
        envAllowlist: true,
      };
  }
}

export type PolicyEnforceCode =
  | 'sandbox_unsupported'
  | 'network_unsupported'
  | 'workspace_write_unsupported'
  | 'env_allowlist_unsupported'
  | 'guardian_requires_explicit'
  | 'guardian_relaxed'
  | 'workspace_write_inconsistent';

export type PolicyEnforceResult =
  | {
      readonly ok: true;
      readonly policy: EffectiveRepoExecutionPolicy;
      readonly capabilities: AdapterExecutionCapabilities;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly code: PolicyEnforceCode;
      readonly policy: EffectiveRepoExecutionPolicy;
      readonly capabilities: AdapterExecutionCapabilities;
    };

/**
 * Fail closed when the adapter cannot enforce a required positive control.
 * Compatible defaults (`sandbox: none`, `network: unspecified`) never block.
 */
export function resolvePolicyAgainstAdapter(
  kind: AdapterKind | 'host-executor' | 'review-grok',
  policy: EffectiveRepoExecutionPolicy,
): PolicyEnforceResult {
  const capabilities = adapterExecutionCapabilities(kind);

  if (policy.profile === 'guardian' && !policy.explicit) {
    // Structural guardian checks run before capability matrix.
    return {
      ok: false,
      code: 'guardian_requires_explicit',
      reason: 'Guardian-grade execution policy must be explicit on the repository',
      policy,
      capabilities,
    };
  }

  if (
    policy.profile === 'guardian' &&
    (policy.sandbox !== 'workspace' ||
      policy.network !== 'off' ||
      !policy.workspaceWrite ||
      !policy.forbidProductionSecrets ||
      !policy.forbidConnectorCredentials ||
      !policy.forbidLivePersonalData)
  ) {
    return {
      ok: false,
      code: 'guardian_relaxed',
      reason:
        'profile guardian requires the full posture (sandbox workspace, network off, ' +
        'workspace_write, all forbid flags) — relaxed overrides fail closed',
      policy,
      capabilities,
    };
  }

  if (policy.workspaceWrite && policy.sandbox !== 'workspace') {
    // read-only cannot satisfy a write-enforcement requirement — contradictory.
    return {
      ok: false,
      code: 'workspace_write_inconsistent',
      reason:
        'workspace_write requires sandbox workspace (got ' + policy.sandbox + ')',
      policy,
      capabilities,
    };
  }

  if (!capabilities.envAllowlist) {
    return {
      ok: false,
      code: 'env_allowlist_unsupported',
      reason: "adapter '" + kind + "' cannot enforce env allowlist filtering",
      policy,
      capabilities,
    };
  }

  if (policy.sandbox !== 'none' && !capabilities.sandboxModes.includes(policy.sandbox)) {
    return {
      ok: false,
      code: 'sandbox_unsupported',
      reason: 'adapter ' + kind + ' cannot enforce sandbox mode ' + policy.sandbox,
      policy,
      capabilities,
    };
  }

  if (
    policy.network !== 'unspecified' &&
    !capabilities.networkPostures.includes(policy.network)
  ) {
    return {
      ok: false,
      code: 'network_unsupported',
      reason: 'adapter ' + kind + ' cannot enforce network posture ' + policy.network,
      policy,
      capabilities,
    };
  }

  if (policy.workspaceWrite && !capabilities.workspaceWrite) {
    return {
      ok: false,
      code: 'workspace_write_unsupported',
      reason: 'adapter ' + kind + ' cannot enforce workspace-scoped writes',
      policy,
      capabilities,
    };
  }

  return { ok: true, policy, capabilities };
}

export function formatPolicyEnforceFailure(
  result: { readonly ok: false; readonly reason: string; readonly code: PolicyEnforceCode },
): string {
  return 'Execution policy blocked dispatch (' + result.code + '): ' + result.reason;
}

/**
 * Durable capability/ops receipt for pre-dispatch policy blocks (Guardian dogfood).
 * Stable reason codes, no credentials, no claim of sandbox support when absent.
 */
export function formatPolicyCapabilityReceipt(input: {
  readonly adapter: string;
  readonly result: {
    readonly ok: false;
    readonly reason: string;
    readonly code: PolicyEnforceCode;
    readonly policy: EffectiveRepoExecutionPolicy;
    readonly capabilities: AdapterExecutionCapabilities;
  };
  readonly stamp?: string;
}): string {
  const r = input.result;
  const stamp = input.stamp ?? new Date().toISOString();
  const caps = r.capabilities;
  return [
    '## Adapter capability receipt',
    '',
    `**Status:** blocked — capability gap (not a product verdict)`,
    `**Code:** \`${r.code}\``,
    `**Adapter:** \`${input.adapter}\``,
    `**Policy profile:** \`${r.policy.profile}\` (explicit=${r.policy.explicit ? 'yes' : 'no'})`,
    `**Required sandbox:** \`${r.policy.sandbox}\` · adapter modes: \`${caps.sandboxModes.join(', ')}\``,
    `**Required network:** \`${r.policy.network}\` · adapter: \`${caps.networkPostures.join(', ')}\``,
    `**Workspace write:** policy=${r.policy.workspaceWrite ? 'required' : 'off'} · adapter=${caps.workspaceWrite ? 'yes' : 'no'}`,
    `**Recorded:** ${stamp}`,
    '',
    r.reason,
    '',
    '_Fail-closed: no agent was started. Do not relax Guardian policy to force dispatch. ' +
      'Sign in / repair the preferred adapter, or use an adapter that can enforce the full posture._',
    '',
  ].join('\n');
}

export function policyDiagnostics(policy: EffectiveRepoExecutionPolicy): {
  readonly explicit: boolean;
  readonly profile: ExecutionPolicyProfile;
  readonly sandbox: SandboxMode;
  readonly network: NetworkPosture;
  readonly envAllowlist: readonly string[];
  readonly forbidProductionSecrets: boolean;
  readonly forbidConnectorCredentials: boolean;
  readonly forbidLivePersonalData: boolean;
  readonly workspaceWrite: boolean;
} {
  return {
    explicit: policy.explicit,
    profile: policy.profile,
    sandbox: policy.sandbox,
    network: policy.network,
    envAllowlist: [...policy.envAllowlist],
    forbidProductionSecrets: policy.forbidProductionSecrets,
    forbidConnectorCredentials: policy.forbidConnectorCredentials,
    forbidLivePersonalData: policy.forbidLivePersonalData,
    workspaceWrite: policy.workspaceWrite,
  };
}
