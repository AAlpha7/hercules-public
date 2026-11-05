import { describe, it, expect } from 'vitest';
import { parseDefinitionOfDone } from '../../src/domain/acceptance.js';
import {
  buildImplementerBrief,
  renderImplementerTaskBody,
  VERIFICATION_DIGEST_HEADING,
  IMPLEMENTER_DIGEST_MAX_CHARS,
} from '../../src/domain/implementerBrief.js';
import type { GateResult, ReviewerVerdict } from '../../src/domain/verification.js';
import { withReviewPacket } from '../../src/orchestrator/orchestrator.js';
import {
  assembleReviewPacket,
  renderPacketMarkdown,
} from '../../src/verification/packet.js';

const PRODUCT_BRIEF = `## Task
Ship the zh copy for the settings panel.

## Acceptance criteria
- [ ] (mechanical) gates green @gate:all
- [ ] (reviewer) copy reads natural
- [ ] (human) ship
`;

const FINAL_REPORT_SENTENCE =
  'UNIQUE_FINAL_REPORT_SENTENCE_do_not_leak_into_digest';

function realisticBody(): string {
  const dod = parseDefinitionOfDone(PRODUCT_BRIEF);
  const gates: GateResult[] = [
    { name: 'typecheck', command: 'pnpm typecheck', passed: true, output: '' },
    {
      name: 'test',
      command: 'pnpm test',
      passed: false,
      output: 'FAIL  test/foo.test.ts\nAssertionError: expected true to be false\nfailing-gate-output-marker',
    },
  ];
  const reviewer: ReviewerVerdict = {
    approved: false,
    summary: 'needs zh polish',
    comments: ['L3-comment-keep-zh-tone', 'fix the missing aria label'],
    report: 'Reviewer looked at the settings panel copy and wants revisions.',
  };
  const packet = assembleReviewPacket({
    taskId: 'T-p5',
    branch: 'hercules/T-p5',
    filesTouched: ['src/web/Settings.tsx'],
    diffSummary: '1 file changed, 12 insertions(+)',
    diff: `diff --git a/src/web/Settings.tsx b/src/web/Settings.tsx
--- a/src/web/Settings.tsx
+++ b/src/web/Settings.tsx
@@ -1,3 +1,4 @@
 export function Settings() {
+  // +secret-hunk-marker
   return <div>设置</div>;
 }
`,
    gates,
    cheatFindings: [
      {
        kind: 'test-edit',
        file: 'test/foo.test.ts',
        detail: 'cheat-finding-marker edits a test file',
      },
    ],
    screenshots: [],
    reviewerVerdict: reviewer,
    reviewerRan: true,
    selfAssessment: `I think it is done.
**Result:** PASS-ish
Evidence: looked at the panel.`,
    finalReport: `Here is what I did.\n${FINAL_REPORT_SENTENCE}\nThanks.`,
    dod,
    usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.42 },
    activityLog: ['tool:read Settings.tsx', 'tool:edit Settings.tsx'],
  });
  const md = renderPacketMarkdown(packet);
  let body = withReviewPacket(PRODUCT_BRIEF, md);
  body += '\n\n## Auto-rework\n\n**Path: full** — gates failed; re-dispatch implementer.';
  body +=
    '\n\n## Human steer (2026-09-04T00:00:00Z)\n\nplease keep the zh copy';
  return body;
}

