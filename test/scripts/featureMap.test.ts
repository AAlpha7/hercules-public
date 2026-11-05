/**
 * Feature map generator (scripts/feature-map.mjs).
 *
 * Documents existing phone-SPA data-evidence chrome + WORKFLOW L2 scenes +
 * L2 fixture task ids. Sync gate: committed doc must match generator output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEATURE_MAP_DOC,
  collectFeatureMap,
  renderFeatureMap,
} from '../../scripts/feature-map.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const DOC_PATH = join(ROOT, FEATURE_MAP_DOC);

function firstDifferingLine(a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const n = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < n; i += 1) {
    if (aLines[i] !== bLines[i]) {
      return `line ${i + 1}: expected ${JSON.stringify(aLines[i] ?? '')} vs actual ${JSON.stringify(bLines[i] ?? '')}`;
    }
  }
  return '(no differing line)';
}

describe('scripts/feature-map.mjs', () => {
  it('committed feature map matches the generator output (run pnpm feature-map)', async () => {
    const generated = renderFeatureMap(await collectFeatureMap(ROOT));
    let committed = '';
    try {
      committed = await readFile(DOC_PATH, 'utf8');
    } catch {
      committed = '';
    }
    if (committed !== generated) {
      const diff = firstDifferingLine(generated, committed);
      expect.fail(`run: pnpm feature-map — ${diff}`);
    }
  });

  it('every WORKFLOW L2 scene anchor resolves to real chrome in src/web', async () => {
    const model = await collectFeatureMap(ROOT);
    expect(model.unknownAnchors).toEqual([]);
    expect(model.unknownTaskIds).toEqual([]);
  });

  describe('fixture parse', () => {
    let tmpRoot: string;

    beforeEach(async () => {
      tmpRoot = await mkdtemp(join(tmpdir(), 'hercules-feature-map-'));
      await mkdir(join(tmpRoot, 'src', 'web', 'nested'), { recursive: true });
      await mkdir(join(tmpRoot, 'scripts'), { recursive: true });
      await mkdir(join(tmpRoot, 'docs', 'agent-readiness'), { recursive: true });

      await writeFile(
        join(tmpRoot, 'src', 'web', 'Demo.tsx'),
        `
export function Demo({ on }: { on: boolean }) {
  return (
    <div>
      <button data-evidence="nav-demo">Demo</button>
      <span data-evidence={'static-brace'} />
      <span
        data-evidence={
          on ? 'ternary-on' : 'ternary-off'
        }
      />
      <span data-evidence={\`run-timeline-kind-\${kind}\`} />
    </div>
  );
}
`.trimStart(),
        'utf8',
      );

      await writeFile(
        join(tmpRoot, 'src', 'web', 'Demo.test.tsx'),
        `// should be skipped\n<button data-evidence="test-only-anchor" />\n`,
        'utf8',
      );

      await writeFile(
        join(tmpRoot, 'WORKFLOW.md'),
        `---
behavioral:
  evidence:
    - unlock
    - click: "[data-evidence=nav-demo]"
    - assert:
        selector: "[data-evidence=ternary-on]"
    - click: "[data-task-id=l2-fixture-demo]"
    - assert:
        selector: "[data-evidence=run-timeline-kind-failover]"
    - screenshot: demo-scene
    - click: "[data-evidence=static-brace]"
---

# body
`,
        'utf8',
      );

      await writeFile(
        join(tmpRoot, 'scripts', 'l2-seed-control-fixture.mjs'),
        `
const TASKS = [
  { id: 'l2-fixture-demo', content: 'x' },
  { id: "l2-fixture-other", content: 'y' },
];
const dyn = \`l2-fixture-resilience-die-\${n}\`;
['l2-m7-pass', 'title'].map(([id]) => ({ id }));
`.trimStart(),
        'utf8',
      );
    });

    afterEach(async () => {
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('parses static, ternary, and template data-evidence hosts from a fixture file', async () => {
      const model = await collectFeatureMap(tmpRoot);

      const byAnchor = new Map(model.anchors.map((a) => [a.anchor, a]));
      expect(byAnchor.get('nav-demo')).toMatchObject({
        dynamic: false,
        file: 'src/web/Demo.tsx',
      });
      expect(byAnchor.get('static-brace')).toMatchObject({ dynamic: false });
      expect(byAnchor.get('ternary-on')).toMatchObject({ dynamic: false });
      expect(byAnchor.get('ternary-off')).toMatchObject({ dynamic: false });
      expect(byAnchor.get('run-timeline-kind-*')).toMatchObject({
        dynamic: true,
      });
      expect(byAnchor.has('test-only-anchor')).toBe(false);

      expect(model.scenes).toHaveLength(2);
      expect(model.scenes[0]?.name).toBe('demo-scene');
      expect(model.scenes[0]?.steps[0]).toBe('unlock');
      expect(model.scenes[0]?.steps).toContain('click [data-evidence=nav-demo]');
      expect(model.scenes[0]?.anchors).toContain('nav-demo');
      expect(model.scenes[0]?.taskIds).toContain('l2-fixture-demo');
      expect(model.scenes[1]?.name).toBe('(no screenshot)');

      expect(model.fixtureTaskIds).toEqual(
        expect.arrayContaining([
          'l2-fixture-demo',
          'l2-fixture-other',
          'l2-fixture-resilience-die-',
          'l2-m7-pass',
        ]),
      );

      expect(model.unknownAnchors).toEqual([]);
      expect(model.unknownTaskIds).toEqual([]);
    });
  });

  it('renders deterministically', async () => {
    const model = await collectFeatureMap(ROOT);
    const a = renderFeatureMap(model);
    const b = renderFeatureMap(model);
    expect(a).toBe(b);
    expect(a.startsWith('# Hercules feature map (generated)\n')).toBe(true);
    expect(a.endsWith('\n')).toBe(true);
  });
});
