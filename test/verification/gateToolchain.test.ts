import { describe, it, expect } from 'vitest';
import { scanGateToolchain } from '../../src/verification/gateToolchain.js';
import { cheatSeverity, isCriticalCheatKind } from '../../src/domain/verification.js';
import {
  assembleReviewPacket,
  renderPacketMarkdown,
} from '../../src/verification/packet.js';
import type { GateResult, ReviewerVerdict } from '../../src/domain/verification.js';
import { parseDefinitionOfDone } from '../../src/domain/acceptance.js';

const TRUSTED_PKG = JSON.stringify(
  {
    scripts: {
      typecheck: 'tsc --noEmit',
      lint: 'eslint .',
      test: 'vitest run',
      build: 'tsc -p tsconfig.build.json',
      'test:spa-smoke': 'vitest run --config vitest.spa-smoke.config.ts',
      'check:full':
        'pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:spa-smoke',
      'dev:web': 'vite',
    },
  },
  null,
  2,
);

const GATE_COMMANDS = [
  'pnpm install --frozen-lockfile',
  'pnpm typecheck',
  'pnpm lint',
  'pnpm test',
  'pnpm build',
  'pnpm exec vitest run test/invariants --config vitest.unit.config.ts',
];

function unifiedDiff(files: ReadonlyArray<{ path: string; body: string }>): string {
  const parts: string[] = [];
  for (const f of files) {
    parts.push(`diff --git a/${f.path} b/${f.path}`);
    parts.push(`--- a/${f.path}`);
    parts.push(`+++ b/${f.path}`);
    parts.push('@@ -1,1 +1,2 @@');
    parts.push(` ${f.body}`);
    parts.push(`+changed`);
  }
  return parts.join('\n');
}

describe('scanGateToolchain', () => {
  it('builds closure through pnpm check:full-style chains', () => {
    const report = scanGateToolchain({
      diff: '',
      gateCommands: ['pnpm check:full'],
      trustedPackageJson: TRUSTED_PKG,
      candidatePackageJson: TRUSTED_PKG,
    });
    expect(report.scriptClosure).toContain('check:full');
    expect(report.scriptClosure).toContain('typecheck');
    expect(report.scriptClosure).toContain('lint');
    expect(report.scriptClosure).toContain('test');
    expect(report.scriptClosure).toContain('build');
    expect(report.scriptClosure).toContain('test:spa-smoke');
    expect(report.scriptClosure).not.toContain('dev:web');
    expect(report.resolvedFiles).toContain('vitest.spa-smoke.config.ts');
    expect(report.findings).toEqual([]);
  });

  it('2026-09-01 case: typecheck rewritten + sync script added → package.json + script findings', () => {
    const candidatePkg = JSON.stringify(
      {
        scripts: {
          typecheck:
            'node scripts/sync-workflow-blob-sha.mjs && tsc --noEmit',
          lint: 'eslint .',
          test: 'vitest run',
          build: 'tsc -p tsconfig.build.json',
          'test:spa-smoke': 'vitest run --config vitest.spa-smoke.config.ts',
          'check:full':
            'pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:spa-smoke',
          'dev:web': 'vite',
        },
      },
      null,
      2,
    );
    const diff = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,5 +1,5 @@',
      '-    "typecheck": "tsc --noEmit",',
      '+    "typecheck": "node scripts/sync-workflow-blob-sha.mjs && tsc --noEmit",',
      'diff --git a/scripts/sync-workflow-blob-sha.mjs b/scripts/sync-workflow-blob-sha.mjs',
      '--- /dev/null',
      '+++ b/scripts/sync-workflow-blob-sha.mjs',
      '@@ -0,0 +1,3 @@',
      '+#!/usr/bin/env node',
      '+console.log("sync");',
      '+',
    ].join('\n');

    const report = scanGateToolchain({
      diff,
      gateCommands: GATE_COMMANDS,
      trustedPackageJson: TRUSTED_PKG,
      candidatePackageJson: candidatePkg,
    });

    const pkgFindings = report.findings.filter((f) => f.file === 'package.json');
    const scriptFindings = report.findings.filter(
      (f) => f.file === 'scripts/sync-workflow-blob-sha.mjs',
    );
    expect(pkgFindings).toHaveLength(1);
    expect(pkgFindings[0]!.detail).toMatch(
      /package\.json script "typecheck" changed:.*sync-workflow-blob-sha/,
    );
    expect(scriptFindings).toHaveLength(1);
    expect(scriptFindings[0]!.detail).toBe(
      'edits gate-invoked script scripts/sync-workflow-blob-sha.mjs',
    );
    expect(report.findings.every((f) => f.kind === 'gate-toolchain-edit')).toBe(true);
    expect(report.resolvedFiles).toContain('scripts/sync-workflow-blob-sha.mjs');
  });

  it('vitest config edit → finding', () => {
    const diff = unifiedDiff([
      { path: 'vitest.config.ts', body: 'export default {}' },
    ]);
    const report = scanGateToolchain({
      diff,
      gateCommands: GATE_COMMANDS,
      trustedPackageJson: TRUSTED_PKG,
      candidatePackageJson: TRUSTED_PKG,
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toEqual({
      kind: 'gate-toolchain-edit',
      file: 'vitest.config.ts',
      detail: 'edits gate-resolved config vitest.config.ts',
    });
  });

  it('package.json change touching only dependencies → no finding', () => {
    const candidatePkg = JSON.stringify(
      {
        scripts: JSON.parse(TRUSTED_PKG).scripts,
        dependencies: { leftpad: '1.0.0' },
      },
      null,
      2,
    );
    const diff = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -20,0 +21,3 @@',
      '+  "dependencies": {',
      '+    "leftpad": "1.0.0"',
      '+  }',
    ].join('\n');
    const report = scanGateToolchain({
      diff,
      gateCommands: GATE_COMMANDS,
      trustedPackageJson: TRUSTED_PKG,
      candidatePackageJson: candidatePkg,
    });
    expect(report.findings).toEqual([]);
  });

  it('npm test resolves the test script (lifecycle shorthand)', () => {
    const report = scanGateToolchain({
      diff: '',
      gateCommands: ['npm test'],
      trustedPackageJson: TRUSTED_PKG,
      candidatePackageJson: TRUSTED_PKG,
    });
    expect(report.scriptClosure).toEqual(['test']);
  });

  it('unparsable candidate JSON → one finding naming the closure scripts', () => {
    const report = scanGateToolchain({
      diff: [
        'diff --git a/package.json b/package.json',
        '--- a/package.json',
        '+++ b/package.json',
        '@@ -1 +1 @@',
        '-{}',
        '+NOT JSON {{{',
      ].join('\n'),
      gateCommands: ['pnpm typecheck', 'pnpm lint'],
      trustedPackageJson: TRUSTED_PKG,
      candidatePackageJson: 'NOT JSON {{{',
    });
    expect(report.scriptClosure.length).toBeGreaterThan(0);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      kind: 'gate-toolchain-edit',
      file: 'package.json',
    });
    expect(report.findings[0]!.detail).toMatch(/^package\.json unparsable on candidate — gate scripts \(typecheck, lint\)/);
  });

  it('no-diff → no findings', () => {
    const report = scanGateToolchain({
      diff: '',
      gateCommands: GATE_COMMANDS,
      trustedPackageJson: TRUSTED_PKG,
      candidatePackageJson: TRUSTED_PKG,
    });
    expect(report.findings).toEqual([]);
  });

  it('gate-toolchain-edit is review severity, not critical', () => {
    expect(isCriticalCheatKind('gate-toolchain-edit')).toBe(false);
    expect(cheatSeverity('gate-toolchain-edit')).toBe('review');
  });
});

