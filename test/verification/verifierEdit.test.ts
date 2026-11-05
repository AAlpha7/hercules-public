import { describe, it, expect } from 'vitest';
import { DEFAULT_VERIFIER_PATHS, scanDiff } from '../../src/verification/antiCheat.js';
import { cheatSeverity, isCriticalCheatKind } from '../../src/domain/verification.js';
import type { GateResult, ReviewerVerdict } from '../../src/domain/verification.js';
import { reviewOnlyFlagMeaningZh } from '../../src/domain/decisionCard.js';
import { parseDefinitionOfDone } from '../../src/domain/acceptance.js';
import {
  assembleReviewPacket,
  renderPacketMarkdown,
} from '../../src/verification/packet.js';

function editDiff(file: string): string {
  return `diff --git a/${file} b/${file}
--- a/${file}
+++ b/${file}
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;
}

describe('scanDiff — verifier-edit (L5, review-only)', () => {
  it.each([
    'src/verification/antiCheat.ts',
    'src/verification/testIntegrity.ts',
    'src/orchestrator/verifier.ts',
    'src/domain/verification.ts',
    'src/domain/evidence.ts',
    'src/domain/mechProof.ts',
    'src/domain/acceptance.ts',
    'src/domain/acceptanceLint.ts',
  ])('flags an edit to %s once per file', (file) => {
    const found = scanDiff(editDiff(file)).filter((f) => f.kind === 'verifier-edit');
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe(file);
    expect(found[0]?.detail).toMatch(/every later task/i);
  });

  it('does not flag ordinary source, tests of the verifier, or docs', () => {
    for (const file of [
      'src/web/TaskDetail.tsx',
      'src/domain/salvage.ts',
      'test/verification/antiCheat.test.ts',
      'docs/autonomy/acceptance-binding-grammar.md',
    ]) {
      expect(scanDiff(editDiff(file)).map((f) => f.kind)).not.toContain('verifier-edit');
    }
  });

  it('protected-path wins over verifier-edit for the same file (one flag per file)', () => {
    const kinds = scanDiff(editDiff('src/verification/antiCheat.ts'), {
      protectedPaths: ['src/verification/**'],
    }).map((f) => f.kind);
    expect(kinds).toContain('protected-path');
    expect(kinds).not.toContain('verifier-edit');
  });

  it('honours an explicit verifierPaths override', () => {
    const kinds = scanDiff(editDiff('lib/judge.ts'), { verifierPaths: ['lib/judge.ts'] }).map(
      (f) => f.kind,
    );
    expect(kinds).toContain('verifier-edit');
    expect(
      scanDiff(editDiff('src/verification/antiCheat.ts'), { verifierPaths: [] }).map(
        (f) => f.kind,
      ),
    ).not.toContain('verifier-edit');
  });

  it('is review severity (human queue), never critical / auto-rework', () => {
    expect(cheatSeverity('verifier-edit')).toBe('review');
    expect(isCriticalCheatKind('verifier-edit')).toBe(false);
    expect(reviewOnlyFlagMeaningZh('verifier-edit')).toMatch(/验证器/);
    expect(DEFAULT_VERIFIER_PATHS).toContain('src/verification/**');
  });
});

describe('assembleReviewPacket + verifier-edit', () => {
  const gatesPass: GateResult[] = [
    { name: 'typecheck', command: 'pnpm typecheck', passed: true, output: '' },
    { name: 'test', command: 'pnpm test', passed: true, output: '' },
  ];
  const approved: ReviewerVerdict = { approved: true, summary: 'ok', comments: [] };
  const dod = parseDefinitionOfDone(`
## Acceptance criteria
- [ ] (mechanical) gates green @gate:all
- [ ] (reviewer) spirit
- [ ] (human) ship
`);

  it('renders the verifier block, keeps mechanical green, and never auto-reworks', () => {
    const packet = assembleReviewPacket({
      taskId: 'T-verifier',
      branch: 'hercules/T-verifier',
      filesTouched: ['src/domain/evidence.ts'],
      diffSummary: '1 file changed',
      diff: '+x',
      gates: gatesPass,
      cheatFindings: [
        {
          kind: 'verifier-edit',
          file: 'src/domain/evidence.ts',
          detail: 'edits verifier/acceptance source',
        },
      ],
      screenshots: [],
      reviewerVerdict: approved,
      reviewerRan: true,
      selfAssessment: 'tightened hook parsing',
      finalReport: 'done',
      dod,
    });
    expect(packet.autoRework).toBe(false);
    // This run was judged by the released daemon, so the mechanical axis stays honest.
    expect(packet.dod.mechanical).toBe('pass');
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('**Verifier source edited (read the diff before merge)**');
    expect(md).toContain('- src/domain/evidence.ts');
  });
});
