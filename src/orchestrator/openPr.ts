/**
 * Coordination layer — open (or locate) a GitHub PR for a task branch.
 * Task-derived PR ops must pass domain/prIdentity bind + payload validation.
 *
 * Prefer `gh pr create` when the CLI is authenticated; if a PR already exists
 * for the head branch, return it; otherwise fall back to a compare deep-link
 * **only when the branch exists on the remote** (otherwise GitHub shows 404).
 * Pure planning is in domain/github; this module only shells out via an injected runner.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  githubCompareUrl,
  githubLoginReturnUrl,
  parseGithubRepo,
  taskBodyLooksNoChange,
  type GithubRepoRef,
} from '../domain/github.js';
import { branchFor } from '../domain/allocation.js';
import {
  githubPrStateToStatus,
  parseGithubMergeCommitSha,
  type PrStatus,
  type Task,
} from '../domain/task.js';
import type { RepoConfig } from '../domain/repos.js';

const execFileAsync = promisify(execFile);

export type OpenPrMode = 'created' | 'existing' | 'compare';

export interface OpenPrResult {
  /** Canonical PR or compare URL. */
  readonly url: string;
  /**
   * Prefer this for phone browsers: login?return_to=… so private-repo
   * anonymous 404 becomes a Sign-in page then the PR.
   */
  readonly openUrl: string;
  readonly mode: OpenPrMode;
  readonly branch: string;
  readonly base: string;
  readonly repo: string; // owner/name
}

function result(
  url: string,
  mode: OpenPrMode,
  branch: string,
  base: string,
  repo: string,
): OpenPrResult {
  return { url, openUrl: githubLoginReturnUrl(url), mode, branch, base, repo };
}

/** Minimal shell surface so tests never invoke real `gh`. */
export type GhRunner = (args: readonly string[]) => Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

export class OpenPrError extends Error {
  override readonly name: string = 'OpenPrError';
}

export interface OpenPrInput {
  readonly task: Task;
  readonly repo: RepoConfig;
  /** Injected `gh` runner; defaults to real `gh` on PATH. */
  readonly gh?: GhRunner;
}

/**
 * Resolve a PR URL for the task's hercules/<id> branch.
 * Allowed states: review | done (human finished or finishing the loop).
 */
export async function openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
  const { task, repo } = input;
  if (task.state !== 'review' && task.state !== 'done') {
    throw new OpenPrError(`can only open a PR from review or done (got '${task.state}')`);
  }
  if (taskBodyLooksNoChange(task.body)) {
    throw new OpenPrError('task had no file changes — nothing to open a PR for');
  }

  const ghRepo = parseGithubRepo(repo.url);
  if (!ghRepo) {
    throw new OpenPrError(`repo URL is not GitHub — cannot open a PR (${repo.url})`);
  }

  const branch = branchFor(task.id);
  const base = repo.defaultBranch;
  const slug = `${ghRepo.owner}/${ghRepo.name}`;
  const compare = githubCompareUrl(ghRepo, base, branch);
  const gh = input.gh ?? defaultGhRunner;

  // 1) Already open?
  const existing = await findExistingPr(gh, ghRepo, branch);
  if (existing) {
    return result(existing, 'existing', branch, base, slug);
  }

  // 2) Create (same-repo head as owner:branch is the reliable form)
  const title = `${task.id}: ${task.title}`.slice(0, 200);
  const body = [
    `Opened from Hercules after human review of task \`${task.id}\`.`,
    '',
    `Branch: \`${branch}\` → \`${base}\``,
  ].join('\n');

  const created = await gh([
    'pr',
    'create',
    '--repo',
    slug,
    '--base',
    base,
    '--head',
    `${ghRepo.owner}:${branch}`,
    '--title',
    title,
    '--body',
    body,
  ]);

  if (created.exitCode === 0) {
    const url = extractUrl(created.stdout) ?? extractUrl(created.stderr);
    if (url) {
      return result(url, 'created', branch, base, slug);
    }
    const again = await findExistingPr(gh, ghRepo, branch);
    if (again) return result(again, 'created', branch, base, slug);
  }

  const errHint = (created.stderr || created.stdout).trim().slice(0, 280);

  // 3) Fallback: compare page ONLY if the head branch exists on GitHub.
  //    Missing heads → GitHub serves a 404 page (bad phone UX). Prefer a clear error.
  const onRemote = await remoteBranchExists(gh, slug, branch);
  if (onRemote) {
    if (errHint.length > 0) {
      console.error(`[hercules] gh pr create failed for ${task.id}: ${errHint}`);
    }
    return result(compare, 'compare', branch, base, slug);
  }

  throw new OpenPrError(
    `could not open PR for ${branch}: ${errHint || 'gh pr create failed'}. ` +
      `Branch is not on GitHub — check HERCULES_PUSH=1 and git credentials, then retry Open PR.`,
  );
}

