/**
 * Pure trust contract for PR metadata derived from a task.
 *
 * The task URL chooses a PR number only after its repository is bound to the
 * configured remote. GitHub's response must then prove the canonical URL,
 * default base, and task-owned head before callers may use any other fields.
 * Cursor Cloud factory PRs prove URL + base + a non-base feature head — the
 * stored PR handle is the done artifact, not `hercules/<id>`.
 */
import { branchFor } from './allocation.js';
import { parseGithubRepo, type GithubRepoRef } from './github.js';

export const PR_IDENTITY_JSON_FIELDS = 'url,baseRefName,headRefName' as const;

export type PrIdentityRejectReason =
  | 'unparseable_pr_url'
  | 'unparseable_repo_url'
  | 'wrong_repository'
  | 'missing_identity_fields'
  | 'wrong_canonical_url'
  | 'wrong_base_ref'
  | 'wrong_head_ref';

export class PrIdentityError extends Error {
  override readonly name = 'PrIdentityError';

  constructor(
    message: string,
    readonly reason: PrIdentityRejectReason,
  ) {
    super(message);
  }
}

export interface ParsedGithubPrUrl extends GithubRepoRef {
  readonly number: number;
}

export interface BoundTaskPr extends ParsedGithubPrUrl {
  readonly slug: string;
  readonly expectedBaseRef: string;
  readonly expectedHeadRef: string;
  readonly canonicalUrl: string;
  /**
   * Cursor Cloud factory PRs are the done artifact. Their head is a remote
   * Cloud Agent branch, not `hercules/<id>`. Local CLI adapters never set this.
   */
  readonly remoteFactoryPr?: boolean;
}

export function parseGithubPrUrl(url: string): ParsedGithubPrUrl | null {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#]|$)/i.exec(
      url.trim(),
    );
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { owner: match[1]!, name: match[2]!, number };
}

export function bindTaskPrUrl(input: {
  readonly prUrl: string;
  readonly taskId: string;
  readonly repoUrl: string;
  readonly defaultBranch: string;
  readonly remoteFactoryPr?: boolean;
}): BoundTaskPr {
  const parsed = parseGithubPrUrl(input.prUrl);
  if (!parsed) {
    throw new PrIdentityError(
      `not a GitHub PR URL: ${input.prUrl}`,
      'unparseable_pr_url',
    );
  }
  const repo = parseGithubRepo(input.repoUrl);
  if (!repo) {
    throw new PrIdentityError(
      `repo URL is not GitHub - cannot bind PR (${input.repoUrl})`,
      'unparseable_repo_url',
    );
  }
  if (!sameGithubRepo(parsed, repo)) {
    throw new PrIdentityError(
      `PR repository ${parsed.owner}/${parsed.name} does not match configured repo ` +
        `${repo.owner}/${repo.name}`,
      'wrong_repository',
    );
  }
  return {
    owner: repo.owner,
    name: repo.name,
    number: parsed.number,
    slug: `${repo.owner}/${repo.name}`,
    expectedBaseRef: input.defaultBranch,
    expectedHeadRef: branchFor(input.taskId),
    canonicalUrl: canonicalGithubPrUrl(repo.owner, repo.name, parsed.number),
    ...(input.remoteFactoryPr === true ? { remoteFactoryPr: true } : {}),
  };
}

export function assertPrIdentityPayload(
  payload: unknown,
  bound: BoundTaskPr,
): asserts payload is Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PrIdentityError(
      'PR identity payload is missing or not an object',
      'missing_identity_fields',
    );
  }
  const record = payload as Record<string, unknown>;
  const url = record['url'];
  const baseRefName = record['baseRefName'];
  const headRefName = record['headRefName'];
  if (
    typeof url !== 'string' ||
    typeof baseRefName !== 'string' ||
    typeof headRefName !== 'string'
  ) {
    throw new PrIdentityError(
      'PR identity payload must include url, baseRefName, and headRefName',
      'missing_identity_fields',
    );
  }

  // GitHub's `url` field is canonical. Query strings, fragments, and subpaths
  // are not accepted here even though task links may contain them.
  if (url.trim().toLowerCase() !== bound.canonicalUrl.toLowerCase()) {
    throw new PrIdentityError(
      `PR identity URL ${url} does not match expected ${bound.canonicalUrl}`,
      'wrong_canonical_url',
    );
  }
  if (baseRefName !== bound.expectedBaseRef) {
    throw new PrIdentityError(
      `PR base '${baseRefName}' does not match default branch '${bound.expectedBaseRef}'`,
      'wrong_base_ref',
    );
  }
  if (bound.remoteFactoryPr === true) {
    const head = headRefName.trim();
    if (head.length === 0 || head === bound.expectedBaseRef) {
      throw new PrIdentityError(
        `factory PR head '${headRefName}' must be a feature branch (not '${bound.expectedBaseRef}')`,
        'wrong_head_ref',
      );
    }
  } else if (headRefName !== bound.expectedHeadRef) {
    throw new PrIdentityError(
      `PR head '${headRefName}' does not match task branch '${bound.expectedHeadRef}'`,
      'wrong_head_ref',
    );
  }
}

function sameGithubRepo(a: GithubRepoRef, b: GithubRepoRef): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  );
}

function canonicalGithubPrUrl(owner: string, name: string, number: number): string {
  return `https://github.com/${owner}/${name}/pull/${number}`;
}
