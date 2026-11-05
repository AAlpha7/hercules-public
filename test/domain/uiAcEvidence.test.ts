/**
 * UI human ACs must map to click/assert/screenshot evidence steps.
 * Otherwise operators cannot verify before deploy (boundary-badge-why case).
 */
import { describe, it, expect } from 'vitest';
import {
  findUnprovenUiCriteria,
  formatCliEvidenceCell,
  isUiHumanCriterion,
  matchCliEvidenceForHuman,
  UNPROVEN_UI_AC_WARNING,
  type CliEvidenceLinkStep,
} from '../../src/domain/uiAcEvidence.js';
import type { EvidenceStep } from '../../src/domain/evidence.js';

const unlock: EvidenceStep = { kind: 'unlock', raw: 'unlock' };
const navTasks: EvidenceStep = {
  kind: 'click',
  selector: '[data-evidence=nav-tasks]',
  raw: 'click [data-evidence=nav-tasks]',
};
const taskList: EvidenceStep = {
  kind: 'assert',
  selector: '[data-evidence=task-list]',
  raw: 'assert sel=[data-evidence=task-list]',
};
const shotList: EvidenceStep = {
  kind: 'screenshot',
  name: 'task-list',
  raw: 'screenshot task-list',
};
const badgeClick: EvidenceStep = {
  kind: 'click',
  selector: '[data-evidence=boundary-badge]',
  raw: 'click [data-evidence=boundary-badge]',
};
const badgeShot: EvidenceStep = {
  kind: 'screenshot',
  name: 'boundary-badge-why',
  raw: 'screenshot boundary-badge-why',
};

describe('isUiHumanCriterion', () => {
  it('hits Chinese UI language', () => {
    expect(isUiHumanCriterion('手机上点黄色跨任务徽章, 一眼看懂为什么黄')).toBe(true);
    expect(isUiHumanCriterion('点开设置能看到语言切换')).toBe(true);
    expect(isUiHumanCriterion('展开面板显示提交列表')).toBe(true);
    expect(isUiHumanCriterion('界面上有明显的按钮')).toBe(true);
  });

  it('hits English UI language', () => {
    expect(isUiHumanCriterion('On phone, tap the yellow badge and see why')).toBe(true);
    expect(isUiHumanCriterion('Click the button to open the settings page')).toBe(true);
    expect(isUiHumanCriterion('screenshot shows the panel expanded')).toBe(true);
  });

  it('misses non-UI human criteria', () => {
    expect(isUiHumanCriterion('Confirm the original failure no longer occurs')).toBe(false);
    expect(isUiHumanCriterion('Spot-check that product behavior is unchanged')).toBe(false);
    expect(isUiHumanCriterion('Skim and accept as entry documentation')).toBe(false);
    expect(isUiHumanCriterion('确认原失败场景不再复现')).toBe(false);
  });
});

