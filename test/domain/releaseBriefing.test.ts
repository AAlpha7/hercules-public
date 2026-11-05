/**
 * Promote briefing pure helpers — trust chain, range risk, area/size,
 * evidence coverage, rollback preview (release-8).
 */
import { describe, it, expect } from 'vitest';
import {
  resolveMergedVia,
  isMergeServiceCommitSubject,
  formatTrustChainStatement,
  classifyDiffSize,
  classifyTopLevelAreas,
  primaryAreaChip,
  findSensitivePaths,
  parseGitNumstat,
  parseGitShortstat,
  aggregateRangeRisk,
  parseEvidenceCoverageFromPacket,
  buildRollbackPreview,
  enrichAheadTask,
  buildReleaseDigest,
  emptyRelease,
  type Release,
} from '../../src/domain/release.js';

const PROD = 'cccccccccccccccccccccccccccccccccccccccc';
const AT = '2026-07-17T12:00:00.000Z';

describe('resolveMergedVia / merge-service subject', () => {
  it('treats explicit gate stamp as gate', () => {
    expect(resolveMergedVia({ mergedVia: 'gate' })).toBe('gate');
    expect(resolveMergedVia({ mergedVia: 'gate', commitSubject: 'manual' })).toBe('gate');
  });

  it('treats explicit operator stamp as operator even if subject looks like gate', () => {
    expect(
      resolveMergedVia({
        mergedVia: 'operator',
        commitSubject: 'hercules: merge t1 — title',
      }),
    ).toBe('operator');
  });

  it('detects merge-service commit subjects when stamp is absent', () => {
    expect(isMergeServiceCommitSubject('hercules: merge release-3 — Safe batch')).toBe(true);
    expect(isMergeServiceCommitSubject('hercules: merge app [a, b] → deadbeef')).toBe(true);
    expect(isMergeServiceCommitSubject('Merge pull request #12')).toBe(false);
    expect(resolveMergedVia({ commitSubject: 'hercules: merge t1 — x' })).toBe('gate');
  });

  it('treats absent stamp + non-gate subject as operator (legacy / backfill)', () => {
    expect(resolveMergedVia({})).toBe('operator');
    expect(resolveMergedVia({ commitSubject: null })).toBe('operator');
    expect(resolveMergedVia({ commitSubject: 'operator cherry-pick' })).toBe('operator');
  });
});

describe('formatTrustChainStatement', () => {
  it('states full trust when every change used the merge gate', () => {
    const s = formatTrustChainStatement({ changeCount: 3, operatorMergedIds: [] });
    expect(s).toContain('3 changes');
    expect(s).toMatch(/L1.?L5|L1–L5/);
    expect(s).toMatch(/Approve/i);
    expect(s).toMatch(/merge gate/i);
    expect(s).not.toMatch(/operator-merged/i);
  });

  it('marks operator-merged exceptions honestly', () => {
    const s = formatTrustChainStatement({
      changeCount: 2,
      operatorMergedIds: ['legacy-1'],
    });
    expect(s).toContain('2 changes');
    expect(s).toMatch(/operator-merged/i);
    expect(s).toContain('legacy-1');
  });

  it('singularizes one change', () => {
    expect(formatTrustChainStatement({ changeCount: 1, operatorMergedIds: [] })).toContain(
      '1 change',
    );
  });
});

describe('area + size classification', () => {
  it('classifies S/M/L by total lines changed', () => {
    expect(classifyDiffSize(0)).toBe('S');
    expect(classifyDiffSize(50)).toBe('S');
    expect(classifyDiffSize(51)).toBe('M');
    expect(classifyDiffSize(250)).toBe('M');
    expect(classifyDiffSize(251)).toBe('L');
  });

  it('breaks down known top-level areas and ignores unmatched roots', () => {
    const areas = classifyTopLevelAreas([
      'src/orchestrator/actions.ts',
      'src/orchestrator/mergeService.ts',
      'src/web/ReleasesPanel.tsx',
      'scripts/deploy-staging.sh',
      'docs/deploy.md',
      'test/domain/release.test.ts',
      'src/isolation/worktree.ts',
      'README.md',
    ]);
    expect(areas).toEqual(
      expect.arrayContaining([
        { area: 'src/orchestrator', count: 2 },
        { area: 'src/web', count: 1 },
        { area: 'scripts/', count: 1 },
        { area: 'docs/', count: 1 },
        { area: 'test/', count: 1 },
        { area: 'src/isolation', count: 1 },
      ]),
    );
    expect(areas.every((a) => a.area !== ('README.md' as never))).toBe(true);
    expect(areas.reduce((n, a) => n + a.count, 0)).toBe(7); // README excluded
  });

  it('picks the primary area chip by highest file count', () => {
    expect(
      primaryAreaChip([
        'src/web/a.tsx',
        'src/web/b.tsx',
        'src/orchestrator/x.ts',
      ]),
    ).toBe('src/web');
    expect(primaryAreaChip(['README.md'])).toBeNull();
  });

  it('flags sensitive paths from git name-only (not task body)', () => {
    const hits = findSensitivePaths([
      'scripts/deploy-staging.sh',
      'scripts/e2e-open-pr.mjs',
      'WORKFLOW.md',
      'src/server/selfUpdate.ts',
      'src/server/api.ts',
      'docs/protected_paths/note.md',
    ]);
    expect(hits).toEqual(
      expect.arrayContaining([
        'scripts/deploy-staging.sh',
        'WORKFLOW.md',
        'src/server/selfUpdate.ts',
        'docs/protected_paths/note.md',
      ]),
    );
    expect(hits).not.toContain('scripts/e2e-open-pr.mjs');
    expect(hits).not.toContain('src/server/api.ts');
  });
});

