import { describe, it, expect } from 'vitest';
import {
  assembleReviewPacket,
  renderPacketMarkdown,
} from '../../src/verification/packet.js';
import type { GateResult, ReviewerVerdict } from '../../src/domain/verification.js';
import {
  buildCredibilityChips,
  evidenceEmptyNote,
  extractAgentReport,
  extractEvidenceMedia,
  latestReviewPacketRegion,
  packetCostChip,
  POST_PACKET_H2_HEADINGS,
} from '../../src/web/taskBodySplit.js';

const TASK_ID = 'logout';
const T = 'T';

/** Real packet-shaped excerpt (mirrors test/verification/packet.test.ts L2 emission). */
const PACKET_WITH_SHOTS = `## Review packet

### ${TASK_ID} — \`hercules/${TASK_ID}\`
**✅ automated proof complete** (human Approve still required if human ACs exist)

## 决策摘要

- **改动**:${TASK_ID}(3 个文件改动)
- **可信度**:门禁 6/6 绿 · 独立审稿:通过 · 浏览器行为证据 3 步通过 · CLI行为证据 1 步通过
- **风险**:无标记风险

**Behavioral evidence** *(declarative plan — not label guessing)*

Plan source: \`workflow\` · ✅ all required steps ok

- ✅ \`unlock\` — opened sheet
- ✅ \`assert [data-evidence=review-decide]\` — visible
- ❌ \`assert [data-evidence=missing]\` — not found
- ✅ \`screenshot scene-a\` — wrote
- ✅ \`screenshot scene-b\` — wrote
- ❌ \`screenshot scene-c\` — wrote

_Screenshot: scene-a.png_ (scene: unlock)
![evidence](/api/tasks/${TASK_ID}/screenshots/scene-a.png)
_Screenshot: scene-b.png_
![evidence](/api/tasks/${TASK_ID}/screenshots/scene-b.png)
_Screenshot: scene-c.png_
![evidence](/api/tasks/${TASK_ID}/screenshots/scene-c.png)
`;