describe('findUnprovenUiCriteria', () => {
  it('flags UI human AC when plan has only unrelated list chrome (case study)', () => {
    const hits = findUnprovenUiCriteria({
      humanCriteria: [
        '手机上点黄色跨任务徽章, 一眼看懂为什么黄、涉及哪些提交',
      ],
      evidencePlanSteps: [unlock, navTasks, taskList, shotList],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toMatch(/跨任务徽章/);
    expect(hits[0]!.reason).toMatch(/无关|任务列表|click\/assert\/screenshot/);
    expect(hits[0]!.warning).toBe(UNPROVEN_UI_AC_WARNING);
    expect(hits[0]!.warning).toMatch(/无对应证据|无法在部署前核验/);
  });

  it('does not warn for non-UI human criteria', () => {
    const hits = findUnprovenUiCriteria({
      humanCriteria: ['Confirm the original failure no longer occurs'],
      evidencePlanSteps: [unlock, shotList],
    });
    expect(hits).toEqual([]);
  });

  it('does not warn when a related screenshot step exists', () => {
    const hits = findUnprovenUiCriteria({
      humanCriteria: ['手机上点黄色跨任务徽章, 一眼看懂为什么黄'],
      evidencePlanSteps: [unlock, badgeClick, badgeShot],
    });
    expect(hits).toEqual([]);
  });

  it('does not warn when English AC matches badge evidence steps', () => {
    const hits = findUnprovenUiCriteria({
      humanCriteria: [
        'On phone tap the yellow boundary badge and see which commits are involved',
      ],
      evidencePlanSteps: [unlock, badgeClick, badgeShot],
    });
    expect(hits).toEqual([]);
  });

  it('flags English UI AC when only unlock + shell screenshot exist', () => {
    const hits = findUnprovenUiCriteria({
      humanCriteria: ['Click the settings button and see the language panel'],
      evidencePlanSteps: [
        unlock,
        { kind: 'screenshot', name: 'shell', raw: 'screenshot shell' },
      ],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.reason).toMatch(/settings|language|click|assert|screenshot/i);
  });

  it('flags when UI AC has zero click/assert/screenshot in the plan', () => {
    const hits = findUnprovenUiCriteria({
      humanCriteria: ['点开徽章能看到原因'],
      evidencePlanSteps: [unlock],
    });
    expect(hits).toHaveLength(1);
  });

  it('uses evidenceResults step text for relatedness when plan names are sparse', () => {
    const hits = findUnprovenUiCriteria({
      humanCriteria: ['tap boundary badge and understand the yellow why'],
      evidencePlanSteps: [
        unlock,
        { kind: 'screenshot', name: 'shot1', raw: 'screenshot shot1' },
      ],
      evidenceResults: [
        {
          step: { kind: 'screenshot', name: 'shot1', raw: 'screenshot shot1' },
          ok: true,
          detail: 'captured boundary-badge panel',
          screenshot: 'boundary-badge.png',
        },
      ],
    });
    expect(hits).toEqual([]);
  });

  it('returns one entry per unproven UI criterion', () => {
    const hits = findUnprovenUiCriteria({
      humanCriteria: [
        '手机上点徽章一眼看懂',
        'Confirm docs are readable',
        'Click the button to open the page',
      ],
      evidencePlanSteps: [unlock],
    });
    expect(hits).toHaveLength(2);
  });

  it('does not warn when @scenario links to a passed CLI step via stdout', () => {
    const cli: CliEvidenceLinkStep = {
      id: 'web-console-flow',
      ok: true,
      status: 'passed',
      artifacts: [
        { name: 'a.png', kind: 'image' },
        { name: 'b.png', kind: 'image' },
        { name: 'flow.webm', kind: 'video' },
      ],
      stdoutTail:
        'ok\nhercules-scenario: chat-sheet-scroll-lock surfaces=webapp/src/vnext/**\ndone\n',
    };
    const hits = findUnprovenUiCriteria({
      humanCriteria: [
        'On phone tap the sheet and watch the recorded scenario video @scenario:chat-sheet-scroll-lock',
      ],
      evidencePlanSteps: [unlock],
      cliSteps: [cli],
    });
    expect(hits).toEqual([]);
    const link = matchCliEvidenceForHuman(
      'Owner watched the recorded scenario video @scenario:chat-sheet-scroll-lock',
      [cli],
    );
    expect(link).toEqual({
      stepId: 'web-console-flow',
      imageCount: 2,
      videoCount: 1,
    });
    expect(formatCliEvidenceCell(link!)).toBe(
      'CLI 步骤 web-console-flow ✓ · 2 张截图 · 1 段录像',
    );
  });

  it('links 录像 language to a passed CLI step with a video artifact', () => {
    const cli: CliEvidenceLinkStep = {
      id: 'record-flow',
      ok: true,
      status: 'passed',
      artifacts: [{ name: 'demo.webm', kind: 'video' }],
      stdoutTail: '',
    };
    const link = matchCliEvidenceForHuman('主人已观看录像确认滚动锁定', [cli]);
    expect(link?.stepId).toBe('record-flow');
    expect(link?.videoCount).toBe(1);
  });

  it('does not link a FAILED CLI step', () => {
    const cli: CliEvidenceLinkStep = {
      id: 'web-console-flow',
      ok: false,
      status: 'failed',
      artifacts: [{ name: 'demo.webm', kind: 'video' }],
      stdoutTail: 'hercules-scenario: chat-sheet-scroll-lock\n',
    };
    expect(
      matchCliEvidenceForHuman(
        'Owner watched the recorded scenario video @scenario:chat-sheet-scroll-lock',
        [cli],
      ),
    ).toBeNull();
    const hits = findUnprovenUiCriteria({
      humanCriteria: [
        'On phone tap the sheet and see the recorded scenario @scenario:chat-sheet-scroll-lock',
      ],
      evidencePlanSteps: [unlock],
      cliSteps: [cli],
    });
    expect(hits).toHaveLength(1);
  });
});

describe('CLI linkage — scenario lines bind only with an artifact on the same step (Claude R17 N1)', () => {
  it('ignores a hercules-scenario line printed by an unrelated passed step without artifacts', () => {
    const link = matchCliEvidenceForHuman('Owner watched the recorded scenario video @scenario:chat-sheet', [
      { id: 'admin-api-health', ok: true, status: 'passed', artifacts: [], stdoutTail: 'ok\nhercules-scenario: chat-sheet\n' },
    ]);
    expect(link).toBeNull();
  });
  it('binds when the declaring step also produced an artifact', () => {
    const link = matchCliEvidenceForHuman('Owner watched the recorded scenario video @scenario:chat-sheet', [
      { id: 'web-console-flow', ok: true, status: 'passed', artifacts: [{ name: 'cli-web-console-flow-clip.webm', kind: 'video' }], stdoutTail: 'hercules-scenario: chat-sheet surfaces=webapp/**\n' },
    ]);
    expect(link?.stepId).toBe('web-console-flow');
  });
});
