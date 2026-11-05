/**
 * Pure helpers for the phone "repo docs browser": which tree paths count as
 * documentation (not every source file), and path hygiene for API queries.
 *
 * Domain-pure — no git/fs/network (ESLint enforces).
 */

/** Root-level markdown names humans expect to open first. */
const ROOT_DOC_NAMES = new Set(
  [
    'readme.md',
    'agents.md',
    'claude.md',
    'workflow.md',
    'spec.md',
    'contributing.md',
    'changelog.md',
    'license.md',
    'security.md',
    'code_of_conduct.md',
  ].map((s) => s.toLowerCase()),
);

/**
 * Whether a repo-relative path should appear in the docs browser list.
 * Accepts known root docs + any `docs/**\/*.md` (case-insensitive `.md`).
 */
export function isRepoDocPath(path: string): boolean {
  const rel = path.trim().replace(/^\/+/, '').replace(/\\/g, '/');
  if (rel.length === 0 || rel.includes('..') || rel.includes('\0')) return false;
  const lower = rel.toLowerCase();
  if (!lower.endsWith('.md')) return false;
  if (!rel.includes('/')) {
    return ROOT_DOC_NAMES.has(lower);
  }
  return lower.startsWith('docs/') && !lower.includes('/../');
}

/**
 * Path hygiene for a single doc read query. Does not require the path to be
 * a "doc" — callers may still filter with {@link isRepoDocPath} for listing;
 * reads only require no traversal so any safe relative path can be opened
 * after the human picks it from the list.
 */
export function isSafeRepoDocRelPath(path: string): boolean {
  const raw = path.trim();
  // Absolute / rooted paths are never valid repo-relative keys.
  if (raw.length === 0 || raw.startsWith('/') || raw.startsWith('\\')) return false;
  if (raw.includes('..') || raw.includes('\\') || raw.includes('\0')) return false;
  return true;
}

/** Filter a raw tree listing to docs, sorted for stable UI (root first). */
export function filterRepoDocPaths(paths: readonly string[]): readonly string[] {
  const docs = paths.filter((p) => isRepoDocPath(p));
  return [...docs].sort((a, b) => {
    const aRoot = !a.includes('/');
    const bRoot = !b.includes('/');
    if (aRoot !== bRoot) return aRoot ? -1 : 1;
    return a.localeCompare(b);
  });
}

/**
 * Fixed pin order for common entry docs (root-level basename match only).
 * Only files that exist in the listing are shown — order stays fixed.
 */
export const REPO_DOC_ENTRYPOINT_ORDER = [
  'README.md',
  'AGENTS.md',
  'WORKFLOW.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
] as const;

export interface RepoDocGroups {
  readonly entrypoints: readonly string[];
  readonly rest: readonly string[];
}

/**
 * Split a docs listing into pinned entrypoints (fixed order, missing omitted)
 * and the remaining paths (stable order among rest).
 */
export function splitRepoDocEntrypoints(paths: readonly string[]): RepoDocGroups {
  const rootByLower = new Map<string, string>();
  for (const p of paths) {
    if (p.includes('/')) continue;
    const lower = p.toLowerCase();
    if (!rootByLower.has(lower)) rootByLower.set(lower, p);
  }
  const entrypoints: string[] = [];
  const used = new Set<string>();
  for (const name of REPO_DOC_ENTRYPOINT_ORDER) {
    const hit = rootByLower.get(name.toLowerCase());
    if (hit === undefined) continue;
    entrypoints.push(hit);
    used.add(hit);
  }
  const rest = paths.filter((p) => !used.has(p));
  return { entrypoints, rest };
}

/**
 * Case-insensitive path substring filter. Empty/whitespace query returns all.
 */
export function filterDocsByQuery(
  paths: readonly string[],
  query: string,
): readonly string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return paths;
  return paths.filter((p) => p.toLowerCase().includes(q));
}
