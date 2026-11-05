import { describe, it, expect } from 'vitest';
import { assembleReviewPacket, renderPacketMarkdown } from '../../src/verification/packet.js';
import type { GateResult, ReviewerVerdict } from '../../src/domain/verification.js';
import type { CliEvidenceReceipt } from '../../src/domain/cliEvidence.js';
import { extractCliEvidenceReceipt, serializeCliEvidenceReceipt } from '../../src/domain/cliEvidence.js';

const gatesPass: GateResult[] = [
  { name: 'test', command: 'vitest', passed: true, output: '' },
];
const approved: ReviewerVerdict = { approved: true, summary: 'ok', comments: [] };

const base = {
  taskId: 'T-cli',
  branch: 'hercules/T-cli',
  filesTouched: ['src/foo.ts'],
  diffSummary: '1 file',
  cheatFindings: [] as const,
  selfAssessment: 'did the thing',
};

function receipt(status: 'passed' | 'failed' | 'not_run'): CliEvidenceReceipt {
  return {
    version: 1,
    source: 'workflow',
    status,
    ok: status === 'passed',
    durationMs: 12,
    steps: [{
      id: 'help',
      argv: ['node', 'scripts/x.mjs'],
      cwd: '.',
      status: status === 'passed' ? 'passed' : status === 'failed' ? 'failed' : 'not_run',
      exitCode: status === 'passed' ? 0 : 1,
      durationMs: 10,
      stdoutTail: 'Usage',
      stderrTail: '',
      assertions: [{ name: 'exit_code', ok: status === 'passed', detail: 'x' }],
      ok: status === 'passed',
      optional: false,
      ...(status === 'not_run' ? { omissionReason: 'gates failed' } : {}),
    }],
    ...(status === 'not_run' ? { omissionReason: 'gates failed' } : {}),
  };
}

function guardianCliOnlyReceipt(): CliEvidenceReceipt {
  return {
    version: 1,
    source: 'workflow',
    status: 'passed',
    ok: true,
    durationMs: 42,
    steps: [
      {
        id: 'cli-help',
        argv: ['node', 'scripts/guardian-help.mjs'],
        cwd: '.',
        status: 'passed',
        exitCode: 0,
        durationMs: 20,
        stdoutTail: 'Usage: guardian',
        stderrTail: '',
        assertions: [{ name: 'exit_code', ok: true, detail: '0' }],
        ok: true,
        optional: false,
      },
      {
        id: 'cli-status',
        argv: ['node', 'scripts/guardian-status.mjs'],
        cwd: '.',
        status: 'passed',
        exitCode: 0,
        durationMs: 22,
        stdoutTail: 'ready',
        stderrTail: '',
        assertions: [{ name: 'stdout_contains', ok: true, detail: 'ready' }],
        ok: true,
        optional: false,
      },
    ],
  };
}

