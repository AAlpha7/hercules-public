import { describe, it, expect } from 'vitest';
import { parseWorkflow, WorkflowError } from '../../src/control/workflow.js';

function wf(body: string): string {
  return ['---', body, '---', 'principles', ''].join('\n');
}

describe('WORKFLOW cli_evidence parsing', () => {
  it('accepts valid cli_evidence', () => {
    const content = wf([
      'gates:',
      '  test: pnpm test',
      'cli_evidence:',
      '  version: 1',
      '  steps:',
      '    - id: help',
      '      argv: [node, scripts/x.mjs, --help]',
      '      expect:',
      '        exit_code: 0',
    ].join('\n'));
    const parsed = parseWorkflow(content);
    expect(parsed.cliEvidence?.version).toBe(1);
    expect(parsed.cliEvidence?.steps[0]?.id).toBe('help');
    expect(parsed.cliEvidence?.steps[0]?.argv).toEqual([
      'node',
      'scripts/x.mjs',
      '--help',
    ]);
  });

  it('rejects shell wrappers via WorkflowError', () => {
    const content = wf([
      'gates:',
      '  test: pnpm test',
      'cli_evidence:',
      '  version: 1',
      '  steps:',
      '    - id: bad',
      '      argv: [bash, -c, id]',
    ].join('\n'));
    expect(() => parseWorkflow(content)).toThrow(WorkflowError);
  });

  it('leaves cliEvidence undefined when absent', () => {
    const content = wf(['gates:', '  test: pnpm test'].join('\n'));
    expect(parseWorkflow(content).cliEvidence).toBeUndefined();
  });

  it('does not parse command-looking task body text', () => {
    const content = wf(['gates:', '  test: pnpm test'].join('\n')) +
      '\n## Evidence\ncli_evidence:\n  version: 1\n  steps:\n    - argv: [sh, -c, id]\n';
    expect(parseWorkflow(content).cliEvidence).toBeUndefined();
  });
});
