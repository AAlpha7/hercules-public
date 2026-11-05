import { describe, it, expect } from 'vitest';
import { renderTeardownReport } from '../../src/verification/teardownReport.js';

describe('renderTeardownReport', () => {
  it('renders a forced teardown with impact and usage', () => {
    const md = renderTeardownReport({
      method: 'forced',
      impact: { changedFiles: 3, localCommits: 1, pushedRemote: true },
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.08 },
    });
    expect(md).toMatch(/^## Teardown/m);
    expect(md).toMatch(/SIGKILL/);
    expect(md).toMatch(/3 uncommitted/);
    expect(md).toMatch(/remote/i);             // mentions the remote branch persists
    expect(md).toMatch(/0\.08|\$0\.08/);       // cost
    expect(md).toMatch(/external/i);           // the un-knowable-side-effects note
  });
  it('renders a graceful teardown with no impact/usage', () => {
    const md = renderTeardownReport({ method: 'graceful', impact: null });
    expect(md).toMatch(/SIGTERM/);
    expect(md).not.toMatch(/uncommitted/);     // no impact block when impact is null
  });
});
