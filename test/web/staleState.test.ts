/**
 * Stale full-snapshot guard: a slow GET /api/state (pull-to-refresh, resume
 * refresh) started BEFORE a mutation can resolve AFTER the optimistic update
 * and shove the whole list back to pre-action state until the next SSE event.
 * Server stamps StateDto.seq; the client must drop any full snapshot older
 * than the last one applied — on BOTH apply paths (fetch + SSE).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('stale state snapshot guard', () => {
  it('StateDto carries the server seq', async () => {
    const api = await readFile(join(ROOT, 'src/web/api.ts'), 'utf8');
    expect(api).toMatch(/seq\?: number/);
  });

  it('App gates every full-state apply through the seq guard', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/stateSeqRef/);
    // SSE path goes through the guard, not raw setState.
    expect(app).toMatch(/subscribeState\(acceptServerState/);
    expect(app).not.toMatch(/subscribeState\(setState/);
    // fetchState path: refresh must bail when the snapshot is stale.
    expect(app).toMatch(/if \(!acceptServerState\(next\)\) return;/);
  });
});
