/**
 * Child-process env hygiene.
 *
 * Everything the daemon spawns for a task — agent CLIs, the L2 app under test —
 * must NOT inherit the daemon's own HERCULES_* configuration. Live incident
 * 2026-07-15/17: the booted instance-under-test inherited HERCULES_WORK_DIR,
 * pointed reclaimOrphans at the PRODUCTION work root, and deleted every live
 * worktree; HERCULES_TOKEN is additionally a secret the agent must not see.
 * Callers re-add the few vars they intend (HERCULES_SLUG, PORT, …).
 */
export function scrubHerculesEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('HERCULES_')) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Exact infra/runtime var names the L2 boot may inherit.
 */
const BOOT_ENV_ALLOW_NAMES = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'TMPDIR', 'TMP',
  'TEMP', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'CI',
  'JAVA_HOME', 'GOPATH', 'GOROOT', 'CARGO_HOME', 'RUSTUP_HOME',
]);

/**
 * Infra/runtime var prefixes the L2 boot may inherit (locale, node, pnpm,
 * corepack, nvm, xdg, python toolchain).
 *
 * Intentionally broader than {@link hostChildEnv}: L2 product boots need
 * NODE_/NPM_/pnpm toolchain inheritance. Deterministic host/deploy children
 * must NOT reuse these prefixes.
 */
const BOOT_ENV_ALLOW_PREFIXES = [
  'LC_', 'NODE_', 'NPM_', 'npm_', 'PNPM_', 'COREPACK_', 'NVM_', 'XDG_', 'PYENV_',
];

/**
 * Strict fixed-name allowlist for deterministic host_operation / deploy
 * children ({@link hostChildEnv}). No broad prefixes (no NODE_*, NPM_*, LC_*).
 * Locale is only the named LANG/LANGUAGE/LC_ALL/LC_CTYPE/LC_MESSAGES entries.
 */
const HOST_CHILD_ENV_ALLOW_NAMES = new Set([
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
  // Narrowly justified fixed toolchain homes (not NODE_OPTIONS / npm config).
  'JAVA_HOME',
  'GOPATH',
  'GOROOT',
  'CARGO_HOME',
  'RUSTUP_HOME',
]);

/**
 * Explicit denylist shapes that must never reach host/deploy children even if
 * a future allowlist widening is attempted. Defense in depth on top of the
 * fixed-name allowlist.
 */
const HOST_CHILD_ENV_BLOCK_EXACT = new Set([
  'NODE_OPTIONS',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DATABASE_URL',
  'NODE_AUTH_TOKEN',
  'NPM_TOKEN',
  'NPM_CONFIG_USERCONFIG',
  'npm_config_userconfig',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]);

function isHostChildEnvBlocked(key: string): boolean {
  if (HOST_CHILD_ENV_BLOCK_EXACT.has(key)) return true;
  if (key.startsWith('DYLD_')) return true;
  if (key.startsWith('HERCULES_')) return true;
  // Credential-shaped names (tokens, secrets, passwords, keys).
  if (
    /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY)$/i.test(
      key,
    )
  ) {
    return true;
  }
  if (
    /(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY)/i.test(key) &&
    /(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(key)
  ) {
    return true;
  }
  // npm auth / registry credential knobs (any casing).
  if (/^npm_config_.*auth/i.test(key)) return true;
  if (/^NPM_CONFIG_.*AUTH/i.test(key)) return true;
  // Proxy vars often carry userinfo (user:pass@host) — never inherit.
  if (/^(?:HTTP|HTTPS|ALL|NO)_?PROXY$/i.test(key)) return true;
  return false;
}

/**
 * Allowlist env for the L2 app-under-test boot (SPEC §10: dummy creds only,
 * MUST NOT connect to production). Unlike {@link scrubHerculesEnv} (agent CLIs
 * legitimately need model API keys), the booted product app needs only the
 * machinery to run node/pnpm — so this passes infra/runtime vars and DROPS
 * everything else, including any host secret (model API keys, GITHUB_TOKEN,
 * STAGING_UI_TOKEN, DATABASE_URL, cloud creds, password/credential vars).
 * The repo's WORKFLOW boot sets whatever the app needs INLINE in the command
 * string, so those never rely on inheritance.
 *
 * @deprecated The live L2 boot path now goes through the policy-aware
 * `bootChildEnv` (adapters/policyEnv.ts) so an explicit repo `env_allowlist`
 * is honored. This fixed variant remains as the documented compatible baseline.
 */
export function bootAppEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('HERCULES_')) continue;
    if (
      BOOT_ENV_ALLOW_NAMES.has(key) ||
      BOOT_ENV_ALLOW_PREFIXES.some((p) => key.startsWith(p))
    ) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Strict fixed-name env for deterministic host_operation / deploy children.
 *
 * Separate from {@link bootAppEnv}: does **not** reuse BOOT_ENV_ALLOW_PREFIXES
 * (no NODE_*, NPM_*, npm_*, PNPM_*, …). Only PATH/HOME/user/shell, locale/TZ/TERM,
 * temp dirs, and narrowly justified fixed toolchain home names pass.
 * Credential, loader, shell-rc, proxy, and token-shaped vars are always dropped.
 */
export function hostChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isHostChildEnvBlocked(key)) continue;
    if (!HOST_CHILD_ENV_ALLOW_NAMES.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Exact non-secret ownership markers deliberately added after host filtering. */
export function hostTaskChildEnv(
  taskId: string,
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...hostChildEnv(env),
    HERCULES_TASK_ID: taskId,
    HERCULES_SLUG: slug,
  };
}

/**
 * @deprecated Prefer {@link hostChildEnv}. Kept as a named alias so older call
 * sites that already imported hostCommandEnv keep compiling during the rename.
 */
export function hostCommandEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return hostChildEnv(env);
}
