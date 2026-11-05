/**
 * H-owned workspace mutation tools (apply_patch / delete_file).
 *
 * Invoked by the stdio MCP server. All paths are confined to HERCULES_WORKSPACE
 * (or an explicit workspace root). No shell — git apply via spawn + stdin only.
 */
import { spawn } from 'node:child_process';
import {
  lstat,
  realpath,
  rm,
  unlink,
  access,
  constants as fsConstants,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  assertPatchPathsConfined,
  normalizeWorkspaceRelativePath,
  WorkspacePathError,
} from '../domain/workspaceMutation.js';

/**
 * Run `git` with a fixed argv and optional stdin body. No shell.
 * Uses spawn (not promisify(execFile)) so patch bytes can be fed on stdin
 * under strict @types/node overloads.
 */
function runGitNoShell(opts: {
  readonly gitBin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin?: string;
}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(opts.gitBin, [...opts.args], {
      cwd: opts.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    const stdinStream = child.stdin;
    if (!stdoutStream || !stderrStream || !stdinStream) {
      reject(new Error('git spawn did not provide stdio pipes'));
      return;
    }
    let stdout = '';
    let stderr = '';
    stdoutStream.setEncoding('utf8');
    stderrStream.setEncoding('utf8');
    stdoutStream.on('data', (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise(`${stdout}${stderr}`.trim());
        return;
      }
      const detail = [stderr, stdout].filter((s) => s.length > 0).join('\n').trim();
      const err = new Error(detail || `git exited ${code ?? 'unknown'}`) as Error & {
        code: number | null;
        stdout: string;
        stderr: string;
      };
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
    if (opts.stdin !== undefined) {
      stdinStream.end(opts.stdin, 'utf8');
    } else {
      stdinStream.end();
    }
  });
}

export class WorkspaceToolError extends Error {
  override readonly name = 'WorkspaceToolError';
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface WorkspaceToolsOptions {
  readonly workspaceRoot: string;
  /** Injected for tests; defaults to system `git`. */
  readonly gitBin?: string;
}

function assertAbsoluteWorkspace(root: string): string {
  const trimmed = root.trim();
  if (trimmed.length === 0) {
    throw new WorkspaceToolError('workspace root is empty', 'workspace_missing');
  }
  if (!trimmed.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw new WorkspaceToolError('workspace root must be absolute', 'workspace_invalid');
  }
  return resolve(trimmed);
}

/**
 * Resolve a workspace-relative target under root with symlink-ancestor checks.
 *
 * - Syntax via {@link normalizeWorkspaceRelativePath}
 * - Parent directory is realpath'd; must stay under realpath(workspace)
 * - Final component may be a symlink (we delete the link, not the target)
 * - Rejects when the path is a directory
 */
export async function resolveConfinedTarget(
  workspaceRoot: string,
  relativePath: unknown,
): Promise<{ readonly absPath: string; readonly relPath: string }> {
  const root = assertAbsoluteWorkspace(workspaceRoot);
  let rel: string;
  try {
    rel = normalizeWorkspaceRelativePath(relativePath);
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      throw new WorkspaceToolError(err.message, err.code);
    }
    throw err;
  }

  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceToolError(`workspace root unreadable: ${msg}`, 'workspace_unreadable');
  }

  const absCandidate = resolve(root, ...rel.split('/'));
  const underLogical = absCandidate === root || absCandidate.startsWith(root + sep);
  if (!underLogical) {
    throw new WorkspaceToolError('path escapes workspace', 'escape');
  }

  const parentLogical = dirname(absCandidate);
  let parentReal: string;
  try {
    parentReal = await realpath(parentLogical);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceToolError(`parent path unreadable: ${msg}`, 'parent_unreadable');
  }

  if (parentReal !== rootReal && !parentReal.startsWith(rootReal + sep)) {
    throw new WorkspaceToolError(
      'path escapes workspace via symlink ancestor',
      'symlink_ancestor_escape',
    );
  }

  const base = absCandidate.slice(absCandidate.lastIndexOf(sep) + 1);
  if (base.length === 0) {
    throw new WorkspaceToolError('path must not target the workspace root', 'root');
  }
  const absPath = join(parentReal, base);
  if (absPath !== rootReal && !absPath.startsWith(rootReal + sep)) {
    throw new WorkspaceToolError('path escapes workspace', 'escape');
  }

  return { absPath, relPath: rel };
}

/** Delete a workspace-relative file or symlink (not a directory). */
export async function deleteWorkspaceFile(
  opts: WorkspaceToolsOptions,
  relativePath: unknown,
): Promise<{ readonly deleted: string }> {
  const { absPath, relPath } = await resolveConfinedTarget(opts.workspaceRoot, relativePath);

  let st;
  try {
    st = await lstat(absPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceToolError(`target not found: ${relPath} (${msg})`, 'not_found');
  }

  if (st.isDirectory()) {
    throw new WorkspaceToolError('refusing to delete a directory', 'is_directory');
  }

  try {
    if (st.isSymbolicLink() || st.isFile()) {
      await unlink(absPath);
    } else {
      // Non-file special nodes — still unlink when possible.
      await rm(absPath, { force: false });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceToolError(`delete failed: ${msg}`, 'delete_failed');
  }

  return { deleted: relPath };
}

/**
 * Apply a unified git diff with check-first, no-shell deterministic subprocess.
 */
export async function applyWorkspacePatch(
  opts: WorkspaceToolsOptions,
  patch: unknown,
): Promise<{ readonly applied: true; readonly check: string }> {
  if (typeof patch !== 'string' || patch.length === 0) {
    throw new WorkspaceToolError('patch must be a non-empty string', 'patch_invalid');
  }
  if (patch.includes('\0')) {
    throw new WorkspaceToolError('patch must not contain null bytes', 'patch_invalid');
  }
  // Fail closed on path headers before spawning git (absolute / .. / null).
  try {
    assertPatchPathsConfined(patch);
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      throw new WorkspaceToolError(err.message, err.code);
    }
    throw err;
  }

  const root = assertAbsoluteWorkspace(opts.workspaceRoot);
  try {
    await access(root, fsConstants.R_OK | fsConstants.W_OK);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WorkspaceToolError(`workspace not writable: ${msg}`, 'workspace_unreadable');
  }

  const gitBin = opts.gitBin ?? 'git';
  const runGit = async (args: string[]): Promise<string> => {
    try {
      // Feed patch on stdin — no temp file, no shell.
      return await runGitNoShell({
        gitBin,
        args,
        cwd: root,
        stdin: patch,
      });
    } catch (err) {
      const e = err as {
        stdout?: string;
        stderr?: string;
        message?: string;
        code?: string | number;
      };
      const detail = [e.stderr, e.stdout, e.message].filter(Boolean).join('\n').trim();
      throw new WorkspaceToolError(
        `git ${args.join(' ')} failed: ${detail || 'unknown error'}`,
        'git_apply_failed',
      );
    }
  };

  // Check-first: never mutate on a patch that would fail. Explicit `-` = stdin.
  const checkOut = await runGit(['apply', '--check', '--whitespace=nowarn', '-']);
  await runGit(['apply', '--whitespace=nowarn', '-']);
  return { applied: true, check: checkOut || 'ok' };
}
