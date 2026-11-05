/**
 * L5 gate-toolchain scan (S2 / acceptance-binding-grammar §5).
 *
 * Pure. Detects when the diff touches files that trusted gate commands resolve
 * from the worktree: package.json scripts in the gate closure, test/lint/type/
 * build configs, and scripts those invoke. Findings are review-severity —
 * never green, mechanical pending — not auto-rework (the edit may be the task).
 */
import type { CheatFinding } from '../domain/verification.js';

export interface GateToolchainInput {
  readonly diff: string;
  /** Trusted commands: workflow gates + setup.install + held-out smoke, in run order. */
  readonly gateCommands: readonly string[];
  /** Root package.json content from the trusted mirror default branch; null when absent. */
  readonly trustedPackageJson: string | null;
  /** Root package.json content at the verified worktree sha; null when absent. */
  readonly candidatePackageJson: string | null;
}

export interface GateToolchainReport {
  /** package.json script names reachable from the gate commands (trusted ∪ candidate closure). */
  readonly scriptClosure: readonly string[];
  /** Repo-relative files referenced by gate commands or closure scripts (e.g. scripts/x.mjs). */
  readonly resolvedFiles: readonly string[];
  readonly findings: readonly CheatFinding[]; // every finding has kind 'gate-toolchain-edit'
}

/** Config basenames a gate toolchain commonly loads from the worktree. */
const GATE_CONFIG_BASENAME =
  /^(?:vitest|vite|jest|eslint|babel|playwright|tsup|rollup|webpack|prettier)\.[\w.-]*config\.[cm]?[jt]s$|^\.eslintrc(?:\..+)?$|^tsconfig[\w.-]*\.json$|^\.npmrc$|^pnpm-workspace\.yaml$|^\.mocharc(?:\..+)?$|^pytest\.ini$|^pyproject\.toml$|^setup\.cfg$|^tox\.ini$|^\.babelrc(?:\..+)?$|^Makefile$/;

const FILE_REF_RE =
  /^(?:\.\/)?[\w@./-]+\.(?:mjs|cjs|js|ts|mts|cts|sh|bash|py)$/;

export function scanGateToolchain(input: GateToolchainInput): GateToolchainReport {
  const trusted = parseScriptsMap(input.trustedPackageJson);
  const candidate = parseScriptsMap(input.candidatePackageJson);
  const { scriptClosure, resolvedFiles } = buildClosure(
    input.gateCommands,
    trusted.scripts,
    candidate.scripts,
  );
  const changed = changedPathsFromDiff(input.diff);
  if (changed.length === 0) {
    return { scriptClosure, resolvedFiles, findings: [] };
  }

  const resolvedSet = new Set(resolvedFiles);
  const findings: CheatFinding[] = [];
  let packageJsonFindingsEmitted = false;

  for (const path of changed) {
    const base = basenameOf(path);
    if (GATE_CONFIG_BASENAME.test(base)) {
      findings.push({
        kind: 'gate-toolchain-edit',
        file: path,
        detail: `edits gate-resolved config ${path}`,
      });
    } else if (resolvedSet.has(path)) {
      findings.push({
        kind: 'gate-toolchain-edit',
        file: path,
        detail: `edits gate-invoked script ${path}`,
      });
    }

    if (path === 'package.json' && !packageJsonFindingsEmitted) {
      packageJsonFindingsEmitted = true;
      findings.push(
        ...packageJsonScriptFindings({
          scriptClosure,
          trusted,
          candidate,
        }),
      );
    }
  }

  // TODO(contract §5): a root package.json change that only touches non-closure
  // scripts or dependencies is out of scope for this slice — no finding.

  return { scriptClosure, resolvedFiles, findings };
}

interface ScriptsParse {
  readonly ok: boolean;
  readonly scripts: ReadonlyMap<string, string>;
}

