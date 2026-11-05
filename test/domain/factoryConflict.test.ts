import { describe, expect, it } from 'vitest';
import {
  buildFactoryConflictSteer,
  buildFactoryConflictThrashSection,
  acceptObservedFactoryHead,
  buildFactoryObservedHeadSection,
  extractFactoryPrHeadRef,
  factoryLaunchNeedsObservedHead,
  factoryOpenPrDuties,
  isFactoryConflictRework,
  isSafeFactoryGitRef,
  resolveFactoryLaunchRef,
} from '../../src/domain/factoryConflict.js';
import type { Task } from '../../src/domain/task.js';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'T-factory',
    title: 'T-factory',
    repo: 'app',
    state: 'review',
    priority: 100,
    blockedBy: [],
    labels: [],
    adapter: 'cursor',
    agentSession: null,
    pendingSteer: null,
    attempts: 0,
    lastEventAt: null,
    createdAt: null,
    startedAt: null,
    endedAt: null,
    prUrl: 'https://github.com/example-org/acme/pull/41',
    prStatus: 'open',
    planPending: false,
    body: 'Add the factory cut.',
    ...over,
  };
}

describe('isSafeFactoryGitRef', () => {
  it('accepts Cursor Cloud feature heads', () => {
    expect(isSafeFactoryGitRef('cursor/cloud-T-factory-abc')).toBe(true);
    expect(isSafeFactoryGitRef('cursor/T-factory-0fb4')).toBe(true);
    expect(isSafeFactoryGitRef('main')).toBe(true);
  });

  it('rejects traversal, option-like, and empty refs', () => {
    expect(isSafeFactoryGitRef('')).toBe(false);
    expect(isSafeFactoryGitRef('-evil')).toBe(false);
    expect(isSafeFactoryGitRef('../main')).toBe(false);
    expect(isSafeFactoryGitRef('cursor//x')).toBe(false);
    expect(isSafeFactoryGitRef('/cursor/head')).toBe(false);
    expect(isSafeFactoryGitRef('cursor/head/')).toBe(false);
    expect(isSafeFactoryGitRef('a'.repeat(300))).toBe(false);
  });
});

describe('extractFactoryPrHeadRef / resolveFactoryLaunchRef', () => {
  const steer = buildFactoryConflictSteer({
    prUrl: 'https://github.com/example-org/acme/pull/41',
    headRef: 'cursor/cloud-T-factory-abc',
    defaultBranch: 'main',
    taskId: 'T-factory',
  });

  it('extracts the Cloud Agent head from the factory steer', () => {
    expect(extractFactoryPrHeadRef(steer)).toBe('cursor/cloud-T-factory-abc');
    expect(steer).toContain('cursor/cloud-T-factory-abc');
    expect(steer).not.toMatch(/work \*\*only\*\* on branch `hercules\//i);
    expect(steer).toMatch(/Do \*\*not\*\* create `hercules\/T-factory`/);
    expect(steer).toMatch(/Do not open a second PR/);
  });

  it('uses the stored head for an open factory PR, else the default branch', () => {
    expect(
      resolveFactoryLaunchRef({
        defaultBranch: 'main',
        hasOpenPr: true,
        pendingSteer: steer,
      }),
    ).toBe('cursor/cloud-T-factory-abc');
    expect(
      resolveFactoryLaunchRef({
        defaultBranch: 'main',
        hasOpenPr: false,
        pendingSteer: steer,
      }),
    ).toBe('main');
    expect(
      resolveFactoryLaunchRef({
        defaultBranch: 'main',
        hasOpenPr: true,
        body: 'no head here',
      }),
    ).toBe('main');
  });

  it('rejects an injected unsafe head marker', () => {
    expect(extractFactoryPrHeadRef('existing Cloud Agent branch `../evil`')).toBeNull();
  });

  it('needs a live GitHub head only when an open PR has no stored ref', () => {
    expect(
      factoryLaunchNeedsObservedHead({
        hasOpenPr: true,
        body: 'Opened the PR then died.',
      }),
    ).toBe(true);
    expect(
      factoryLaunchNeedsObservedHead({
        hasOpenPr: false,
        pendingSteer: steer,
      }),
    ).toBe(false);
    expect(
      factoryLaunchNeedsObservedHead({
        hasOpenPr: true,
        pendingSteer: steer,
      }),
    ).toBe(false);
    expect(
      factoryLaunchNeedsObservedHead({
        hasOpenPr: true,
        body: steer,
      }),
    ).toBe(false);
  });

  it('accepts a safe observed feature head and rejects default / unsafe', () => {
    expect(acceptObservedFactoryHead('cursor/cloud-T-factory-abc', 'main')).toBe(
      'cursor/cloud-T-factory-abc',
    );
    expect(acceptObservedFactoryHead('main', 'main')).toBeNull();
    expect(acceptObservedFactoryHead('../evil', 'main')).toBeNull();
    expect(acceptObservedFactoryHead('', 'main')).toBeNull();
  });

  it('persisted observe section is extractable as the launch ref', () => {
    const section = buildFactoryObservedHeadSection({
      stamp: '2026-08-27T21:00:00.000Z',
      prUrl: 'https://github.com/example-org/acme/pull/41',
      headRef: 'cursor/cloud-T-factory-abc',
    });
    expect(extractFactoryPrHeadRef(section)).toBe('cursor/cloud-T-factory-abc');
    expect(
      resolveFactoryLaunchRef({
        defaultBranch: 'main',
        hasOpenPr: true,
        body: section,
      }),
    ).toBe('cursor/cloud-T-factory-abc');
    expect(factoryLaunchNeedsObservedHead({ hasOpenPr: true, body: section })).toBe(false);
  });
});

describe('factory identity / prompt duties', () => {
  it('treats cursor adapter or session as factory rework', () => {
    expect(isFactoryConflictRework({ adapter: 'cursor', agentSessionAdapter: null })).toBe(
      true,
    );
    expect(isFactoryConflictRework({ adapter: 'grok', agentSessionAdapter: 'cursor' })).toBe(
      true,
    );
    expect(isFactoryConflictRework({ adapter: 'grok', agentSessionAdapter: null })).toBe(
      false,
    );
  });

  it('names the existing Cloud Agent PR, not hercules/<id>', () => {
    const duties = factoryOpenPrDuties(
      task({
        pendingSteer: buildFactoryConflictSteer({
          prUrl: 'https://github.com/example-org/acme/pull/41',
          headRef: 'cursor/cloud-T-factory-abc',
          defaultBranch: 'main',
          taskId: 'T-factory',
        }),
      }),
    );
    expect(duties).toContain('https://github.com/example-org/acme/pull/41');
    expect(duties).toContain('cursor/cloud-T-factory-abc');
    expect(duties).toMatch(/do not create `hercules\/<id>`/i);
    expect(duties).toMatch(/ready for review/);
    expect(factoryOpenPrDuties(task({ adapter: 'grok', prUrl: null, prStatus: null }))).toBeNull();
  });

  it('factory thrash section keeps the Cloud Agent head as the source of truth', () => {
    const md = buildFactoryConflictThrashSection({
      stamp: 't',
      prUrl: 'https://github.com/example-org/acme/pull/41',
      headRef: 'cursor/cloud-T-factory-abc',
      taskId: 'T-factory',
    });
    expect(md).toMatch(/Thrash brake \(pr-mergeable\)/);
    expect(md).toContain('cursor/cloud-T-factory-abc');
    expect(md).not.toMatch(/Work \*\*only\*\* on branch `hercules\/T-factory`/);
  });
});
