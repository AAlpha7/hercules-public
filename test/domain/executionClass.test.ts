import { describe, it, expect } from 'vitest';
import {
  EXECUTION_CLASSES,
  HOST_MUTATING_EXECUTION_CLASSES,
  DEFAULT_EXECUTION_CLASS,
  isExecutionClass,
  parseExecutionClass,
  resolveExecutionClass,
  isHostMutatingClass,
  isCodingExecutionClass,
  isAutonomousHostEligible,
  validateHostCommandScope,
  validateHostOperationReceipt,
  isIsoTimestamp,
  formatHostOperationReceipt,
  parseHostOperationReceipt,
  stripHostOperationReceiptSections,
  stampHostOperationApproval,
  HOST_OP_APPROVAL_HEADING,
  type HostOperationReceipt,
} from '../../src/domain/executionClass.js';

describe('execution class vocabulary', () => {
  it('exposes the five audited classes', () => {
    expect([...EXECUTION_CLASSES]).toEqual([
      'explore',
      'implement',
      'verify',
      'host_operation',
      'deploy',
    ]);
    expect([...HOST_MUTATING_EXECUTION_CLASSES]).toEqual(['host_operation', 'deploy']);
    expect(DEFAULT_EXECUTION_CLASS).toBe('implement');
  });

  it('isExecutionClass / parseExecutionClass accept known values and reject junk', () => {
    expect(isExecutionClass('implement')).toBe(true);
    expect(isExecutionClass('host_operation')).toBe(true);
    expect(isExecutionClass('bogus')).toBe(false);
    expect(parseExecutionClass('  Deploy ')).toBe('deploy');
    expect(parseExecutionClass(null)).toBeNull();
    expect(parseExecutionClass('')).toBeNull();
    expect(parseExecutionClass('nope')).toBeNull();
  });

  it('resolveExecutionClass defaults legacy / missing to implement', () => {
    expect(resolveExecutionClass({})).toBe('implement');
    expect(resolveExecutionClass({ executionClass: null })).toBe('implement');
    expect(resolveExecutionClass({ executionClass: 'explore' })).toBe('explore');
  });

  it('classifies coding vs host-mutating classes', () => {
    expect(isCodingExecutionClass('explore')).toBe(true);
    expect(isCodingExecutionClass('implement')).toBe(true);
    expect(isCodingExecutionClass('verify')).toBe(true);
    expect(isCodingExecutionClass('host_operation')).toBe(false);
    expect(isHostMutatingClass('host_operation')).toBe(true);
    expect(isHostMutatingClass('deploy')).toBe(true);
    expect(isHostMutatingClass('implement')).toBe(false);
  });
});

