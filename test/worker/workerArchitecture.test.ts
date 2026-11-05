/**
 * M10 worker-layer import boundary (source scan).
 *
 * - every file under `src/worker/` may import only relative paths inside
 *   `src/worker/` or `../domain/...`
 * - no file under `src/` outside `src/worker/` and `src/domain/` may import
 *   anything from `src/worker/`
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');
const WORKER = join(SRC, 'worker');

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (extname(entry.name) === '.ts' || extname(entry.name) === '.tsx') {
      files.push(path);
    }
  }
  return files;
}

/** Extract module specifiers from import/export-from statements (multi-line safe). */
function importSpecsFromSource(source: string): string[] {
  const specs: string[] = [];
  const fromRe = /\bfrom\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(fromRe)) {
    if (match[1] !== undefined) {
      specs.push(match[1]);
    }
  }
  const sideEffectRe = /^import\s+['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(sideEffectRe)) {
    if (match[1] !== undefined) {
      specs.push(match[1]);
    }
  }
  return specs;
}

function isLayerLocalImport(spec: string): boolean {
  return spec.startsWith('./');
}

function isDomainImportFromLayer(spec: string): boolean {
  return (
    spec === '../domain' ||
    spec.startsWith('../domain/') ||
    /^(\.\.\/)+domain\//.test(spec)
  );
}

describe('M10 worker architecture boundary', () => {
  it('restricts src/worker imports to worker-local or ../domain paths', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(WORKER)) {
      const local = relative(ROOT, path);
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (spec.startsWith('node:')) {
          violations.push(`${local}: node builtin ${spec}`);
          continue;
        }
        if (!spec.startsWith('.')) {
          violations.push(`${local}: bare/package import ${spec}`);
          continue;
        }
        if (isLayerLocalImport(spec) || isDomainImportFromLayer(spec)) {
          continue;
        }
        violations.push(`${local}: forbidden import ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('forbids non-worker/non-domain src files from importing src/worker', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      // M12 proofs + M13 qualification harnesses may drive the M10 worker boundary.
      if (
        local.startsWith('src/worker/') ||
        local.startsWith('src/domain/') ||
        local.startsWith('src/proofs/') ||
        local.startsWith('src/qualification/')
      ) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (
          /(^|\/)worker(\/|$)/.test(spec) &&
          (spec.includes('worker/') || spec.endsWith('/worker'))
        ) {
          violations.push(`${local}: imports worker via ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