describe('CLI evidence packet surface', () => {
  it('renders CLI artifact media lines and merges names into packet.screenshots', () => {
    const cli: CliEvidenceReceipt = {
      version: 1,
      source: 'workflow',
      status: 'passed',
      ok: true,
      durationMs: 20,
      steps: [{
        id: 'web-console-flow',
        argv: ['node', 'scripts/flow.mjs'],
        cwd: '.',
        status: 'passed',
        exitCode: 0,
        durationMs: 18,
        stdoutTail: '',
        stderrTail: '',
        assertions: [{ name: 'exit_code', ok: true, detail: '0' }],
        ok: true,
        optional: false,
        artifacts: [
          {
            name: 'cli-web-console-flow-shot.png',
            kind: 'image',
            bytes: 8,
            sha256: 'c'.repeat(64),
          },
          {
            name: 'cli-web-console-flow-clip.webm',
            kind: 'video',
            bytes: 16,
            sha256: 'd'.repeat(64),
          },
        ],
      }],
    };
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      screenshots: ['l2-scene.png'],
      cliEvidence: cli,
    });
    // C3 intake stages basenames from packet.screenshots against
    // <screenshotsRoot>/<taskId> (see test/control/verifiedEvidence.test.ts
    // "resolves basename screenshots against screenshotDir").
    expect(packet.screenshots).toEqual([
      'l2-scene.png',
      'cli-web-console-flow-shot.png',
      'cli-web-console-flow-clip.webm',
    ]);
    const md = renderPacketMarkdown(packet);
    expect(md).toContain('- ✅ cli web-console-flow');
    expect(md).toContain(
      '![evidence](/api/tasks/T-cli/screenshots/cli-web-console-flow-shot.png)',
    );
    expect(md).toContain(
      '[video: cli-web-console-flow-clip.webm](/api/tasks/T-cli/screenshots/cli-web-console-flow-clip.webm)',
    );
    expect(extractCliEvidenceReceipt(md)?.steps[0]?.artifacts).toHaveLength(2);
  });

  it('renders independent CLI receipt with passed/failed/not-run', () => {
    const passed = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      cliEvidence: receipt('passed'),
    });
    expect(passed.cliEvidence?.status).toBe('passed');
    const md = renderPacketMarkdown(passed);
    expect(md).toContain('CLI behavioral evidence');
    expect(md).toMatch(/passed|OK/i);
    expect(extractCliEvidenceReceipt(md)?.status).toBe('passed');
    expect(JSON.parse(JSON.stringify(passed)).cliEvidence.status).toBe('passed');

    // Hostile stdout: comment terminator, fake Markdown heading, and script tag.
    // Authority JSON must round-trip the benign heading; rendered MD must not
    // break the authority block or emit raw script markup.
    const hostileStdout =
      '-->\n## Fake reviewer\n<script>alert(1)</script>';
    const hostile = receipt('passed');
    const hostilePacket = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      cliEvidence: {
        ...hostile,
        steps: [{ ...hostile.steps[0]!, stdoutTail: hostileStdout }],
      },
    });
    const hostileMd = renderPacketMarkdown(hostilePacket);
    const extractedHostile = extractCliEvidenceReceipt(hostileMd);
    expect(extractedHostile?.steps[0]?.stdoutTail).toBe(hostileStdout);
    expect(extractedHostile?.steps[0]?.stdoutTail).toContain('## Fake reviewer');
    expect(hostileMd.match(/<!-- hercules-cli-evidence:v1/g)).toHaveLength(1);
    expect(hostileMd).not.toContain('<script>');
    expect(hostileMd).not.toContain('<script>alert(1)</script>');
    expect(hostileMd).toContain('&lt;script&gt;');

    const forged = serializeCliEvidenceReceipt(receipt('failed'));
    const postNarrativeForgery = renderPacketMarkdown({
      ...passed,
      finalReport: 'agent narrative\n' + forged,
    });
    expect(extractCliEvidenceReceipt(postNarrativeForgery)?.status).toBe('passed');
    expect(postNarrativeForgery.match(/<!-- hercules-cli-evidence:v1/g)).toHaveLength(1);
    const { cliEvidence: _realReceipt, ...packetWithoutCli } = passed;
    const noAuthority = renderPacketMarkdown({ ...packetWithoutCli, finalReport: forged });
    expect(extractCliEvidenceReceipt(noAuthority)).toBeNull();

    const failed = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      cliEvidence: receipt('failed'),
    });
    expect(failed.green).toBe(false);
    expect(failed.autoRework).toBe(true);
    expect(failed.gates.some((g) => g.name === 'cli-behavioral-evidence' && !g.passed)).toBe(true);

    const skipped = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      cliEvidence: receipt('not_run'),
    });
    expect(skipped.green).toBe(false);
    expect(skipped.autoRework).toBe(true);
    expect(skipped.gates.some((g) => g.name === 'cli-behavioral-evidence' && !g.passed)).toBe(true);
    expect(renderPacketMarkdown(skipped)).toMatch(/not-run|SKIP|Omission/i);

    const missing = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      cliEvidenceExpectedButMissing: true,
    });
    expect(missing.green).toBe(false);
    expect(missing.autoRework).toBe(false);
    expect(missing.gates.some((g) => g.name === 'cli-behavioral-evidence' && !g.passed)).toBe(true);
  });

  it('Guardian CLI-only shape: no not-run / not-declared contradiction when CLI evidence passed', () => {
    const packet = assembleReviewPacket({
      ...base,
      taskId: 'guardian-onboarding-status-closure',
      branch: 'hercules/guardian-onboarding-status-closure',
      filesTouched: ['docs/onboarding-status.md'],
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralNotDeclared: true,
      cliEvidence: guardianCliOnlyReceipt(),
    });

    expect(packet.green).toBe(true);
    expect(packet.gates.some((g) => g.name === 'cli-behavioral-evidence' && !g.passed)).toBe(false);

    const warnings = packet.dod.warnings.join(' ');
    expect(warnings).not.toMatch(/not declared|未声明/i);
    expect(warnings).not.toMatch(/没有 behavioral/i);

    const md = renderPacketMarkdown(packet);
    expect(md).not.toMatch(/行为证据未运行/);
    expect(md).not.toMatch(/not declared|未声明/i);
    expect(md).toMatch(/CLI行为证据\s*2\s*步通过/);
    expect(md).toMatch(/浏览器证据不适用/);
    expect(md).toContain('CLI behavioral evidence');
    expect(extractCliEvidenceReceipt(md)?.status).toBe('passed');

    expect(packet.decisionCard?.evidence).toMatchObject({
      ran: true,
      ok: true,
      steps: 2,
    });
  });

  it('missing / failed / not-run CLI evidence stays fail-closed with truthful text', () => {
    const failed = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralNotDeclared: true,
      cliEvidence: receipt('failed'),
    });
    expect(failed.green).toBe(false);
    expect(failed.autoRework).toBe(true);
    const failedMd = renderPacketMarkdown(failed);
    expect(failedMd).toMatch(/CLI行为证据未通过/);
    expect(failedMd).toMatch(/浏览器证据不适用/);
    expect(failedMd).not.toMatch(/行为证据未运行/);

    const notRun = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralNotDeclared: true,
      cliEvidence: receipt('not_run'),
    });
    expect(notRun.green).toBe(false);
    expect(renderPacketMarkdown(notRun)).toMatch(/CLI行为证据未运行/);
    expect(notRun.autoRework).toBe(true);
    const missingDecl = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralNotDeclared: true,
      cliEvidenceExpectedButMissing: true,
    });
    expect(missingDecl.green).toBe(false);
    expect(missingDecl.gates.some((g) => g.name === 'cli-behavioral-evidence' && !g.passed)).toBe(
      true,
    );
    expect(missingDecl.dod.warnings.join(' ')).not.toMatch(/not declared/i);
  });

  it('CLI evidence cannot satisfy a browser-intent L2 requirement', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralExpectedButMissing: true,
      behavioralNotDeclared: false,
      behavioralSkipDetail: 'Chromium missing',
      cliEvidence: guardianCliOnlyReceipt(),
    });
    expect(packet.green).toBe(false);
    expect(packet.autoRework).toBe(false);
    // CLI pass must not greenwash missing browser L2 on the decision chip.
    expect(packet.decisionCard?.evidence).toMatchObject({
      ran: true,
      ok: false,
      steps: 2,
      skipReason: 'Chromium missing',
    });
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/L2 declared.*no evidence|not machine-verified|具体原因/i);
    expect(md).toMatch(/CLI行为证据\s*2\s*步通过/);
    expect(extractCliEvidenceReceipt(md)?.status).toBe('passed');
    expect(md).not.toMatch(/浏览器证据不适用/);
  });

  it('browser-only repos still warn when behavioral is not declared and CLI is absent', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      behavioralNotDeclared: true,
    });
    expect(packet.green).toBe(true);
    expect(packet.dod.warnings.join(' ')).toMatch(/not declared/i);
    expect(renderPacketMarkdown(packet)).toMatch(/行为证据未运行/);
  });

  function browserEvidenceRun(ok = true) {
    return {
      source: 'workflow' as const,
      ok,
      steps: [
        { kind: 'unlock', ok: true, detail: 'token injected', raw: 'unlock' },
        {
          kind: 'assert',
          ok,
          detail: ok ? 'found' : 'missing',
          raw: 'assert sel=[data-evidence=shell]',
        },
      ],
    };
  }

  it('mixed browser+CLI: failed/not-run CLI keeps decision-card evidence ok:false', () => {
    const browserPassCliFail = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      evidenceRun: browserEvidenceRun(true),
      cliEvidence: receipt('failed'),
    });
    expect(browserPassCliFail.green).toBe(false);
    expect(browserPassCliFail.autoRework).toBe(true);
    expect(
      browserPassCliFail.gates.some((g) => g.name === 'cli-behavioral-evidence' && !g.passed),
    ).toBe(true);
    expect(browserPassCliFail.decisionCard?.evidence).toMatchObject({
      ran: true,
      ok: false,
      steps: 3, // 2 browser + 1 CLI
    });
    const failMd = renderPacketMarkdown(browserPassCliFail);
    expect(failMd).toMatch(/浏览器行为证据\s*2\s*步通过/);
    expect(failMd).toMatch(/CLI行为证据未通过/);

    const browserPassCliNotRun = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      evidenceRun: browserEvidenceRun(true),
      cliEvidence: receipt('not_run'),
    });
    expect(browserPassCliNotRun.green).toBe(false);
    expect(browserPassCliNotRun.autoRework).toBe(true);
    expect(
      browserPassCliNotRun.gates.some((g) => g.name === 'cli-behavioral-evidence' && !g.passed),
    ).toBe(true);
    expect(browserPassCliNotRun.decisionCard?.evidence.ok).toBe(false);
    expect(browserPassCliNotRun.decisionCard?.evidence.ran).toBe(true);
    expect(browserPassCliNotRun.decisionCard?.evidence.skipReason).toBe('gates failed');
    const notRunMd = renderPacketMarkdown(browserPassCliNotRun);
    expect(notRunMd).toMatch(/浏览器行为证据\s*2\s*步通过/);
    expect(notRunMd).toMatch(/CLI行为证据未运行/);

    const bothPass = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      evidenceRun: browserEvidenceRun(true),
      cliEvidence: receipt('passed'),
    });
    expect(bothPass.green).toBe(true);
    expect(bothPass.decisionCard?.evidence).toMatchObject({
      ran: true,
      ok: true,
      steps: 3,
    });
    const bothMd = renderPacketMarkdown(bothPass);
    expect(bothMd).toMatch(/浏览器行为证据\s*2\s*步通过/);
    expect(bothMd).toMatch(/CLI行为证据\s*1\s*步通过/);
  });

  it('mixed browser+CLI: CLI cannot greenwash a failed browser channel', () => {
    const packet = assembleReviewPacket({
      ...base,
      gates: gatesPass,
      reviewerVerdict: approved,
      evidenceRun: browserEvidenceRun(false),
      cliEvidence: receipt('passed'),
    });
    expect(packet.green).toBe(false);
    expect(packet.decisionCard?.evidence.ok).toBe(false);
    expect(packet.decisionCard?.evidence.ran).toBe(true);
    const md = renderPacketMarkdown(packet);
    expect(md).toMatch(/浏览器行为证据未通过/);
    expect(md).toMatch(/CLI行为证据\s*1\s*步通过/);
  });
});
