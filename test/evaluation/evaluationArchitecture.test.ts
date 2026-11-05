/**
 * M8 evaluation-layer + M9 routing-layer import boundary (source scan).
 *
 * - every file under `src/evaluation/` may import only relative paths inside
 *   `src/evaluation/` or `../domain/...`
 * - no file under `src/` outside `src/evaluation/` and `src/domain/` may import
 *   anything from `src/evaluation/`
 * - `src/domain/independentEvaluation.ts` imports only from `src/domain/`
 * - every file under `src/routing/` may import only relative paths inside
 *   `src/routing/` or `../domain/...` (no node:, no bare packages, no other
 *   `src/` subtree)
 * - no file under `src/` outside `src/routing/` and `src/domain/` may import
 *   anything from `src/routing/`
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');
const EVALUATION = join(SRC, 'evaluation');
const ROUTING = join(SRC, 'routing');
const DOMAIN = join(SRC, 'domain');

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

describe('M8 evaluation architecture boundary', () => {
  it('restricts src/evaluation imports to evaluation-local or ../domain paths', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(EVALUATION)) {
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

  it('forbids non-evaluation/non-domain src files from importing src/evaluation', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      // M12 proofs + M13 qualification harnesses may drive the M8 evaluation engine.
      // C3.3 production review-evaluation runtime is the sole control-layer importer.
      if (
        local.startsWith('src/evaluation/') ||
        local.startsWith('src/domain/') ||
        local.startsWith('src/proofs/') ||
        local.startsWith('src/qualification/') ||
        local === 'src/control/reviewEvaluation.ts'
      ) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (
          /(^|\/)evaluation(\/|$)/.test(spec) &&
          (spec.includes('evaluation/') || spec.endsWith('/evaluation'))
        ) {
          violations.push(`${local}: imports evaluation via ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps independentEvaluation.ts importing only from src/domain', () => {
    const path = join(DOMAIN, 'independentEvaluation.ts');
    const local = relative(ROOT, path);
    const source = readFileSync(path, 'utf8');
    const violations: string[] = [];
    for (const spec of importSpecsFromSource(source)) {
      if (spec.startsWith('node:')) {
        violations.push(`${local}: node builtin ${spec}`);
        continue;
      }
      if (!spec.startsWith('./')) {
        violations.push(`${local}: non-domain-local import ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps capabilityProof.ts importing only from src/domain', () => {
    const path = join(DOMAIN, 'capabilityProof.ts');
    const local = relative(ROOT, path);
    const source = readFileSync(path, 'utf8');
    const violations: string[] = [];
    for (const spec of importSpecsFromSource(source)) {
      if (spec.startsWith('node:')) {
        violations.push(`${local}: node builtin ${spec}`);
        continue;
      }
      if (!spec.startsWith('./')) {
        violations.push(`${local}: non-domain-local import ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps qualification.ts importing only from src/domain', () => {
    const path = join(DOMAIN, 'qualification.ts');
    const local = relative(ROOT, path);
    const source = readFileSync(path, 'utf8');
    const violations: string[] = [];
    for (const spec of importSpecsFromSource(source)) {
      if (spec.startsWith('node:')) {
        violations.push(`${local}: node builtin ${spec}`);
        continue;
      }
      if (!spec.startsWith('./')) {
        violations.push(`${local}: non-domain-local import ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('M9 routing architecture boundary', () => {
  it('restricts src/routing imports to routing-local or ../domain paths', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(ROUTING)) {
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

  it('forbids non-routing/non-domain src files from importing src/routing', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      // M12 proofs + M13 qualification harnesses may drive the M9 repair router.
      if (
        local.startsWith('src/routing/') ||
        local.startsWith('src/domain/') ||
        local.startsWith('src/proofs/') ||
        local.startsWith('src/qualification/')
      ) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (
          /(^|\/)routing(\/|$)/.test(spec) &&
          (spec.includes('routing/') || spec.endsWith('/routing'))
        ) {
          violations.push(`${local}: imports routing via ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('M12 proofs architecture boundary', () => {
  const PROOFS = join(SRC, 'proofs');

  const ALLOWED_PROOF_TARGETS = [
    'proofs/',
    'domain/',
    'evaluation/',
    'routing/',
    'worker/',
    'controlapi/',
  ] as const;

  function isAllowedProofImport(fromFile: string, spec: string): boolean {
    if (spec.startsWith('node:')) {
      // node:crypto is used only for artifact digest of seeded bytes in spine.
      return spec === 'node:crypto';
    }
    if (!spec.startsWith('.')) {
      return false;
    }
    const resolved = resolve(fromFile, '..', spec);
    const rel = relative(SRC, resolved).replace(/\\/g, '/');
    // Strip a trailing .js so directory-prefix checks match the source layout.
    const normalized = rel.replace(/\.js$/, '');
    return ALLOWED_PROOF_TARGETS.some(
      (prefix) =>
        normalized === prefix.slice(0, -1) ||
        normalized.startsWith(prefix) ||
        rel.startsWith(prefix),
    );
  }

  it('restricts src/proofs imports to domain + allowlisted engines (+ node:crypto)', () => {
    if (!existsSync(PROOFS)) {
      return;
    }
    const violations: string[] = [];
    for (const path of sourceFiles(PROOFS)) {
      const local = relative(ROOT, path);
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (!isAllowedProofImport(path, spec)) {
          violations.push(`${local}: forbidden import ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('forbids production paths from importing src/proofs', () => {
    if (!existsSync(PROOFS)) {
      return;
    }
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      // M13 qualification harness may re-consume the M12 proofs.
      if (
        local.startsWith('src/proofs/') ||
        local.startsWith('src/qualification/')
      ) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (
          /(^|\/)proofs(\/|$)/.test(spec) &&
          (spec.includes('proofs/') || spec.endsWith('/proofs'))
        ) {
          violations.push(`${local}: imports proofs via ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('M13 qualification architecture boundary', () => {
  const QUALIFICATION = join(SRC, 'qualification');

  /** Slice 1–3 harness modules (render assertions live in test/, not here). */
  const REQUIRED_QUALIFICATION_MODULES = [
    'heldOutCorpus.ts',
    'adversarialCases.ts',
    'mobileWebReview.ts',
    'finalPackage.ts',
    'terminalInventory.ts',
  ] as const;

  const ALLOWED_QUALIFICATION_TARGETS = [
    'qualification/',
    'domain/',
    'evaluation/',
    'routing/',
    'worker/',
    'controlapi/',
    'proofs/',
  ] as const;

  function isAllowedQualificationImport(
    fromFile: string,
    spec: string,
  ): boolean {
    if (spec.startsWith('node:')) {
      // Allowlisted L2 render/browser fixture entrypoints may need node builtins
      // under the L2 multi-guard. Slice 3 keeps render assertions in test/.
      return false;
    }
    if (!spec.startsWith('.')) {
      return false;
    }
    const resolved = resolve(fromFile, '..', spec);
    const rel = relative(SRC, resolved).replace(/\\/g, '/');
    const normalized = rel.replace(/\.js$/, '');
    return ALLOWED_QUALIFICATION_TARGETS.some(
      (prefix) =>
        normalized === prefix.slice(0, -1) ||
        normalized.startsWith(prefix) ||
        rel.startsWith(prefix),
    );
  }

  it('requires the slice 1–3 qualification harness modules', () => {
    expect(existsSync(QUALIFICATION)).toBe(true);
    for (const name of REQUIRED_QUALIFICATION_MODULES) {
      expect(existsSync(join(QUALIFICATION, name))).toBe(true);
    }
  });

  it('restricts src/qualification imports to domain + allowlisted engines + proofs', () => {
    if (!existsSync(QUALIFICATION)) {
      return;
    }
    const violations: string[] = [];
    for (const path of sourceFiles(QUALIFICATION)) {
      const local = relative(ROOT, path);
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (!isAllowedQualificationImport(path, spec)) {
          violations.push(`${local}: forbidden import ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('forbids production paths from importing src/qualification', () => {
    if (!existsSync(QUALIFICATION)) {
      return;
    }
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      if (local.startsWith('src/qualification/')) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (
          /(^|\/)qualification(\/|$)/.test(spec) &&
          (spec.includes('qualification/') || spec.endsWith('/qualification'))
        ) {
          violations.push(`${local}: imports qualification via ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('forbids domain/qualification and src/qualification from importing the state store', () => {
    const paths = [
      join(DOMAIN, 'qualification.ts'),
      ...sourceFiles(QUALIFICATION),
    ];
    const violations: string[] = [];
    for (const path of paths) {
      if (!existsSync(path)) {
        continue;
      }
      const local = relative(ROOT, path);
      const source = readFileSync(path, 'utf8');
      for (const spec of importSpecsFromSource(source)) {
        if (
          /control\/state|sqliteStateStore|stateStore/.test(spec) ||
          spec.includes('better-sqlite3')
        ) {
          violations.push(`${local}: imports state store via ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
