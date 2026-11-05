import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSnapshot } from '../src/control/snapshot.js';
import { draftReadinessPipeline } from '../src/domain/onboarding.js';

const exampleDir = fileURLToPath(new URL('../examples/control-repo', import.meta.url));
const readinessDir = fileURLToPath(new URL('../examples/readiness-pipeline', import.meta.url));

describe('bundled example control repo', () => {
  it('loads cleanly with no problems', async () => {
    const snap = await buildSnapshot(exampleDir);
    expect(snap.problems).toEqual([]);
    expect(Object.keys(snap.repos.repos)).toContain('example-app');

    const ex1 = snap.tasks.find((t) => t.id === 'EX-1');
    expect(ex1).toBeDefined();
    expect(ex1!.repo).toBe('example-app');
    expect(ex1!.state).toBe('todo');
  });
});

describe('readiness pipeline example', () => {
  it('api-example.json matches 4-stage draft shape for operators', async () => {
    const raw = await readFile(join(readinessDir, 'api-example.json'), 'utf8');
    const api = JSON.parse(raw) as {
      repo: string;
      idPrefix: string;
      stages: { title: string; body: string; labels: string[] }[];
    };
    expect(api.stages).toHaveLength(4);
    expect(api.idPrefix).toBe(`${api.repo}-ready`);
    for (const s of api.stages) {
      expect(s.labels).toEqual(expect.arrayContaining(['onboarding', 'readiness']));
      expect(s.body).toMatch(/## Definition of Done/);
    }
    const draft = draftReadinessPipeline(api.repo);
    expect(api.stages.map((s) => s.title)).toEqual(draft.stages.map((s) => s.title));
    // Stage bodies stay aligned with domain draft (example is a snapshot of the generator).
    for (let i = 0; i < 4; i++) {
      expect(api.stages[i]!.body.trim()).toBe(draft.stages[i]!.body.trim());
    }
  });

  it('documents operator entry in README', async () => {
    const readme = await readFile(join(readinessDir, 'README.md'), 'utf8');
    expect(readme).toMatch(/draftReadinessPipeline/);
    expect(readme).toMatch(/POST \/api\/pipelines/);
    expect(readme).toMatch(/R1/);
  });
});
