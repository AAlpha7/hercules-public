import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const REVIEW_PACKAGE_MODULE = join(ROOT, 'src/domain/reviewPackageV2.ts');
const API_MODULE = join(ROOT, 'src/server/api.ts');
// Reviewed allowlist for the raw source projector: the server projection site,
// the ISOLATED, fake-only, L2-gated Control API V2 review seed (the isolation
// analog of the trusted projection site — never wired in production), and the
// M12 capability-proof engine chain (a fenced non-production fixture under
// src/proofs/ that drives the real M6 projection over a seeded spine; no
// production path imports src/proofs/, enforced by the proofs architecture fence).
const SOURCE_PROJECTOR_ALLOWLIST = new Set([
  API_MODULE,
  join(ROOT, 'src/isolation/controlApiV2ReviewSeed.ts'),
  join(ROOT, 'src/proofs/engineChain.ts'),
  // C2.3 assembler — the store's refresh seam, the only production projection site besides api.ts
  join(ROOT, 'src/control/reviewPackageSource.ts'),
]);
const SOURCE_PROJECTOR = 'projectAndAssertReviewPackageV2';
const FORBIDDEN_AUTHORITY_IMPORTS = new Set([
  'assertReviewPackageV2StructuralConsistency',
  'projectReviewPackageV2',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(path) ? [path] : [];
  });
}

const compilerOptionsCache = new Map<string, ts.CompilerOptions>();

function compilerOptionsFor(path: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(dirname(path), ts.sys.fileExists);
  if (!configPath) return {};
  const cached = compilerOptionsCache.get(configPath);
  if (cached) return cached;
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) return {};
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
  );
  compilerOptionsCache.set(configPath, parsed.options);
  return parsed.options;
}

function resolvesToReviewPackage(from: string, specifier: string): boolean {
  const resolvedModule = ts.resolveModuleName(
    specifier,
    from,
    compilerOptionsFor(from),
    ts.sys,
  ).resolvedModule;
  return (
    resolvedModule !== undefined &&
    resolve(resolvedModule.resolvedFileName) === REVIEW_PACKAGE_MODULE
  );
}

function authorityImportViolations(path: string, text: string): string[] {
  const violations: string[] = [];
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const report = (kind: string) => {
    violations.push(`${relative(ROOT, path)} ${kind}`);
  };
  const inspect = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      resolvesToReviewPackage(path, node.moduleSpecifier.text)
    ) {
      if (node.importClause?.isTypeOnly) {
        ts.forEachChild(node, inspect);
        return;
      }
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        report('namespace-imports reviewPackageV2');
      } else if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) continue;
          const imported = element.propertyName?.text ?? element.name.text;
          if (FORBIDDEN_AUTHORITY_IMPORTS.has(imported)) {
            report(`imports ${imported}`);
          } else if (
            imported === SOURCE_PROJECTOR &&
            !SOURCE_PROJECTOR_ALLOWLIST.has(path)
          ) {
            report(`imports ${SOURCE_PROJECTOR} outside its reviewed allowlist`);
          }
        }
      }
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      resolvesToReviewPackage(path, node.moduleSpecifier.text)
    ) {
      if (node.isTypeOnly) {
        ts.forEachChild(node, inspect);
        return;
      }
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
        report('re-exports reviewPackageV2 namespace');
      } else {
        for (const element of node.exportClause.elements) {
          if (element.isTypeOnly) continue;
          const exported = element.propertyName?.text ?? element.name.text;
          if (
            FORBIDDEN_AUTHORITY_IMPORTS.has(exported) ||
            exported === SOURCE_PROJECTOR
          ) {
            report(`re-exports ${exported}`);
          }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const specifier = node.arguments[0]!;
      if (!ts.isStringLiteral(specifier)) {
        report('uses a non-literal dynamic import');
      } else if (resolvesToReviewPackage(path, specifier.text)) {
        report('dynamically imports reviewPackageV2');
      }
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  return violations;
}

describe('ReviewPackageV2 authority boundary', () => {
  it('keeps raw DTO projection and structural checks out of outer source layers', () => {
    const violations: string[] = [];
    for (const path of sourceFiles(join(ROOT, 'src'))) {
      if (path === REVIEW_PACKAGE_MODULE) continue;
      violations.push(...authorityImportViolations(path, readFileSync(path, 'utf8')));
    }

    expect(violations).toEqual([]);
  });

  it('detects namespace, sibling, TSX, re-export, and dynamic-import bypasses', () => {
    const cases = [
      [
        join(ROOT, 'src/web/Bypass.tsx'),
        `import * as review from '../domain/reviewPackageV2.js'; void review;`,
      ],
      [
        join(ROOT, 'src/domain/bypass.ts'),
        `import { projectReviewPackageV2 } from './reviewPackageV2.js';`,
      ],
      [
        join(ROOT, 'src/server/bypass.ts'),
        `export * from '../domain/reviewPackageV2.js';`,
      ],
      [
        join(ROOT, 'src/server/bypass.ts'),
        `void import('../domain/reviewPackageV2.js');`,
      ],
      [
        join(ROOT, 'src/orchestrator/bypass.ts'),
        `import { projectAndAssertReviewPackageV2 } from '../domain/reviewPackageV2.js';`,
      ],
      [
        join(ROOT, 'src/web/Bypass.tsx'),
        `import { projectAndAssertReviewPackageV2 } from '../domain/reviewPackageV2';`,
      ],
      [
        join(ROOT, 'src/web/Bypass.tsx'),
        `const modulePath = '../domain/reviewPackageV2.js'; void import(modulePath);`,
      ],
    ] as const;

    for (const [path, source] of cases) {
      expect(authorityImportViolations(path, source)).not.toEqual([]);
    }
  });

  it('routes the authenticated read API through exactly one constructor call', () => {
    const api = ts.createSourceFile(
      API_MODULE,
      readFileSync(API_MODULE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let constructorCalls = 0;
    const inspect = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === SOURCE_PROJECTOR
      ) {
        constructorCalls += 1;
      }
      ts.forEachChild(node, inspect);
    };
    inspect(api);
    expect(constructorCalls).toBe(1);
  });

  it('does not export an API wrapper around the source projector', () => {
    const api = ts.createSourceFile(
      API_MODULE,
      readFileSync(API_MODULE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const exportedProjectorCapabilities: string[] = [];
    for (const statement of api.statements) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      let wrapsProjector = false;
      const inspect = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === SOURCE_PROJECTOR
        ) wrapsProjector = true;
        ts.forEachChild(node, inspect);
      };
      inspect(statement);
      if (wrapsProjector) exportedProjectorCapabilities.push(statement.getText(api));
    }
    expect(exportedProjectorCapabilities).toEqual([]);
  });

  it('does not export the raw projector', () => {
    const domain = ts.createSourceFile(
      REVIEW_PACKAGE_MODULE,
      readFileSync(REVIEW_PACKAGE_MODULE, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const raw = domain.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'projectReviewPackageV2',
    );
    expect(raw).toBeDefined();
    expect(
      Boolean(
        raw?.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        ),
      ),
    ).toBe(false);
  });
});
