import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

import { browserSmokeTests } from './vitest.browser-smoke.js';

/**
 * Fast suite for the local edit loop (node / pure tests).
 *
 * Excludes tests that shell out to real git worktrees, network-ish probes, or a
 * browser. Those still run in `pnpm test` / CI / `pnpm check:full`.
 *
 * Render tests (jsdom + Testing Library) live in a separate config
 * (`vitest.render.config.ts`) with `isolate: true`. Sharing a worker under
 * `isolate: false` leaves an empty document across files — do not merge them
 * back into this config.
 *
 * `pnpm test:unit` / `pnpm check` run both configs sequentially.
 *
 * Rule of thumb: if a test needs >~1s of real subprocess work per case, it
 * belongs in the full suite, not here.
 */
const workers = Math.max(2, Math.min(8, Math.floor((cpus().length || 4) / 2)));

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      // True React render tests — separate config with isolate:true (see above).
      'test/web/render/**',
      // Real bare mirrors + worktrees (~15s alone).
      'test/isolation/worktree.test.ts',
      // Provision race uses real git (onboard reliability pack).
      'test/orchestrator/onboard-reliability.test.ts',
      // Real git plumbing against temp repos.
      'test/control/git.test.ts',
      'test/isolation/diff.test.ts',
      'test/orchestrator/gitControlPort.test.ts',
      // ls-remote probe (env + timeout paths are multi-second).
      'test/orchestrator/repoProbe.test.ts',
      // Real Chromium.
      'test/verification/browser.test.ts',
      'test/verification/liveBehavioral.test.ts',
      // SPA smoke needs built dist/web + CDP (check:full via test:spa-smoke).
      ...browserSmokeTests,
    ],
    environment: 'node',
    pool: 'threads',
    fileParallelism: true,
    maxWorkers: workers,
    minWorkers: 1,
    // Pure node tests can share a worker; render suite must not use this flag.
    isolate: false,
  },
});
