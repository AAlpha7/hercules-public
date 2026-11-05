import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = join(ROOT, 'src');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (['.ts', '.tsx'].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

describe('M4/M5 state-store boundary', () => {
  it('keeps SQLite and concrete stores inside the state-store implementation boundary', () => {
    const sqliteImplementations = new Set([
      'src/control/state/sqliteStateStore.ts',
      'src/control/state/sqliteArtifactMetadataStore.ts',
    ]);
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      const source = readFileSync(path, 'utf8');
      if (source.includes("from 'better-sqlite3'")) {
        if (!sqliteImplementations.has(local)) violations.push(`${local}: sqlite`);
      }
      if (/from ['"].*control\/state\/sqliteStateStore\.js['"]/.test(source)) {
        if (local !== 'src/main.ts' && local !== 'src/control/state/sqliteArtifactMetadataStore.ts') {
          violations.push(`${local}: concrete-store-import`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('constructs shadow state only behind the explicit paired M4 configuration', () => {
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    expect(main).toContain("env['HERCULES_V2_SHADOW_ROOT']");
    expect(main).toContain("env['HERCULES_V2_SHADOW_DATABASE']");
    expect(main).toContain('shadowStore === null\n    ? new GitControlPort(controlRepoDir)');
  });

  it('never fabricates retirement from a startup snapshot omission', () => {
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    expect(main).not.toContain('shadowStore.listTaskIds().filter');
    expect(main).toContain('retiredTaskIds: []');
  });

  it('keeps store, reconciler, paths, and reports out of untrusted runtime layers', () => {
    const forbiddenRoots = [
      'src/adapters/', 'src/server/', 'src/web/', 'src/sessions/', 'src/verification/',
      'src/isolation/', 'src/mcp/',
    ];
    const needles = [
      'SqliteStateStore', 'shadowReconciler', 'ShadowReconciliationReport',
      'HERCULES_V2_SHADOW_ROOT', 'HERCULES_V2_SHADOW_DATABASE',
      'ArtifactEvidenceArchive', 'openArtifactEvidenceArchive',
      'SqliteArtifactMetadataStore', 'FilesystemArtifactStore',
    ];
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      if (!forbiddenRoots.some((root) => local.startsWith(root))) continue;
      const source = readFileSync(path, 'utf8');
      for (const needle of needles) {
        if (source.includes(needle)) violations.push(`${local}: ${needle}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps M5 construction and concrete archive ports inside the private coordinator', () => {
    const rules = [
      {
        needle: 'new SqliteArtifactMetadataStore',
        allowed: new Set(['src/control/artifacts/evidenceArchive.ts']),
      },
      {
        needle: 'openFilesystemArtifactStore(',
        allowed: new Set([
          'src/control/artifacts/evidenceArchive.ts',
          'src/control/artifacts/filesystemArtifactStore.ts',
        ]),
      },
      {
        needle: 'openFilesystemArchiveAnchorStore(',
        allowed: new Set([
          'src/control/artifacts/evidenceArchive.ts',
          'src/control/artifacts/archiveAnchor.ts',
        ]),
      },
      {
        needle: 'publishArtifactExport(',
        allowed: new Set([
          'src/control/artifacts/evidenceArchive.ts',
          'src/control/artifacts/archiveExport.ts',
        ]),
      },
    ];
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      const source = readFileSync(path, 'utf8');
      for (const rule of rules) {
        if (source.includes(rule.needle) && !rule.allowed.has(local)) {
          violations.push(`${local}: ${rule.needle}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps direct V3 metadata capabilities inside the archive and SQLite boundaries', () => {
    const allowed = new Set([
      'src/control/artifacts/archiveExport.ts',
      'src/control/artifacts/evidenceArchive.ts',
      'src/control/state/artifactMetadataValidation.ts',
      'src/control/state/sqliteArtifactMetadataStore.ts',
    ]);
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      const source = readFileSync(path, 'utf8');
      if (source.includes('/artifactMetadataStore.js') && !allowed.has(local)) {
        violations.push(`${local}: direct-v3-metadata-port`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('mechanically binds all four task-writing commitPaths seams to outbox preparation', () => {
    const source = readFileSync(join(SRC, 'orchestrator', 'gitControlPort.ts'), 'utf8');
    expect(source.match(/this\.git\.commitPaths\(/g)).toHaveLength(4);
    expect(source.match(/await this\.prepareShadow\(/g)).toHaveLength(4);
  });

  it('keeps Control API V2 engine and clients free of the concrete SQLite state store', () => {
    const scopedRoots = [
      'src/controlapi/',
      'src/client/',
      'src/web/controlApiV2Client.ts',
      'src/isolation/controlApiV2FakeProvider.ts',
      'src/server/api.ts',
    ];
    const forbidden = [
      'control/state/',
      'SqliteStateStore',
      'sqliteStateStore',
      "from 'better-sqlite3'",
    ];
    const violations: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const local = relative(ROOT, path);
      if (
        !scopedRoots.some(
          (root) => local === root || local.startsWith(root),
        )
      ) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      for (const needle of forbidden) {
        if (source.includes(needle)) {
          violations.push(`${local}: ${needle}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps M12 capability-proof domain and harness free of the concrete SQLite state store', () => {
    const scopedPaths = [
      'src/domain/capabilityProof.ts',
      ...(existsSync(join(SRC, 'proofs'))
        ? sourceFiles(join(SRC, 'proofs')).map((path) => relative(ROOT, path))
        : []),
    ];
    const forbidden = [
      'control/state/',
      'SqliteStateStore',
      'sqliteStateStore',
      "from 'better-sqlite3'",
    ];
    const violations: string[] = [];
    for (const local of scopedPaths) {
      const source = readFileSync(join(ROOT, local), 'utf8');
      for (const needle of forbidden) {
        if (source.includes(needle)) {
          violations.push(`${local}: ${needle}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('keeps M13 qualification domain free of the concrete SQLite state store', () => {
    const scopedPaths = [
      'src/domain/qualification.ts',
      ...(existsSync(join(SRC, 'qualification'))
        ? sourceFiles(join(SRC, 'qualification')).map((path) =>
            relative(ROOT, path),
          )
        : []),
    ];
    const forbidden = [
      'control/state/',
      'SqliteStateStore',
      'sqliteStateStore',
      "from 'better-sqlite3'",
    ];
    const violations: string[] = [];
    for (const local of scopedPaths) {
      const source = readFileSync(join(ROOT, local), 'utf8');
      for (const needle of forbidden) {
        if (source.includes(needle)) {
          violations.push(`${local}: ${needle}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
