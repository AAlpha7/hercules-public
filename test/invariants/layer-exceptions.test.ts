/**
 * Architecture listing for named layer-map exceptions.
 *
 * This test records exceptions. It does not invert them, does not add a
 * forbidden-import rule, and does not mock bwrap/Guardian.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/**
 * Named exceptions to the published `src/` layer map. Keep this list in
 * lockstep with `AGENTS.md`; adding a row here is documentation, not a ban.
 */
const NAMED_LAYER_EXCEPTIONS = [
  {
    id: 'PATH_LEASE_PROCESS_PROBE',
    fromModule: 'taskPathLeaseStore',
    toModule: 'processTree',
  },
] as const;

async function readAgentsMap(): Promise<string> {
  return readFile(join(ROOT, 'AGENTS.md'), 'utf8');
}

describe('named layer-map exceptions', () => {
  it('lists each recorded exception in AGENTS.md without inverting it', async () => {
    const map = await readAgentsMap();
    expect(map).toMatch(/named exceptions/i);
    expect(NAMED_LAYER_EXCEPTIONS.length).toBeGreaterThan(0);
    for (const exception of NAMED_LAYER_EXCEPTIONS) {
      expect(map, `AGENTS.md must name ${exception.id}`).toContain(exception.id);
      expect(map, `AGENTS.md must list ${exception.fromModule}`).toContain(exception.fromModule);
      expect(map, `AGENTS.md must list ${exception.toModule}`).toContain(exception.toModule);
      expect(map).toMatch(/named exception/i);
      expect(map).toMatch(/do not invert/i);
    }
  });
});
