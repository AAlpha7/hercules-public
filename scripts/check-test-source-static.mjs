#!/usr/bin/env node
/**
 * L1 gate helper — fail on actionable test-source transform diagnostics.
 *
 * TypeScript project checks run via `tsc` in `pnpm typecheck` (real test-project
 * typechecking including test/web). This script adds structured esbuild
 * transform diagnostics (duplicate keys, syntax recovery, etc.) that Vitest
 * may only print as soft warnings while still exiting 0.
 *
 * Not a stderr grep: redirecting stderr or renaming a warning string cannot
 * bypass this gate — only esbuild Message objects count.
 *
 * Invoked from `pnpm typecheck` so full verify, reverify, auto-rework, and
 * Merge Selected all enforce the same policy.
 */
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, stat } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEST_SOURCE_RE = /\.(tsx?|jsx?|mjs|cjs)$/;
const REPORT_MAX_ITEMS = 20;
const REPORT_MAX_CHARS = 4000;

/**
 * Default allowlist — intentionally empty. Entries must be exact
 * { source, code and/or messageExact, reasonCode, doc } and covered by tests.
 * Runtime Vitest/React warnings are never allowlisted here (not static).
 */
const ALLOWLIST = Object.freeze([]);

function redact(raw, max = REPORT_MAX_CHARS) {
  let text = String(raw).replace(/\r\n/g, '\n');
  text = text.replace(/(?:Bearer\s+)\S+/gi, 'Bearer [REDACTED]');
  text = text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+):([^/\s@]+)@/gi,
    '$1[REDACTED]@',
  );
  text = text.replace(
    /(?:(?:HERCULES_[A-Z0-9_]*TOKEN|[A-Z0-9_]*(?:API[_-]?KEY|PASSWORD|SECRET|TOKEN|CREDENTIAL|DATABASE_URL|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*[=:]\s*)\S+/gi,
    (m) => {
      const eq = m.includes('=') ? '=' : ':';
      const key = m.split(/[=:]/)[0] ?? 'SECRET';
      return `${key.trim()}${eq}[REDACTED]`;
    },
  );
  text = text.replace(/\b(?:sk|xai|ghp|gho|ghu|ghs)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  if (text.length <= max) return text;
  return `…[truncated ${text.length - max} chars]…\n${text.slice(-max)}`;
}

function isAllowlisted(diag) {
  for (const entry of ALLOWLIST) {
    if (entry.source !== diag.source) continue;
    if (entry.code != null && entry.code !== diag.code) continue;
    if (entry.messageExact != null && entry.messageExact !== diag.message) continue;
    // Require at least one exact matcher (empty allowlist entries are invalid).
    if (entry.code == null && entry.messageExact == null) continue;
    return true;
  }
  return false;
}

function isActionable(diag) {
  if (diag.severity === 'info') return false;
  if (isAllowlisted(diag)) return false;
  return true;
}

function formatOne(d) {
  let loc = '(no-file)';
  if (d.file != null) {
    if (d.line != null && d.column != null) loc = `${d.file}:${d.line}:${d.column}`;
    else if (d.line != null) loc = `${d.file}:${d.line}`;
    else loc = d.file;
  }
  const code = d.code ? `[${d.code}] ` : '';
  return `${d.source} ${d.severity} ${loc}: ${code}${d.message}`;
}

function evaluate(diags) {
  const actionable = diags.filter(isActionable);
  if (actionable.length === 0) {
    return { ok: true, report: 'test-source static diagnostics: clean' };
  }
  const head = actionable.slice(0, REPORT_MAX_ITEMS);
  const extra = actionable.length - head.length;
  const lines = [
    `test-source static diagnostics: ${actionable.length} actionable finding(s)`,
    ...head.map((d) => `- ${formatOne(d)}`),
  ];
  if (extra > 0) lines.push(`- ... +${extra} more`);
  return { ok: false, report: redact(lines.join('\n')) };
}

async function* walkFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
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

async function listTestSources() {
  const out = [];
  for await (const f of walkFiles(join(ROOT, 'test'))) out.push(f);
  out.sort();
  return out;
}

function loaderFor(rel) {
  if (rel.endsWith('.tsx')) return 'tsx';
  if (rel.endsWith('.jsx')) return 'jsx';
  if (rel.endsWith('.ts')) return 'ts';
  return 'js';
}

function loadEsbuild() {
  for (const host of ['vite', 'vitest']) {
    try {
      const hostPkg = require.resolve(`${host}/package.json`);
      return createRequire(hostPkg)('esbuild');
    } catch {
      // try next
    }
  }
  return require('esbuild');
}

async function collectEsbuild(files) {
  let esbuild;
  try {
    esbuild = loadEsbuild();
  } catch (err) {
    throw new Error(`esbuild required (via vite/vitest): ${err.message}`);
  }
  const out = [];
  for (const abs of files) {
    let text;
    try {
      text = await readFile(abs, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') continue;
      throw err;
    }
    const rel = relative(ROOT, abs).replaceAll('\\', '/');
    const toDiag = (msg, severity) => ({
      source: 'esbuild',
      severity,
      code: msg.id && msg.id.length > 0 ? msg.id : null,
      message: msg.text,
      file: msg.location?.file
        ? msg.location.file.replaceAll('\\', '/')
        : rel,
      line: msg.location?.line ?? null,
      column:
        msg.location && typeof msg.location.column === 'number'
          ? msg.location.column + 1
          : null,
    });
    try {
      const result = esbuild.transformSync(text, {
        loader: loaderFor(rel),
        sourcefile: rel,
        logLevel: 'silent',
        logLimit: 0,
      });
      for (const w of result.warnings ?? []) out.push(toDiag(w, 'warning'));
    } catch (err) {
      if (Array.isArray(err.errors)) {
        for (const msg of err.errors) out.push(toDiag(msg, 'error'));
      } else {
        out.push({
          source: 'esbuild',
          severity: 'error',
          code: null,
          message: err.message ?? String(err),
          file: rel,
          line: null,
          column: null,
        });
      }
      if (Array.isArray(err.warnings)) {
        for (const msg of err.warnings) out.push(toDiag(msg, 'warning'));
      }
    }
  }
  return out;
}

async function main() {
  await stat(ROOT);
  const files = await listTestSources();
  const diags = await collectEsbuild(files);
  const result = evaluate(diags);
  if (result.ok) {
    process.stdout.write(result.report + '\n');
    process.exit(0);
  }
  process.stderr.write(result.report + '\n');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(
    `test-source static gate crashed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(2);
});
