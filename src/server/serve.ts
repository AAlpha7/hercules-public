/**
 * Presentation layer — Node bootstrap: serve the API + the built SPA from one
 * process (SPEC §2, §14). The orchestrator and HTTP server share the same
 * in-memory runtime snapshot (via the RuntimeSource), so the UI is always a
 * direct view of what the loop sees.
 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { join } from 'node:path';
import { createApi, type ApiDeps } from './api.js';
import { mountCeoPanel } from './ceoPanel.js';
import { resolveRepoRootFromModule } from './selfUpdate.js';

export interface ServeOptions extends ApiDeps {
  readonly port: number;
  /** Absolute path to the built SPA (dist/web). Omit to serve API only. */
  readonly webDir?: string;
  /**
   * Listen address. Omit for all interfaces (0.0.0.0) — the live daemon is
   * reached over a private network, so this is the default; a locked-down deployment
   * can pin it (e.g. 127.0.0.1) via HERCULES_BIND_HOST.
   */
  readonly hostname?: string;
}

/**
 * Resolve the optional bind host from env. Default undefined = all interfaces
 * (SPEC §10: exposure is prevented by a private network + the mandatory token, not a
 * loopback bind — a 127.0.0.1 default would break the live remote access).
 */
export function resolveBindHost(env: NodeJS.ProcessEnv): string | undefined {
  const v = env['HERCULES_BIND_HOST']?.trim();
  return v && v.length > 0 ? v : undefined;
}

export interface RunningServer {
  close(): void;
  /** Actual bound port (equals opts.port, or the OS-chosen port when opts.port is 0). */
  readonly port: number;
}

export function startServer(opts: ServeOptions): RunningServer {
  const app = new Hono();
  const repoRoot =
    opts.webDir != null ? join(opts.webDir, '..', '..') : resolveRepoRootFromModule();
  mountCeoPanel(app, repoRoot);
  app.route('/', createApi(opts));

  if (opts.webDir) {
    const webDir = opts.webDir;
    // Hashed /assets/* can be cached forever; the SPA shell (index.html and
    // extensionless routes) must always revalidate so deploys pick up new hashes.
    // Without this, phones keep an old JS bundle that cannot render new UI
    // (e.g. in-chat Open review packet buttons) while still showing new text via SSE.
    app.use('/*', async (c, next) => {
      await next();
      const path = c.req.path;
      if (path.startsWith('/assets/')) {
        c.header('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (
        path === '/' ||
        path.endsWith('.html') ||
        !path.includes('.') ||
        path.endsWith('/index.html')
      ) {
        c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
        c.header('Pragma', 'no-cache');
      }
    });
    app.use('/*', serveStatic({ root: webDir }));
    // SPA fallback: anything not matched above returns the app shell.
    app.get('*', serveStatic({ path: join(webDir, 'index.html') }));
  }

  const server = serve({
    fetch: app.fetch,
    port: opts.port,
    ...(opts.hostname ? { hostname: opts.hostname } : {}),
  });
  // When port is 0, Node picks an ephemeral port — surface it for tests.
  const addr = server.address();
  const bound =
    typeof addr === 'object' && addr !== null && typeof addr.port === 'number'
      ? addr.port
      : opts.port;
  return {
    port: bound,
    close: () => {
      server.close();
    },
  };
}