describe('autonomous host eligibility', () => {
  it('coding classes are eligible without host approval (legacy ordinary path)', () => {
    expect(isAutonomousHostEligible({ executionClass: 'implement' })).toBe(true);
    expect(isAutonomousHostEligible({})).toBe(true);
    expect(isAutonomousHostEligible({ executionClass: 'explore' })).toBe(true);
    expect(isAutonomousHostEligible({ executionClass: 'verify' })).toBe(true);
  });

  it('host_operation / deploy are ineligible without approval + bounded command scope', () => {
    expect(isAutonomousHostEligible({ executionClass: 'host_operation' })).toBe(false);
    expect(
      isAutonomousHostEligible({
        executionClass: 'host_operation',
        hostCommandScope: ['systemctl restart hercules'],
      }),
    ).toBe(false);
    expect(
      isAutonomousHostEligible({
        executionClass: 'deploy',
        hostApprovedAt: '2026-07-31T00:00:00.000Z',
      }),
    ).toBe(false);
    expect(
      isAutonomousHostEligible({
        executionClass: 'host_operation',
        hostCommandScope: [],
        hostApprovedAt: '2026-07-31T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('host_operation / deploy become eligible with valid approval record + literal scope', () => {
    expect(
      isAutonomousHostEligible({
        executionClass: 'host_operation',
        hostCommandScope: ['systemctl restart hercules'],
        hostApprovedAt: '2026-07-31T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      isAutonomousHostEligible({
        executionClass: 'deploy',
        hostCommandScope: ['./scripts/deploy-staging.sh'],
        hostApprovedAt: '2026-07-31T12:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      isAutonomousHostEligible({
        executionClass: 'deploy',
        hostCommandScope: ['bash -c systemctl restart hercules'],
        hostApprovedAt: 'not-a-date',
      }),
    ).toBe(false);
  });
});

describe('validateHostCommandScope', () => {
  it('accepts a small list of non-empty named commands', () => {
    const r = validateHostCommandScope(['systemctl restart hercules', 'curl -sf http://localhost:8787/']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.scope).toEqual([
        'systemctl restart hercules',
        'curl -sf http://localhost:8787/',
      ]);
    }
  });

  it('rejects empty, wildcard, wrapper, shell syntax, duplicate, and oversized scopes', () => {
    expect(validateHostCommandScope([]).ok).toBe(false);
    expect(validateHostCommandScope(['  ']).ok).toBe(false);
    expect(validateHostCommandScope(['*']).ok).toBe(false);
    expect(validateHostCommandScope(['Bash(*)']).ok).toBe(false);
    expect(validateHostCommandScope(['Bash(systemctl restart hercules)']).ok).toBe(false);
    expect(validateHostCommandScope(['bash -c systemctl restart hercules']).ok).toBe(false);
    expect(validateHostCommandScope(['command bash -c id']).ok).toBe(false);
    expect(validateHostCommandScope(['systemctl restart hercules; id']).ok).toBe(false);
    expect(validateHostCommandScope(['systemctl restart $UNIT']).ok).toBe(false);
    expect(validateHostCommandScope(['curl https://example.test/*']).ok).toBe(false);
    expect(validateHostCommandScope(['systemctl\trestart hercules']).ok).toBe(false);
    expect(validateHostCommandScope(['systemctl is-active x', 'systemctl is-active x']).ok).toBe(
      false,
    );
    const tooMany = Array.from({ length: 20 }, (_, i) => `cmd-${i}`);
    expect(validateHostCommandScope(tooMany).ok).toBe(false);
    expect(validateHostCommandScope(['x'.repeat(300)]).ok).toBe(false);
  });

  it('rejects credential-like assignments and credential-bearing URIs (fail-closed)', () => {
    expect(validateHostCommandScope(['export XAI_API_KEY=sk-live-secret']).ok).toBe(false);
    expect(validateHostCommandScope(['env GITHUB_TOKEN=ghp-secret true']).ok).toBe(false);
    expect(validateHostCommandScope(['cmd DATABASE_URL=postgres://u:p@h/db']).ok).toBe(false);
    expect(
      validateHostCommandScope(['curl https://user:pass@example.test/secret']).ok,
    ).toBe(false);
    // Still accept ordinary non-secret literals.
    expect(validateHostCommandScope(['systemctl is-active hercules']).ok).toBe(true);
  });
});

describe('host approval timestamp', () => {
  it('accepts ISO UTC timestamps and rejects arbitrary text', () => {
    expect(isIsoTimestamp('2026-07-31T12:00:00.000Z')).toBe(true);
    expect(isIsoTimestamp('2026-07-31T12:00:00Z')).toBe(true);
    expect(isIsoTimestamp('2026-07-31')).toBe(false);
    expect(isIsoTimestamp('tomorrow')).toBe(false);
  });
});

describe('host operation receipt (packet section)', () => {
  it('round-trips markdown receipt with scope, outcome, post-check evidence', () => {
    const receipt: HostOperationReceipt = {
      commandScope: ['systemctl restart hercules', 'curl -sf http://localhost:8787/'],
      outcome: 'success',
      postCheckEvidence: 'health returned HTTP 200',
    };
    const md = formatHostOperationReceipt(receipt);
    expect(md).toContain('## Host operation receipt');
    expect(md).toContain('systemctl restart hercules');
    expect(md).toContain('success');
    expect(md).toContain('health returned HTTP 200');
    const parsed = parseHostOperationReceipt(md);
    expect(parsed).toEqual(receipt);
  });

  it('returns null when section is absent', () => {
    expect(parseHostOperationReceipt('## Goal\nordinary task\n')).toBeNull();
  });

  it('requires exact scope, success, and nonblank post-check evidence', () => {
    const approved = ['systemctl restart hercules'];
    expect(
      validateHostOperationReceipt(
        {
          commandScope: approved,
          outcome: 'success',
          postCheckEvidence: 'systemctl is-active returned active',
        },
        approved,
      ).ok,
    ).toBe(true);
    expect(validateHostOperationReceipt(null, approved).ok).toBe(false);
    expect(
      validateHostOperationReceipt(
        { commandScope: ['systemctl restart other'], outcome: 'success', postCheckEvidence: 'ok' },
        approved,
      ).ok,
    ).toBe(false);
    expect(
      validateHostOperationReceipt(
        { commandScope: approved, outcome: 'partial', postCheckEvidence: 'not active' },
        approved,
      ).ok,
    ).toBe(false);
    expect(
      validateHostOperationReceipt(
        { commandScope: approved, outcome: 'success', postCheckEvidence: '  ' },
        approved,
      ).ok,
    ).toBe(false);
  });

  it('stripHostOperationReceiptSections removes the receipt block and keeps narrative', () => {
    const text = [
      'Deterministic host executor ran 1 approved command(s) successfully.',
      '',
      '## Host operation receipt',
      '',
      '- **Command scope:** `true`',
      '- **Outcome:** success',
      '- **Post-check evidence:** exit=0',
      '',
      '## Self-assessment',
      '',
      '- done',
    ].join('\n');
    const stripped = stripHostOperationReceiptSections(text);
    expect(stripped).toContain('Deterministic host executor ran 1 approved command(s) successfully.');
    expect(stripped).toContain('## Self-assessment');
    expect(stripped).toContain('- done');
    expect(stripped).not.toContain('## Host operation receipt');
    expect(stripped).not.toContain('**Command scope:**');
  });
});

describe('stampHostOperationApproval', () => {
  it('appends an audit section for the human approval record', () => {
    const body = stampHostOperationApproval('## Goal\nrestart unit\n', {
      commandScope: ['systemctl restart hercules'],
      approvedAt: '2026-07-31T12:00:00.000Z',
    });
    expect(body).toContain(HOST_OP_APPROVAL_HEADING);
    expect(body).toContain('systemctl restart hercules');
    expect(body).toContain('2026-07-31T12:00:00.000Z');
  });
});
