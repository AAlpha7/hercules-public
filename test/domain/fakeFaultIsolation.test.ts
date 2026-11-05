/**
 * Fault injection must not leak into real adapter paths or production boot.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('fake fault injection isolation (no production path leak)', () => {
  it('real adapters never reference fakeBehavior / FAKE_FAULT_INJECTION', async () => {
    for (const rel of [
      'src/adapters/grok.ts',
      'src/adapters/grokAcp.ts',
      'src/adapters/codex.ts',
      'src/adapters/claude.ts',
      'src/adapters/acpClient.ts',
    ]) {
      const src = await readFile(join(ROOT, rel), 'utf8');
      expect(src, rel).not.toMatch(/fakeBehavior|fake_behavior|FAKE_FAULT_INJECTION|fakeBehaviorToRunKnobs/);
    }
  });

  it('only FakeAdapter maps fakeBehavior scripts onto run knobs', async () => {
    const fake = await readFile(join(ROOT, 'src/orchestrator/fakeAdapter.ts'), 'utf8');
    expect(fake).toMatch(/isFakeFaultInjectionEnabled/);
    expect(fake).toMatch(/fakeBehaviorToRunKnobs|resolveFakeBehaviorScript/);

    // Composition root does not force fault injection on for production.
    const main = await readFile(join(ROOT, 'src/main.ts'), 'utf8');
    expect(main).not.toMatch(/HERCULES_FAKE_FAULT_INJECTION\s*=\s*['"]1['"]/);
    expect(main).not.toMatch(/FAKE_FAULT_INJECTION/);
  });

  it('WORKFLOW isolation boot enables fault injection only next to HERCULES_ADAPTER=fake', async () => {
    const wf = await readFile(join(ROOT, 'WORKFLOW.md'), 'utf8');
    // Both knobs appear in the same boot chain line group.
    expect(wf).toMatch(
      /HERCULES_ADAPTER=fake[\s\S]{0,200}HERCULES_FAKE_FAULT_INJECTION=1|HERCULES_FAKE_FAULT_INJECTION=1[\s\S]{0,200}HERCULES_ADAPTER=fake/,
    );
  });
});
