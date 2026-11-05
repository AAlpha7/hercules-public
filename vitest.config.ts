import { defineConfig } from 'vitest/config';

import { browserSmokeTests } from './vitest.browser-smoke.js';

export default defineConfig({
  // Avoid @vitejs/plugin-react here: it binds Vite 8 types while vitest 2
  // resolves Vite 5 — typecheck fails. esbuild jsx is enough for tests.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx', 'src/**/*.test.ts'],
    // SPA smoke needs built dist/web + Chromium; run via `pnpm test:spa-smoke` / check:full.
    exclude: ['**/node_modules/**', ...browserSmokeTests],
    environment: 'node',
    // True React render tests only — keep domain/server on node (fast, no DOM).
    // setup is imported by each render file (not global) so node suite stays lean.
    environmentMatchGlobs: [['test/web/render/**', 'jsdom']],
  },
});
