import { describe, it, expect } from 'vitest';
import {
  extractTaskProposals,
  parseProposalBody,
} from '../../src/domain/taskProposal.js';

describe('task proposal parser', () => {
  it('parses a full fence from assistant text', () => {
    const text = [
      'I recommend tracking this formally.',
      '',
      '```hercules-task-proposal',
      'title: Make silver light visible',
      'repo: bookshelf',
      'priority: 40',
      'body: |',
      '  ## Task',
      '  Fix lighting.',
      '  ## Acceptance criteria',
      '  - [ ] (human) Looks good',
      '```',
      '',
      'Tap Approve when ready.',
    ].join('\n');
    const found = extractTaskProposals(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toBe('Make silver light visible');
    expect(found[0]?.repo).toBe('bookshelf');
    expect(found[0]?.priority).toBe(40);
    expect(found[0]?.body).toContain('Fix lighting');
  });

  it('requires a title', () => {
    expect(parseProposalBody('repo: bookshelf\nbody: hi')).toBeNull();
  });

  it('allows omitting repo and body', () => {
    const p = parseProposalBody('title: Just a title');
    expect(p?.title).toBe('Just a title');
    expect(p?.repo).toBeNull();
    expect(p?.body).toContain('Just a title');
  });
});
