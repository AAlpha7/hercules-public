import { defineConfig } from 'vitest/config';

import { browserSmokeTests } from './vitest.browser-smoke.js';

/** SPA smoke only — needs built dist/web + Chromium (see package.json test:spa-smoke). */
export default defineConfig({
  test: {
    include: [...browserSmokeTests],
    environment: 'node',
    fileParallelism: false,
    pool: 'forks',
  },
});
