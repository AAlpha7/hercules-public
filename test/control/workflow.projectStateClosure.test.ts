import { describe, it, expect } from 'vitest';
import { parseWorkflow, WorkflowError } from '../../src/control/workflow.js';

describe('WORKFLOW project_state_closure', () => {
  it('parses opt-in surfaces without task-body path injection', () => {
    const wf = parseWorkflow(`---
gates:
  test: echo ok
project_state_closure:
  surfaces:
    status: PROJECT_STATUS.md
    backlog: docs/roadmap.md
    exec_plan: docs/ExecPlan.md
    changelog: CHANGELOG.md
  rules:
    - id: close-onboarding
      when:
        labels_any: [onboarding]
      surfaces: [status, backlog]
      forbid_patterns:
        - "onboarding incomplete"
      require_patterns:
        - "onboarding complete"
      required_update: Mark Status and Backlog as onboarding complete
---
body
`);
    expect(wf.projectStateClosure).toBeDefined();
    expect(wf.projectStateClosure!.surfaces.map((s) => s.kind).sort()).toEqual([
      'backlog',
      'changelog',
      'exec_plan',
      'status',
    ]);
    expect(wf.projectStateClosure!.rules[0]!.id).toBe('close-onboarding');
  });

  it('absent section leaves ordinary repos unaffected', () => {
    const wf = parseWorkflow(`---\ngates:\n  test: echo ok\n---\nbody\n`);
    expect(wf.projectStateClosure).toBeUndefined();
  });

  it('rejects unknown surface kinds from trusted config', () => {
    expect(() =>
      parseWorkflow(`---
gates:
  test: echo ok
project_state_closure:
  surfaces:
    secret: evil.md
  rules:
    - id: r1
      surfaces: [status]
      forbid_patterns: [x]
      required_update: fix
---
body
`),
    ).toThrow(WorkflowError);
  });

  it('accepts policy-path stub for external trusted policy', () => {
    const wf = parseWorkflow(`---
gates:
  test: echo ok
project_state_closure:
  policy: docs/project-state-closure.yaml
---
body
`);
    expect(wf.projectStateClosure?.policyPath).toBe('docs/project-state-closure.yaml');
    expect(wf.projectStateClosure?.surfaces).toEqual([]);
  });
});
