/**
 * Domain layer — GitHub URL helpers for Approve → open PR.
 *
 * Pure: parse owner/repo from common git remote shapes and build compare /
 * pull-request deep links. No network.
 */

export interface GithubRepoRef {
  readonly owner: string;
  readonly name: string;
}

/**
 * Extract owner/name from a GitHub remote URL (https, ssh, git@, with or
 * without .git). Returns null for non-GitHub remotes (GitLab, local paths, …).
 */
export function parseGithubRepo(url: string): GithubRepoRef | null {
  const u = url.trim();
  // https://github.com/owner/repo[.git][/]
  // https://github.com/owner/repo.git
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { owner: m[1]!, name: stripGit(m[2]!) };
  // git@github.com:owner/repo.git
  m = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { owner: m[1]!, name: stripGit(m[2]!) };
  // ssh://git@github.com/owner/repo.git
  m = /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { owner: m[1]!, name: stripGit(m[2]!) };
  // git://github.com/owner/repo.git
  m = /^git:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { owner: m[1]!, name: stripGit(m[2]!) };
  return null;
}

function stripGit(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -4) : name;
}

/**
 * GitHub compare URL that opens the "Open a pull request" form for head vs base.
 * Branch names are path-encoded (slashes → %2F).
 */
export function githubCompareUrl(
  repo: GithubRepoRef,
  baseBranch: string,
  headBranch: string,
): string {
  const base = encodeURIComponent(baseBranch);
  const head = encodeURIComponent(headBranch);
  return `https://github.com/${repo.owner}/${repo.name}/compare/${base}...${head}?expand=1`;
}

/**
 * Wrap a GitHub target URL so browsers without a session hit **Sign in**
 * instead of a private-repo **404** (GitHub hides private resources when
 * anonymous). Logged-in users with access are redirected straight to the PR.
 */
export function githubLoginReturnUrl(targetUrl: string): string {
  if (!/^https:\/\/github\.com\//i.test(targetUrl)) return targetUrl;
  // Already a login URL — leave alone.
  if (/^https:\/\/github\.com\/login(?:\?|$)/i.test(targetUrl)) return targetUrl;
  return `https://github.com/login?return_to=${encodeURIComponent(targetUrl)}`;
}

/** True when the review packet documents a no-change (read-only / Q&A) run. */
export function taskBodyLooksNoChange(body: string): boolean {
  return /\*\*ℹ️ No file changes\.\*\*|No file changes\./i.test(body);
}