describe('extractEvidenceMedia', () => {
  it('maps step-labelled screenshots with ok badges from markers', () => {
    const media = extractEvidenceMedia(PACKET_WITH_SHOTS, TASK_ID);
    expect(media).toHaveLength(3);
    expect(media[0]).toMatchObject({
      kind: 'image',
      name: 'scene-a.png',
      url: `/api/tasks/${TASK_ID}/screenshots/scene-a.png`,
      ok: true,
    });
    expect(media[0]!.label).toMatch(/screenshot scene-a/i);
    expect(media[1]).toMatchObject({ name: 'scene-b.png', ok: true });
    expect(media[2]).toMatchObject({ name: 'scene-c.png', ok: false });
    expect(media[2]!.label).toMatch(/screenshot scene-c/i);
  });

  it('uses file stem and ok=null when no step precedes an image', () => {
    const body = `## Review packet
![evidence](/api/tasks/${TASK_ID}/screenshots/orphan.png)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toEqual([
      {
        kind: 'image',
        name: 'orphan.png',
        url: `/api/tasks/${TASK_ID}/screenshots/orphan.png`,
        label: 'orphan',
        ok: null,
      },
    ]);
  });

  it('parses a video link as kind=video', () => {
    const body = `## Review packet
- ✅ \`record clip\` — saved
![clip](/api/tasks/${TASK_ID}/screenshots/clip.webm)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      kind: 'video',
      name: 'clip.webm',
      label: expect.stringMatching(/record clip/i),
      ok: true,
    });
  });

  it('pairs CLI artifact lines (✅ cli <stepId>) with image and video tiles', () => {
    const body = `## CLI behavioral evidence

- OK \`web-console-flow\` status=\`passed\` exit=0 12ms
- ✅ cli web-console-flow
![evidence](/api/tasks/${TASK_ID}/screenshots/cli-web-console-flow-shot.png)
- ✅ cli web-console-flow
[video: cli-web-console-flow-clip.webm](/api/tasks/${TASK_ID}/screenshots/cli-web-console-flow-clip.webm)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toHaveLength(2);
    expect(media[0]).toMatchObject({
      kind: 'image',
      name: 'cli-web-console-flow-shot.png',
      label: expect.stringMatching(/^cli web-console-flow$/i),
      ok: true,
    });
    expect(media[1]).toMatchObject({
      kind: 'video',
      name: 'cli-web-console-flow-clip.webm',
      label: expect.stringMatching(/^cli web-console-flow$/i),
      ok: true,
    });
  });

  it('dedupes by name preserving first occurrence order', () => {
    const body = `## Review packet
- ✅ screenshot dup — ok
![evidence](/api/tasks/${TASK_ID}/screenshots/dup.png)
- ❌ screenshot other — fail
![evidence](/api/tasks/${TASK_ID}/screenshots/dup.png)
![evidence](/api/tasks/${TASK_ID}/screenshots/other.png)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media.map((m) => m.name)).toEqual(['dup.png', 'other.png']);
    expect(media[0]!.ok).toBe(true);
    expect(media[0]!.label).toMatch(/screenshot dup/i);
    expect(media[1]).toMatchObject({ name: 'other.png', ok: false });
  });

  it('ignores screenshots belonging to another task id', () => {
    const body = `## Review packet
- ✅ screenshot mine — ok
![evidence](/api/tasks/${TASK_ID}/screenshots/mine.png)
- ✅ screenshot theirs — ok
![evidence](/api/tasks/other-task/screenshots/theirs.png)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toHaveLength(1);
    expect(media[0]!.name).toBe('mine.png');
  });

  it('does not guess from proximity when step text does not name the file', () => {
    const body = `## Review packet
- ✅ only-one-step — ok
![evidence](/api/tasks/${TASK_ID}/screenshots/a.png)
![evidence](/api/tasks/${TASK_ID}/screenshots/b.png)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media[0]).toMatchObject({ name: 'a.png', label: 'a', ok: null });
    expect(media[1]).toMatchObject({ name: 'b.png', label: 'b', ok: null });
  });

  it('pairs via unique exact screenshot stem (checkout ≠ checkout-after)', () => {
    // Reviewer B2 reproduction: substring must not steal the later step's badge.
    const body = `## Review packet
- ❌ \`screenshot checkout\` — wrote
- ✅ \`screenshot checkout-after\` — wrote
_Screenshot: checkout.png_
![evidence](/api/tasks/${TASK_ID}/screenshots/checkout.png)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      name: 'checkout.png',
      ok: false,
    });
    expect(media[0]!.label).toMatch(/screenshot checkout(?!-after)/i);
  });

  it('pairs a uniquely named screenshot step (exact stem)', () => {
    const body = `## Review packet
- ✅ \`screenshot scene-a\` — wrote
![evidence](/api/tasks/${TASK_ID}/screenshots/scene-a.png)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      kind: 'image',
      name: 'scene-a.png',
      url: `/api/tasks/${TASK_ID}/screenshots/scene-a.png`,
      ok: true,
    });
    expect(media[0]!.label).toMatch(/screenshot scene-a/i);
  });

  it('leaves ok=null when two identical screenshot steps match the same file', () => {
    const body = `## Review packet
- ❌ \`screenshot twin\` — first
- ✅ \`screenshot twin\` — second
_Screenshot: twin.png_
![evidence](/api/tasks/${TASK_ID}/screenshots/twin.png)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toEqual([
      {
        kind: 'image',
        name: 'twin.png',
        url: `/api/tasks/${TASK_ID}/screenshots/twin.png`,
        label: 'twin',
        ok: null,
      },
    ]);
  });

  it('accepts bare /api/… screenshot links (not only markdown images)', () => {
    const body = `See /api/tasks/${TASK_ID}/screenshots/bare.png for proof.`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toEqual([
      {
        kind: 'image',
        name: 'bare.png',
        url: `/api/tasks/${TASK_ID}/screenshots/bare.png`,
        label: 'bare',
        ok: null,
      },
    ]);
  });

  // ── Reviewer findings B2 / N5 — fail-closed probes (verbatim) ──────────

  it('B2a: longer CLI step id does not steal a shorter prefix match; conflict → unlabeled', () => {
    const body =
      '- ✅ cli flow\n' +
      `![evidence](/api/tasks/${T}/screenshots/cli-flow-extra-shot.png)\n` +
      '- ❌ cli flow-extra';
    const media = extractEvidenceMedia(body, T);
    expect(media).toEqual([
      {
        kind: 'image',
        name: 'cli-flow-extra-shot.png',
        url: `/api/tasks/${T}/screenshots/cli-flow-extra-shot.png`,
        label: 'cli-flow-extra-shot',
        ok: null,
      },
    ]);
  });

  it('B2b: captions never bind; conflicting markers at the image → unlabeled', () => {
    const body =
      '- ✅ screenshot shot\n' +
      '_Screenshot: shot.png_\n' +
      '- ❌ screenshot shot\n' +
      `![evidence](/api/tasks/${T}/screenshots/shot.png)`;
    const media = extractEvidenceMedia(body, T);
    expect(media).toEqual([
      {
        kind: 'image',
        name: 'shot.png',
        url: `/api/tasks/${T}/screenshots/shot.png`,
        label: 'shot',
        ok: null,
      },
    ]);
  });

  it('B2c: only the latest review-packet region is scanned', () => {
    const body =
      '## Review packet\n' +
      '- ✅ screenshot shot\n' +
      `![evidence](/api/tasks/${T}/screenshots/shot.png)\n` +
      '## Review packet\n' +
      '- ❌ screenshot shot\n' +
      `![evidence](/api/tasks/${T}/screenshots/shot.png)`;
    const media = extractEvidenceMedia(body, T);
    expect(media).toHaveLength(1);
    expect(media[0]).toMatchObject({
      name: 'shot.png',
      label: expect.stringMatching(/screenshot shot/i),
      ok: false,
    });
  });

  it('B2d: task id in URL is case-sensitive (T ≠ t)', () => {
    const body =
      '- ✅ screenshot shot\n' +
      '![evidence](/api/tasks/t/screenshots/shot.png)';
    const media = extractEvidenceMedia(body, T);
    expect(media).toEqual([]);
  });

  it('N5: identical non-CLI markers are ambiguous — both files unlabeled', () => {
    const body =
      '- ✅ screenshot shot\n' +
      '- ✅ screenshot shot\n' +
      `![evidence](/api/tasks/${T}/screenshots/shot.png)\n` +
      `![evidence](/api/tasks/${T}/screenshots/shot.webp)`;
    const media = extractEvidenceMedia(body, T);
    expect(media).toEqual([
      {
        kind: 'image',
        name: 'shot.png',
        url: `/api/tasks/${T}/screenshots/shot.png`,
        label: 'shot',
        ok: null,
      },
      {
        kind: 'image',
        name: 'shot.webp',
        url: `/api/tasks/${T}/screenshots/shot.webp`,
        label: 'shot',
        ok: null,
      },
    ]);
  });

  it('pairs two different CLI steps each with one artifact', () => {
    const body = `## Review packet
- ✅ cli step-a
![evidence](/api/tasks/${TASK_ID}/screenshots/cli-step-a-one.png)
- ✅ cli step-b
![evidence](/api/tasks/${TASK_ID}/screenshots/cli-step-b-two.png)
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toHaveLength(2);
    expect(media[0]).toMatchObject({
      name: 'cli-step-a-one.png',
      label: 'cli step-a',
      ok: true,
    });
    expect(media[1]).toMatchObject({
      name: 'cli-step-b-two.png',
      label: 'cli step-b',
      ok: true,
    });
  });

  it('pairs when the CLI marker appears after its media (same id, same verdict)', () => {
    const body = `## Review packet
![evidence](/api/tasks/${TASK_ID}/screenshots/cli-late-shot.png)
- ✅ cli late
`;
    const media = extractEvidenceMedia(body, TASK_ID);
    expect(media).toEqual([
      {
        kind: 'image',
        name: 'cli-late-shot.png',
        url: `/api/tasks/${TASK_ID}/screenshots/cli-late-shot.png`,
        label: 'cli late',
        ok: true,
      },
    ]);
  });

  it('latestReviewPacketRegion continues through embedded agent ## headings; stops at post-packet trail', () => {
    expect(POST_PACKET_H2_HEADINGS).toContain('Teardown');
    expect(POST_PACKET_H2_HEADINGS).toContain('Human steer');
    expect(POST_PACKET_H2_HEADINGS).not.toContain('决策摘要');
    expect(POST_PACKET_H2_HEADINGS).not.toContain('Host operation receipt');
    expect(POST_PACKET_H2_HEADINGS).not.toContain('CLI behavioral evidence');
    const body = `## Review packet
### x
## 决策摘要
- **改动**:ok
## CLI behavioral evidence
- ✅ cli z
![evidence](/api/tasks/${TASK_ID}/screenshots/cli-z-a.png)
## Implementation
agent prose — must stay in region
## Teardown
gone
`;
    const region = latestReviewPacketRegion(body);
    expect(region).toMatch(/决策摘要/);
    expect(region).toMatch(/CLI behavioral evidence/);
    expect(region).toMatch(/cli-z-a\.png/);
    expect(region).toMatch(/## Implementation/);
    expect(region).not.toMatch(/## Teardown/);
  });

  it('B2: real renderPacketMarkdown with heading-bearing finalReport keeps media + report', () => {
    const gates: GateResult[] = [
      { name: 'typecheck', command: 'tsc', passed: true, output: '' },
      { name: 'test', command: 'vitest', passed: true, output: '' },
    ];
    const approved: ReviewerVerdict = {
      approved: true,
      summary: 'good',
      comments: [],
    };
    const packet = assembleReviewPacket({
      taskId: T,
      branch: `hercules/${T}`,
      filesTouched: ['src/web/taskBodySplit.ts'],
      diffSummary: '1 file changed',
      cheatFindings: [],
      selfAssessment: 'ok',
      gates,
      reviewerVerdict: approved,
      screenshots: ['shot.png'],
      finalReport:
        '## Implementation\nImplemented change.\n## Verification\nTests passed.',
    });
    const md = '## Review packet\n\n' + renderPacketMarkdown(packet);
    expect(md).toMatch(/\/api\/tasks\/T\/screenshots\/shot\.png/);
    const media = extractEvidenceMedia(md, T);
    expect(media).toEqual([
      {
        kind: 'image',
        name: 'shot.png',
        url: `/api/tasks/${T}/screenshots/shot.png`,
        label: 'shot',
        ok: null,
      },
    ]);
    const report = extractAgentReport(md);
    expect(report).toMatch(/## Implementation/);
    expect(report).toMatch(/Implemented change/);
    expect(report).toMatch(/## Verification/);
    expect(report).toMatch(/Tests passed/);
  });

  it('B2c: two packets — region / media / report select the last only', () => {
    const old = `## Review packet
### old
## 决策摘要
- **可信度**:门禁 6/6 绿 · 独立审稿:通过
![evidence](/api/tasks/${T}/screenshots/old.png)
**Agent's report**
## Old heading
old report
`;
    const neu = `## Review packet
### new
## 决策摘要
- **可信度**:门禁 0/6 绿 · 独立审稿:要求修改
![evidence](/api/tasks/${T}/screenshots/new.png)
**Agent's report**
## New heading
new report
## Teardown
trail
`;
    const body = `${old}\n\n${neu}`;
    const region = latestReviewPacketRegion(body);
    expect(region).toMatch(/### new/);
    expect(region).toMatch(/new\.png/);
    expect(region).toMatch(/## New heading/);
    expect(region).not.toMatch(/old\.png/);
    expect(region).not.toMatch(/## Teardown/);
    expect(extractEvidenceMedia(body, T).map((m) => m.name)).toEqual(['new.png']);
    expect(extractAgentReport(body)).toMatch(/new report/);
    expect(extractAgentReport(body)).not.toMatch(/old report/);
  });
});

describe('extractAgentReport (N6)', () => {
  it('returns the report from a real renderPacketMarkdown body', () => {
    const gates: GateResult[] = [
      { name: 'typecheck', command: 'tsc', passed: true, output: '' },
      { name: 'test', command: 'vitest', passed: true, output: '' },
    ];
    const approved: ReviewerVerdict = {
      approved: true,
      summary: 'good',
      comments: [],
    };
    const packet = assembleReviewPacket({
      taskId: 'agent-report-probe',
      branch: 'hercules/agent-report-probe',
      filesTouched: ['src/web/taskBodySplit.ts'],
      diffSummary: '1 file changed',
      cheatFindings: [],
      selfAssessment: 'ok',
      gates,
      reviewerVerdict: approved,
      finalReport: 'Implemented fail-closed pairing.\nSecond line of report.',
    });
    const md = '## Review packet\n\n' + renderPacketMarkdown(packet);
    const report = extractAgentReport(md);
    expect(report).toMatch(/Implemented fail-closed pairing/);
    expect(report).toMatch(/Second line of report/);
  });
});

describe('POST_PACKET_H2_HEADINGS pin', () => {
  it('pins the hand-verified post-packet stem list', () => {
    // Keep in sync with the emitter citations on POST_PACKET_H2_HEADINGS.
    expect([...POST_PACKET_H2_HEADINGS]).toEqual([
      'Teardown',
      'Human steer',
      'Steer result',
      'Run failure',
      'Salvage brief',
      'Thrash brake',
      'Auto-rework',
      'Attempts exhausted',
      'System recovery',
      'Cost cap',
      'Clean salvage provenance',
      'Switch stop',
      'Agent switch',
      'Re-verify',
      'Pending human steer',
      'Host operation replay blocked',
      'Dependency preflight recovery hold',
      'Adapter failover',
      'Adapter start blocked',
      'Operator override',
      'Auto-merge',
      'Merge failure',
      'ALERT',
      'Session abandoned',
      'From Remote Control',
      'Factory PR',
      'System steer',
      'Self-heal',
      'Run timeline',
      'Provision blocked',
      'Mirror branch',
      'Pipeline',
      'Proposed graph',
      'Provider session recovery',
      'Reviewer infrastructure recovery',
      'Path-lease scope blocked',
      'Protected path (pre-dispatch)',
      'Execution policy blocked (pre-dispatch)',
      'Adapter capability receipt',
      'Path lease owner bind blocked',
      'Finalize skipped state write',
      'Path lease blocked (pre-dispatch)',
      'Cancellation audit',
      'Task-ref ownership',
      'Host operation approval',
      'Host execution started',
      'Project-state closure',
      'Platform remediation',
      'Bootstrap escalation (platform-external rescue)',
    ]);
  });
});

describe('region-aware chips (N2 / N3)', () => {
  it('N2: packetCostChip reads Cost after ## 决策摘要 in the latest region', () => {
    const body = `## Review packet
### x
**✅ automated proof complete**

## 决策摘要

- **改动**:x(1 个文件改动)
- **可信度**:门禁 1/1 绿 · 独立审稿:通过

**Cost (full implementer)**
💰 **Full run** $0.42 · 1.0k in / 0.2k out
`;
    const chip = packetCostChip(body);
    expect(chip?.kind).toBe('implementer');
    expect(chip?.amount).toBe('0.42');
    expect(chip?.label).toMatch(/Full run \$0\.42/);
  });

  it('N3: buildCredibilityChips uses the latest packet 决策摘要, not an older one', () => {
    const body = `## Review packet
### old
## 决策摘要
- **改动**:old(6 个文件改动)
- **可信度**:门禁 6/6 绿 · 独立审稿:通过 · 浏览器行为证据 1 步通过 · CLI行为证据 1 步通过

## Review packet
### new
## 决策摘要
- **改动**:new(0 个文件改动)
- **可信度**:门禁 0/6 绿 · 独立审稿:要求修改 · 浏览器行为证据未运行 · CLI行为证据未运行
`;
    const chips = buildCredibilityChips(body, null);
    expect(chips.find((c) => c.kind === 'gates')?.label).toBe('门禁 0/6');
    expect(chips.find((c) => c.kind === 'reviewer')?.label).toBe('审稿 要求修改');
  });
});

describe('buildCredibilityChips', () => {
  it('builds chips from a decision card', () => {
    const chips = buildCredibilityChips('', {
      gates: [
        { passed: true },
        { passed: true },
        { passed: false },
        { passed: true, outcome: 'skipped' },
      ],
      evidence: { ran: true, ok: true, steps: 3 },
      reviewer: { ran: true, approved: true },
      filesTouched: 4,
    });
    expect(chips.find((c) => c.kind === 'gates')?.label).toBe('门禁 2/3');
    expect(chips.find((c) => c.kind === 'reviewer')?.label).toBe('审稿 通过');
    expect(chips.find((c) => c.kind === 'behavioral')?.label).toBe('行为证据 3 步 ✓');
    expect(chips.find((c) => c.kind === 'cli')?.label).toBe('CLI证据 未运行');
    expect(chips.find((c) => c.kind === 'files')?.label).toBe('改动 4 文件');
  });

  it('falls back to the packet 可信度 line when no card', () => {
    const chips = buildCredibilityChips(PACKET_WITH_SHOTS, null);
    expect(chips.find((c) => c.kind === 'gates')?.label).toBe('门禁 6/6');
    expect(chips.find((c) => c.kind === 'reviewer')?.label).toBe('审稿 通过');
    expect(chips.find((c) => c.kind === 'behavioral')?.label).toBe('行为证据 3 步 ✓');
    expect(chips.find((c) => c.kind === 'cli')?.label).toBe('CLI证据 ✓');
    expect(chips.find((c) => c.kind === 'files')?.label).toBe('改动 3 文件');
  });
});

describe('evidenceEmptyNote', () => {
  it('includes skip reason when present', () => {
    expect(
      evidenceEmptyNote('', { evidence: { ran: false, skipReason: '浏览器证据不适用' } }),
    ).toBe('无截图证据 · 浏览器证据不适用');
  });

  it('falls back to a plain muted note', () => {
    expect(evidenceEmptyNote('no packet', null)).toBe('无截图证据');
  });
});