function parseScriptsMap(raw: string | null): ScriptsParse {
  if (raw === null) {
    return { ok: true, scripts: new Map() };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, scripts: new Map() };
    }
    const scriptsVal = (parsed as Record<string, unknown>)['scripts'];
    if (scriptsVal === undefined) {
      return { ok: true, scripts: new Map() };
    }
    if (scriptsVal === null || typeof scriptsVal !== 'object' || Array.isArray(scriptsVal)) {
      return { ok: false, scripts: new Map() };
    }
    const out = new Map<string, string>();
    for (const [k, v] of Object.entries(scriptsVal as Record<string, unknown>)) {
      if (typeof v === 'string') out.set(k, v);
    }
    return { ok: true, scripts: out };
  } catch {
    return { ok: false, scripts: new Map() };
  }
}

function buildClosure(
  gateCommands: readonly string[],
  trustedScripts: ReadonlyMap<string, string>,
  candidateScripts: ReadonlyMap<string, string>,
): { scriptClosure: readonly string[]; resolvedFiles: readonly string[] } {
  const allKeys = new Set<string>([
    ...trustedScripts.keys(),
    ...candidateScripts.keys(),
  ]);
  const visited: string[] = [];
  const visitedSet = new Set<string>();
  const resolvedFiles: string[] = [];
  const seenFiles = new Set<string>();

  const addFilesFrom = (cmd: string): void => {
    for (const f of extractFileRefs(cmd)) {
      if (!seenFiles.has(f)) {
        seenFiles.add(f);
        resolvedFiles.push(f);
      }
    }
  };

  const enqueueRefs = (cmd: string): void => {
    for (const ref of extractScriptRefs(cmd, allKeys)) {
      if (!visitedSet.has(ref)) {
        visitedSet.add(ref);
        visited.push(ref);
      }
    }
  };

  for (const cmd of gateCommands) {
    addFilesFrom(cmd);
    enqueueRefs(cmd);
  }

  for (let i = 0; i < visited.length; i += 1) {
    const name = visited[i]!;
    const trustedCmd = trustedScripts.get(name);
    const candidateCmd = candidateScripts.get(name);
    if (trustedCmd !== undefined) {
      addFilesFrom(trustedCmd);
      enqueueRefs(trustedCmd);
    }
    if (candidateCmd !== undefined) {
      addFilesFrom(candidateCmd);
      enqueueRefs(candidateCmd);
    }
  }

  return { scriptClosure: visited, resolvedFiles };
}

/** Split a shell chain on && || ; | (bounded, no quote awareness). */
function splitCommandChain(cmd: string): string[] {
  return cmd
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Script names referenced after pnpm / pnpm run / npm run / npm run-script /
 * yarn / yarn run / bun run when the next token is a known scripts-map key.
 */
function extractScriptRefs(
  command: string,
  scriptKeys: ReadonlySet<string>,
): string[] {
  const refs: string[] = [];
  for (const part of splitCommandChain(command)) {
    const tokens = part.split(/\s+/).filter((t) => t.length > 0);
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      if (
        t === 'pnpm' &&
        tokens[i + 1] === 'run' &&
        tokens[i + 2] !== undefined &&
        scriptKeys.has(tokens[i + 2]!)
      ) {
        refs.push(tokens[i + 2]!);
        i += 2;
        continue;
      }
      if (
        t === 'npm' &&
        tokens[i + 1] === 'run-script' &&
        tokens[i + 2] !== undefined &&
        scriptKeys.has(tokens[i + 2]!)
      ) {
        refs.push(tokens[i + 2]!);
        i += 2;
        continue;
      }
      if (
        t === 'npm' &&
        tokens[i + 1] === 'run' &&
        tokens[i + 2] !== undefined &&
        scriptKeys.has(tokens[i + 2]!)
      ) {
        refs.push(tokens[i + 2]!);
        i += 2;
        continue;
      }
      if (
        t === 'yarn' &&
        tokens[i + 1] === 'run' &&
        tokens[i + 2] !== undefined &&
        scriptKeys.has(tokens[i + 2]!)
      ) {
        refs.push(tokens[i + 2]!);
        i += 2;
        continue;
      }
      if (
        t === 'bun' &&
        tokens[i + 1] === 'run' &&
        tokens[i + 2] !== undefined &&
        scriptKeys.has(tokens[i + 2]!)
      ) {
        refs.push(tokens[i + 2]!);
        i += 2;
        continue;
      }
      // `npm test` / `npm start` are lifecycle shorthands for `npm run <name>`.
      if (
        t === 'npm' &&
        (tokens[i + 1] === 'test' || tokens[i + 1] === 'start') &&
        scriptKeys.has(tokens[i + 1]!)
      ) {
        refs.push(tokens[i + 1]!);
        i += 1;
        continue;
      }
      if (t === 'pnpm' && tokens[i + 1] !== undefined && scriptKeys.has(tokens[i + 1]!)) {
        refs.push(tokens[i + 1]!);
        i += 1;
        continue;
      }
      if (t === 'yarn' && tokens[i + 1] !== undefined && scriptKeys.has(tokens[i + 1]!)) {
        refs.push(tokens[i + 1]!);
        i += 1;
        continue;
      }
    }
  }
  return refs;
}

