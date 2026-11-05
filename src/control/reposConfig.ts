/**
 * Control layer — repos.yaml parse/validate (SPEC §3.3).
 *
 * The registry of target repos the daemon manages. Keys are repo identifiers
 * and MUST be safe (SPEC §10) since they become path and branch segments.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { isValidIdentifier } from '../domain/task.js';
import { isAdapterKind, type AdapterKind } from '../domain/agents.js';
import type { RepoConfig, ReposConfig } from '../domain/repos.js';
import { executionPolicySchema, serializeExecutionPolicy } from './executionPolicyYaml.js';
import { autoMergeSchema, serializeAutoMerge } from './autoMergeYaml.js';

export class ReposConfigError extends Error {
  override readonly name = 'ReposConfigError';
}

export class RepoUrlError extends Error {
  override readonly name = 'RepoUrlError';
}

/** Redact userinfo (credentials) from a URL for display/transport: `//user:pass@host` → `//***@host`. */
export function redactUrl(url: string): string {
  return url.replace(/\/\/[^/@]+@/, '//***@');
}

/**
 * Reject repo URLs that are unsafe to hand to git (SPEC §10 defense-in-depth):
 *  - argument injection: a leading '-' would be parsed as a git flag
 *  - dangerous transport helpers: ext::/fd:: run arbitrary commands (RCE)
 *  - disallowed URL schemes: only http(s), ssh, git, file are permitted;
 *    scp-like (user@host:path) and local paths have no '://' and are allowed.
 */
export function assertSafeRepoUrl(url: string): void {
  const u = url.trim();
  if (u.length === 0) throw new RepoUrlError('url is empty');
  if (u.startsWith('-')) throw new RepoUrlError('url must not start with "-"');
  // <transport>::<address> helper syntax (ext::, fd::, ...) — RCE vector.
  if (/^[a-z][a-z0-9+.-]*::/i.test(u)) throw new RepoUrlError(`unsafe git transport in url`);
  // If it declares a scheme, it must be on the allowlist.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(u);
  if (schemeMatch) {
    const scheme = schemeMatch[1]!.toLowerCase();
    const allowed = ['http', 'https', 'ssh', 'git', 'file'];
    if (!allowed.includes(scheme)) throw new RepoUrlError(`unsupported url scheme '${scheme}'`);
  }
}

const adapterSchema = z
  .string()
  .optional()
  .nullable()
  .transform((v, ctx): AdapterKind | null => {
    if (v === undefined || v === null || v.trim() === '') return null;
    const k = v.trim().toLowerCase();
    if (!isAdapterKind(k)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown adapter '${v}'` });
      return z.NEVER;
    }
    return k;
  });

const readinessSchema = z
  .string()
  .optional()
  .nullable()
  .transform((v, ctx): 'ready' | 'incomplete' => {
    if (v === undefined || v === null || v.trim() === '') return 'ready';
    const k = v.trim().toLowerCase();
    if (k === 'ready' || k === 'incomplete') return k;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unknown readiness '${v}'` });
    return z.NEVER;
  });

const cargoTargetDirSchema = z
  .string()
  .optional()
  .nullable()
  .transform((v): string | null => {
    if (v === undefined || v === null) return null;
    const t = v.trim();
    return t.length === 0 ? null : t;
  });

const repoEntrySchema = z.object({
  url: z.string().min(1),
  default_branch: z.string().min(1),
  workflow: z.string().min(1).default('WORKFLOW.md'),
  max_concurrent: z.number().int().min(1).default(1),
  /** Optional per-repo agent; omit or null → daemon default. */
  adapter: adapterSchema,
  /** ready (default) | incomplete — only onboarding tasks when incomplete. */
  readiness: readinessSchema,
  /**
   * Optional absolute cargo target / `.shared-target` path for auto-prune after
   * verify + at disk warn. Omit → env HERCULES_CARGO_TARGET_DIR only.
   */
  cargo_target_dir: cargoTargetDirSchema,
  /** Optional per-repo sandbox/network/env policy. */
  execution_policy: executionPolicySchema,
  /** Optional per-repo auto-merge pilot policy. */
  auto_merge: autoMergeSchema,
  owner_checkouts: z.array(z.object({
    id: z.string().min(1),
    path: z.string().min(1),
  }).strict()).max(16).optional().default([]),
});

const schema = z.object({
  repos: z.record(z.string(), repoEntrySchema).default({}),
});

export function parseReposConfig(yamlText: string): ReposConfig {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new ReposConfigError(`could not parse repos.yaml: ${(err as Error).message}`);
  }

  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ReposConfigError(`invalid repos.yaml: ${issues}`);
  }

  const repos: Record<string, RepoConfig> = {};
  for (const [key, entry] of Object.entries(result.data.repos)) {
    if (!isValidIdentifier(key)) {
      throw new ReposConfigError(`repo key '${key}' is not a safe identifier`);
    }
    const checkoutIds = new Set<string>();
    const ownerCheckouts = entry.owner_checkouts.map((checkout) => {
      if (!isValidIdentifier(checkout.id) || checkoutIds.has(checkout.id)) {
        throw new ReposConfigError(`repo '${key}' owner checkout id is invalid or duplicated`);
      }
      if (!checkout.path.startsWith('/')) {
        throw new ReposConfigError(`repo '${key}' owner checkout path must be absolute`);
      }
      checkoutIds.add(checkout.id);
      return { id: checkout.id, path: checkout.path };
    });
    repos[key] = {
      key,
      url: entry.url,
      defaultBranch: entry.default_branch,
      workflow: entry.workflow,
      readiness: entry.readiness,
      maxConcurrent: entry.max_concurrent,
      adapter: entry.adapter ?? null,
      // Only attach when set — keeps equality with fixtures that omit the field.
      ...(entry.cargo_target_dir ? { cargoTargetDir: entry.cargo_target_dir } : {}),
      ...(entry.execution_policy ? { executionPolicy: entry.execution_policy } : {}),
      ...(entry.auto_merge ? { autoMerge: entry.auto_merge } : {}),
      ...(ownerCheckouts.length > 0 ? { ownerCheckouts } : {}),
    };
  }

  return { repos };
}

/** Inverse of {@link parseReposConfig}: snake_case YAML, entries sorted by key. */
export function serializeReposConfig(config: ReposConfig): string {
  const repos: Record<string, unknown> = {};
  for (const key of Object.keys(config.repos).sort()) {
    const r = config.repos[key]!;
    const entry: Record<string, unknown> = {
      url: r.url,
      default_branch: r.defaultBranch,
      workflow: r.workflow,
      max_concurrent: r.maxConcurrent,
    };
    // Only emit adapter when overridden — keeps diffs small and defaults implicit.
    if (r.adapter !== null) entry['adapter'] = r.adapter;
    if (r.readiness === 'incomplete') entry['readiness'] = 'incomplete';
    if (r.cargoTargetDir) entry['cargo_target_dir'] = r.cargoTargetDir;
    if (r.executionPolicy) {
      const ep = serializeExecutionPolicy(r.executionPolicy);
      if (ep) entry['execution_policy'] = ep;
    }
    if (r.autoMerge) {
      entry['auto_merge'] = serializeAutoMerge(r.autoMerge);
    }
    if (r.ownerCheckouts && r.ownerCheckouts.length > 0) {
      entry['owner_checkouts'] = r.ownerCheckouts.map((checkout) => ({
        id: checkout.id,
        path: checkout.path,
      }));
    }
    repos[key] = entry;
  }
  return stringifyYaml({ repos }, { lineWidth: 0 });
}
