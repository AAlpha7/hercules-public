import { describe, it, expect } from 'vitest';
import {
  assembleReviewPacket,
  packetStatusLine,
  renderPacketMarkdown,
} from '../../src/verification/packet.js';
import type { GateResult, ReviewerVerdict } from '../../src/domain/verification.js';

const gatesPass: GateResult[] = [
  { name: 'typecheck', command: 'tsc', passed: true, output: '' },
  { name: 'test', command: 'vitest', passed: true, output: '' },
];
const approved: ReviewerVerdict = { approved: true, summary: 'good', comments: [] };

const base = {
  taskId: 'T-1',
  branch: 'hercules/T-1',
  filesTouched: ['src/foo.ts'],
  diffSummary: '1 file changed',
  cheatFindings: [],
  selfAssessment: 'I fixed the retry bug.',
};

describe('assembleReviewPacket (SPEC §9.6)', () => {
  it('records workflowGatesPassed from the WORKFLOW L1 gates only (C3.57)', () => {
    const green = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved });
    expect(green.workflowGatesPassed).toBe(true);
    const red = assembleReviewPacket({
      ...base,
      gates: [...gatesPass, { name: 'test', command: 'pnpm test', passed: false, output: 'boom' }],
      reviewerVerdict: approved,
    });
    expect(red.workflowGatesPassed).toBe(false);
    // Synthetic hercules:* rows do not count as WORKFLOW gates.
    const hygiene = assembleReviewPacket({
      ...base,
      gates: [...gatesPass, { name: 'report-hygiene', command: 'hercules:hygiene', passed: false, output: 'x' }],
      reviewerVerdict: approved,
    });
    expect(hygiene.workflowGatesPassed).toBe(true);
  });

  it('retains host-operation receipt (scope, outcome, post-check) in packet + markdown', () => {
    const receipt = {
      commandScope: ['systemctl restart hercules'] as const,
      outcome: 'success' as const,
      postCheckEvidence: 'health returned HTTP 200',
    };
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      hostOperationReceipt: receipt,
    });
    expect(packet.hostOperationReceipt).toEqual(receipt);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('## Host operation receipt');
    expect(md).toContain('systemctl restart hercules');
    expect(md).toContain('success');
    expect(md).toContain('health returned HTTP 200');
  });

  it('does not recover a stale host-operation receipt from the initial task body', () => {
    const body = `## Goal\nrestart\n\n## Host operation receipt\n\n- **Command scope:** \`./scripts/deploy-staging.sh\`\n- **Outcome:** success\n- **Post-check evidence:** curl ok\n`;
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      taskBody: body,
    });
    expect(packet.hostOperationReceipt).toBeUndefined();
  });

  it('requires a successful current-run receipt with exact scope before host work is green', () => {
    const host = {
      ...base,
      executionClass: 'host_operation' as const,
      hostCommandScope: ['systemctl restart hercules'],
      gates: gatesPass,
      reviewerVerdict: approved,
    };
    const missing = assembleReviewPacket(host);
    expect(missing.green).toBe(false);
    expect(missing.gates.find((g) => g.name === 'host-operation-receipt')?.passed).toBe(false);

    const staleBody = assembleReviewPacket({
      ...host,
      taskBody:
        '## Host operation receipt\n\n- **Command scope:** `systemctl restart hercules`\n' +
        '- **Outcome:** success\n- **Post-check evidence:** old check\n',
    });
    expect(staleBody.green).toBe(false);

    const mismatch = assembleReviewPacket({
      ...host,
      finalReport:
        '## Host operation receipt\n\n- **Command scope:** `systemctl restart other`\n' +
        '- **Outcome:** success\n- **Post-check evidence:** active\n',
    });
    expect(mismatch.green).toBe(false);

    const duplicate = assembleReviewPacket({
      ...host,
      finalReport:
        '## Host operation receipt\n\n- **Command scope:** `systemctl restart hercules`\n' +
        '- **Outcome:** success\n- **Post-check evidence:** active\n\n' +
        '## Host operation receipt\n\n- **Command scope:** `systemctl restart hercules`\n' +
        '- **Outcome:** success\n- **Post-check evidence:** active\n',
    });
    expect(duplicate.green).toBe(false);

    const current = assembleReviewPacket({
      ...host,
      finalReport:
        '## Host operation receipt\n\n- **Command scope:** `systemctl restart hercules`\n' +
        '- **Outcome:** success\n- **Post-check evidence:** service active and health HTTP 200\n',
    });
    expect(current.green).toBe(true);
    expect(current.hostOperationReceipt?.postCheckEvidence).toContain('HTTP 200');
  });

  it('marks mechanical evidence rows failed when the host receipt failed', async () => {
    const { parseDefinitionOfDone } = await import('../../src/domain/acceptance.js');
    const taskBody = [
      '## Definition of Done',
      '- [ ] (mechanical) deploy completed',
      '- [ ] (mechanical) services are active after deploy',
      '- [ ] (reviewer) no unapproved command ran',
    ].join('\n');
    const packet = assembleReviewPacket({
      ...base,
      executionClass: 'deploy',
      hostCommandScope: ['make deploy'],
      taskBody,
      dod: parseDefinitionOfDone(taskBody),
      gates: gatesPass,
      reviewerVerdict: null,
      selfAssessment:
        'Services are active, but the deploy timed out and did not complete successfully.',
      finalReport:
        '## Host operation receipt\n\n- **Command scope:** `make deploy`\n' +
        '- **Outcome:** failed\n- **Post-check evidence:** services were already active\n',
    });

    expect(packet.green).toBe(false);
    expect(packet.evidenceMatrix.filter((row) => row.kind === 'mechanical')).toEqual([
      expect.objectContaining({
        status: 'fail',
        evidence: expect.stringContaining("receipt outcome is 'failed'"),
      }),
      expect.objectContaining({
        status: 'fail',
        evidence: expect.stringContaining("receipt outcome is 'failed'"),
      }),
    ]);
    expect(packet.decisionCard?.criteria.filter((row) => row.kind === 'mechanical')).toEqual([
      expect.objectContaining({ status: 'fail' }),
      expect.objectContaining({ status: 'fail' }),
    ]);
  });

  it('allows a pure host operation to be green without a worktree diff or auto-rework', () => {
    const packet = assembleReviewPacket({
      ...base,
      filesTouched: [],
      diffSummary: '0 files changed',
      executionClass: 'host_operation',
      hostCommandScope: ['systemctl restart hercules'],
      gates: gatesPass,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
      finalReport:
        '## Host operation receipt\n\n- **Command scope:** `systemctl restart hercules`\n' +
        '- **Outcome:** success\n' +
        '- **Post-check evidence:** systemctl is-active returned active\n',
    });
    expect(packet.noChanges).toBe(true);
    expect(packet.green).toBe(true);
    expect(packet.autoRework).toBe(false);
    expect(packet.dod.reviewer).toBe('n/a');
  });

  it('renders exactly one receipt when finalReport has narrative + one receipt (dedupe)', () => {
    // Production canary: host-executor final message embeds the receipt, and
    // renderPacketMarkdown also emits the structured receipt → two headings
    // unless Agent report is stripped of the receipt block.
    const narrative = 'Deterministic host executor ran 1 approved command(s) successfully.';
    const finalReport = [
      narrative,
      '',
      '## Host operation receipt',
      '',
      '- **Command scope:** `systemctl restart hercules`',
      '- **Outcome:** success',
      '- **Post-check evidence:** service active and health HTTP 200',
    ].join('\n');
    const packet = assembleReviewPacket({
      ...base,
      filesTouched: [],
      diffSummary: '0 files changed',
      executionClass: 'host_operation',
      hostCommandScope: ['systemctl restart hercules'],
      gates: gatesPass,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
      selfAssessment: '- Host commands: executed once in order\n- Receipt outcome: success',
      finalReport,
    });
    expect(packet.green).toBe(true);
    expect(packet.hostOperationReceipt).toEqual({
      commandScope: ['systemctl restart hercules'],
      outcome: 'success',
      postCheckEvidence: 'service active and health HTTP 200',
    });
    const md = renderPacketMarkdown(packet);
    expect(md.match(/## Host operation receipt/g)).toHaveLength(1);
    expect(md).toContain(narrative);
    expect(md).toContain('systemctl restart hercules');
    expect(md).toContain('service active and health HTTP 200');
    expect(md).toMatch(/\*\*Outcome:\*\*\s*success/);
    // Agent report keeps narrative; receipt lives only in the canonical section.
    expect(md).toContain("Agent's report");
    const agentIdx = md.indexOf("Agent's report");
    const agentSection = md.slice(agentIdx);
    expect(agentSection).toContain(narrative);
    expect(agentSection).not.toContain('## Host operation receipt');
  });

  it('still fails the host receipt gate on zero or multiple input markers', () => {
    const host = {
      ...base,
      filesTouched: [] as string[],
      diffSummary: '0 files changed',
      executionClass: 'host_operation' as const,
      hostCommandScope: ['systemctl restart hercules'],
      gates: gatesPass,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
    };
    const zero = assembleReviewPacket({
      ...host,
      finalReport: 'Narrative only — no receipt section.',
    });
    expect(zero.green).toBe(false);
    expect(zero.gates.find((g) => g.name === 'host-operation-receipt')?.passed).toBe(false);

    const duplicateReport = [
      '## Host operation receipt',
      '',
      '- **Command scope:** `systemctl restart hercules`',
      '- **Outcome:** success',
      '- **Post-check evidence:** first',
      '',
      '## Host operation receipt',
      '',
      '- **Command scope:** `systemctl restart hercules`',
      '- **Outcome:** success',
      '- **Post-check evidence:** second',
    ].join('\n');
    const dup = assembleReviewPacket({ ...host, finalReport: duplicateReport });
    expect(dup.green).toBe(false);
    expect(dup.gates.find((g) => g.name === 'host-operation-receipt')?.passed).toBe(false);
    // Malformed/duplicate input stays visible in Agent report (not hidden by dedupe).
    const md = renderPacketMarkdown(dup);
    expect(md.match(/## Host operation receipt/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('is green when all gates pass and the reviewer approved', () => {
    const packet = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved });
    expect(packet.green).toBe(true);
  });

  it('is not green when a gate failed', () => {
    const gates = [{ name: 'typecheck', command: 'tsc', passed: false, output: 'err' }];
    const packet = assembleReviewPacket({ ...base, gates, reviewerVerdict: approved });
    expect(packet.green).toBe(false);
  });

  it('is not green when the reviewer requested changes', () => {
    const verdict: ReviewerVerdict = { approved: false, summary: 'needs work', comments: ['x'] };
    const packet = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: verdict });
    expect(packet.green).toBe(false);
  });

  it('is not green when the reviewer did not run (skipped axis)', () => {
    const packet = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: null });
    expect(packet.green).toBe(false);
    expect(packet.dod.reviewer).toBe('skipped');
  });

  it('is NOT green when L2 was declared but produced no evidence (fail-open fix)', () => {
    // A repo whose WORKFLOW declares behavioral: but where L2 never ran (no
    // browser / boot failed / empty plan) used to reach review "green" having
    // never booted the app. Declared-but-missing must be non-green + visible.
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralExpectedButMissing: true,
    });
    expect(packet.green).toBe(false);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/L2 declared.*no evidence|not machine-verified|did not run/i);
  });

  it('a repo that never declared L2 warns — it must NOT fake a passing gate', () => {
    // bookshelf/orbit: WORKFLOW has no behavioral block. The warning used to be
    // encoded as `{name:'behavioral', passed:true}`, so the phone card showed
    // ✅ behavioral and counted 门禁 7/7 — a green tick meaning "nothing was
    // verified" (2026-07-25, orbit-l2-webapp-evidence). Warn, never fake-pass.
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralNotDeclared: true,
    });
    expect(packet.green).toBe(true); // policy problem, not this task's fault
    const row = packet.gates.find((g) => g.name === 'behavioral');
    expect(row).toBeUndefined();
    expect(packet.dod.warnings.join(' ')).toMatch(/not declared|未声明|no behavioral/i);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/not declared|未声明/i);
    // The decision card must not count a phantom gate.
    expect(packet.decisionCard?.gates.some((g) => g.name === 'behavioral')).toBe(false);
  });

  it('does not set autoRework for a missing L2 run (env/config, not agent-fixable)', () => {
    // Re-dispatching the agent cannot install a browser — thrashing is wrong.
    // It lands in review non-green so the human decides.
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralExpectedButMissing: true,
    });
    expect(packet.autoRework).toBe(false);
  });

  it('stays green when L2 evidence actually ran and passed (not falsely blocked)', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralExpectedButMissing: false,
      evidenceRun: { source: 'workflow', ok: true, steps: [
        { kind: 'assert', ok: true, detail: 'found', raw: 'assert x' },
      ] },
    });
    expect(packet.green).toBe(true);
  });

  it('renders a zh executive-decision block at the top (CEO lens)', () => {
    // 改动 = reviewer's business-language line (fallback deterministic);
    // 可信度 + 风险 = STRICTLY mechanical from packet facts — never invented.
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: { approved: true, summary: 'ok', comments: [], summaryZh: '修复了上传重试丢文件的问题' },
      evidenceRun: { source: 'workflow', ok: true, steps: [
        { kind: 'assert', ok: true, detail: 'found', raw: 'assert x' },
        { kind: 'screenshot', ok: true, detail: 'wrote', raw: 'screenshot s' },
      ] },
    });
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/## 决策摘要/);
    expect(md).toMatch(/修复了上传重试丢文件的问题/);
    expect(md).toMatch(/门禁 2\/2 绿/);
    expect(md).toMatch(/独立审稿.*通过/);
    expect(md).toMatch(/行为证据 2 步通过/);
    expect(md).toMatch(/风险.*无标记风险/);
    // Decision block leads the packet.
    expect(md.indexOf('决策摘要')).toBeLessThan(md.indexOf('Definition of Done'));
  });

  it('executive block lists risks mechanically when findings exist', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: { approved: true, summary: 'ok', comments: [] },
      cheatFindings: [
        { kind: 'test-edit', file: 't.ts', detail: 'edited test' },
        {
          kind: 'cross-task-commits',
          file: '(branch history)',
          detail:
            'commits attributed to other tasks aboard: ORBIT-READINESS-R2-WORKFLOW — lineage crosses',
        },
      ],
    });
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/风险/);
    expect(md).toMatch(/测试被改动|test-edit/);
    expect(md).toMatch(/跨任务|cross-task/);
    // Self-contained: names the foreign task id, never "出处见发现".
    expect(md).toMatch(/含跨任务提交: ORBIT-READINESS-R2-WORKFLOW/);
    expect(md).not.toMatch(/出处见发现/);
  });

  it('embeds a structured decision card in the rendered packet (parse roundtrip)', async () => {
    const { parseDecisionCard } = await import('../../src/domain/decisionCard.js');
    const packet = assembleReviewPacket({
      ...base,
      taskBody: '## Goal\nFix retry.\n',
      branch: 'hercules/T-1',
      gates: gatesPass,
      reviewerVerdict: { approved: true, summary: 'ok', comments: [], summaryZh: '修好了重试' },
    });
    const md = renderPacketMarkdown(packet);
    const card = parseDecisionCard(md);
    expect(card).not.toBeNull();
    expect(card!.purpose).toBe('Fix retry.');
    expect(card!.reviewer.summaryZh).toBe('修好了重试');
    expect(card!.criteria.length).toBeGreaterThan(0);
  });

  it('warns (soft) when UI human AC has no related L2 evidence steps', async () => {
    const { parseDecisionCard } = await import('../../src/domain/decisionCard.js');
    const { parseDefinitionOfDone } = await import('../../src/domain/acceptance.js');
    const taskBody = [
      '## Goal',
      'Boundary badge why',
      '',
      '## Definition of Done',
      '- [ ] (mechanical) gates green @gate:test',
      '- [ ] (human) 手机上点黄色跨任务徽章, 一眼看懂为什么黄、涉及哪些提交',
      '',
      '## Evidence',
      '- unlock',
      '- click [data-evidence=nav-tasks]',
      '- assert sel=[data-evidence=task-list]',
      '- screenshot task-list',
    ].join('\n');
    const packet = assembleReviewPacket({
      ...base,
      taskBody,
      dod: parseDefinitionOfDone(taskBody),
      gates: gatesPass,
      reviewerVerdict: approved,
      evidenceRun: {
        source: 'task',
        ok: true,
        steps: [
          { kind: 'unlock', ok: true, detail: 'ok', raw: 'unlock' },
          {
            kind: 'click',
            ok: true,
            detail: 'ok',
            raw: 'click [data-evidence=nav-tasks]',
          },
          {
            kind: 'assert',
            ok: true,
            detail: 'ok',
            raw: 'assert sel=[data-evidence=task-list]',
          },
          {
            kind: 'screenshot',
            ok: true,
            detail: 'ok',
            raw: 'screenshot task-list',
            screenshot: 'task-list.png',
          },
        ],
      },
    });
    // Soft — must not fail mechanical green / auto-rework for this alone.
    expect(packet.green).toBe(true);
    expect(packet.autoRework).toBe(false);
    const uiRow = packet.evidenceMatrix.find((r) => r.kind === 'human');
    expect(uiRow?.unprovenUiWarning).toMatch(/无对应证据|无法在部署前核验/);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/UI 人工项缺少证据|无对应证据步骤/);
    const card = packet.decisionCard ?? parseDecisionCard(md);
    expect(card).not.toBeNull();
    const human = card!.criteria.find((c) => c.kind === 'human');
    expect(human?.unprovenUiWarning).toMatch(/无对应证据/);
    expect(human?.unprovenUiReason).toBeTruthy();
  });

  it('renders the three DoD axes in the packet markdown', () => {
    const packet = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved });
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('Definition of Done');
    expect(md).toContain('mechanical');
    expect(md).toContain('reviewer');
    expect(md).toMatch(/evidence only|not authoritative/i);
  });

  it('flags noChanges and is never green when the agent touched no files', () => {
    const packet = assembleReviewPacket({
      ...base,
      filesTouched: [],
      gates: gatesPass,
      reviewerVerdict: approved, // even with passing gates + approval
      // Analysis opt-out: soft no-diff (not delivery fail)
      taskTitle: '分析架构',
      taskBody: '只做调研 <!-- hercules:no-diff-ok -->',
      runKind: 'implementer',
    });
    expect(packet.noChanges).toBe(true);
    expect(packet.green).toBe(false);
    expect(packet.autoRework).toBe(false);
  });

  it('strips stale screenshots on empty-diff packets', () => {
    const packet = assembleReviewPacket({
      ...base,
      filesTouched: [],
      gates: gatesPass,
      reviewerVerdict: null,
      screenshots: ['evidence-0.png'],
      finalReport:
        'See ![evidence](/api/tasks/logout/screenshots/evidence-0.png)\n\n**还没 ready。**',
      taskTitle: 'Logout页面改成设置页面',
      taskBody: '设置页',
      runKind: 'steer',
    });
    expect(packet.screenshots).toEqual([]);
    expect(packet.finalReport).not.toMatch(/evidence-0\.png/);
    expect(packet.finalReport).toMatch(/还没 ready/);
    const md = renderPacketMarkdown(packet);
    expect(md).not.toMatch(/Behavioral evidence/);
    expect(md).toMatch(/\*\*not\*\* evidence for this empty-diff turn/i);
  });

  it('auto-reworks empty-diff Settings task even on steer (logout case study)', () => {
    const p = assembleReviewPacket({
      taskId: 'logout',
      branch: 'hercules/logout',
      filesTouched: [],
      diffSummary: 'no changes',
      diff: '',
      gates: [
        { name: 'setup', command: 'true', passed: true, output: 'skipped: no file changes' },
        { name: 'test', command: 'pnpm test', passed: true, output: 'skipped: no file changes' },
      ],
      cheatFindings: [],
      reviewerVerdict: null,
      selfAssessment: 'Evidence: no',
      finalReport: '**还没 ready。** 需要重新实现',
      taskTitle: 'Logout页面改成设置页面',
      taskBody: '页面里面加几个功能：语言（中/英）、默认agent、Logout',
      runKind: 'steer',
    });
    expect(p.autoRework).toBe(true);
    expect(p.dod.mechanical).toBe('fail');
    expect(p.gates.some((g) => g.name === 'delivery' && !g.passed)).toBe(true);
    const md = renderPacketMarkdown(p);
    expect(md).toMatch(/Delivery check failed/i);
    expect(md).not.toMatch(/Allowed for this run/i);
  });

  it('auto-reworks implementer empty-diff UI tasks (delivery honesty)', () => {
    const packet = assembleReviewPacket({
      ...base,
      filesTouched: [],
      gates: gatesPass,
      reviewerVerdict: null,
      taskTitle: 'Logout页面改成设置页面',
      taskBody: '页面里面加几个功能：语言（中/英）、默认agent、Logout',
      runKind: 'implementer',
      finalReport: '设置页已上线：底部 **设置** 里可切换中/英',
      selfAssessment: 'done',
    });
    expect(packet.noChanges).toBe(true);
    expect(packet.autoRework).toBe(true);
    expect(packet.green).toBe(false);
    expect(packet.dod.mechanical).toBe('fail');
    expect(packet.gates.some((g) => g.name === 'delivery' && !g.passed)).toBe(true);
    expect(packet.cheatFindings.some((f) => f.kind === 'false-delivery')).toBe(true);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/Delivery check failed/i);
  });

  it('is not noChanges when files were touched', () => {
    const packet = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved });
    expect(packet.noChanges).toBe(false);
  });

  it('renders a Base drift section when the report is present', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      baseDrift: {
        defaultBranch: 'main',
        mergeBase: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        baseSha: 'cccccccccccccccccccccccccccccccccccccccc',
        behind: 2,
        ahead: 1,
        status: 'diverged',
        conflictRisk: 'none',
        conflictDetail: null,
        rebaseAttempted: false,
        rebaseOk: null,
        rebaseDetail: null,
      },
    });
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('**Base drift**');
    expect(md).toContain('behind **2**');
    expect(md).toContain('conflict risk **none**');
    expect(packet.green).toBe(true); // lag alone does not un-green
  });

  it('fails green + auto-reworks when base-drift conflict is present', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      baseDrift: {
        defaultBranch: 'main',
        mergeBase: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        baseSha: 'cccccccccccccccccccccccccccccccccccccccc',
        behind: 1,
        ahead: 1,
        status: 'diverged',
        conflictRisk: 'conflict',
        conflictDetail: 'CONFLICT (content): Merge conflict in src/foo.ts',
        rebaseAttempted: false,
        rebaseOk: null,
        rebaseDetail: null,
      },
    });
    expect(packet.green).toBe(false);
    expect(packet.autoRework).toBe(true);
    expect(packet.gates.some((g) => g.name === 'base-drift' && !g.passed)).toBe(true);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/Base drift/);
    expect(md).toMatch(/never merge to main/i);
  });


  it('when only review-only L5 (test-edit) and L3 approved, summarizes without file dump', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      cheatFindings: [
        { kind: 'test-edit', file: 'test/a.test.ts', detail: 'edits a test file' },
        { kind: 'test-edit', file: 'test/b.test.ts', detail: 'edits a test file' },
      ],
    });
    expect(packet.green).toBe(true);
    expect(packet.autoRework).toBe(false);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/Anti-cheating \(L5 → L3\)/);
    expect(md).toMatch(/test-edit ×2/);
    // Names kind + zh meaning (not bare count alone).
    expect(md).toMatch(/改动了测试文件/);
    expect(md).not.toMatch(/test\/a\.test\.ts/);
  });

  it('names each review-only kind on the card + packet (cross-task + test-edit)', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      cheatFindings: [
        { kind: 'test-edit', file: 'test/a.test.ts', detail: 'edits a test file' },
        {
          kind: 'cross-task-commits',
          file: '(branch history)',
          detail:
            'commits attributed to other tasks aboard: R2 — lineage crosses',
        },
      ],
      crossTaskCommits: [
        {
          sha: 'eb2182c0abcdef0123456789abcdef0123456789',
          subject: 'hercules: R2 — verified state',
          taskId: 'R2',
        },
      ],
    });
    expect(packet.decisionCard?.boundaries.crossTaskCommits).toHaveLength(1);
    expect(packet.decisionCard?.reviewOnlyFlags.map((f) => f.kind).sort()).toEqual([
      'cross-task-commits',
      'test-edit',
    ]);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/test-edit/);
    expect(md).toMatch(/cross-task-commits/);
    expect(md).toMatch(/审计血缘|夹带其他任务/);
    expect(md).not.toMatch(/出处见发现/);
  });

  it('critical L5 forces auto-rework even if L3 approved (G4 hard gate)', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      cheatFindings: [
        { kind: 'test-edit', file: 'test/a.test.ts', detail: 'edits a test file' },
        { kind: 'eslint-disable', file: 'src/x.ts', line: 2, detail: 'disables a lint rule' },
      ],
    });
    expect(packet.autoRework).toBe(true);
    expect(packet.green).toBe(false);
    expect(packet.dod.mechanical).toBe('fail');
    expect(packet.gates.some((g) => g.name === 'anti-cheat' && !g.passed)).toBe(true);
  });

  it('test-integrity is critical: fails even if L3 approved and names title', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      cheatFindings: [
        { kind: 'test-edit', file: 'test/a.test.ts', detail: 'edits a test file' },
        {
          kind: 'test-integrity',
          file: 'test/a.test.ts',
          detail: 'removed or renamed test case "retries upload three times"',
        },
      ],
    });
    expect(packet.autoRework).toBe(true);
    expect(packet.green).toBe(false);
    expect(packet.dod.mechanical).toBe('fail');
    const anti = packet.gates.find((g) => g.name === 'anti-cheat');
    expect(anti?.passed).toBe(false);
    expect(anti?.output).toMatch(/test-integrity/);
    expect(anti?.output).toMatch(/retries upload three times/);
    expect(anti?.output).toMatch(/test\/a\.test\.ts/);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/test-integrity|removed or renamed test case/);
    expect(md).toMatch(/retries upload three times/);
  });

  it('L2 evidence fail forces auto-rework (G1)', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      evidenceRun: {
        source: 'task',
        ok: false,
        steps: [
          { kind: 'click', ok: false, detail: 'not found', raw: 'click [data-evidence=nav-settings]' },
        ],
      },
    });
    expect(packet.autoRework).toBe(true);
    expect(packet.green).toBe(false);
    expect(packet.gates.some((g) => g.name === 'behavioral' && !g.passed)).toBe(true);
  });

  it('L2 relevance partial: warning + summary + scene labels; green unchanged', () => {
    const diff = [
      'diff --git a/src/web/App.tsx b/src/web/App.tsx',
      '--- a/src/web/App.tsx',
      '+++ b/src/web/App.tsx',
      '@@ -1,2 +1,3 @@',
      '+  <div data-evidence="hit-hook">',
      '+  <button data-evidence="miss-hook" />',
    ].join('\n');
    const evidenceRun = {
      source: 'workflow' as const,
      ok: true,
      steps: [
        {
          kind: 'click',
          ok: true,
          detail: 'ok',
          raw: 'click [data-evidence=hit-hook]',
        },
        {
          kind: 'screenshot',
          ok: true,
          detail: 'wrote',
          raw: 'screenshot scene-a',
          screenshot: 'scene-a.png',
        },
      ],
    };
    const withRelevance = assembleReviewPacket({
      ...base,
      filesTouched: ['src/web/App.tsx'],
      diff,
      gates: gatesPass,
      reviewerVerdict: approved,
      evidenceRun,
      screenshots: ['scene-a.png'],
    });
    expect(withRelevance.l2Relevance?.label).toBe('partial');
    expect(withRelevance.l2Relevance?.uncovered).toEqual(['miss-hook']);
    expect(withRelevance.dod.warnings).toEqual(
      expect.arrayContaining([
        'L2: partial — uncovered changed anchors: miss-hook',
      ]),
    );
    const md = renderPacketMarkdown(withRelevance);
    expect(md).toContain('_L2: partial — uncovered changed anchors: miss-hook_');
    expect(md).toContain('_Screenshot: scene-a.png_ (scene: hit-hook)');

    // Green identical to the same packet shape without relevance signals
    // (non-UI file → no-ui-change, warning null — green path unchanged).
    const noUi = assembleReviewPacket({
      ...base,
      filesTouched: ['src/foo.ts'],
      diff: 'diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n+x\n',
      gates: gatesPass,
      reviewerVerdict: approved,
      evidenceRun,
      screenshots: ['scene-a.png'],
    });
    expect(noUi.l2Relevance?.label).toBe('no-ui-change');
    expect(noUi.green).toBe(withRelevance.green);
    expect(withRelevance.green).toBe(true);
    expect(withRelevance.autoRework).toBe(false);
  });

  it('when L3 rejects, lists flags for implementer rework (not human queue)', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: {
        approved: false,
        summary: 'tests weakened',
        comments: ['restore assertion'],
      },
      cheatFindings: [
        { kind: 'test-edit', file: 'test/a.test.ts', detail: 'edits a test file' },
        { kind: 'eslint-disable', file: 'src/x.ts', line: 2, detail: 'disables a lint rule' },
      ],
    });
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/auto-rework/i);
    expect(md).toMatch(/not human code review/i);
    expect(md).toMatch(/🚨 eslint-disable in `src\/x\.ts`:2/);
    expect(md).toMatch(/test-edit ×1/);
    expect(md).toMatch(/test\/a\.test\.ts/);
  });

  it('names placeholder-evidence-hook as `file:line` — Chinese detail (cannot silently regress)', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: null,
      cheatFindings: [
        {
          kind: 'placeholder-evidence-hook',
          file: 'src/web/ReposPanel.tsx',
          line: 42,
          detail: '新增带 data-evidence 的禁用控件且事件处理为空,疑似仅为 L2 assert 占位',
        },
      ],
    });
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(
      /placeholder-evidence-hook in `src\/web\/ReposPanel\.tsx`:42 — 新增带 data-evidence 的禁用控件/,
    );
    expect(packet.autoRework).toBe(false); // REVIEW_ONLY — never auto-rework alone
    expect(packet.green).toBe(false); // L3 did not run
  });

  it("renders the agent's final report so a text deliverable is reviewable", () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      finalReport: '# Project summary\n\nThe orchestrator dispatches one agent per task.',
    });
    expect(packet.finalReport).toBe(
      '# Project summary\n\nThe orchestrator dispatches one agent per task.',
    );
    const md = renderPacketMarkdown(packet);
    expect(md).toContain("Agent's report");
    expect(md).toContain('The orchestrator dispatches one agent per task.');
  });

  it("omits the agent's report section when the agent produced no final message", () => {
    const packet = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved });
    expect(packet.finalReport).toBe('');
    expect(renderPacketMarkdown(packet)).not.toContain("Agent's report");
  });

  it('defaults activityLog to [] and carries it when provided', () => {
    expect(assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: null }).activityLog).toEqual([]);
    const withLog = assembleReviewPacket({
      ...base, gates: gatesPass, reviewerVerdict: null, activityLog: ['Edit src/x.ts', 'Bash: pnpm test'],
    });
    expect(withLog.activityLog).toEqual(['Edit src/x.ts', 'Bash: pnpm test']);
  });
});

