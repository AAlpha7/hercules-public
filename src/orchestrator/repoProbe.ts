/**
 * Coordination layer — reachability probe for a target repo URL (design §probe).
 *
 * Lets ActionService validate a repo is cloneable at add/edit time without
 * depending on git directly, so the service stays unit-testable behind a fake.
 */
import { simpleGit } from 'simple-git';
import { assertSafeRepoUrl, redactUrl } from '../control/reposConfig.js';

/**
 * Env vars that simple-git's blockUnsafeOperationsPlugin rejects unless the
 * matching `allowUnsafe*` option is enabled (see @simple-git/argv-parser's env
 * vulnerability map). A reachability probe must never invoke editors, pagers,
 * custom ssh wrappers, or alternate config paths — strip the whole set so the
 * probe works under interactive shells and CI that set e.g. GIT_SEQUENCE_EDITOR,
 * PAGER, GIT_SSH_COMMAND.
 *
 * Keep this list in sync with simple-git's map; missing an entry surfaces as
 * `RepoProbeError: Use of "VAR" is not permitted…` rather than a network error.
 */
const GIT_ENV_DENYLIST = new Set([
  // allowUnsafeEditor
  'EDITOR',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  // allowUnsafePager
  'PAGER',
  'GIT_PAGER',
  // allowUnsafeSshCommand
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  // allowUnsafeAskPass
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  // allowUnsafeDiffExternal
  'GIT_EXTERNAL_DIFF',
  // allowUnsafeGitProxy
  'GIT_PROXY_COMMAND',
  // allowUnsafeTemplateDir
  'GIT_TEMPLATE_DIR',
  // allowUnsafeConfigPaths / ConfigEnvCount
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_EXEC_PATH',
  'PREFIX',
]);

export class RepoProbeError extends Error {
  override readonly name = 'RepoProbeError';
}

export interface RepoProbe {
  /** Resolve with the remote's head branch names, or throw if unreachable. */
  probe(url: string): Promise<{ branches: string[] }>;
}

/** Default probe: `git ls-remote --heads <url>` with a bounded timeout. */
export class GitRepoProbe implements RepoProbe {
  private readonly timeoutMs: number;
  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async probe(url: string): Promise<{ branches: string[] }> {
    // Validate before touching git — throws RepoUrlError for unsafe input.
    assertSafeRepoUrl(url);

    // Build env: strip every var simple-git treats as an unsafe override, drop
    // dynamic GIT_CONFIG_KEY_N / GIT_CONFIG_VALUE_N pairs (gated by
    // GIT_CONFIG_COUNT), then pin a safe protocol allow-list.
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => {
        if (GIT_ENV_DENYLIST.has(k)) return false;
        // Dynamic config injection via GIT_CONFIG_COUNT (allowUnsafeConfigEnvCount).
        if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) return false;
        return true;
      }),
    );
    const git = simpleGit({ timeout: { block: this.timeoutMs } }).env({
      ...safeEnv,
      GIT_ALLOW_PROTOCOL: 'https:http:ssh:git:file',
      // Never prompt; a probe is non-interactive.
      GIT_TERMINAL_PROMPT: '0',
    });
    let raw: string;
    try {
      raw = await git.listRemote(['--heads', '--end-of-options', url]);
    } catch (err) {
      throw new RepoProbeError('repo not reachable: ' + redactUrl((err as Error).message));
    }
    const branches = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/^[0-9a-f]+\s+refs\/heads\//, ''))
      .filter((b) => !b.includes('\t') && !b.includes(' '));
    return { branches };
  }
}
