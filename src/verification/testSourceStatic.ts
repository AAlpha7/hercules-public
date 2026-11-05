/**
 * Verification — collect structured test-source static/transform diagnostics.
 *
 * Uses the TypeScript program API and esbuild transform messages (not stderr
 * greps). Redirecting process stderr or renaming a warning string cannot
 * bypass this gate: only structured Message/Diagnostic objects count.
 *
 * Wired into L1 via `pnpm typecheck` → `scripts/check-test-source-static.mjs`,
 * so full verify, reverify, auto-rework, and Merge Selected share the policy.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import {
  DEFAULT_STATIC_DIAGNOSTIC_ALLOWLIST,
  evaluateStaticDiagnostics,
} from '../domain/staticDiagnostics.js';
import type {
  StaticDiagnostic,
  StaticDiagnosticAllowlistEntry,
  StaticDiagnosticSeverity,
  StaticDiagnosticsGateResult,
} from '../domain/staticDiagnostics.js';

const require = createRequire(import.meta.url);

/** File extensions scanned for transform/typecheck diagnostics. */
const TEST_SOURCE_RE = /\.(tsx?|jsx?|mjs|cjs)$/;

export class TestSourceStaticError extends Error {
  override readonly name = 'TestSourceStaticError';
}

export interface TestSourceStaticOptions {
  readonly rootDir: string;
  /** Override allowlist (tests). Default: domain DEFAULT. */
  readonly allowlist?: readonly StaticDiagnosticAllowlistEntry[];
  /**
   * Project configs for TypeScript program checks (relative to rootDir).
   * Default covers node tests + web/render tests.
   */
  readonly tsconfigPaths?: readonly string[];
  /** When false, skip esbuild transform pass (tests). Default true. */
  readonly includeEsbuild?: boolean;
  /** When false, skip TypeScript program pass (tests). Default true. */
  readonly includeTypescript?: boolean;
  /** Optional file list override (absolute or root-relative). */
  readonly files?: readonly string[];
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw err;
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (
        ent.name === 'node_modules' ||
        ent.name === 'dist' ||
        ent.name === 'fixtures' ||
        ent.name.startsWith('.')
      ) {
        continue;
      }
      yield* walkFiles(full);
    } else if (ent.isFile() && TEST_SOURCE_RE.test(ent.name)) {
      yield full;
    }
  }
}

/** Discover test source files under rootDir/test (and optional override list). */
export async function listTestSourceFiles(rootDir: string): Promise<string[]> {
  const testRoot = join(rootDir, 'test');
  const out: string[] = [];
  for await (const f of walkFiles(testRoot)) {
    out.push(f);
  }
  out.sort();
  return out;
}

