import { describe, it, expect } from 'vitest';
import {
  decideTaskBranchFetch,
  mustKeepLocalTaskTip,
  formatSkipRewindEvent,
  formatNotPropagatedEvent,
  appendMirrorBranchNotes,
  SKIP_REWIND_LOG,
  NOT_PROPAGATED_LOG,
} from '../../src/domain/mirrorFetch.js';

describe('decideTaskBranchFetch (three-state hercules/* policy)', () => {
  it('local ahead → keep (no silent rewind)', () => {
    const d = decideTaskBranchFetch(0, 3);
    expect(d.action).toBe('keep');
    expect(d.reason).toBe('local_ahead');
    expect(d.logLine).toBe(SKIP_REWIND_LOG);
    expect(mustKeepLocalTaskTip(0, 3)).toBe(true);
  });

  it('remote ahead → update (fast-forward)', () => {
    const d = decideTaskBranchFetch(2, 0);
    expect(d.action).toBe('update');
    expect(d.reason).toBe('remote_ahead');
    expect(d.logLine).toBe('');
    expect(mustKeepLocalTaskTip(2, 0)).toBe(false);
  });

  it('diverged → update to remote and log (status quo + surface)', () => {
    const d = decideTaskBranchFetch(1, 2);
    expect(d.action).toBe('update');
    expect(d.reason).toBe('diverged');
    expect(d.logLine).toMatch(/分叉/);
    expect(d.logLine).toMatch(/跟随远端/);
    expect(mustKeepLocalTaskTip(1, 2)).toBe(false);
  });

  it('equal → noop', () => {
    const d = decideTaskBranchFetch(0, 0);
    expect(d.action).toBe('noop');
    expect(d.reason).toBe('equal');
    expect(d.logLine).toBe('');
  });

  it('non-finite counts → unknown noop (safe default)', () => {
    const d = decideTaskBranchFetch(Number.NaN, 1);
    expect(d.action).toBe('noop');
    expect(d.reason).toBe('unknown');
  });
});

describe('mirror fetch / propagate log samples', () => {
  it('formatSkipRewindEvent includes 跳过回卷 + branch + tips', () => {
    const line = formatSkipRewindEvent(
      'hercules/release-verify-timeout',
      '281094c5abcd',
      'e1ec4c51ffff',
    );
    expect(line).toContain(SKIP_REWIND_LOG);
    expect(line).toContain('hercules/release-verify-timeout');
    expect(line).toContain('281094c5abcd'.slice(0, 12));
    expect(line).toContain('e1ec4c51ffff'.slice(0, 12));
  });

  it('formatNotPropagatedEvent includes 未传播 warning', () => {
    const line = formatNotPropagatedEvent('hercules/T-1', 'push rejected');
    expect(line).toContain(NOT_PROPAGATED_LOG);
    expect(line).toContain('hercules/T-1');
    expect(line).toContain('push rejected');
  });

  it('appendMirrorBranchNotes extends Run timeline with **mirror** rows', () => {
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
    const neutral = appendMirrorBranchNotes(body, 't1', [SKIP_REWIND_LOG]);
    expect(neutral).toContain('**mirror**');
    expect(neutral).toContain(SKIP_REWIND_LOG);
    expect(neutral).toContain('## Other');
    expect(neutral).toContain('keep me');
    const bad = appendMirrorBranchNotes(body, 't1', [NOT_PROPAGATED_LOG], { ok: false });
    expect(bad).toContain('**mirror** ❌');
    expect(bad).toContain(NOT_PROPAGATED_LOG);
  });

  it('appendMirrorBranchNotes creates Mirror branch section when no timeline', () => {
    const body = '# Task\n\nbody\n';
    const next = appendMirrorBranchNotes(body, 't1', [NOT_PROPAGATED_LOG], { ok: false });
    expect(next).toContain('## Mirror branch');
    expect(next).toContain(NOT_PROPAGATED_LOG);
  });
});
