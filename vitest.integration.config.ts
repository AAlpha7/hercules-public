import { defineConfig } from 'vitest/config';

/**
 * Slow / real-subprocess suite only. Useful when debugging isolation, git, or
 * browser layers without re-running the whole unit matrix.
 *
 * `pnpm test` still runs everything (unit + integration).
 */
export default defineConfig({
  test: {
    include: [
      'test/isolation/worktree.test.ts',
      'test/isolation/diff.test.ts',
      'test/control/git.test.ts',
      'test/orchestrator/gitControlPort.test.ts',
      'test/orchestrator/onboard-reliability.test.ts',
      'test/orchestrator/repoProbe.test.ts',
      'test/verification/browser.test.ts',
      'test/verification/liveBehavioral.test.ts',
    ],
    environment: 'node',
  },
});
