import { describe, it, expect } from 'vitest';
import { draftTaskFromIntent } from '../../src/domain/intentDraft.js';

/**
 * Dogfood gap from task-7 (queue-front): intent-generated UI/shell tasks had no
 * DoD about test/web/appSplit.test.ts, so agents grew App.tsx past the ceiling.
 */
describe('intent draft App shell budget guidance', () => {
  it('emits App.tsx line-budget / appSplit guidance for web UI shell intents', () => {
    const d = draftTaskFromIntent(
      'Settings panel: language and default agent selection UI',
      'hercules',
    );
    expect(d.body).toMatch(/appSplit\.test\.ts/);
    expect(d.body).toMatch(/App\.tsx/);
    expect(d.body).toMatch(/line budget|size budget|line ceiling/i);
    // Prefer extract over raising the configured ceiling.
    expect(d.body).toMatch(/prefer extract|extract over/i);
    // Mechanical AC so L1 can gate on it.
    expect(d.body).toMatch(
      /\(mechanical\)[\s\S]*appSplit\.test\.ts[\s\S]*@gate:test/,
    );
  });

  it('also emits budget guidance for generic UI / shell layout intents', () => {
    const d = draftTaskFromIntent(
      'Add a nicer card layout on the home screen',
      'hercules',
    );
    expect(d.body).toMatch(/appSplit\.test\.ts/);
    expect(d.body).toMatch(/App\.tsx/);
  });

  it('does not emit App.tsx budget guidance for pure backend intents', () => {
    const backend = draftTaskFromIntent(
      'Add adapter failover when agent_exit streaks exceed the threshold',
      'hercules',
    );
    expect(backend.body).not.toMatch(/appSplit\.test\.ts/);

    const docs = draftTaskFromIntent('Update README documentation for operators', 'hercules');
    expect(docs.body).not.toMatch(/appSplit\.test\.ts/);

    const bug = draftTaskFromIntent(
      'Fix flaky upload retry bug in the orchestrator drain path',
      'hercules',
    );
    expect(bug.body).not.toMatch(/appSplit\.test\.ts/);
  });
});