function loadTypescript(): typeof import('typescript') {
  try {
    return require('typescript') as typeof import('typescript');
  } catch (err) {
    throw new TestSourceStaticError(
      'typescript package required for test-source static gate: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

type EsbuildApi = {
  transformSync: (
    input: string,
    options?: Record<string, unknown>,
  ) => { code: string; map: string; warnings: EsbuildMessage[] };
};

/** Resolve esbuild via vite/vitest so we need no extra direct dependency. */
function loadEsbuild(): EsbuildApi {
  for (const host of ['vite', 'vitest'] as const) {
    try {
      const hostPkg = require.resolve(host + '/package.json');
      const fromHost = createRequire(hostPkg);
      return fromHost('esbuild') as EsbuildApi;
    } catch {
      // try next host
    }
  }
  try {
    return require('esbuild') as EsbuildApi;
  } catch (err) {
    throw new TestSourceStaticError(
      'esbuild package required for test-source static gate (via vite/vitest): ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

interface EsbuildMessage {
  readonly id?: string;
  readonly pluginName?: string;
  readonly text: string;
  readonly location: {
    readonly file: string;
    readonly line: number;
    readonly column: number;
  } | null;
}

function tsCategoryToSeverity(
  ts: typeof import('typescript'),
  category: import('typescript').DiagnosticCategory,
): StaticDiagnosticSeverity {
  if (category === ts.DiagnosticCategory.Error) return 'error';
  if (category === ts.DiagnosticCategory.Warning) return 'warning';
  return 'info';
}

/**
 * Collect TypeScript program diagnostics for the given tsconfig paths.
 * Structured only — never parses tsc stderr text.
 */
export function collectTypescriptDiagnostics(
  rootDir: string,
  tsconfigPaths: readonly string[],
): StaticDiagnostic[] {
  const ts = loadTypescript();
  const out: StaticDiagnostic[] = [];
  const seen = new Set<string>();

  for (const relConfig of tsconfigPaths) {
    const configPath = resolve(rootDir, relConfig);
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    if (read.error) {
      out.push(diagnosticFromTs(ts, read.error, rootDir));
      continue;
    }
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      resolve(rootDir, relConfig, '..'),
      undefined,
      configPath,
    );
    if (parsed.errors.length > 0) {
      for (const e of parsed.errors) {
        out.push(diagnosticFromTs(ts, e, rootDir));
      }
    }
    const program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: { ...parsed.options, noEmit: true },
    });
    const diags = [
      ...program.getOptionsDiagnostics(),
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ];
    for (const d of diags) {
      const mapped = diagnosticFromTs(ts, d, rootDir);
      const key = [
        mapped.file ?? '',
        mapped.line ?? '',
        mapped.code ?? '',
        mapped.message,
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(mapped);
    }
  }
  return out;
}

function diagnosticFromTs(
  ts: typeof import('typescript'),
  d: import('typescript').Diagnostic,
  rootDir: string,
): StaticDiagnostic {
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
  let file: string | null = null;
  let line: number | null = null;
  let column: number | null = null;
  if (d.file && typeof d.start === 'number') {
    const abs = d.file.fileName;
    file = relative(rootDir, abs).replaceAll('\\', '/');
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    line = pos.line + 1;
    column = pos.character + 1;
  }
  const code = typeof d.code === 'number' ? 'TS' + String(d.code) : null;
  return {
    source: 'typescript',
    severity: tsCategoryToSeverity(ts, d.category),
    code,
    message,
    file,
    line,
    column,
  };
}

/**
 * Transform each test source with esbuild and collect structured warnings.
 * Duplicate object keys, syntax recovery notes, etc. surface here even when
 * Vitest assertions pass.
 */
export async function collectEsbuildTransformDiagnostics(
  rootDir: string,
  files: readonly string[],
): Promise<StaticDiagnostic[]> {
  const esbuild = loadEsbuild();
  const out: StaticDiagnostic[] = [];

  for (const abs of files) {
    let text: string;
    try {
      text = await readFile(abs, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      throw err;
    }
    const rel = relative(rootDir, abs).replaceAll('\\', '/');
    const loader = loaderFor(rel);
    try {
      const result = esbuild.transformSync(text, {
        loader,
        sourcefile: rel,
        // Surface duplicate-key and other transform warnings as structured messages.
        logLevel: 'silent',
        logLimit: 0,
      });
      for (const w of result.warnings ?? []) {
        out.push(esbuildMessageToDiagnostic(w, rel, 'warning'));
      }
    } catch (err) {
      // esbuild throws on hard errors with an errors[] array.
      const e = err as {
        errors?: EsbuildMessage[];
        warnings?: EsbuildMessage[];
        message?: string;
      };
      if (Array.isArray(e.errors)) {
        for (const msg of e.errors) {
          out.push(esbuildMessageToDiagnostic(msg, rel, 'error'));
        }
      } else {
        out.push({
          source: 'esbuild',
          severity: 'error',
          code: null,
          message: e.message ?? String(err),
          file: rel,
          line: null,
          column: null,
        });
      }
      if (Array.isArray(e.warnings)) {
        for (const msg of e.warnings) {
          out.push(esbuildMessageToDiagnostic(msg, rel, 'warning'));
        }
      }
    }
  }
  return out;
}

function loaderFor(
  rel: string,
): 'ts' | 'tsx' | 'js' | 'jsx' {
  if (rel.endsWith('.tsx')) return 'tsx';
  if (rel.endsWith('.jsx')) return 'jsx';
  if (rel.endsWith('.ts')) return 'ts';
  return 'js';
}

function esbuildMessageToDiagnostic(
  msg: EsbuildMessage,
  fallbackFile: string,
  severity: StaticDiagnosticSeverity,
): StaticDiagnostic {
  const file = msg.location?.file
    ? msg.location.file.replaceAll('\\', '/')
    : fallbackFile;
  return {
    source: 'esbuild',
    severity,
    code: msg.id && msg.id.length > 0 ? msg.id : null,
    message: msg.text,
    file,
    line: msg.location?.line ?? null,
    column:
      msg.location && typeof msg.location.column === 'number'
        ? msg.location.column + 1
        : null,
  };
}

const DEFAULT_TSCONFIGS = [
  'tsconfig.json',
  'src/web/tsconfig.json',
  'tsconfig.test-web.json',
] as const;

/**
 * Run the full test-source static gate: TypeScript programs + esbuild
 * transform, then evaluate against the allowlist.
 */
export async function runTestSourceStaticGate(
  opts: TestSourceStaticOptions,
): Promise<StaticDiagnosticsGateResult> {
  const rootDir = resolve(opts.rootDir);
  try {
    const st = await stat(rootDir);
    if (!st.isDirectory()) {
      throw new TestSourceStaticError('rootDir is not a directory: ' + rootDir);
    }
  } catch (err) {
    if (err instanceof TestSourceStaticError) throw err;
    throw new TestSourceStaticError(
      'rootDir not accessible: ' +
        rootDir +
        ' (' +
        (err instanceof Error ? err.message : String(err)) +
        ')',
    );
  }

  const files =
    opts.files && opts.files.length > 0
      ? opts.files.map((f) => (f.startsWith('/') ? f : resolve(rootDir, f)))
      : await listTestSourceFiles(rootDir);

  const collected: StaticDiagnostic[] = [];

  if (opts.includeTypescript !== false) {
    const configs = opts.tsconfigPaths ?? DEFAULT_TSCONFIGS;
    collected.push(...collectTypescriptDiagnostics(rootDir, configs));
  }

  if (opts.includeEsbuild !== false) {
    collected.push(...(await collectEsbuildTransformDiagnostics(rootDir, files)));
  }

  return evaluateStaticDiagnostics(
    collected,
    opts.allowlist ?? DEFAULT_STATIC_DIAGNOSTIC_ALLOWLIST,
  );
}
