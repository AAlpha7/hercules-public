import { describe, it, expect } from 'vitest';
import { isStashLikeSubject } from '../../src/isolation/worktree.js';

describe('isStashLikeSubject', () => {
  it('detects git stash commit subjects', () => {
    expect(
      isStashLikeSubject(
        'WIP on hercules/logout: 2a4f91e feat(web): replace Logout nav with Settings',
      ),
    ).toBe(true);
    expect(
      isStashLikeSubject(
        'index on hercules/logout: 2a4f91e feat(web): replace Logout nav with Settings',
      ),
    ).toBe(true);
    expect(
      isStashLikeSubject(
        'untracked files on hercules/logout: 2a4f91e feat(web): replace Logout',
      ),
    ).toBe(true);
  });

  it('allows real agent subjects', () => {
    expect(isStashLikeSubject('feat(web): Settings panel')).toBe(false);
    expect(isStashLikeSubject('hercules: logout — preserve')).toBe(false);
    expect(isStashLikeSubject('fix(test): align expectations')).toBe(false);
  });
});
