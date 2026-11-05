import { describe, it, expect } from 'vitest';
import { formatAgentTurnText } from '../../src/domain/session.js';

describe('formatAgentTurnText', () => {
  it('returns body alone when no meta', () => {
    expect(formatAgentTurnText({ content: '  hello  ' })).toBe('hello');
  });

  it('appends refs and attachment paths for the agent', () => {
    const text = formatAgentTurnText({
      content: 'fix the UI',
      refs: [{ kind: 'task', target: 'task-4', label: 'loop' }],
      attachments: [
        {
          id: 'a1',
          kind: 'image',
          name: 'shot.png',
          relPath: '.scratch/uploads/a1-shot.png',
          mime: 'image/png',
          bytes: 12,
        },
      ],
    });
    expect(text).toContain('fix the UI');
    expect(text).toContain('Context references');
    expect(text).toContain('task-4');
    expect(text).toContain('.scratch/uploads/a1-shot.png');
  });
});