describe('git numstat / shortstat pure parsers', () => {
  it('parses numstat into files + insertions/deletions', () => {
    const raw = [
      '10\t2\tsrc/web/a.tsx',
      '0\t5\tscripts/deploy-production.sh',
      '-\t-\tassets/logo.png',
      '',
    ].join('\n');
    const p = parseGitNumstat(raw);
    expect(p.files).toEqual([
      'src/web/a.tsx',
      'scripts/deploy-production.sh',
      'assets/logo.png',
    ]);
    expect(p.insertions).toBe(10);
    expect(p.deletions).toBe(7);
    expect(p.filesChanged).toBe(3);
  });

  it('parses shortstat summary line', () => {
    expect(parseGitShortstat(' 3 files changed, 10 insertions(+), 2 deletions(-)')).toEqual({
      filesChanged: 3,
      insertions: 10,
      deletions: 2,
    });
    expect(parseGitShortstat(' 1 file changed, 4 insertions(+)')).toEqual({
      filesChanged: 1,
      insertions: 4,
      deletions: 0,
    });
    expect(parseGitShortstat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });
});

describe('aggregateRangeRisk', () => {
  it('combines stat + areas + sensitive highlight', () => {
    const risk = aggregateRangeRisk({
      files: [
        'src/orchestrator/a.ts',
        'scripts/deploy-staging.sh',
        'src/web/b.tsx',
      ],
      insertions: 40,
      deletions: 10,
    });
    expect(risk.filesChanged).toBe(3);
    expect(risk.insertions).toBe(40);
    expect(risk.deletions).toBe(10);
    expect(risk.size).toBe('S'); // 40+10 = 50 → S
    expect(risk.areas.map((a) => a.area)).toEqual(
      expect.arrayContaining(['src/orchestrator', 'scripts/', 'src/web']),
    );
    expect(risk.sensitivePaths).toEqual(['scripts/deploy-staging.sh']);
  });
});

describe('parseEvidenceCoverageFromPacket', () => {
  it('counts ✓/✗ evidence step lines and builds n/n label', () => {
    const body = `## Release packet

### Evidence

- **ok:** yes
- ✓ unlock: injected
- ✓ screenshot shell: ok
- ✓ click [data-evidence=nav-settings]: ok
- ✗ assert sel: missing
`;
    const cov = parseEvidenceCoverageFromPacket(body);
    expect(cov).toEqual({
      passed: 3,
      total: 4,
      label: '3/4 steps',
      evidenceOk: true,
    });
  });

  it('returns null when evidence section is absent', () => {
    expect(parseEvidenceCoverageFromPacket('## Release packet\n\nnope\n')).toBeNull();
  });
});

describe('buildRollbackPreview', () => {
  it('surfaces known-good sha + deployed_at when present', () => {
    const r: Release = {
      ...emptyRelease('app'),
      productionSha: PROD,
      productionDeployedAt: AT,
      history: [{ sha: PROD, at: AT, outcome: 'ok' }],
    };
    const p = buildRollbackPreview(r);
    expect(p.hasTarget).toBe(true);
    expect(p.targetSha).toBe(PROD);
    expect(p.deployedAt).toBe(AT);
  });

  it('warns when first promote has no rollback target', () => {
    const p = buildRollbackPreview(emptyRelease('app'));
    expect(p.hasTarget).toBe(false);
    expect(p.targetSha).toBeNull();
    expect(p.deployedAt).toBeNull();
  });
});

describe('enrichAheadTask', () => {
  it('attaches area chip, size chip, and mergedVia', () => {
    const t = enrichAheadTask({
      id: 't1',
      title: 'One',
      mergedSha: 'a'.repeat(40),
      files: ['src/web/ReleasesPanel.tsx', 'src/web/api.ts'],
      insertions: 80,
      deletions: 20,
      mergedViaStamp: 'gate',
      commitSubject: null,
    });
    expect(t.area).toBe('src/web');
    expect(t.size).toBe('M');
    expect(t.mergedVia).toBe('gate');
  });

  it('marks operator-merged when stamp/subject missing', () => {
    const t = enrichAheadTask({
      id: 'legacy',
      title: 'Backfill',
      mergedSha: 'b'.repeat(40),
      files: [],
      insertions: 0,
      deletions: 0,
      mergedViaStamp: null,
      commitSubject: 'manual merge',
    });
    expect(t.mergedVia).toBe('operator');
    expect(t.area).toBeNull();
    expect(t.size).toBe('S');
  });
});

describe('aheadTask verified flag', () => {
  it('marks verified when the task carries a verified SHA', () => {
    const t = enrichAheadTask({
      id: 't1',
      title: 'One',
      mergedSha: 'a'.repeat(40),
      files: [],
      insertions: 0,
      deletions: 0,
      mergedViaStamp: 'gate',
      commitSubject: null,
      verifiedSha: 'c'.repeat(40),
    });
    expect(t.verified).toBe(true);
  });

  it('marks unverified for operator-salvaged tasks without verified SHA', () => {
    // Phone Releases question (2026-07-17): a failed-then-salvaged task showed
    // in the release with a failing packet — the row must say it never passed
    // machine verification instead of looking like every other row.
    const t = enrichAheadTask({
      id: 'salvaged',
      title: 'Docs salvage',
      mergedSha: 'b'.repeat(40),
      files: [],
      insertions: 0,
      deletions: 0,
      mergedViaStamp: null,
      commitSubject: 'manual merge',
      verifiedSha: null,
    });
    expect(t.verified).toBe(false);
    expect(t.mergedVia).toBe('operator');
  });
});

describe('trust chain with unverified tasks', () => {
  it('never claims every change passed verification when salvaged tasks are aboard', () => {
    const s = formatTrustChainStatement({
      changeCount: 3,
      operatorMergedIds: ['a', 'b', 'c'],
      unverifiedIds: ['c'],
    });
    expect(s).not.toMatch(/every one passed/);
    expect(s).toContain('2 passed');
    expect(s).toContain('no recorded machine verification');
    expect(s).toContain('c');
  });

  it('keeps the strong claim when all changes are verified', () => {
    const s = formatTrustChainStatement({
      changeCount: 2,
      operatorMergedIds: [],
      unverifiedIds: [],
    });
    expect(s).toMatch(/every one passed/);
  });
});

describe('buildReleaseDigest', () => {
  const brief = (over: Record<string, unknown>) => ({
    id: 'x',
    title: 'T',
    mergedSha: 'a'.repeat(40),
    area: null,
    size: 'S',
    mergedVia: 'gate',
    verified: true,
    ...over,
  });

  it('counts changes per area and picks the largest changes as headlines', () => {
    const d = buildReleaseDigest([
      brief({ id: 'w1', title: 'Phone releases panel', area: 'src/web', size: 'L' }),
      brief({ id: 'w2', title: 'Voice dock polish', area: 'src/web', size: 'S' }),
      brief({ id: 'o1', title: 'Stall-safe gates', area: 'src/orchestrator', size: 'M' }),
      brief({ id: 'd1', title: 'Deploy runbook', area: 'docs/', size: 'S' }),
    ] as never);
    expect(d.areaCounts).toEqual([
      { area: 'src/web', count: 2 },
      { area: 'src/orchestrator', count: 1 },
      { area: 'docs/', count: 1 },
    ]);
    // Largest first; capped.
    expect(d.headlines[0]).toBe('Phone releases panel');
    expect(d.headlines).toContain('Stall-safe gates');
  });

  it('caps headlines and skips nothing when fewer than the cap', () => {
    const d = buildReleaseDigest(
      Array.from({ length: 8 }, (_, i) =>
        brief({ id: `t${i}`, title: `Change ${i}`, size: 'L' }),
      ) as never,
    );
    expect(d.headlines.length).toBeLessThanOrEqual(4);
  });
});

describe('primaryAreaChip business preference', () => {
  it('prefers the source area over a larger accompanying test count', () => {
    // A feature lands with 1 src file + 3 test files — business-wise it is a
    // src change; tests are supporting evidence (digest skew 2026-07-17).
    expect(
      primaryAreaChip([
        'src/web/App.tsx',
        'test/web/a.test.ts',
        'test/web/b.test.ts',
        'test/web/c.test.ts',
      ]),
    ).toBe('src/web');
  });

  it('still reports test/ or docs/ when nothing else changed', () => {
    expect(primaryAreaChip(['test/web/a.test.ts'])).toBe('test/');
    expect(primaryAreaChip(['docs/x.md', 'test/y.test.ts', 'docs/z.md'])).toBe('docs/');
  });
});