describe('packetStatusLine', () => {
  it('says automated proof complete when fully green', () => {
    const p = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved });
    expect(packetStatusLine(p)).toMatch(/automated proof complete/i);
  });

  it('names unverified criteria on green status line and trust line; round-trips decision card', async () => {
    const { parseDefinitionOfDone } = await import('../../src/domain/acceptance.js');
    const { parseDecisionCard } = await import('../../src/domain/decisionCard.js');
    const { bodyHasSuccessfulPacket } = await import('../../src/web/taskBodySplit.js');
    const { unverifiedTestPathWarning } = await import('../../src/domain/mechProof.js');
    const taskBody = [
      '## Definition of Done',
      '- [ ] (mechanical) unit coverage @test:test/web/x.test.ts',
      '- [ ] (human) Owner watched the recorded scenario video @scenario:chat-sheet-scroll-lock',
      '- [ ] (reviewer) spirit',
    ].join('\n');
    const p = assembleReviewPacket({
      ...base,
      filesTouched: ['src/foo.ts', 'test/web/x.test.ts'],
      gates: gatesPass,
      reviewerVerdict: approved,
      taskBody,
      dod: parseDefinitionOfDone(taskBody),
      testGate: { passed: true, output: '3 passed\n' },
      cliEvidence: {
        version: 1 as const,
        source: 'workflow' as const,
        status: 'passed' as const,
        ok: true,
        durationMs: 10,
        steps: [
          {
            id: 'web-console-flow',
            argv: ['node', 'scripts/flow.mjs'],
            cwd: '.',
            status: 'passed' as const,
            exitCode: 0,
            durationMs: 10,
            stdoutTail:
              'hercules-scenario: chat-sheet-scroll-lock surfaces=webapp/src/vnext/**\n',
            stderrTail: '',
            assertions: [],
            ok: true,
            optional: false,
            artifacts: [
              {
                name: 'a.png',
                kind: 'image' as const,
                bytes: 10,
                sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
              {
                name: 'flow.webm',
                kind: 'video' as const,
                bytes: 20,
                sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              },
            ],
          },
        ],
      },
    });
    expect(p.dod.mechanical).toBe('pass');
    expect(p.dod.unverifiedCriteria?.length).toBe(1);
    expect(p.dod.unverifiedCriteria?.[0]?.text).toMatch(/unit coverage/);
    expect(p.dod.criteria.some((c) => c.status === 'unverified')).toBe(true);
    const line = packetStatusLine(p);
    expect(line).toMatch(/automated proof complete/i);
    expect(line).toMatch(/1 项无法自动核验，需人工确认/);
    const md = renderPacketMarkdown(p, { nonce: '0123456789abcdef0123456789abcdef' });
    expect(md).toMatch(/无法自动核验 1 项/);
    expect(md).toContain('❔');
    // Full warning text once in human packet prose (criteria list). Status /
    // trust lines use count only; dod.warnings must not repeat it. (Decision
    // card JSON may still carry the warning for SPA needsYou.)
    const fullWarn = unverifiedTestPathWarning('test/web/x.test.ts');
    const prose = md.replace(/<!-- hercules:decision-card\n[\s\S]*?\n-->/g, '');
    expect(prose.split(fullWarn).length - 1).toBe(1);
    expect(p.dod.warnings.some((w) => w.includes(fullWarn))).toBe(false);
    const card = parseDecisionCard(md);
    expect(card).not.toBeNull();
    expect(card!.unverifiedCriteria?.length).toBe(1);
    expect(card!.criteria.some((c) => c.status === 'unverified')).toBe(true);
    const humanRow = card!.criteria.find((c) => c.kind === 'human');
    expect(humanRow?.text).toBe('Owner watched the recorded scenario video');
    expect(humanRow?.why).toMatch(/CLI 步骤 web-console-flow/);
    expect(humanRow?.unprovenUiWarning).toBeUndefined();
    const body = `## Review packet\n\n${md}`;
    expect(
      bodyHasSuccessfulPacket(body, { nonce: '0123456789abcdef0123456789abcdef' }),
    ).toBe(true);
  });

  it('hollow evidence (identical screenshots across scenarios) fails behavioural axis', () => {
    const HASH =
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const p = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      evidenceRun: {
        source: 'workflow',
        ok: true,
        steps: [
          {
            kind: 'screenshot',
            ok: true,
            detail: 'wrote login.png',
            screenshot: 'login.png',
            screenshotSha256: HASH,
            raw: 'screenshot login',
          },
          {
            kind: 'screenshot',
            ok: true,
            detail: 'wrote settings.png',
            screenshot: 'settings.png',
            screenshotSha256: HASH,
            raw: 'screenshot settings',
          },
        ],
      },
      screenshots: ['login.png', 'settings.png'],
    });
    expect(p.cheatFindings.some((f) => f.kind === 'hollow-evidence')).toBe(true);
    expect(p.evidenceRun?.ok).toBe(false);
    expect(p.dod.mechanical).toBe('fail');
    expect(p.autoRework).toBe(true);
    const md = renderPacketMarkdown(p);
    expect(md).toMatch(
      /❌ hollow evidence — 2 screenshots identical across scenarios \(login, settings\)/,
    );
  });

  it('says automated checks green with named gaps when green but axes are n/a', () => {
    const p = assembleReviewPacket({
      ...base,
      filesTouched: [],
      gates: [
        {
          name: 'test',
          command: 'pnpm test',
          passed: true,
          output: 'skipped: no file changes',
          outcome: 'skipped',
        },
      ],
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
      taskTitle: 'Q&A',
      taskBody: '<!-- hercules:no-diff-ok -->',
    });
    expect(p.green).toBe(false); // noChanges without host → not green
    // Host/analysis path with green + n/a axes:
    const hostGreen = assembleReviewPacket({
      ...base,
      filesTouched: [],
      executionClass: 'host_operation',
      hostCommandScope: ['systemctl restart hercules'],
      gates: gatesPass,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
      finalReport:
        '## Host operation receipt\n\n- **Command scope:** `systemctl restart hercules`\n' +
        '- **Outcome:** success\n' +
        '- **Post-check evidence:** active\n',
    });
    expect(hostGreen.green).toBe(true);
    expect(hostGreen.dod.reviewer).toBe('n/a');
    const line = packetStatusLine(hostGreen);
    expect(line).toMatch(/automated checks green/i);
    expect(line).not.toMatch(/automated proof complete/i);
    expect(line).toMatch(/reviewer n\/a \(no file changes\)/);
  });

  it('shows DoD axes when not fully green (e.g. L3 skipped)', () => {
    const p = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: null });
    expect(packetStatusLine(p)).toMatch(/DoD/i);
    expect(packetStatusLine(p)).toMatch(/reviewer/);
    expect(p.dod.reviewer).toBe('skipped');
  });

  it('reviewer disabled with a real diff → skipped axis (never n/a)', () => {
    const p = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'L3 disabled (HERCULES_REVIEWER=0)',
    });
    expect(p.dod.reviewer).toBe('skipped');
    expect(p.green).toBe(false);
  });

  it('flags auto-rework when L3 rejects', () => {
    const p = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: { approved: false, summary: 'drafty', comments: ['expand ch6'] },
    });
    expect(p.autoRework).toBe(true);
    expect(packetStatusLine(p)).toMatch(/auto-rework/i);
    expect(packetStatusLine(p)).toMatch(/will be queued|will be re-queued/i);
  });

  it('labels rework path steer for small L3-only nits', () => {
    const p = assembleReviewPacket({
      ...base,
      filesTouched: ['src/foo.ts'],
      diffSummary: '1 file changed, 8 insertions(+)',
      gates: gatesPass,
      reviewerVerdict: {
        approved: false,
        summary: 'Polish nits',
        comments: ['Fix typo in comment'],
      },
      runKind: 'implementer',
    });
    expect(p.autoRework).toBe(true);
    expect(p.reworkPath).toBe('steer');
    expect(p.reworkPathReason).toMatch(/comment|polish|small/i);
    expect(packetStatusLine(p)).toMatch(/auto-rework \(steer\)/i);
    const md = renderPacketMarkdown(p);
    expect(md).toMatch(/\*\*Rework path:\*\* `steer`/);
  });

  it('labels rework path full for design issues', () => {
    const p = assembleReviewPacket({
      ...base,
      filesTouched: ['src/foo.ts'],
      diffSummary: '1 file changed, 8 insertions(+)',
      gates: gatesPass,
      reviewerVerdict: {
        approved: false,
        summary: 'Wrong architecture — needs redesign',
        comments: ['Start over with a different approach'],
      },
      runKind: 'implementer',
    });
    expect(p.autoRework).toBe(true);
    expect(p.reworkPath).toBe('full');
    expect(packetStatusLine(p)).toMatch(/auto-rework \(full\)/i);
    expect(renderPacketMarkdown(p)).toMatch(/\*\*Rework path:\*\* `full`/);
  });

  it('escalates prior steer failure to full rework path', () => {
    const p = assembleReviewPacket({
      ...base,
      filesTouched: ['src/foo.ts'],
      diffSummary: '1 file changed, 8 insertions(+)',
      gates: gatesPass,
      reviewerVerdict: {
        approved: false,
        summary: 'still a typo',
        comments: ['fix typo'],
      },
      runKind: 'steer',
    });
    expect(p.autoRework).toBe(true);
    expect(p.reworkPath).toBe('full');
    expect(p.reworkPathReason).toMatch(/prior steer|anti-loop/i);
  });

  it('says attempts exhausted (not re-queued) when max attempts hit', () => {
    const p = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: { approved: false, summary: 'still missing hooks', comments: [] },
    });
    expect(p.autoRework).toBe(true);
    const line = packetStatusLine(p, { attemptsExhausted: true });
    expect(line).toMatch(/attempts exhausted/i);
    expect(line).not.toMatch(/will be re-queued/i);
    const md = renderPacketMarkdown(p, { attemptsExhausted: true });
    expect(md).toMatch(/attempts exhausted/i);
    expect(md).not.toMatch(/will be re-queued/i);
  });

  it('does NOT auto-rework or fail green for soft report pollution alone', () => {
    const p = assembleReviewPacket({
      ...base,
      gates: [
        ...gatesPass,
        {
          name: 'report-hygiene',
          command: 'hercules:report-hygiene',
          passed: true,
          output: 'WARN soft',
        },
      ],
      reviewerVerdict: approved,
      reportPolluted: true,
      finalReport: 'cleaned short narrative',
    });
    expect(p.autoRework).toBe(false);
    expect(p.green).toBe(true);
    expect(p.dod.mechanical).toBe('pass');
    expect(packetStatusLine(p)).toMatch(/automated proof complete/i);
    expect(packetStatusLine(p)).toMatch(/soft hygiene|cleaned/i);
  });

  it('distinguishes allowed no-change runs (opt-out)', () => {
    const ok = assembleReviewPacket({
      ...base,
      filesTouched: [],
      gates: gatesPass,
      reviewerVerdict: null,
      taskTitle: 'Q&A',
      taskBody: '<!-- hercules:no-diff-ok -->',
      runKind: 'implementer',
    });
    expect(ok.noChanges).toBe(true);
    expect(ok.autoRework).toBe(false);
    expect(packetStatusLine(ok)).toMatch(/DoD|human/i);
  });
});

