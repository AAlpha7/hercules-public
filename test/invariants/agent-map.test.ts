/**
 * Agent-map hygiene: one canonical short map, thin dual-entry stubs, no bloat.
 *
 * - AGENTS.md is the single source of map content (Codex / Grok / multi-agent).
 * - CLAUDE.md is a short pointer so Claude Code auto-load still finds an entry.
 * - Line budgets keep auto-injected context small (attention is finite).
 * - Both files must stay present so discovery does not silently degrade.
 */
import { describe, it, expect } from 'vitest';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

/** Soft encyclopedia ceiling — map, not SPEC. */
const AGENTS_MAX_LINES = 120;
/** Pointer only; if this grows, content is being duplicated. */
const CLAUDE_MAX_LINES = 20;

async function linesOf(rel: string): Promise<{ text: string; lines: number; path: string }> {
  const path = join(ROOT, rel);
  const text = await readFile(path, 'utf8');
  // Count non-empty trailing newline as one line the way `wc -l` does.
  const lines = text.length === 0 ? 0 : text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
  return { text, lines, path };
}

describe('agent map dual-entry', () => {
  it('AGENTS.md exists and stays within the line budget', async () => {
    const { lines, text } = await linesOf('AGENTS.md');
    expect(lines, `AGENTS.md is ${lines} lines (max ${AGENTS_MAX_LINES}) — cut content, link to SPEC.md`).toBeLessThanOrEqual(
      AGENTS_MAX_LINES,
    );
    expect(lines).toBeGreaterThan(20); // not an empty stub
    expect(text).toMatch(/pnpm check/);
    expect(text).toMatch(/HERCULES_ADAPTER/);
    expect(text).toMatch(/domain\//);
  });

  it('CLAUDE.md is a thin pointer to AGENTS.md (no second encyclopedia)', async () => {
    const { lines, text } = await linesOf('CLAUDE.md');
    expect(lines, `CLAUDE.md is ${lines} lines (max ${CLAUDE_MAX_LINES}) — keep it a stub`).toBeLessThanOrEqual(
      CLAUDE_MAX_LINES,
    );
    expect(text).toMatch(/AGENTS\.md/);
    // Must not re-host the layer dump / long status — those belong in AGENTS.md only.
    expect(text).not.toMatch(/src\/orchestrator\//);
    expect(text).not.toMatch(/HERCULES_ADAPTER=grok/);
  });

  it('WORKFLOW.md points agents at AGENTS.md (not a stale CLAUDE-only path)', async () => {
    const { text } = await linesOf('WORKFLOW.md');
    expect(text).toMatch(/AGENTS\.md/);
  });

  it('both entry files are present (discovery must not 404)', async () => {
    await expect(access(join(ROOT, 'AGENTS.md'))).resolves.toBeUndefined();
    await expect(access(join(ROOT, 'CLAUDE.md'))).resolves.toBeUndefined();
  });
});
