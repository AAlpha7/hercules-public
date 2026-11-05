import { describe, it, expect } from 'vitest';
import {
  parseGithubRepo,
  githubCompareUrl,
  githubLoginReturnUrl,
  taskBodyLooksNoChange,
} from '../../src/domain/github.js';

describe('parseGithubRepo', () => {
  it('parses https and ssh remotes', () => {
    expect(parseGithubRepo('https://github.com/example-org/acme.git')).toEqual({
      owner: 'example-org',
      name: 'acme',
    });
    expect(parseGithubRepo('git@github.com:example-org/sample-app.git')).toEqual({
      owner: 'example-org',
      name: 'sample-app',
    });
    expect(parseGithubRepo('ssh://git@github.com/example-org/acme')).toEqual({
      owner: 'example-org',
      name: 'acme',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGithubRepo('https://gitlab.com/x/y')).toBeNull();
    expect(parseGithubRepo('/local/path')).toBeNull();
  });
});

describe('githubCompareUrl', () => {
  it('encodes branch slashes and expands the PR form', () => {
    const url = githubCompareUrl(
      { owner: 'example-org', name: 'acme' },
      'main',
      'hercules/ONBOARD-1',
    );
    expect(url).toBe(
      'https://github.com/example-org/acme/compare/main...hercules%2FONBOARD-1?expand=1',
    );
  });
});

describe('githubLoginReturnUrl', () => {
  it('wraps PR URLs so private repos do not show anonymous 404', () => {
    const pr = 'https://github.com/example-org/acme/pull/1';
    const wrapped = githubLoginReturnUrl(pr);
    expect(wrapped).toBe(
      `https://github.com/login?return_to=${encodeURIComponent(pr)}`,
    );
    // Idempotent for login URLs
    expect(githubLoginReturnUrl(wrapped)).toBe(wrapped);
  });
});

describe('taskBodyLooksNoChange', () => {
  it('detects the review-packet no-change banner', () => {
    expect(taskBodyLooksNoChange('**ℹ️ No file changes.** Confirm via…')).toBe(true);
    expect(taskBodyLooksNoChange('## Review packet\nchanged stuff')).toBe(false);
  });
});
