import { describe, it, expect } from 'vitest';
import {
  appendProvisionDiscardNote,
  untrustedRemoteTipReason,
} from '../../src/domain/provisionNote.js';

describe('appendProvisionDiscardNote', () => {
  it('appends a timeline row when ## Run timeline exists', () => {
    const body = [
      '# Task',
      '',
      '## Run timeline',
      '',
      '- `t0` **dispatch** — dispatched',
      '',
      '## Other',
      '',
      'keep me',
      '',
    ].join('\n');
    const next = appendProvisionDiscardNote(body, 't1', 'lease changed', 2);
    expect(next).toContain(
      '- `t1` **provision** ❌ — lease changed (×2, retried every tick until resolved)',
    );
    expect(next).toContain('## Other');
    expect(next).toContain('keep me');
    expect(next.indexOf('**provision**')).toBeLessThan(next.indexOf('## Other'));
  });

  it('adds a ## Provision blocked section otherwise', () => {
    const body = '# Task\n\nbody\n';
    const next = appendProvisionDiscardNote(body, 't1', 'lease changed', 2);
    expect(next).toContain('## Provision blocked');
    expect(next).toContain(
      '- `t1` **provision** ❌ — lease changed (×2, retried every tick until resolved)',
    );
  });

  it('is idempotent for the same reason', () => {
    const body = '# Task\n\nbody\n';
    const once = appendProvisionDiscardNote(body, 't1', 'same reason', 2);
    const twice = appendProvisionDiscardNote(once, 't2', 'same reason', 3);
    expect(twice).toBe(once);
    expect(twice.match(/\*\*provision\*\*/g)).toHaveLength(1);
  });
});

describe('untrustedRemoteTipReason', () => {
  it('formats branch + short sha', () => {
    expect(untrustedRemoteTipReason('hercules/task', '07fa107cabcdef')).toBe(
      'unpinned task found a pre-existing remote branch `hercules/task` at 07fa107 ' +
        'not created by this task — delete or rename that branch to continue',
    );
  });
});