async function remoteBranchExists(
  gh: GhRunner,
  slug: string,
  branch: string,
): Promise<boolean> {
  // GitHub API: /repos/{owner}/{repo}/git/ref/heads/{branch} — encode each segment.
  const refPath = branch
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const res = await gh(['api', `repos/${slug}/git/ref/heads/${refPath}`, '-q', '.ref']);
  return res.exitCode === 0 && res.stdout.trim().length > 0;
}

async function findExistingPr(
  gh: GhRunner,
  repo: GithubRepoRef,
  headBranch: string,
): Promise<string | null> {
  const slug = `${repo.owner}/${repo.name}`;
  // Same-repo PRs: --head owner:branch is the reliable filter.
  const attempts: readonly (readonly string[])[] = [
    [
      'pr',
      'list',
      '--repo',
      slug,
      '--head',
      `${repo.owner}:${headBranch}`,
      '--state',
      'open',
      '--json',
      'url',
      '--limit',
      '1',
    ],
    [
      'pr',
      'list',
      '--repo',
      slug,
      '--head',
      headBranch,
      '--state',
      'open',
      '--json',
      'url',
      '--limit',
      '1',
    ],
  ];
  for (const args of attempts) {
    const res = await gh(args);
    if (res.exitCode !== 0) continue;
    const url = parsePrListJson(res.stdout);
    if (url) return url;
  }
  return null;
}

function parsePrListJson(stdout: string): string | null {
  try {
    const rows = JSON.parse(stdout) as Array<{ url?: string }>;
    const url = rows[0]?.url;
    return typeof url === 'string' && url.startsWith('http') ? url : null;
  } catch {
    return null;
  }
}

function extractUrl(text: string): string | null {
  const m = /https:\/\/github\.com\/[^\s]+\/pull\/\d+/.exec(text);
  return m ? m[0]! : null;
}

export async function defaultGhRunner(args: readonly string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  try {
    const { stdout, stderr } = await execFileAsync('gh', [...args], {
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
    });
    return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
    };
  }
}

/** Parse GitHub PR URLs (canonical implementation: domain/prIdentity). */
export { parseGithubPrUrl } from '../domain/prIdentity.js';

export interface PrLifecycleStatus {
  readonly status: PrStatus;
  readonly mergeCommitSha: string | null;
}

/**
 * Pure parser for gh pr view JSON (state,mergeCommit or state alone).
 * Unknown state -> null (do not clobber). Malformed mergeCommit -> null sha.
 */
export function parsePrLifecyclePayload(data: unknown): PrLifecycleStatus | null {
  if (data == null || typeof data !== 'object') return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec['state'] !== 'string') return null;
  const status = githubPrStateToStatus(rec['state']);
  if (!status) return null;
  const mergeCommitSha =
    status === 'merged' ? parseGithubMergeCommitSha(rec['mergeCommit']) : null;
  return { status, mergeCommitSha };
}
