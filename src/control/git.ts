/**
 * Control layer — git plumbing for the control repo (SPEC §1, §7.1).
 *
 * The control repo's git history is the source of truth and the audit log.
 * This wrapper exposes only the two operations the orchestration loop needs:
 * pull (sync) and commit-all (record a mutation). All higher-level meaning
 * (what changed, why) lives in the commit message the caller supplies.
 */
import { simpleGit, type SimpleGit } from 'simple-git';

export interface CommitResult {
  /** False when the working tree was clean and nothing was committed. */
  readonly committed: boolean;
  /** Short hash of the new commit, when one was made. */
  readonly hash?: string;
}

export class ControlDurabilityError extends Error {
  override readonly name = 'ControlDurabilityError';

  constructor(message: string, readonly originalCause?: unknown) {
    super(message);
  }
}

/** Bounded receipt for a control mutation that encountered unrelated dirt. */
export class ControlConflictError extends Error {
  override readonly name = 'ControlConflictError';

  constructor(readonly dirtyPaths: readonly string[]) {
    super(`control commit conflict: unrelated dirty paths: ${dirtyPaths.slice(0, 10).join(', ')}`);
  }
}

const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

export class ControlGit {
  private readonly git: SimpleGit;

  constructor(readonly dir: string) {
    this.git = simpleGit(dir);
  }

  /**
   * Fast-forward the current branch from its upstream. No-op for a remote-less
   * local control repo (a valid dev/single-box setup), so sync never throws
   * just because there is nothing to pull from.
   */
  async pull(): Promise<void> {
    const remotes = await this.git.getRemotes();
    if (remotes.length === 0) return;
    await this.git.pull(['--ff-only']);
  }

  /** Stage everything and commit. No-op (committed:false) if the tree is clean. */
  async commitAll(message: string): Promise<CommitResult> {
    const beforeHead = await this.readHead();
    await this.git.add('.');
    return this.commitStaged(message, beforeHead);
  }

  /** Commit exactly the declared paths, refusing any unrelated working-tree dirt. */
  async commitPaths(paths: readonly string[], message: string): Promise<CommitResult> {
    const allowed = new Set(paths);
    const status = await this.git.status();
    const unrelated = status.files
      .map((file) => file.path)
      .filter((path) => !allowed.has(path));
    if (unrelated.length > 0) throw new ControlConflictError(unrelated);
    if (allowed.size === 0) return { committed: false };
    const beforeHead = await this.readHead();
    await this.git.add([...allowed]);
    return this.commitStaged(message, beforeHead);
  }

  private async commitStaged(message: string, beforeHead: string | null): Promise<CommitResult> {
    const status = await this.git.status();
    if (status.staged.length === 0) {
      return { committed: false };
    }
    let reportedHash: string;
    try {
      const summary = await this.git.commit(message);
      reportedHash = summary.commit.trim().toLowerCase();
    } catch (err) {
      throw new ControlDurabilityError(
        `control commit failed before durability was proven: ${(err as Error).message}`,
        err,
      );
    }
    const afterHead = await this.readHead();
    if (
      !FULL_COMMIT_SHA.test(reportedHash) ||
      afterHead !== reportedHash ||
      afterHead === beforeHead
    ) {
      throw new ControlDurabilityError(
        'control commit did not advance HEAD to the full hash reported by git ' +
          `(before=${beforeHead ?? '(unborn)'}, reported=${reportedHash || '(empty)'}, ` +
          `after=${afterHead ?? '(unborn)'})`,
      );
    }
    return { committed: true, hash: reportedHash };
  }

  private async readHead(): Promise<string | null> {
    try {
      const head = (await this.git.revparse(['--verify', 'HEAD'])).trim().toLowerCase();
      if (!FULL_COMMIT_SHA.test(head)) {
        throw new ControlDurabilityError(`control HEAD is not a full commit hash: ${head}`);
      }
      return head;
    } catch (err) {
      if (err instanceof ControlDurabilityError) throw err;
      try {
        const symbolic = (await this.git.raw(['symbolic-ref', '-q', 'HEAD'])).trim();
        if (symbolic.startsWith('refs/heads/')) return null;
      } catch {
        // Fall through to the typed durability error below.
      }
      throw new ControlDurabilityError(
        `could not resolve control HEAD: ${(err as Error).message}`,
        err,
      );
    }
  }

