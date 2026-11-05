/**
 * Clause-scoped evidence negation: punctuation + adversative conjunctions.
 * Negator applies only within its clause; later positive clauses remain claims.
 * Coordinating and/or (yu/he) must NOT open a new clause.
 */
import { describe, it, expect } from 'vitest';
import { isEvidenceHookNegated } from '../../src/domain/evidenceClaim.js';
import {
  extractDataEvidenceHooks,
  resolveEvidencePlan,
  taskBodyWithoutEvidenceSection,
} from '../../src/domain/evidence.js';

function hookIndex(line: string, hook: string): number {
  const idx = line.indexOf('data-evidence=' + hook);
  if (idx < 0) throw new Error('hook ' + hook + ' not found');
  return idx;
}

const CJK = {
  buyao: String.fromCharCode(0x4e0d, 0x8981),
  jinzhi: String.fromCharCode(0x7981, 0x6b62),
  dan: String.fromCharCode(0x4f46),
  danshi: String.fromCharCode(0x4f46, 0x662f),
  er: String.fromCharCode(0x800c),
  xuyao: String.fromCharCode(0x9700, 0x8981),
  yu: String.fromCharCode(0x4e0e),
  he: String.fromCharCode(0x548c),
};

describe('evidence claim clause boundaries - adversative', () => {
  it.each([
    {
      name: 'English but',
      line: 'must not emit data-evidence=login but must emit data-evidence=shell',
      negated: ['login'],
      claimed: ['shell'],
    },
    {
      name: 'English however',
      line: 'never data-evidence=login however need data-evidence=nav-settings',
      negated: ['login'],
      claimed: ['nav-settings'],
    },
    {
      name: 'English yet',
      line: 'must not assert data-evidence=login yet must assert data-evidence=shell',
      negated: ['login'],
      claimed: ['shell'],
    },
    {
      name: 'Chinese dan',
      line: CJK.buyao + ' data-evidence=login ' + CJK.dan + CJK.xuyao + ' data-evidence=shell',
      negated: ['login'],
      claimed: ['shell'],
    },
    {
      name: 'Chinese danshi',
      line: CJK.jinzhi + ' data-evidence=login ' + CJK.danshi + CJK.xuyao + ' data-evidence=settings-panel',
      negated: ['login'],
      claimed: ['settings-panel'],
    },
    {
      name: 'Chinese er',
      line: CJK.buyao + ' data-evidence=login ' + CJK.er + CJK.xuyao + ' data-evidence=shell',
      negated: ['login'],
      claimed: ['shell'],
    },
  ])('positive after adversative: $name', ({ line, negated, claimed }) => {
    for (const h of negated) {
      expect(isEvidenceHookNegated(line, hookIndex(line, h))).toBe(true);
    }
    for (const h of claimed) {
      expect(isEvidenceHookNegated(line, hookIndex(line, h))).toBe(false);
    }
    const hooks = extractDataEvidenceHooks(line);
    for (const h of claimed) expect(hooks).toContain(h);
    for (const h of negated) expect(hooks).not.toContain(h);
  });

  it.each([
    {
      name: 'English and',
      line: 'must not emit data-evidence=login and data-evidence=auth',
      hooks: ['login', 'auth'],
    },
    {
      name: 'English or',
      line: 'never data-evidence=login or data-evidence=fake-auth',
      hooks: ['login', 'fake-auth'],
    },
    {
      name: 'Chinese yu',
      line: CJK.buyao + ' data-evidence=login ' + CJK.yu + ' data-evidence=auth',
      hooks: ['login', 'auth'],
    },
    {
      name: 'Chinese he',
      line: CJK.buyao + ' data-evidence=login ' + CJK.he + ' data-evidence=fake-auth',
      hooks: ['login', 'fake-auth'],
    },
  ])('coordinating enumeration under one negator: $name', ({ line, hooks }) => {
    for (const h of hooks) {
      expect(isEvidenceHookNegated(line, hookIndex(line, h))).toBe(true);
    }
    const found = extractDataEvidenceHooks(line);
    for (const h of hooks) expect(found).not.toContain(h);
  });

  it('adversative scope integrates with plan hardening', () => {
    const body = [
      '## Definition of Done',
      '- [ ] (mechanical) must not emit data-evidence=login but must emit data-evidence=shell',
      '- [ ] (mechanical) never data-evidence=fake-auth and data-evidence=login-form',
      '',
      '## Evidence',
      '- unlock',
      '- screenshot shell',
      '- assert sel=[data-evidence=shell] optional',
    ].join(String.fromCharCode(10));
    const hooks = extractDataEvidenceHooks(taskBodyWithoutEvidenceSection(body));
    expect(hooks).toContain('shell');
    expect(hooks).not.toContain('login');
    expect(hooks).not.toContain('fake-auth');
    expect(hooks).not.toContain('login-form');
    const plan = resolveEvidencePlan({ taskBody: body });
    expect(plan.steps.some((s) => s.selector?.includes('shell'))).toBe(true);
    expect(plan.steps.some((s) => s.selector?.includes('login'))).toBe(false);
    expect(plan.steps.some((s) => s.selector?.includes('fake-auth'))).toBe(false);
    const shellAssert = plan.steps.find(
      (s) => s.kind === 'assert' && s.selector?.includes('shell'),
    );
    expect(shellAssert?.optional).toBeFalsy();
  });
});
