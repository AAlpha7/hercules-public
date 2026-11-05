import { describe, expect, it } from 'vitest';
import {
  buildFactoryMergedAuditSection,
  buildFactoryMergeWithheldAuditSection,
  isFactoryMergeClean,
  shouldMergeFactoryPr,
} from '../../src/domain/factoryMerge.js';

describe('isFactoryMergeClean', () => {
  it('treats CLEAN or missing mergeStateStatus as mergeable-clean', () => {
    expect(isFactoryMergeClean('CLEAN')).toBe(true);
    expect(isFactoryMergeClean('clean')).toBe(true);
    expect(isFactoryMergeClean('')).toBe(true);
    expect(isFactoryMergeClean(null)).toBe(true);
    expect(isFactoryMergeClean(undefined)).toBe(true);
    expect(isFactoryMergeClean('BEHIND')).toBe(false);
    expect(isFactoryMergeClean('BLOCKED')).toBe(false);
    expect(isFactoryMergeClean('DIRTY')).toBe(false);
    expect(isFactoryMergeClean('UNSTABLE')).toBe(false);
    expect(isFactoryMergeClean('DRAFT')).toBe(false);
  });
});

describe('shouldMergeFactoryPr', () => {
  const ready = {
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    ciStatus: 'success',
    body: '## Task\nfactory cut',
  };

  it('merges only a ready MERGEABLE CLEAN green factory PR', () => {
    expect(shouldMergeFactoryPr(ready)).toBe(true);
    expect(shouldMergeFactoryPr({ ...ready, mergeStateStatus: null })).toBe(true);
    expect(shouldMergeFactoryPr({ ...ready, mergeable: 'CONFLICTING' })).toBe(false);
    expect(shouldMergeFactoryPr({ ...ready, mergeStateStatus: 'BEHIND' })).toBe(false);
    expect(shouldMergeFactoryPr({ ...ready, mergeStateStatus: 'BLOCKED' })).toBe(false);
    expect(shouldMergeFactoryPr({ ...ready, ciStatus: 'pending' })).toBe(false);
    expect(shouldMergeFactoryPr({ ...ready, ciStatus: 'failure' })).toBe(false);
    expect(shouldMergeFactoryPr({ ...ready, isDraft: true })).toBe(false);
    expect(
      shouldMergeFactoryPr({ ...ready, mergeStateStatus: 'DRAFT', isDraft: false }),
    ).toBe(false);
  });

  it('stops after a merge or withheld audit section', () => {
    const merged = buildFactoryMergedAuditSection({
      stamp: 't',
      prUrl: 'https://github.com/example-org/acme/pull/41',
    });
    expect(merged).toMatch(/Factory PR merged via GitHub/);
    expect(merged).toContain('https://github.com/example-org/acme/pull/41');
    expect(merged).toMatch(/Not an Approve/);
    expect(merged).toMatch(/Not MergeService/);
    expect(merged).toMatch(/No verified_sha/);
    expect(shouldMergeFactoryPr({ ...ready, body: `## Task\n\n${merged}` })).toBe(false);

    const withheld = buildFactoryMergeWithheldAuditSection({
      stamp: 't',
      prUrl: 'https://github.com/example-org/acme/pull/41',
      detail: 'required reviews',
    });
    expect(withheld).toMatch(/Factory PR merge withheld/);
    expect(withheld).toContain('required reviews');
    expect(shouldMergeFactoryPr({ ...ready, body: `## Task\n\n${withheld}` })).toBe(false);
  });
});