describe('renderPacketMarkdown', () => {
  it('renders skipped/info gate rows and excludes them from 门禁 n/m', () => {
    const packet = assembleReviewPacket({
      ...base,
      filesTouched: [],
      gates: [
        {
          name: 'typecheck',
          command: 'tsc',
          passed: true,
          output: 'skipped: no file changes',
          outcome: 'skipped',
        },
        {
          name: 'test',
          command: 'vitest',
          passed: true,
          output: 'skipped: no file changes',
          outcome: 'skipped',
        },
        {
          name: 'report-hygiene',
          command: 'hercules:report-hygiene',
          passed: true,
          output: 'WARN soft',
          outcome: 'info',
        },
      ],
      reviewerVerdict: null,
      reviewerRan: false,
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
      taskBody: '<!-- hercules:no-diff-ok -->',
      reportPolluted: true,
    });
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/⏭ typecheck \(skipped: no file changes\)/);
    expect(md).toMatch(/⏭ test \(skipped: no file changes\)/);
    expect(md).toMatch(/ℹ️ report-hygiene/);
    expect(md).toMatch(/门禁 0\/0 绿/);
  });

  it('prints proof: on each DoD criterion line', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      dod: {
        criteria: [
          { text: 'gates green @gate:test', kind: 'mechanical', checked: null },
          { text: 'looks good', kind: 'human', checked: null },
        ],
        needsReviewer: false,
        needsHuman: true,
        hasMechanical: true,
        hasSection: true,
        warnings: [],
      },
    });
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/proof:/);
    expect(md).toMatch(/regression: gate test|proof: unbound|proof: human/);
  });

  it('renders L3 truncation warning when inputTruncation is set', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      cheatFindings: [{ kind: 'test-edit', file: 't.ts', detail: 'poll' }],
      reviewerVerdict: {
        ...approved,
        inputTruncation: { diffChars: 120_000, maxChars: 80_000 },
      },
    });
    expect(packet.dod.warnings.some((w) => /L3 read the first 80000 of 120000/.test(w))).toBe(
      true,
    );
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(
      /⚠️ L3 read the first 80000 of 120000 diff chars — the rest was not reviewed/,
    );
    expect(md).not.toMatch(/need not re-read/);
    expect(md).toMatch(/see L3 summary/);
  });

  it('renders gates as a checklist, plus verdict and self-assessment', () => {
    const packet = assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved });
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('hercules/T-1');
    expect(md).toContain('✅');
    expect(md).toContain('typecheck');
    expect(md).toContain('I fixed the retry bug.');
    expect(md).toContain('src/foo.ts');
  });

  it('shows failing gates and reviewer comments', () => {
    const gates = [{ name: 'lint', command: 'eslint', passed: false, output: 'do X to fix' }];
    const verdict: ReviewerVerdict = { approved: false, summary: 'needs work', comments: ['add a test'] };
    const md = renderPacketMarkdown(
      assembleReviewPacket({ ...base, gates, reviewerVerdict: verdict }),
    );
    expect(md).toContain('❌');
    expect(md).toContain('add a test');
  });

  it('flags allowed no-diff runs neutrally (no-diff-ok)', () => {
    const md = renderPacketMarkdown(
      assembleReviewPacket({
        ...base,
        filesTouched: [],
        gates: gatesPass,
        reviewerVerdict: null,
        taskTitle: '分析',
        taskBody: '调研 <!-- hercules:no-diff-ok -->',
        finalReport: 'Summary of findings only.',
        runKind: 'implementer',
      }),
    );
    expect(md).toContain('No file changes');
    expect(md).toMatch(/Allowed for this run|no-diff-ok/i);
    expect(md).not.toMatch(/Delivery check failed/i);
  });

  it('does not show the no-changes note when files were touched', () => {
    const md = renderPacketMarkdown(
      assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved }),
    );
    expect(md).not.toContain('No file changes');
  });

  it('collapses lockfile/dist noise under a summary line', () => {
    const md = renderPacketMarkdown(
      assembleReviewPacket({
        ...base,
        filesTouched: ['src/foo.ts', 'pnpm-lock.yaml', 'dist/out.js'],
        gates: gatesPass,
        reviewerVerdict: approved,
      }),
    );
    expect(md).toContain('`src/foo.ts`');
    expect(md).toMatch(/\+2 noise\/generated/);
    expect(md).toContain('pnpm-lock.yaml');
  });

  it('folds WORKFLOW map hunks out of the inline Diff section', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/WORKFLOW.md b/WORKFLOW.md',
      '--- a/WORKFLOW.md',
      '+++ b/WORKFLOW.md',
      '@@ -1 +1 @@',
      '+huge policy rewrite',
    ].join('\n');
    const md = renderPacketMarkdown(
      assembleReviewPacket({
        ...base,
        filesTouched: ['src/foo.ts', 'WORKFLOW.md'],
        diff,
        gates: gatesPass,
        reviewerVerdict: approved,
      }),
    );
    expect(md).toContain('src/foo.ts');
    expect(md).toContain('+b');
    expect(md).not.toContain('huge policy rewrite');
    expect(md).toMatch(/Folded .*agent-map\/policy/i);
    // Still listed in files touched (primary, not noise).
    expect(md).toContain('`WORKFLOW.md`');
  });

  it('renders the agent activity log when present, and omits the section when empty', () => {
    const withLog = renderPacketMarkdown(
      assembleReviewPacket({
        ...base, gates: gatesPass, reviewerVerdict: approved,
        activityLog: ['Edit src/x.ts', 'Bash: pnpm test'],
      }),
    );
    expect(withLog).toContain('Agent activity');
    expect(withLog).toContain('Edit src/x.ts');
    expect(withLog).toContain('Bash: pnpm test');

    const noLog = renderPacketMarkdown(
      assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved }),
    );
    expect(noLog).not.toContain('Agent activity');
  });

  it('renders cost + tokens when usage is present (full implementer)', () => {
    const md = renderPacketMarkdown(
      assembleReviewPacket({
        ...base, gates: gatesPass, reviewerVerdict: approved,
        usage: { inputTokens: 12000, outputTokens: 3400, costUsd: 0.08 },
        runKind: 'implementer',
      }),
    );
    expect(md).toMatch(/Cost \(full implementer\)/i);
    expect(md).toContain('Full run');
    expect(md).toContain('$0.08');
    expect(md).toContain('12.0k in');
  });

  it('appends cost-cap section when opts.costCapSection is provided', () => {
    const md = renderPacketMarkdown(
      assembleReviewPacket({
        ...base, gates: gatesPass, reviewerVerdict: approved,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
      }),
      {
        costCapSection:
          '**Cost caps**\n\n- Cap level: **soft**\n- ⚠ per-task soft warn: cost $0.50 ≥ $0.40\n',
      },
    );
    expect(md).toContain('**Cost caps**');
    expect(md).toContain('Cap level: **soft**');
  });


  it('labels steer resume cost distinctly from a full run', () => {
    const md = renderPacketMarkdown(
      assembleReviewPacket({
        ...base, gates: gatesPass, reviewerVerdict: approved,
        usage: { inputTokens: 800, outputTokens: 200, costUsd: 0.02 },
        runKind: 'steer',
      }),
    );
    expect(md).toMatch(/Cost \(steer resume\)/i);
    expect(md).toContain('Steer turn');
    expect(md).toContain('$0.02');
    expect(md).toMatch(/session resume/i);
    expect(md).not.toContain('Full run');
  });

  it('renders evidence matrix and L3 skip reason when present', () => {
    const md = renderPacketMarkdown(
      assembleReviewPacket({
        ...base,
        gates: gatesPass,
        reviewerVerdict: null,
        reviewerRan: false,
        reviewerSkipReason: 'L3 disabled (HERCULES_REVIEWER=0)',
        selfAssessment: '- tests pass — ran pnpm test',
        dod: {
          criteria: [
            { text: 'tests pass', kind: 'mechanical', checked: null },
            { text: 'looks good', kind: 'human', checked: null },
          ],
          needsReviewer: false,
          needsHuman: true,
          hasMechanical: true,
          hasSection: true,
          warnings: [],
        },
      }),
    );
    expect(md).toContain('Evidence matrix');
    expect(md).toContain('L3 not run');
    expect(md).toContain('HERCULES_REVIEWER=0');
    expect(md).toMatch(/tests pass/i);
  });

  it('includes full GitHub diff link when provided', () => {
    const md = renderPacketMarkdown(
      assembleReviewPacket({
        ...base,
        gates: gatesPass,
        reviewerVerdict: approved,
        diffUrl: 'https://github.com/o/r/compare/main...hercules/T-1?expand=1',
      }),
    );
    expect(md).toContain('Full diff on GitHub');
    expect(md).toContain('github.com/o/r/compare');
  });

  it('truncates a long activity log in the render (keeps the most recent steps)', () => {
    const log = Array.from({ length: 250 }, (_, i) => `step ${i}`);
    const md = renderPacketMarkdown(
      assembleReviewPacket({ ...base, gates: gatesPass, reviewerVerdict: approved, activityLog: log }),
    );
    expect(md).toContain('250 steps');
    expect(md).toContain('50 earlier steps omitted'); // 250 - last 200
    expect(md).toContain('step 249'); // newest kept
    expect(md).not.toContain('step 0'); // oldest dropped from the render
  });
});

