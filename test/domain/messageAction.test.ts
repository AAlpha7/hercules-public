import { describe, it, expect } from 'vitest';
import {
  backfillMessageActions,
  isMessageAction,
  lifecycleOpenTaskAction,
  type ChatMessage,
} from '../../src/domain/session.js';

describe('MessageAction', () => {
  it('accepts open_task / open_session with valid ids', () => {
    expect(isMessageAction({ kind: 'open_task', target: 'logout', label: 'Open review packet' })).toBe(
      true,
    );
    expect(isMessageAction({ kind: 'open_session', target: 'rc-abc' })).toBe(true);
  });

  it('rejects bad kinds or identifiers', () => {
    expect(isMessageAction({ kind: 'open_task', target: '../x' })).toBe(false);
    expect(isMessageAction({ kind: 'delete', target: 'logout' })).toBe(false);
    expect(isMessageAction(null)).toBe(false);
  });

  it('parses lifecycle finish lines into open_task actions', () => {
    const a = lifecycleOpenTaskAction(
      'Task `logout` finished this turn → **review**. Evidence packet is on the task detail.',
    );
    expect(a).toEqual({
      kind: 'open_task',
      target: 'logout',
      label: 'Open review packet',
    });
    expect(
      lifecycleOpenTaskAction('Task `x` finished this turn → **failed**.', 'x')?.label,
    ).toMatch(/failed/i);
  });

  it('backfills only finished system messages missing actions', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'system',
        content: 'Task `logout` finished this turn → **review**. Open task detail…',
        at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: '2',
        role: 'system',
        content: 'Task `logout` finished this turn → **review**. Newer.',
        at: '2026-01-01T00:01:00.000Z',
        actions: [{ kind: 'open_task', target: 'logout', label: 'Open review packet' }],
      },
      {
        id: '3',
        role: 'user',
        content: 'ready?',
        at: '2026-01-01T00:02:00.000Z',
      },
    ];
    const out = backfillMessageActions(messages, 'logout');
    expect(out[0]?.actions?.[0]?.label).toBe('Open review packet');
    expect(out[1]?.actions?.[0]?.target).toBe('logout');
    expect(out[2]?.actions).toBeUndefined();
    // Unchanged messages keep identity when already complete.
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });
});
