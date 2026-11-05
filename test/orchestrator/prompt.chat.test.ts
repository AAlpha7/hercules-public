import { describe, it, expect } from 'vitest';
import { assembleChatPrompt, assembleChatContinuePrompt } from '../../src/orchestrator/prompt.js';

describe('Remote Control chat prompts', () => {
  it('frames a free session without DoD self-assessment gate language', () => {
    const p = assembleChatPrompt({
      message: 'Explain src/main.ts',
      allocation: { slug: 'rc-x', port: 4100, scratchDir: '/tmp/s' },
      repoKey: 'hercules',
    });
    expect(p).toContain('Remote Control');
    expect(p).toContain('Explain src/main.ts');
    expect(p).toContain('hercules');
    expect(p).not.toContain('report-hygiene');
    expect(p).toContain('hercules-task-proposal');
  });

  it('continue prompt includes proposal instructions', () => {
    const p = assembleChatContinuePrompt('Also check tests');
    expect(p).toContain('Also check tests');
    expect(p).toContain('hercules-task-proposal');
    expect(p.length).toBeLessThan(2000);
  });
});
