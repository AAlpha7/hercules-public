import { describe, it, expect } from 'vitest';
import {
  buildEvidenceMatrix,
  citeEvidenceForCriterion,
} from '../../src/domain/evidenceMatrix.js';

describe('citeEvidenceForCriterion', () => {
  it('finds a bullet that mentions the criterion', () => {
    const sa = `
- tests pass — ran \`pnpm test\` (12 passed)
- looks good pending human
`;
    expect(citeEvidenceForCriterion('tests pass', sa)).toMatch(/pnpm test/i);
  });

  it('returns placeholder when nothing matches', () => {
    expect(citeEvidenceForCriterion('ship UI polish', 'unrelated notes')).toBe(
      '(no evidence cited)',
    );
  });
});

describe('buildEvidenceMatrix', () => {
  it('builds one row per criterion with status and evidence', () => {
    const rows = buildEvidenceMatrix(
      [
        { text: 'gates green', kind: 'mechanical', status: 'pass' },
        { text: 'spirit ok', kind: 'reviewer', status: 'pass' },
        { text: 'ready to ship', kind: 'human', status: 'pending' },
      ],
      '- gates green — tsc + vitest ok\n- spirit ok — L3 approved\n- ready to ship — pending human',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]!.kind).toBe('mechanical');
    expect(rows[0]!.evidence).toMatch(/tsc|vitest/i);
    expect(rows[2]!.status).toBe('pending');
  });

  it('keeps checkpoint as a first-class kind (not folded to human)', () => {
    const rows = buildEvidenceMatrix(
      [{ text: 'before deploy: confirm URL', kind: 'checkpoint', status: 'pending' }],
      '(none)',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('checkpoint');
  });

  it('annotates unproven UI human ACs when plan has no related evidence', () => {
    const rows = buildEvidenceMatrix(
      [
        {
          text: '手机上点黄色跨任务徽章, 一眼看懂为什么黄',
          kind: 'human',
          status: 'pending',
        },
        {
          text: 'Confirm docs are fine',
          kind: 'human',
          status: 'pending',
        },
      ],
      '(none)',
      {
        evidencePlanSteps: [
          { kind: 'unlock', raw: 'unlock' },
          {
            kind: 'screenshot',
            name: 'task-list',
            raw: 'screenshot task-list',
          },
        ],
      },
    );
    expect(rows[0]!.unprovenUiWarning).toMatch(/无对应证据|无法在部署前核验/);
    expect(rows[0]!.unprovenUiReason).toBeTruthy();
    // Non-UI human AC is not flagged
    expect(rows[1]!.unprovenUiWarning).toBeUndefined();
  });

  it('links human @scenario AC to CLI evidence cell and strips the binding', () => {
    const rows = buildEvidenceMatrix(
      [
        {
          text: 'Owner watched the recorded scenario video @scenario:chat-sheet-scroll-lock',
          kind: 'human',
          status: 'pending',
        },
      ],
      '(none)',
      {
        evidencePlanSteps: [{ kind: 'unlock', raw: 'unlock' }],
        cliSteps: [
          {
            id: 'web-console-flow',
            ok: true,
            status: 'passed',
            artifacts: [
              { name: 'a.png', kind: 'image' },
              { name: 'b.png', kind: 'image' },
              { name: 'c.png', kind: 'image' },
              { name: 'd.png', kind: 'image' },
              { name: 'e.png', kind: 'image' },
              { name: 'f.png', kind: 'image' },
              { name: 'flow.webm', kind: 'video' },
            ],
            stdoutTail:
              'hercules-scenario: chat-sheet-scroll-lock surfaces=webapp/src/vnext/**\n',
          },
        ],
      },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe('Owner watched the recorded scenario video');
    expect(rows[0]!.unprovenUiWarning).toBeUndefined();
    expect(rows[0]!.evidence).toBe(
      'CLI 步骤 web-console-flow ✓ · 6 张截图 · 1 段录像',
    );
  });

  it('unchanged behaviour when no CLI steps are provided', () => {
    const rows = buildEvidenceMatrix(
      [
        {
          text: '手机上点黄色跨任务徽章, 一眼看懂为什么黄',
          kind: 'human',
          status: 'pending',
        },
      ],
      '(none)',
      {
        evidencePlanSteps: [{ kind: 'unlock', raw: 'unlock' }],
      },
    );
    expect(rows[0]!.unprovenUiWarning).toMatch(/无对应证据|无法在部署前核验/);
  });
});
