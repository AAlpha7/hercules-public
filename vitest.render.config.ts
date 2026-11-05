import { cpus } from 'node:os';
import { defineConfig } from 'vitest/config';

/**
 * jsdom + Testing Library suite for critical UI decision paths.
 *
 * Must use isolate:true (default). Sharing workers with isolate:false empties
 * the document across files — see vitest.unit.config.ts comment.
 *
 * Invoked by `pnpm test:unit` after the node suite, and included in full
 * `pnpm test` via vitest.config.ts environmentMatchGlobs.
 */
const workers = Math.max(1, Math.min(4, Math.floor((cpus().length || 4) / 2)));

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['test/web/render/**/*.test.tsx'],
    environment: 'jsdom',
    pool: 'threads',
    fileParallelism: true,
    maxWorkers: workers,
    minWorkers: 1,
    // Explicit: each file gets a fresh module graph + DOM.
    isolate: true,
  },
});
