/**
 * Human AC how-to-verify + action patterns: three-source priority,
 * no invented guidance, EN/ZH action matching.
 */
import { describe, it, expect } from 'vitest';
import {
  extractOperatorChecklistSection,
  matchOperatorChecklistPaths,
  extractMentionedPaths,
  matchHumanAcAction,
  resolveHumanAcGuidance,
  isUsefulHumanEvidence,
} from '../../src/domain/humanAcGuidance.js';

describe('extractOperatorChecklistSection', () => {
  it('reads ## Operator checklist until the next ## heading', () => {
    const body = [
      '## Goal',
      'Ship it',
      '',
      '## Operator checklist',
      '1. Open docs/agent/ops.md',
      '2. Confirm the 2-minute entry path',
      '',
      '## Definition of Done',
      '- [ ] (human) Spot-check',
    ].join('\n');
    expect(extractOperatorChecklistSection(body)).toBe(
      '1. Open docs/agent/ops.md\n2. Confirm the 2-minute entry path',
    );
  });

  it('accepts ## 核验指引 (zh)', () => {
    const body = '## 核验指引\n先看 README 入口\n\n## Notes\nx';
    expect(extractOperatorChecklistSection(body)).toBe('先看 README 入口');
  });

  it('returns null when neither heading exists', () => {
    expect(extractOperatorChecklistSection('## Goal\nno checklist')).toBeNull();
  });
});

describe('matchOperatorChecklistPaths', () => {
  it('matches **/operator-checklist*.md and docs/agent/*readiness*checklist*.md', () => {
    const files = [
      'src/main.ts',
      'docs/agent/hercules-readiness-operator-checklist.md',
      'notes/operator-checklist.md',
      'docs/agent/operator-checklist-v2.md',
      'docs/agent/other.md',
      'docs/readiness-checklist.md',
    ];
    expect(matchOperatorChecklistPaths(files)).toEqual([
      'docs/agent/hercules-readiness-operator-checklist.md',
      'notes/operator-checklist.md',
      'docs/agent/operator-checklist-v2.md',
    ]);
  });

  it('returns empty when nothing matches (no inventing)', () => {
    expect(matchOperatorChecklistPaths(['README.md', 'src/a.ts'])).toEqual([]);
  });
});

describe('extractMentionedPaths', () => {
  it('pulls repo-relative .md paths from free text', () => {
    expect(
      extractMentionedPaths(
        'See `docs/agent/hercules-readiness-operator-checklist.md` and AGENTS.md later',
      ),
    ).toEqual(['docs/agent/hercules-readiness-operator-checklist.md']);
  });
});

describe('isUsefulHumanEvidence', () => {
  it('rejects empty / placeholder citations', () => {
    expect(isUsefulHumanEvidence('')).toBe(false);
    expect(isUsefulHumanEvidence('(no evidence cited)')).toBe(false);
    expect(isUsefulHumanEvidence('(agent provided none)')).toBe(false);
    expect(isUsefulHumanEvidence('(human判断)')).toBe(false);
  });

  it('accepts real evidence lines', () => {
    expect(
      isUsefulHumanEvidence(
        'docs/agent/hercules-readiness-operator-checklist.md (76 lines, 2-3 min entry)',
      ),
    ).toBe(true);
  });
});

describe('matchHumanAcAction', () => {
  it('matches EN: set … in Repos UI', () => {
    expect(matchHumanAcAction('Repo readiness set to ready in Repos UI')).toEqual({
      kind: 'mark-ready',
      label: 'Mark ready',
    });
  });

  it('matches EN: mark … ready', () => {
    expect(matchHumanAcAction('Mark ready in Repos')).toEqual({
      kind: 'mark-ready',
      label: 'Mark ready',
    });
    expect(
      matchHumanAcAction(
        'Spot-check README / map / WORKFLOW; **Mark ready** in Repos when trustworthy',
      ),
    ).toEqual({ kind: 'mark-ready', label: 'Mark ready' });
  });

  it('matches ZH: 在 … 界面设置', () => {
    expect(matchHumanAcAction('在 Repos 界面设置仓库为 ready')).toEqual({
      kind: 'mark-ready',
      label: '标记就绪',
    });
  });

  it('returns null for pure judgment items (no action inventing)', () => {
    expect(matchHumanAcAction('Spot-check passed')).toBeNull();
    expect(matchHumanAcAction('Packet evidence trustworthy')).toBeNull();
  });
});

describe('resolveHumanAcGuidance (priority a > b > c)', () => {
  const files = [
    'src/x.ts',
    'docs/agent/hercules-readiness-operator-checklist.md',
  ];

  it('(a) Operator checklist section wins for how; refs include checklist paths', () => {
    const taskBody = [
      '## Operator checklist',
      'Run the 2–3 min entry path in docs/agent/hercules-readiness-operator-checklist.md',
      '',
      '## Definition of Done',
      '- [ ] (human) Spot-check passed',
    ].join('\n');
    const g = resolveHumanAcGuidance({
      criterionText: 'Spot-check passed',
      taskBody,
      evidence: 'ignored when section present',
      files,
    });
    expect(g.how).toMatch(/2–3 min entry path/);
    expect(g.refs).toContain('docs/agent/hercules-readiness-operator-checklist.md');
  });

  it('(b) self-assessment evidence used when no operator section', () => {
    const g = resolveHumanAcGuidance({
      criterionText: 'Spot-check passed',
      taskBody: '## Goal\nx',
      evidence:
        'Wrote docs/agent/hercules-readiness-operator-checklist.md with a 2-3 min entry path',
      files,
    });
    expect(g.how).toMatch(/2-3 min entry path/);
    expect(g.refs).toContain('docs/agent/hercules-readiness-operator-checklist.md');
  });

  it('(c) checklist paths only when no how from a/b — how empty, refs filled', () => {
    const g = resolveHumanAcGuidance({
      criterionText: 'Spot-check passed',
      taskBody: '## Goal\nx',
      evidence: '(no evidence cited)',
      files,
    });
    expect(g.how).toBeNull();
    expect(g.refs).toEqual(['docs/agent/hercules-readiness-operator-checklist.md']);
  });

  it('no sources → empty how/refs (do not invent)', () => {
    const g = resolveHumanAcGuidance({
      criterionText: 'Spot-check passed',
      taskBody: '## Goal\nx',
      evidence: '(no evidence cited)',
      files: ['src/main.ts'],
    });
    expect(g).toEqual({ how: null, refs: [] });
  });
});
