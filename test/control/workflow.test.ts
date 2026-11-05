import { describe, it, expect } from 'vitest';
import { parseWorkflow, WorkflowError } from '../../src/control/workflow.js';

const WORKFLOW = `---
gates:
  typecheck: pnpm typecheck
  lint: pnpm lint
  test: pnpm test
  build: pnpm build
held_out_smoke: pnpm test:smoke
protected_paths:
  - test/smoke/**
---

# Working in Example

## Golden principles
- domain must not import web
- all new code is tested
`;

describe('parseWorkflow (SPEC §12)', () => {
  it('extracts gates in canonical order', () => {
    const wf = parseWorkflow(WORKFLOW);
    expect(wf.gates.map((g) => g.name)).toEqual(['typecheck', 'lint', 'test', 'build']);
    expect(wf.gates[0]!.command).toBe('pnpm typecheck');
  });

  it('extracts protected paths and held-out smoke', () => {
    const wf = parseWorkflow(WORKFLOW);
    expect(wf.protectedPaths).toEqual(['test/smoke/**']);
    expect(wf.heldOutSmoke).toBe('pnpm test:smoke');
  });

  it('keeps the markdown body as the principles/prompt', () => {
    const wf = parseWorkflow(WORKFLOW);
    expect(wf.body).toContain('Golden principles');
    expect(wf.body).toContain('domain must not import web');
  });

  it('extracts setup.install commands and health_check', () => {
    const wf = parseWorkflow(`---
setup:
  install:
    - pnpm install --frozen-lockfile
  boot:
    - pnpm dev &
  health_check: curl -sf localhost:3000/health
gates:
  test: pnpm test
---
body
`);
    expect(wf.setup.install).toEqual(['pnpm install --frozen-lockfile']);
    expect(wf.setup.boot).toEqual(['pnpm dev &']);
    expect(wf.healthCheck).toBe('curl -sf localhost:3000/health');
  });

  it('defaults setup to empty arrays when absent', () => {
    const wf = parseWorkflow(`---\ngates:\n  test: pnpm test\n---\nbody\n`);
    expect(wf.setup.install).toEqual([]);
    expect(wf.setup.boot).toEqual([]);
  });

  it('tolerates a partial gates set', () => {
    const wf = parseWorkflow(`---\ngates:\n  test: pnpm test\n---\nbody\n`);
    expect(wf.gates.map((g) => g.name)).toEqual(['test']);
    expect(wf.protectedPaths).toEqual([]);
  });

  it('extracts behavioral config (Layer 2, SPEC §9.2)', () => {
    const wf = parseWorkflow(`---
behavioral:
  base_url: http://localhost:{port}
  driver: cdp
  auth_token: demo
  auth_storage_key: hercules_token
  capture:
    - screenshot
  smoke_flows:
    - load / and check it renders
  evidence:
    - unlock
    - screenshot: shell
    - click: "[data-evidence=nav-settings]"
      optional: true
gates:
  test: pnpm test
---
body
`);
    expect(wf.behavioral?.baseUrl).toBe('http://localhost:{port}');
    expect(wf.behavioral?.capture).toEqual(['screenshot']);
    expect(wf.behavioral?.smokeFlows).toEqual(['load / and check it renders']);
    expect(wf.behavioral?.authToken).toBe('demo');
    expect(wf.behavioral?.authStorageKey).toBe('hercules_token');
    expect(wf.behavioral?.evidence.map((s) => s.kind)).toEqual([
      'unlock',
      'screenshot',
      'click',
    ]);
    expect(wf.behavioral?.evidence[2]?.optional).toBe(true);
  });

  it('leaves behavioral undefined when absent', () => {
    const wf = parseWorkflow(`---\ngates:\n  test: pnpm test\n---\nbody\n`);
    expect(wf.behavioral).toBeUndefined();
  });

  it('throws on missing front matter', () => {
    expect(() => parseWorkflow('just a body')).toThrow(WorkflowError);
  });

  // ── deploy: section (release pipeline design §2) ─────────────────────

  it('leaves deploy undefined when the section is absent (zero behavior change)', () => {
    const wf = parseWorkflow(WORKFLOW);
    expect(wf.deploy).toBeUndefined();
  });

  it('parses a full deploy section (staging + production)', () => {
    const wf = parseWorkflow(`---
gates:
  test: pnpm test
deploy:
  staging:
    command: ./scripts/deploy-staging.sh
    health: curl -sf http://localhost:8788/
    url: http://host:8788/
    verify:
      - unlock
      - screenshot: shell
      - click: "[data-evidence=nav-settings]"
      - assert: { selector: "[data-evidence=settings-panel]" }
  production:
    command: ./scripts/deploy-production.sh <sha>
    health: curl -sf http://localhost:8787/
    smoke: curl -sf http://localhost:8787/api/health
---
body
`);
    expect(wf.deploy).toBeDefined();
    expect(wf.deploy?.staging).toEqual({
      authStorageKey: 'hercules_token',
      authTokenEnv: undefined,
      command: './scripts/deploy-staging.sh',
      health: 'curl -sf http://localhost:8788/',
      url: 'http://host:8788/',
      verify: expect.any(Array),
    });
    expect(wf.deploy?.staging?.verify.map((s) => s.kind)).toEqual([
      'unlock',
      'screenshot',
      'click',
      'assert',
    ]);
    expect(wf.deploy?.staging?.verify[2]?.selector).toBe('[data-evidence=nav-settings]');
    expect(wf.deploy?.staging?.verify[3]?.selector).toBe('[data-evidence=settings-panel]');
    expect(wf.deploy?.production).toEqual({
      command: './scripts/deploy-production.sh <sha>',
      health: 'curl -sf http://localhost:8787/',
      smoke: 'curl -sf http://localhost:8787/api/health',
    });
  });

  it('parses partial deploy (staging only; optional fields absent)', () => {
    const wf = parseWorkflow(`---
gates:
  test: pnpm test
deploy:
  staging:
    command: ./scripts/deploy-staging.sh
    health: curl -sf http://localhost:8788/
---
body
`);
    expect(wf.deploy?.staging?.command).toBe('./scripts/deploy-staging.sh');
    expect(wf.deploy?.staging?.health).toBe('curl -sf http://localhost:8788/');
    expect(wf.deploy?.staging?.url).toBeUndefined();
    expect(wf.deploy?.staging?.verify).toEqual([]);
    expect(wf.deploy?.production).toBeUndefined();
  });

  it('parses partial deploy (production only; smoke optional)', () => {
    const wf = parseWorkflow(`---
gates:
  test: pnpm test
deploy:
  production:
    command: ./scripts/deploy-production.sh <sha>
    health: curl -sf http://localhost:8787/
---
body
`);
    expect(wf.deploy?.staging).toBeUndefined();
    expect(wf.deploy?.production?.command).toBe('./scripts/deploy-production.sh <sha>');
    expect(wf.deploy?.production?.health).toBe('curl -sf http://localhost:8787/');
    expect(wf.deploy?.production?.smoke).toBeUndefined();
  });

  it('reuses the existing evidence DSL for staging.verify (no second dialect)', () => {
    const wf = parseWorkflow(`---
gates:
  test: pnpm test
deploy:
  staging:
    command: ./scripts/deploy-staging.sh
    health: curl -sf http://localhost:8788/
    verify:
      - unlock
      - "screenshot shell"
      - click "[data-evidence=nav-settings]"
      - assert text=Language|语言
---
body
`);
    const kinds = wf.deploy?.staging?.verify.map((s) => s.kind);
    expect(kinds).toEqual(['unlock', 'screenshot', 'click', 'assert']);
    expect(wf.deploy?.staging?.verify[1]?.name).toBe('shell');
    expect(wf.deploy?.staging?.verify[3]?.text).toBe('Language|语言');
  });

  it('throws WorkflowError on malformed deploy.staging (missing command)', () => {
    expect(() =>
      parseWorkflow(`---
gates:
  test: pnpm test
deploy:
  staging:
    health: curl -sf http://localhost:8788/
---
body
`),
    ).toThrow(WorkflowError);
  });

  it('throws WorkflowError on malformed deploy.production (missing health)', () => {
    expect(() =>
      parseWorkflow(`---
gates:
  test: pnpm test
deploy:
  production:
    command: ./scripts/deploy-production.sh
---
body
`),
    ).toThrow(WorkflowError);
  });

  it('throws WorkflowError when deploy is not an object', () => {
    expect(() =>
      parseWorkflow(`---
gates:
  test: pnpm test
deploy: not-an-object
---
body
`),
    ).toThrow(WorkflowError);
  });
});

describe('deploy.staging auth (release verify unlock)', () => {
  it('parses auth_token_env + auth_storage_key for staging evidence', () => {
    const wf = parseWorkflow(`---
deploy:
  staging:
    command: ./s.sh
    health: curl -sf http://localhost:1/
    auth_token_env: STAGING_UI_TOKEN
    auth_storage_key: hercules_token
---
b`);
    expect(wf.deploy?.staging?.authTokenEnv).toBe('STAGING_UI_TOKEN');
    expect(wf.deploy?.staging?.authStorageKey).toBe('hercules_token');
  });

  it('defaults: absent auth fields stay undefined / hercules_token', () => {
    const wf = parseWorkflow(`---
deploy:
  staging:
    command: ./s.sh
    health: h
---
b`);
    expect(wf.deploy?.staging?.authTokenEnv).toBeUndefined();
    expect(wf.deploy?.staging?.authStorageKey).toBe('hercules_token');
  });
});