describe('a task that edits WORKFLOW cannot prove its own new boot/gates', () => {
  // Verification reads WORKFLOW from the TRUSTED MIRROR (default branch) by
  // design — a task must not rewrite its own gates. Consequence: a task whose
  // whole point is changing setup.boot runs against the OLD boot, so its L2
  // evidence necessarily fails. l2-control-fixture burned all 3 attempts on an
  // impossible target (2026-07-25). Report the reason; never auto-rework it.
  const wfParts = {
    ...base,
    gates: gatesPass,
    reviewerVerdict: approved,
    filesTouched: ['WORKFLOW.md', 'scripts/l2-seed-control-fixture.mjs'],
    workflowPath: 'WORKFLOW.md',
  };

  it('does not auto-rework when L2 steps fail and the task changed WORKFLOW', () => {
    const packet = assembleReviewPacket({
      ...wfParts,
      evidenceRun: {
        source: 'task',
        ok: false,
        steps: [
          { kind: 'assert', raw: 'assert text=L2 fixture', ok: false, optional: false, detail: 'not found' },
        ],
      },
    });
    expect(packet.autoRework).toBe(false);
    expect(packet.green).toBe(false);
  });

  it('names the reason instead of blaming the change', () => {
    const packet = assembleReviewPacket({
      ...wfParts,
      evidenceRun: {
        source: 'task',
        ok: false,
        steps: [
          { kind: 'assert', raw: 'assert text=L2 fixture', ok: false, optional: false, detail: 'not found' },
        ],
      },
    });
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/WORKFLOW/);
    expect(md).toMatch(/合并后|after merge|可信 main|trusted/i);
  });

  it('a task that does NOT touch WORKFLOW still auto-reworks on failed L2', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      filesTouched: ['src/web/App.tsx'],
      workflowPath: 'WORKFLOW.md',
      evidenceRun: {
        source: 'task',
        ok: false,
        steps: [{ kind: 'assert', raw: 'assert x', ok: false, optional: false, detail: 'no' }],
      },
    });
    expect(packet.autoRework).toBe(true);
  });
});