  async isClean(): Promise<boolean> {
    return (await this.git.status()).isClean();
  }

  /** Reset only one path in the index; leaves unrelated control changes alone. */
  async resetPath(path: string): Promise<void> {
    await this.git.raw(['reset', '--', path]);
  }

  /** Remove a newly-added path from the index without requiring HEAD to exist. */
  async removePathFromIndex(path: string): Promise<void> {
    await this.git.raw(['rm', '--cached', '--ignore-unmatch', '--', path]);
  }

  /** Name of the currently checked-out branch. */
  async currentBranch(): Promise<string> {
    return (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  }

  /** Full current HEAD, or null for an unborn control repository. */
  async headHash(): Promise<string | null> {
    return this.readHead();
  }

  /** UTF-8 contents of one path from current HEAD. */
  async readPathAtHead(path: string): Promise<string> {
    return this.git.show([`HEAD:${path}`]);
  }

  /** UTF-8 contents of one path at an exact revision, or null when absent. */
  async readPathAtRevision(revision: string, path: string): Promise<string | null> {
    if (!FULL_COMMIT_SHA.test(revision)) {
      throw new ControlDurabilityError('control revision is not an exact commit hash');
    }
    const tree = await this.git.raw(['ls-tree', '-z', revision, '--', path]);
    if (tree.length === 0) return null;
    const entries = tree.split('\0').filter(Boolean);
    if (entries.length !== 1) {
      throw new ControlDurabilityError('control revision path did not resolve uniquely');
    }
    const match = /^(\d+) (\S+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(entries[0]!);
    if (match === null || match[2] !== 'blob' || match[4] !== path) {
      throw new ControlDurabilityError('control revision path is not an exact blob');
    }
    // A symlink (mode 120000) is a blob to git but never a task file; absent,
    // consistent with listBlobsAtRevision and the working-tree snapshot.
    if (match[1] === '120000') return null;
    return this.git.raw(['cat-file', 'blob', match[3]!]);
  }

  /** Sorted paths below a prefix in an exact commit tree. */
  async listPathsAtRevision(revision: string, prefix: string): Promise<readonly string[]> {
    if (!FULL_COMMIT_SHA.test(revision)) {
      throw new ControlDurabilityError('control revision is not an exact commit hash');
    }
    const raw = await this.git.raw(['ls-tree', '-r', '--name-only', revision, '--', prefix]);
    return raw.split('\n').map((path) => path.trim()).filter(Boolean).sort();
  }

  /**
   * Blob entries (path → exact blob oid) below a prefix in an exact commit
   * tree, sorted by path, in ONE git process. Non-blob entries (submodules)
   * and symlink blobs (mode 120000) are skipped so the caller never reads
   * content through a link; a stored task at such a path then fails closed
   * as absent.
   */
  async listBlobsAtRevision(
    revision: string,
    prefix: string,
  ): Promise<readonly { readonly path: string; readonly oid: string }[]> {
    if (!FULL_COMMIT_SHA.test(revision)) {
      throw new ControlDurabilityError('control revision is not an exact commit hash');
    }
    const raw = await this.git.raw(['ls-tree', '-r', '-z', revision, '--', prefix]);
    const entries: { path: string; oid: string }[] = [];
    for (const entry of raw.split('\0')) {
      if (entry.length === 0) continue;
      const match = /^(\d+) (\S+) ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
      if (match === null) {
        throw new ControlDurabilityError('control revision tree entry is malformed');
      }
      if (match[2] !== 'blob' || match[1] === '120000') continue;
      entries.push({ path: match[4]!, oid: match[3]! });
    }
    return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  }

  /** UTF-8 contents of one exact blob object (immutable; safe to cache by oid). */
  async readBlob(oid: string): Promise<string> {
    if (!/^[0-9a-f]{40}$/.test(oid)) {
      throw new ControlDurabilityError('control blob id is not an exact object hash');
    }
    return this.git.raw(['cat-file', 'blob', oid]);
  }

  /** UTF-8 contents staged in the index, or null when absent. */
  async readPathAtIndex(path: string): Promise<string | null> {
    const staged = await this.git.raw(['ls-files', '--stage', '-z', '--', path]);
    if (staged.length === 0) return null;
    const entries = staged.split('\0').filter(Boolean);
    if (entries.length !== 1) {
      throw new ControlDurabilityError('control index path did not resolve uniquely');
    }
    const match = /^(\d+) ([0-9a-f]{40}) 0\t([\s\S]+)$/.exec(entries[0]!);
    if (match === null || match[3] !== path) {
      throw new ControlDurabilityError('control index path is not an exact stage-zero blob');
    }
    return this.git.raw(['cat-file', 'blob', match[2]!]);
  }

  /** Exact bounded status paths for fail-closed transaction recovery. */
  async statusPaths(): Promise<readonly string[]> {
    const paths = new Set<string>();
    for (const file of (await this.git.status()).files) {
      paths.add(file.path);
      if (file.from !== undefined) paths.add(file.from);
    }
    return [...paths].sort();
  }

  /** First-parent commits after an ancestor, oldest first. */
  async firstParentAfter(ancestor: string, head: string): Promise<readonly string[]> {
    if (!FULL_COMMIT_SHA.test(ancestor) || !FULL_COMMIT_SHA.test(head)) {
      throw new ControlDurabilityError('first-parent range requires exact commit hashes');
    }
    const raw = await this.git.raw([
      'rev-list', '--first-parent', '--reverse', `${ancestor}..${head}`,
    ]);
    return raw.split('\n').map((value) => value.trim().toLowerCase()).filter(Boolean);
  }

  /** First-parent history ending at an exact head, oldest first. */
  async firstParentHistory(head: string): Promise<readonly string[]> {
    if (!FULL_COMMIT_SHA.test(head)) {
      throw new ControlDurabilityError('first-parent history requires an exact commit hash');
    }
    const raw = await this.git.raw(['rev-list', '--first-parent', '--reverse', head]);
    return raw.split('\n').map((value) => value.trim().toLowerCase()).filter(Boolean);
  }

  /** Exact metadata for any proven commit, not only current HEAD. */
  async commitMetadata(revision: string): Promise<{
    readonly parent: string | null;
    readonly message: string;
    readonly paths: readonly string[];
  }> {
    if (!FULL_COMMIT_SHA.test(revision)) {
      throw new ControlDurabilityError('control revision is not an exact commit hash');
    }
    const parentLine = (await this.git.raw([
      'rev-list', '--parents', '-n', '1', revision,
    ])).trim().split(/\s+/);
    const parent = parentLine[1]?.toLowerCase() ?? null;
    const message = (await this.git.raw(['log', '-1', '--format=%B', revision])).trimEnd();
    const changed = await this.git.raw(parent === null
      ? ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', revision]
      : ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', parent, revision]);
    return {
      parent,
      message,
      paths: changed.split('\0').filter(Boolean).sort(),
    };
  }

  /** Exact metadata used to prove a pending transaction owns current HEAD. */
  async headCommitMetadata(): Promise<{
    readonly parent: string | null;
    readonly message: string;
    readonly paths: readonly string[];
  }> {
    const head = await this.readHead();
    if (head === null) throw new ControlDurabilityError('control HEAD is unborn');
    return this.commitMetadata(head);
  }

  /** Absolute per-worktree git directory (supports both .git dirs and files). */
  async gitDir(): Promise<string> {
    return (await this.git.revparse(['--absolute-git-dir'])).trim();
  }
}
