import { describe, expect, it } from 'vitest';
import {
  buildFactoryReadyAuditSection,
  factoryFirstLaunchDuties,
  isFactoryDraft,
  shouldMarkFactoryPrReady,
} from '../../src/domain/factoryDraft.js';
import type { Task } from '../../src/domain/task.js';

function task(over: Partial<Task> = {}): Task {
  return {
    id: 'T-factory',
    title: 'T-factory',
    repo: 'app',
    state: 'todo',
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
    prUrl: null,
    prStatus: null,
    planPending: false,
    body: 'Add the factory cut.',
    ...over,
  };
}

describe('isFactoryDraft', () => {
  it('treats isDraft true or mergeStateStatus DRAFT as a draft', () => {
    expect(isFactoryDraft({ isDraft: true })).toBe(true);
    expect(isFactoryDraft({ isDraft: true, mergeStateStatus: 'BLOCKED' })).toBe(true);
    expect(isFactoryDraft({ isDraft: false, mergeStateStatus: 'DRAFT' })).toBe(true);
    expect(isFactoryDraft({ isDraft: false, mergeStateStatus: 'draft' })).toBe(true);
    expect(isFactoryDraft({ isDraft: false, mergeStateStatus: 'CLEAN' })).toBe(false);
    expect(isFactoryDraft({ isDraft: false, mergeStateStatus: 'BEHIND' })).toBe(false);
    expect(isFactoryDraft({ isDraft: false, mergeStateStatus: 'BLOCKED' })).toBe(false);
    expect(isFactoryDraft({ isDraft: false })).toBe(false);
  });
});

describe('shouldMarkFactoryPrReady', () => {
  it('marks a draft once, then stops after the audit section', () => {
    expect(
      shouldMarkFactoryPrReady({ isDraft: true, body: '## Task\nfactory cut' }),
    ).toBe(true);
    expect(
      shouldMarkFactoryPrReady({
        isDraft: false,
        mergeStateStatus: 'DRAFT',
        body: '## Task\nfactory cut',
      }),
    ).toBe(true);
    expect(
      shouldMarkFactoryPrReady({ isDraft: false, body: '## Task\nfactory cut' }),
    ).toBe(false);

    const audit = buildFactoryReadyAuditSection({
      stamp: 't',
      prUrl: 'https://github.com/example-org/acme/pull/41',
    });
    expect(audit).toMatch(/Factory PR marked ready/);
    expect(audit).toContain('https://github.com/example-org/acme/pull/41');
    expect(audit).toMatch(/Not an Approve/);
    expect(audit).toMatch(/Not a merge/);
    expect(
      shouldMarkFactoryPrReady({
        isDraft: true,
        body: `## Task\nfactory cut\n\n${audit}`,
      }),
    ).toBe(false);
  });
});

describe('factoryFirstLaunchDuties', () => {
  it('tells a first factory launch to open a ready-for-review PR', () => {
    const duties = factoryFirstLaunchDuties(task());
    expect(duties).toMatch(/Factory PR \(done artifact\)/);
    expect(duties).toMatch(/ready for review/);
    expect(duties).toMatch(/do not leave it as a draft/i);
    expect(duties).toMatch(/Do \*\*not\*\* create `hercules\/<id>`/);
    expect(duties).toMatch(/Do not open a second PR/);
  });

  it('is silent for local CLI and for an already-open factory PR', () => {
    expect(factoryFirstLaunchDuties(task({ adapter: 'grok' }))).toBeNull();
    expect(
      factoryFirstLaunchDuties(
        task({
          prUrl: 'https://github.com/example-org/acme/pull/41',
          prStatus: 'open',
        }),
      ),
    ).toBeNull();
  });
});