describe('stale-workflow L2 must not fail evidence-bound mechanical criteria', () => {
  // Third auto-rework path found the hard way: L2 was excused and L3 approved,
  // but the DoD's own "(mechanical) evidence steps all pass" criterion still
  // read the stale run as a failure → mechanical axis fail → auto-rework.
  // l2-control-fixture burned two more attempts (2026-07-27).
  it('treats stale evidence as "did not run", not as a failure', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      filesTouched: ['WORKFLOW.md', 'scripts/seed.mjs'],
      workflowPath: 'WORKFLOW.md',
      dod: {
        criteria: [
          { text: '上述 evidence 步骤全过, 截图里能看到夹具', kind: 'mechanical' as const, checked: false },
        ],
        needsReviewer: false,
        needsHuman: false,
        hasMechanical: true,
        hasSection: true,
        warnings: [],
      },
      evidenceRun: {
        source: 'task',
        ok: false,
        steps: [{ kind: 'assert', raw: 'assert text=fixture', ok: false, optional: false, detail: 'not found' }],
      },
    });
    expect(packet.dod.mechanical).not.toBe('fail');
    expect(packet.autoRework).toBe(false);
  });

  it('trunk-inherited gate fail → mechanical skipped, no auto-rework, packet warns', async () => {
    const { classifyGateFailAttribution, TRUNK_INHERITED_MARKER } = await import(
      '../../src/domain/gateFailAttribution.js'
    );
    const attr = classifyGateFailAttribution({
      gateName: 'held-out-smoke',
      originalCommand: 'cargo test -p guards',
      mergeBase: '7dbb9a39aabbccdd',
      failedTests: ['structural_guards::expected_mcp_pseudo_tool_count'],
      baseResults: [
        {
          testId: 'structural_guards::expected_mcp_pseudo_tool_count',
          failedOnBase: true,
          fromCache: false,
        },
      ],
      filesTouched: ['src/web/App.tsx'],
      rerunCommand: 'cargo test structural_guards::expected_mcp_pseudo_tool_count -- --exact',
    });
    const gates: GateResult[] = [
      {
        name: 'held-out-smoke',
        command: 'cargo test -p guards',
        passed: false,
        output: 'failures:\n    structural_guards::expected_mcp_pseudo_tool_count\n',
      },
    ];
    const packet = assembleReviewPacket({
      ...base,
      gates,
      reviewerVerdict: null,
      gateFailAttribution: attr,
      dod: {
        criteria: [
          { text: 'pnpm check:full green', kind: 'mechanical', checked: false },
          { text: 'look at packet', kind: 'human', checked: false },
        ],
        needsReviewer: false,
        needsHuman: true,
        hasMechanical: true,
        hasSection: true,
        warnings: [],
      },
    });
    expect(packet.dod.mechanical).toBe('skipped');
    expect(packet.autoRework).toBe(false);
    expect(packet.green).toBe(false);
    expect(packet.gateFailAttribution?.outcome).toBe('trunk_inherited');
    const md = renderPacketMarkdown(packet);
    expect(md).toContain(TRUNK_INHERITED_MARKER);
    expect(md).toMatch(/merge-base `7dbb9a39aabb`/);
    expect(md).toMatch(/主干既有问题/);
  });

  it('branch-introduced gate fail keeps auto-rework', async () => {
    const { classifyGateFailAttribution } = await import(
      '../../src/domain/gateFailAttribution.js'
    );
    const attr = classifyGateFailAttribution({
      gateName: 'test',
      originalCommand: 'pnpm test',
      mergeBase: 'aaaaaaaaaaaa',
      failedTests: ['my new break'],
      baseResults: [{ testId: 'my new break', failedOnBase: false, fromCache: false }],
      filesTouched: ['src/foo.ts'],
      rerunCommand: "pnpm exec vitest run -t 'my new break'",
    });
    const packet = assembleReviewPacket({
      ...base,
      gates: [{ name: 'test', command: 'pnpm test', passed: false, output: 'FAIL my new break' }],
      reviewerVerdict: null,
      gateFailAttribution: attr,
    });
    expect(packet.autoRework).toBe(true);
    expect(packet.dod.mechanical).toBe('fail');
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/MUST fix attributed L1 probe first/i);
    expect(md).toContain('my new break');
    expect(md).toContain("pnpm exec vitest run -t 'my new break'");
  });
});

describe('renderPacketMarkdown finalReport back-references (P6)', () => {
  it('adds soft info note for finalReport back-references without gate or autoRework', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      finalReport: 'Shipped as above. See earlier. As discussed.',
    });
    expect(packet.autoRework).toBe(false);
    expect(packet.green).toBe(true);
    expect(packet.gates.some((g) => /back-ref|standalone|final-report/i.test(g.name))).toBe(false);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/back-reference/i);
    expect(md).toMatch(/ℹ️/);
    expect(md).toContain('as above');
    expect(md).toMatch(/Does not block review/i);
  });
  it('omits back-reference soft note for a standalone finalReport', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      finalReport: 'Goal: stand-alone. Changed: foo. Proof: tests. Blocker: none',
    });
    expect(packet.autoRework).toBe(false);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('Agent');
    expect(md).not.toMatch(/back-reference/i);
  });
});
