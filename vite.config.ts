import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Build-time version stamp (matches src/buildInfo.ts):
 *   vYYYYMMDD.<n>  — n = commits on HEAD for this UTC day
 * Overridable via VITE_APP_VERSION / HERCULES_VERSION.
 */
function buildVersion(): string {
  const forced = process.env['VITE_APP_VERSION'] ?? process.env['HERCULES_VERSION'];
  if (forced && forced.trim()) return forced.trim().replace(/\.dirty$/i, '');
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  try {
    const since = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00Z`;
    const until = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T23:59:59Z`;
    const raw = execFileSync(
      'git',
      ['rev-list', '--count', `--since=${since}`, `--until=${until}`, 'HEAD'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .toString()
      .trim();
    let n = Number(raw);
    if (!Number.isFinite(n) || n < 1) n = 1;
    if (n > 999) n = 999;
    return `v${ymd}.${n}`;
  } catch {
    return `v${ymd}.1`;
  }
}

// Builds the mobile-first SPA in src/web into dist/web, which the daemon's
// HTTP server serves as static files (SPEC §14 — single deployable process).
export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion()),
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    // Dev convenience: proxy API calls to a locally running daemon.
    // '^/api/' (regex): a bare '/api' prefix also captured the SPA's own
    // /api.ts module request and broke dev entirely.
    // HERCULES_DEV_API lets dev target the staging daemon (8788) instead.
    proxy: { '^/api/': process.env['HERCULES_DEV_API'] ?? 'http://localhost:8787' },
  },
});
