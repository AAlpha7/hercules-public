import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('M7 provider wiring boundary', () => {
  it('keeps direct M7 authority ports out of the production composition root', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    expect(main).not.toMatch(
      /\b(?:reviewPackageV2|reviewEvidence|learningProposals|reviewDecisionActor|reviewDecisions)\b/,
    );
    expect(main).toMatch(/openIsolatedM7ReviewApiDeps/);
  });

  it('confines all M7 wiring to the reviewed fake-only factory', () => {
    const api = readFileSync(resolve(process.cwd(), 'src/server/api.ts'), 'utf8');
    const provider = readFileSync(
      resolve(process.cwd(), 'src/isolation/m7L2ReviewProvider.ts'),
      'utf8',
    );
    expect(api).toMatch(/openM7L2ReviewProvider/);
    expect(api).toMatch(/HERCULES_M7_L2_FIXTURE_PATH/);
    expect(api).not.toMatch(/export function inspectReviewPackageV2Source/);
    expect(provider).toMatch(/HERCULES_ADAPTER.*!== 'fake'/);
    expect(provider).toMatch(/HERCULES_FAKE_FAULT_INJECTION.*!== '1'/);
    expect(provider).toMatch(/HERCULES_L2_ISOLATED.*!== '1'/);
    expect(provider).not.toMatch(/ActionService|merge|deploy|GitControl|fetch\(|https?:/);
  });

  it('makes the real L2 boot opt out of credentials and external background work', () => {
    const workflow = readFileSync(resolve(process.cwd(), 'WORKFLOW.md'), 'utf8');
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    expect(workflow).toMatch(/env -u XAI_API_KEY -u GROK_API_KEY/);
    expect(workflow).toMatch(/HERCULES_L2_ISOLATED=1/);
    expect(workflow).toMatch(/HERCULES_XAI_USE_CLI_TOKEN=0/);
    expect(main).toMatch(/isolatedL2Boot/);
    expect(main).toMatch(/if \(!isolatedL2Boot\)/);
    expect(main).toMatch(/external voice avatar generation disabled/);
    expect(main).toMatch(/external pull-request reconciliation disabled/);
  });

  it('wires Control API V2 only behind the authority flag via src/control/', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    expect(main).not.toMatch(/\b(?:controlApiV2Reader|controlApiV2Mutator|controlApiV2Events)\b/);
    expect(main).not.toMatch(/openIsolatedControlApiV2Deps/);
    expect(main).toMatch(/from '\.\/control\/controlApiV2Provider\.js'/);
    expect(main).toMatch(/openControlApiV2Deps\(\{\s*store: shadowStore,\s*env: process\.env/);
    const provider = readFileSync(resolve(process.cwd(), 'src/control/controlApiV2Provider.ts'), 'utf8');
    expect(provider).toMatch(/HERCULES_CONTROL_API_V2_AUTHORITY/);
    expect(provider).toMatch(/=== '1'/);
    expect(provider).not.toMatch(/from ['"].*(?:controlapi|server|isolation)\//);
    expect(provider).not.toMatch(/sqliteStateStore|better-sqlite3/);
  });

  it('pins the C3 wiring-point env names and roster file constant in main.ts', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    expect(main).toMatch(/HERCULES_V2_EVIDENCE_ROOT/);
    expect(main).toMatch(/HERCULES_V2_REVIEW_EVALUATION/);
    expect(main).toMatch(/HERCULES_V2_APPROVAL_BRIDGE/);
    expect(main).toMatch(/HERCULES_V2_DECISION_EFFECTS/);
    expect(main).toMatch(/AUTHORITY_ROSTER_FILE/);
  });

  it('constructs Control API V2 providers only in the isolated fake factory', () => {
    const provider = readFileSync(
      resolve(process.cwd(), 'src/isolation/controlApiV2FakeProvider.ts'),
      'utf8',
    );
    expect(provider).toMatch(/export function openIsolatedControlApiV2Deps/);
    expect(provider).toMatch(/HERCULES_ADAPTER.*=== 'fake'/);
    expect(provider).toMatch(/HERCULES_FAKE_FAULT_INJECTION.*=== '1'/);
    expect(provider).toMatch(/HERCULES_L2_ISOLATED.*=== '1'/);
    expect(provider).not.toMatch(/from ['"].*control\/state\//);
    expect(provider).not.toMatch(/ActionService|merge|deploy|GitControl/);
  });
});
