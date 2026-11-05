import { describe, it, expect } from 'vitest';
import {
  buildSalvageBrief,
  buildSalvageForkBody,
  buildSalvageForkProvenanceSection,
  isFullCommitSha,
  parseSalvageForkInput,
  productBriefForSalvage,
  validateSalvageForkRequest,
} from '../../src/domain/salvage.js';

describe('buildSalvageBrief — primary recovery is Retry on preserved branch', () => {
  it('states Retry resets attempts and reuses hercules/<id>', () => {
    const md = buildSalvageBrief({
      taskId: 'FAIL-1',
      maxAttempts: 3,
      dimensions: {
        mechanical: 'fail',
        reviewer: 'skipped',
        human: 'pending',
        criteria: [],
        warnings: [],
      },
    });
    expect(md).toMatch(/## Salvage brief/);
    expect(md).toMatch(/hercules\/FAIL-1/);
    expect(md).toMatch(/\*\*Retry\*\*.*reset attempts/i);
    expect(md).toMatch(/reuses the preserved `hercules\/FAIL-1` branch/i);
    // Clean salvage fork is an explicit secondary path — not "just create a task".
    expect(md).toMatch(/\*\*Clean salvage fork\*\*/i);
    expect(md).not.toMatch(/create a new task(?! via)/i);
    expect(md).not.toMatch(/Salvage manually/i);
  });
});

describe('parseSalvageForkInput', () => {
  it('accepts empty object and omitted body fields', () => {
    expect(parseSalvageForkInput({})).toEqual({ ok: true, value: {} });
    expect(parseSalvageForkInput(null)).toEqual({ ok: true, value: {} });
    expect(parseSalvageForkInput(undefined)).toEqual({ ok: true, value: {} });
  });

  it('accepts a well-typed payload', () => {
    const r = parseSalvageForkInput({
      id: 'TGT-1',
      title: 'Salvage title',
      body: '## Goal\nDo it\n',
      priority: 10,
      labels: ['a', 'b'],
      adapter: 'codex',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({
        id: 'TGT-1',
        title: 'Salvage title',
        body: '## Goal\nDo it\n',
        priority: 10,
        labels: ['a', 'b'],
        adapter: 'codex',
      });
    }
  });

  it('refuses non-object JSON values', () => {
    for (const bad of ['x', 1, true, []]) {
      const r = parseSalvageForkInput(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/object/i);
    }
  });

  it('refuses wrong field types and unsafe lengths', () => {
    expect(parseSalvageForkInput({ id: 12 }).ok).toBe(false);
    expect(parseSalvageForkInput({ id: '../evil' }).ok).toBe(false);
    expect(parseSalvageForkInput({ title: 9 }).ok).toBe(false);
    expect(parseSalvageForkInput({ title: 'x'.repeat(501) }).ok).toBe(false);
    expect(parseSalvageForkInput({ body: 1 }).ok).toBe(false);
    expect(parseSalvageForkInput({ body: 'x'.repeat(100_001) }).ok).toBe(false);
    expect(parseSalvageForkInput({ priority: 'hi' }).ok).toBe(false);
    expect(parseSalvageForkInput({ priority: 1.5 }).ok).toBe(false);
    expect(parseSalvageForkInput({ labels: 'a' }).ok).toBe(false);
    expect(parseSalvageForkInput({ labels: [1] }).ok).toBe(false);
    expect(parseSalvageForkInput({ adapter: 'nope' }).ok).toBe(false);
  });
});

describe('validateSalvageForkRequest', () => {
  const base = {
    sourceId: 'SRC-1',
    targetId: 'TGT-1',
    sourceRepo: 'app',
    targetRepo: 'app',
    sourceState: 'failed' as const,
    targetExists: false,
    sourceBranchPresent: true,
  };

  it('accepts a clean same-repo failed → new-id fork', () => {
    expect(validateSalvageForkRequest(base)).toEqual({ ok: true });
  });

  it('skips branch-presence check when sourceBranchPresent is omitted (pre-IO)', () => {
    const { sourceBranchPresent: _drop, ...noBranch } = base;
    expect(validateSalvageForkRequest(noBranch)).toEqual({ ok: true });
  });

  it('refuses unsafe source id', () => {
    const r = validateSalvageForkRequest({ ...base, sourceId: '../evil' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unsafe|identifier/i);
  });

  it('refuses unsafe target id', () => {
    const r = validateSalvageForkRequest({ ...base, targetId: 'bad/id' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/unsafe|identifier/i);
  });

  it('refuses source === target', () => {
    const r = validateSalvageForkRequest({ ...base, targetId: 'SRC-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/different|same/i);
  });

  it('refuses repo mismatch', () => {
    const r = validateSalvageForkRequest({ ...base, targetRepo: 'other' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/repo/i);
  });

  // Title preserved for L5 test-integrity continuity with main; body now
  // asserts both accepted terminal states (failed and cancelled).
  it('refuses non-failed source', () => {
    for (const sourceState of ['todo', 'in_progress', 'retrying', 'review', 'done'] as const) {
      const r = validateSalvageForkRequest({ ...base, sourceState });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/failed/i);
    }
  });

  it('refusal reason names failed and cancelled as accepted states', () => {
    for (const sourceState of ['todo', 'in_progress', 'retrying', 'review', 'done'] as const) {
      const r = validateSalvageForkRequest({ ...base, sourceState });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toMatch(/failed/i);
        expect(r.reason).toMatch(/cancelled/i);
      }
    }
  });

  it('accepts cancelled source when preserved branch is present', () => {
    expect(validateSalvageForkRequest({ ...base, sourceState: 'cancelled' })).toEqual({
      ok: true,
    });
    const { sourceBranchPresent: _drop, ...noBranch } = base;
    expect(validateSalvageForkRequest({ ...noBranch, sourceState: 'cancelled' })).toEqual({
      ok: true,
    });
  });

  it('refuses cancelled source when preserved branch is missing', () => {
    const r = validateSalvageForkRequest({
      ...base,
      sourceState: 'cancelled',
      sourceBranchPresent: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/mirror/i);
      expect(r.reason).toMatch(/origin/i);
    }
  });

  it('refuses missing source branch', () => {
    const r = validateSalvageForkRequest({ ...base, sourceBranchPresent: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/mirror/i);
      expect(r.reason).toMatch(/origin/i);
    }
  });

  it('refuses target collision', () => {
    const r = validateSalvageForkRequest({ ...base, targetExists: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/exists|collision/i);
  });
});

describe('salvage fork provenance + body', () => {
  it('isFullCommitSha accepts only 40-hex', () => {
    expect(isFullCommitSha('a'.repeat(40))).toBe(true);
    expect(isFullCommitSha('A1b2'.repeat(10))).toBe(true);
    expect(isFullCommitSha('abc')).toBe(false);
    expect(isFullCommitSha('g'.repeat(40))).toBe(false);
  });

  it('stamps durable source task + sha section', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const section = buildSalvageForkProvenanceSection({
      sourceTaskId: 'SRC-1',
      sourceSha: sha,
      stampedAt: '2026-07-31T12:00:00.000Z',
    });
    expect(section).toMatch(/## Clean salvage provenance/);
    expect(section).toMatch(/SRC-1/);
    expect(section).toMatch(sha);
    expect(section).toMatch(/2026-07-31T12:00:00\.000Z/);
    expect(section).toMatch(/immutable/i);
  });

  it('productBriefForSalvage strips review packet / salvage / run failure', () => {
    const body = `## Goal
Ship it.

## Acceptance criteria
- [ ] (mechanical) tests pass

## Review packet
**Status:** fail

## Salvage brief
old
`;
    const brief = productBriefForSalvage(body);
    expect(brief).toMatch(/## Goal/);
    expect(brief).toMatch(/Acceptance criteria/);
    expect(brief).not.toMatch(/Review packet/);
    expect(brief).not.toMatch(/Salvage brief/);
  });

  it('buildSalvageForkBody puts product brief first then provenance', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const body = buildSalvageForkBody({
      sourceTaskId: 'SRC-1',
      sourceSha: sha,
      stampedAt: '2026-07-31T12:00:00.000Z',
      sourceBody: '## Goal\nFinish the feature.\n\n## Review packet\nnoise\n',
      operatorBody: undefined,
    });
    expect(body).toMatch(/## Clean salvage provenance/);
    expect(body).toMatch(/## Goal/);
    expect(body).toMatch(/Finish the feature/);
    expect(body).not.toMatch(/## Review packet/);
    // Brief before harness so extractProductBrief still sees Goal/DoD.
    expect(body.indexOf('## Goal')).toBeLessThan(body.indexOf('## Clean salvage provenance'));
  });

  it('operatorBody overrides source brief when provided', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const body = buildSalvageForkBody({
      sourceTaskId: 'SRC-1',
      sourceSha: sha,
      stampedAt: '2026-07-31T12:00:00.000Z',
      sourceBody: '## Goal\nOld\n',
      operatorBody: '## Goal\nNew tighter DoD\n',
    });
    expect(body).toMatch(/New tighter DoD/);
    expect(body).not.toMatch(/## Goal\nOld/);
  });
});
