import { describe, it, expect } from 'vitest';
import {
  assertPrIdentityPayload,
  bindTaskPrUrl,
  parseGithubPrUrl,
  PrIdentityError,
} from '../../src/domain/prIdentity.js';

const REPO = 'https://github.com/example-org/acme.git';

describe('parseGithubPrUrl', () => {
  it('parses standard PR URLs', () => {
    expect(parseGithubPrUrl('https://github.com/example-org/acme/pull/12')).toEqual({
      owner: 'example-org',
      name: 'acme',
      number: 12,
    });
  });

  it('rejects non-positive, unsafe, and non-delimited PR numbers', () => {
    expect(parseGithubPrUrl('https://github.com/o/r/pull/0')).toBeNull();
    expect(
      parseGithubPrUrl('https://github.com/o/r/pull/999999999999999999999'),
    ).toBeNull();
    expect(parseGithubPrUrl('https://github.com/o/r/pull/12evil')).toBeNull();
  });
});

describe('bindTaskPrUrl', () => {
  it('accepts case-insensitive owner/name match', () => {
    const b = bindTaskPrUrl({
      prUrl: 'https://github.com/example-org/acme/pull/9',
      taskId: 'T-1',
      repoUrl: REPO,
      defaultBranch: 'main',
    });
    expect(b.number).toBe(9);
    expect(b.expectedHeadRef).toBe('hercules/T-1');
    expect(b.expectedBaseRef).toBe('main');
  });

  it('rejects wrong-repository URL', () => {
    try {
      bindTaskPrUrl({
        prUrl: 'https://github.com/evil/other/pull/1',
        taskId: 'T-1',
        repoUrl: REPO,
        defaultBranch: 'main',
      });
      throw new Error('expected identity rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(PrIdentityError);
      expect((err as PrIdentityError).reason).toBe('wrong_repository');
    }
  });

  it('rejects unparseable PR and repo URLs with typed reasons', () => {
    try {
      bindTaskPrUrl({
        prUrl: 'not-a-url',
        taskId: 'T-1',
        repoUrl: REPO,
        defaultBranch: 'main',
      });
      throw new Error('expected unparseable_pr_url');
    } catch (err) {
      expect(err).toBeInstanceOf(PrIdentityError);
      expect((err as PrIdentityError).reason).toBe('unparseable_pr_url');
    }

    try {
      bindTaskPrUrl({
        prUrl: 'https://github.com/example-org/acme/pull/1',
        taskId: 'T-1',
        repoUrl: 'https://gitlab.com/x/y',
        defaultBranch: 'main',
      });
      throw new Error('expected unparseable_repo_url');
    } catch (err) {
      expect(err).toBeInstanceOf(PrIdentityError);
      expect((err as PrIdentityError).reason).toBe('unparseable_repo_url');
    }
  });
});

describe('assertPrIdentityPayload', () => {
  const bound = bindTaskPrUrl({
    prUrl: 'https://github.com/example-org/acme/pull/9',
    taskId: 'T-1',
    repoUrl: REPO,
    defaultBranch: 'main',
  });

  it('accepts matching identity', () => {
    expect(() =>
      assertPrIdentityPayload(
        {
          url: 'https://github.com/example-org/acme/pull/9',
          baseRefName: 'main',
          headRefName: 'hercules/T-1',
        },
        bound,
      ),
    ).not.toThrow();
  });

  it('rejects wrong head branch', () => {
    expect(() =>
      assertPrIdentityPayload(
        {
          url: 'https://github.com/example-org/acme/pull/9',
          baseRefName: 'main',
          headRefName: 'hercules/OTHER',
        },
        bound,
      ),
    ).toThrow(/PR head/);
  });

  it('rejects a Cursor Cloud head for local-adapter identity', () => {
    expect(() =>
      assertPrIdentityPayload(
        {
          url: 'https://github.com/example-org/acme/pull/9',
          baseRefName: 'main',
          headRefName: 'cursor/cloud-T-factory-abc',
        },
        bound,
      ),
    ).toThrow(/PR head/);
  });

  it('accepts a Cursor Cloud feature head for a factory PR', () => {
    const factory = bindTaskPrUrl({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      taskId: 'T-factory',
      repoUrl: REPO,
      defaultBranch: 'main',
      remoteFactoryPr: true,
    });
    expect(factory.remoteFactoryPr).toBe(true);
    expect(factory.expectedHeadRef).toBe('hercules/T-factory');
    expect(() =>
      assertPrIdentityPayload(
        {
          url: 'https://github.com/example-org/acme/pull/41',
          baseRefName: 'main',
          headRefName: 'cursor/cloud-T-factory-abc',
        },
        factory,
      ),
    ).not.toThrow();
  });

  it('still rejects a factory PR whose base is not the default branch', () => {
    const factory = bindTaskPrUrl({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      taskId: 'T-factory',
      repoUrl: REPO,
      defaultBranch: 'main',
      remoteFactoryPr: true,
    });
    try {
      assertPrIdentityPayload(
        {
          url: 'https://github.com/example-org/acme/pull/41',
          baseRefName: 'release',
          headRefName: 'cursor/cloud-T-factory-abc',
        },
        factory,
      );
      throw new Error('expected factory base rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(PrIdentityError);
      expect((err as PrIdentityError).reason).toBe('wrong_base_ref');
    }
  });

  it('still rejects factory PRs with empty or default-branch heads', () => {
    const factory = bindTaskPrUrl({
      prUrl: 'https://github.com/example-org/acme/pull/41',
      taskId: 'T-factory',
      repoUrl: REPO,
      defaultBranch: 'main',
      remoteFactoryPr: true,
    });
    for (const headRefName of ['', 'main']) {
      try {
        assertPrIdentityPayload(
          {
            url: 'https://github.com/example-org/acme/pull/41',
            baseRefName: 'main',
            headRefName,
          },
          factory,
        );
        throw new Error('expected factory head rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(PrIdentityError);
        expect((err as PrIdentityError).reason).toBe('wrong_head_ref');
      }
    }
  });

  it.each([
    [
      'canonical URL',
      {
        url: 'https://github.com/example-org/acme/pull/9?tab=checks',
        baseRefName: 'main',
        headRefName: 'hercules/T-1',
      },
      'wrong_canonical_url',
    ],
    [
      'base',
      {
        url: 'https://github.com/example-org/acme/pull/9',
        baseRefName: 'release',
        headRefName: 'hercules/T-1',
      },
      'wrong_base_ref',
    ],
    [
      'required fields',
      {
        url: 'https://github.com/example-org/acme/pull/9',
        baseRefName: 'main',
      },
      'missing_identity_fields',
    ],
  ])('rejects a payload with wrong %s', (_label, payload, reason) => {
    try {
      assertPrIdentityPayload(payload, bound);
      throw new Error('expected identity rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(PrIdentityError);
      expect((err as PrIdentityError).reason).toBe(reason);
    }
  });
});