describe('buildImplementerBrief', () => {
  it('keeps the product brief, trusted digest, and trail — drops agent narrative', () => {
    const body = realisticBody();
    const result = buildImplementerBrief(body);

    expect(result.brief).toBe(PRODUCT_BRIEF.trim());
    expect(result.verificationDigest).not.toBeNull();
    const digest = result.verificationDigest!;

    expect(digest).toContain('**Definition of Done**');
    expect(digest).toMatch(/\| mechanical/);
    expect(digest).toContain('L3-comment-keep-zh-tone');
    expect(digest).toContain('failing-gate-output-marker');
    expect(digest).toMatch(/Anti-cheating \(L5 → L3\)/);
    expect(digest).toContain('test-edit');
    expect(digest).toContain('test/foo.test.ts');

    expect(digest).not.toContain('**Result:** PASS-ish');
    expect(digest).not.toContain(FINAL_REPORT_SENTENCE);
    expect(digest).not.toContain('secret-hunk-marker');
    expect(digest).not.toContain('**Cost (');

    expect(result.trail).not.toBeNull();
    expect(result.trail!).toContain('## Auto-rework');
    expect(result.trail!).toContain('## Human steer');
    expect(result.trail!).toContain('please keep the zh copy');

    expect(result.dropped).toContain('**Self-assessment**');
    expect(result.dropped).toContain("**Agent's report**");
    expect(result.dropped).toContain('**Diff**');
  });

  it('returns null digest and trail when the body has no review packet', () => {
    const body = '## Task\nJust the brief.\n';
    const result = buildImplementerBrief(body);
    expect(result.verificationDigest).toBeNull();
    expect(result.trail).toBeNull();
    expect(result.brief).toBe('## Task\nJust the brief.');
    expect(result.dropped).toEqual([]);
    expect(renderImplementerTaskBody(body)).toBe('## Task\nJust the brief.');
  });

  it('strips whole-line <!-- hercules:… --> fences from the verification digest', () => {
    const body = realisticBody();
    const digest = buildImplementerBrief(body).verificationDigest ?? '';
    expect(digest.length).toBeGreaterThan(0);
    for (const line of digest.split('\n')) {
      expect(line).not.toMatch(/^\s*<!--\s*hercules:/);
    }
    // Realistic body still carries fences in the raw packet section.
    expect(body).toMatch(/<!--\s*hercules:packet\b/);
  });

  it('handles ## Review packet at offset 0', () => {
    const packetMd = [
      '### T-0 — `hercules/T-0`',
      '**status**',
      '',
      '**Definition of Done**',
      '| Axis | Status |',
      '|---|---|',
      '| mechanical (L1/L2/L5) | ❌ fail |',
      '',
      '**Self-assessment** *(agent evidence only — not authoritative)*',
      'I passed.',
      '',
      '**Gates**',
      '- ❌ test',
    ].join('\n');
    const body = `## Review packet\n\n${packetMd}\n\n## Auto-rework\n\n**Path: full**`;
    const result = buildImplementerBrief(body);
    expect(result.brief).toBe('');
    expect(result.verificationDigest).toContain('**Definition of Done**');
    expect(result.verificationDigest).toContain('**Gates**');
    expect(result.verificationDigest).not.toContain('I passed.');
    expect(result.trail).toContain('## Auto-rework');
    expect(result.dropped).toContain('**Self-assessment**');
  });

  it('does not resurrect a dropped block from an agent ** line', () => {
    const packetMd = [
      '### T-res — `hercules/T-res`',
      '**fail**',
      '',
      "**Agent's report** *(evidence, not a verdict)*",
      'Narrative here.',
      '**Result:** PASS-ish',
      'Still inside the report.',
      '',
      '**Gates**',
      '- ❌ test',
    ].join('\n');
    const body = `## Task\nBrief\n\n## Review packet\n\n${packetMd}`;
    const result = buildImplementerBrief(body);
    expect(result.verificationDigest).toContain('**Gates**');
    expect(result.verificationDigest).not.toContain('**Result:** PASS-ish');
    expect(result.verificationDigest).not.toContain('Still inside the report.');
    expect(result.dropped).toContain("**Agent's report**");
  });

  it('does not resurrect a dropped block from an agent-written ### heading', () => {
    const body = [
      '## Review packet',
      '### T-x — `hercules/T-x`',
      '**Gates**',
      '- typecheck ✅',
      "**Agent's report**",
      'narrative-line',
      '### What I changed',
      'leaked-subheading-line',
      '**Self-assessment**',
      'self-line',
    ].join('\n');
    const result = buildImplementerBrief(body);
    expect(result.verificationDigest).toContain('typecheck ✅');
    expect(result.verificationDigest).toContain('### T-x');
    expect(result.verificationDigest).not.toContain('leaked-subheading-line');
    expect(result.verificationDigest).not.toContain('What I changed');
    expect(result.verificationDigest).not.toContain('self-line');
  });

  it('does not start a block from **Gates** text inside a fenced code block', () => {
    const packetMd = [
      '### T-fence — `hercules/T-fence`',
      '**fail**',
      '',
      '**Definition of Done**',
      '| Axis | Status |',
      '',
      '**Gates**',
      '- ❌ test',
      '  ```',
      '  **Gates** should stay inside the fence',
      '  fence-gates-marker',
      '  ```',
      '',
      '**Self-assessment** *(agent evidence only — not authoritative)*',
      'drop me',
    ].join('\n');
    const body = `## Task\nx\n\n## Review packet\n\n${packetMd}`;
    const result = buildImplementerBrief(body);
    const digest = result.verificationDigest!;
    // Only one Gates heading block — fence content stays under Gates, not a new block.
    expect(digest).toContain('fence-gates-marker');
    expect(digest).toContain('**Gates** should stay inside the fence');
    expect(digest).not.toContain('drop me');
    // Counting heading lines: the fenced occurrence is indented / not a block start.
    const gatesHeadings = digest.split('\n').filter((l) => l.startsWith('**Gates**'));
    expect(gatesHeadings).toHaveLength(1);
  });

  it('truncates the digest and appends the marker at maxDigestChars', () => {
    const packetMd = [
      '### T-trunc — `hercules/T-trunc`',
      '**fail**',
      '',
      '**Definition of Done**',
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(20),
    ].join('\n');
    const body = `## Task\nx\n\n## Review packet\n\n${packetMd}`;
    const max = 80;
    const result = buildImplementerBrief(body, { maxDigestChars: max });
    expect(result.verificationDigest!).toContain(
      `… (digest truncated at ${max} chars — read the packet on the task page)`,
    );
    expect(result.verificationDigest!.indexOf('… (digest truncated')).toBeGreaterThanOrEqual(max);
    expect(IMPLEMENTER_DIGEST_MAX_CHARS).toBe(12_000);
  });

  it('yields an empty-string digest when every packet block is dropped', () => {
    const packetMd = [
      '**Self-assessment** *(agent evidence only — not authoritative)*',
      'only noise',
      '',
      "**Agent's report** *(evidence, not a verdict)*",
      'also noise',
    ].join('\n');
    const body = `## Task\nx\n\n## Review packet\n\n${packetMd}`;
    const result = buildImplementerBrief(body);
    expect(result.verificationDigest).toBe('');
    expect(result.verificationDigest).not.toBeNull();
  });
});

describe('renderImplementerTaskBody', () => {
  it('joins brief, digest heading, and trail for a rework body', () => {
    const body = realisticBody();
    const rendered = renderImplementerTaskBody(body);
    expect(rendered).toContain(PRODUCT_BRIEF.trim().slice(0, 40));
    expect(rendered).toContain(VERIFICATION_DIGEST_HEADING);
    expect(rendered).toContain('L3-comment-keep-zh-tone');
    expect(rendered).toContain('## Auto-rework');
    expect(rendered).toContain('please keep the zh copy');
    expect(rendered).not.toContain(FINAL_REPORT_SENTENCE);
    expect(rendered).not.toContain('secret-hunk-marker');
    expect(rendered.indexOf(VERIFICATION_DIGEST_HEADING)).toBeGreaterThan(
      rendered.indexOf('Ship the zh copy'),
    );
    expect(rendered.indexOf('## Auto-rework')).toBeGreaterThan(
      rendered.indexOf(VERIFICATION_DIGEST_HEADING),
    );
  });
});