function extractFileRefs(command: string): string[] {
  const out: string[] = [];
  for (const part of splitCommandChain(command)) {
    for (const token of part.split(/\s+/)) {
      if (token.length === 0) continue;
      let path: string | null = null;
      if (token.startsWith('scripts/')) {
        path = token.replace(/^\.\//, '');
      } else if (FILE_REF_RE.test(token)) {
        path = token.replace(/^\.\//, '');
      }
      if (path !== null) out.push(path);
    }
  }
  return out;
}

/** Changed paths from `+++ b/<path>` with at least one +/- line; `/dev/null` ignored. */
function changedPathsFromDiff(diff: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  let file = '';
  let hasChange = false;

  const flush = (): void => {
    if (file.length > 0 && file !== '/dev/null' && hasChange && !seen.has(file)) {
      seen.add(file);
      order.push(file);
    }
  };

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      flush();
      file = raw.slice(4).replace(/^b\//, '').trim();
      hasChange = false;
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      continue;
    }
    if (
      (raw.startsWith('+') && !raw.startsWith('+++')) ||
      (raw.startsWith('-') && !raw.startsWith('---'))
    ) {
      hasChange = true;
    }
  }
  flush();
  return order;
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function packageJsonScriptFindings(input: {
  readonly scriptClosure: readonly string[];
  readonly trusted: ScriptsParse;
  readonly candidate: ScriptsParse;
}): CheatFinding[] {
  const { scriptClosure, trusted, candidate } = input;
  if (scriptClosure.length === 0) return [];

  if (!trusted.ok || !candidate.ok) {
    // Prefer candidate side when both fail — that is what the gates would execute.
    const side = !candidate.ok ? 'candidate' : 'trusted';
    return [
      {
        kind: 'gate-toolchain-edit',
        file: 'package.json',
        detail: `package.json unparsable on ${side} — gate scripts (${scriptClosure.join(', ')}) cannot be compared`,
      },
    ];
  }

  // Both sides parse: only closure scripts whose command differs / appears / vanishes.
  const findings: CheatFinding[] = [];
  for (const name of scriptClosure) {
    const oldCmd = trusted.scripts.get(name);
    const newCmd = candidate.scripts.get(name);
    if (oldCmd === newCmd) continue;
    // Both undefined should not happen for a closure member, but guard anyway.
    if (oldCmd === undefined && newCmd === undefined) continue;
    findings.push({
      kind: 'gate-toolchain-edit',
      file: 'package.json',
      detail: `package.json script "${name}" changed: "${oldCmd ?? ''}" → "${newCmd ?? ''}"`,
    });
  }
  return findings;
}
