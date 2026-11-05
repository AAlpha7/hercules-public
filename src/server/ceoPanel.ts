/**
 * CEO panel — static HTML at /ceo/ (Cloudflare Access only, no Bearer).
 * Serves from static/ceo/index.html at repo root (not bundled in dist/).
 */
import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function mountCeoPanel(app: Hono, repoRoot: string): void {
  app.get('/ceo', (c) => c.redirect('/ceo/', 301));
  app.get('/ceo/', async (c) => {
    try {
      const html = await readFile(join(repoRoot, 'static/ceo/index.html'), 'utf8');
      c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      c.header('Pragma', 'no-cache');
      return c.html(html);
    } catch {
      return c.text('CEO panel not installed', 503);
    }
  });
}
