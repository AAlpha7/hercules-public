/**
 * M11 controlapi-layer import boundary (source scan).
 *
 * - every file under `src/controlapi/` may import only relative paths inside
 *   `src/controlapi/` or `../domain/...`
 * - no file under `src/` outside the allowance list may import
 *   anything from `src/controlapi/`
 *
 * Allowance (slice 2 + anticipating slice 3 route/fake-provider wiring):
 * `src/controlapi/`, `src/domain/`, `src/server/`, `src/isolation/`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');
const CONTROLAPI = join(SRC, 'controlapi');

/** Directories allowed to import `src/controlapi/` (consumer fence). */
const ALLOWED_CONTROLAPI_CONSUMERS = [
  'src/controlapi/',
  'src/domain/',
  'src/server/',
  'src/isolation/',
  // M12 proofs harness drives decideControlApiV2 over seeded reads.
  'src/proofs/',
  // M13 qualification harness drives decideControlApiV2 for adversarial fixtures.
  'src/qualification/',
] as const;

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

function isAllowedControlApiConsumer(localPath: string): boolean {
  return ALLOWED_CONTROLAPI_CONSUMERS.some((prefix) =>
    localPath.startsWith(prefix),
  );
}

describe('M11 controlapi architecture boundary', () => {
  it('restricts src/controlapi imports to controlapi-local or ../domain paths', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(CONTROLAPI)) {
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

  it('forbids non-allowed src files from importing src/controlapi', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      if (isAllowedControlApiConsumer(local)) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (
          /(^|\/)controlapi(\/|$)/.test(spec) &&
          (spec.includes('controlapi/') || spec.endsWith('/controlapi'))
        ) {
          violations.push(`${local}: imports controlapi via ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