describe('assembleReviewPacket + gate-toolchain-edit', () => {
  const gatesPass: GateResult[] = [
    { name: 'typecheck', command: 'pnpm typecheck', passed: true, output: '' },
    { name: 'test', command: 'pnpm test', passed: true, output: '' },
  ];
  const approved: ReviewerVerdict = {
    approved: true,
    summary: 'ok',
    comments: [],
  };
  const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) gates green @gate:all
- [ ] (reviewer) spirit
- [ ] (human) ship
`);

  it('finding present → green false, mechanical pending, block rendered, no autoRework', () => {
    const packet = assembleReviewPacket({
      taskId: 'T-toolchain',
      branch: 'hercules/T-toolchain',
      filesTouched: ['package.json', 'scripts/sync-workflow-blob-sha.mjs'],
      diffSummary: '2 files changed',
      diff: '+x',
      gates: gatesPass,
      cheatFindings: [
        {
          kind: 'gate-toolchain-edit',
          file: 'package.json',
          detail:
            'package.json script "typecheck" changed: "tsc --noEmit" → "node scripts/sync-workflow-blob-sha.mjs && tsc --noEmit"',
        },
        {
          kind: 'gate-toolchain-edit',
          file: 'scripts/sync-workflow-blob-sha.mjs',
          detail: 'edits gate-invoked script scripts/sync-workflow-blob-sha.mjs',
        },
      ],
      screenshots: [],
      reviewerVerdict: approved,
      reviewerRan: true,
      selfAssessment: 'rewrote typecheck',
      finalReport: 'done',
      dod,
    });

    expect(packet.green).toBe(false);
    expect(packet.dod.mechanical).toBe('pending');
    expect(packet.autoRework).toBe(false);
    expect(packet.dod.warnings.some((w) => /gate toolchain edited/i.test(w))).toBe(
      true,
    );

    const md = renderPacketMarkdown(packet);
    expect(md).toContain('**Gate toolchain edited (human review required)**');
    expect(md).toContain('package.json:');
    expect(md).toContain('scripts/sync-workflow-blob-sha.mjs:');
    expect(md).toMatch(/mechanical.*pending|`pending`/);
  });
});
