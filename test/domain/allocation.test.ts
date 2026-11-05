import { describe, it, expect } from 'vitest';
import { branchFor, BRANCH_PREFIX, remoteFactoryWorkspace } from '../../src/domain/allocation.js';
import { IdentifierError } from '../../src/domain/task.js';

describe('branchFor (SPEC §8.2)', () => {
  it('namespaces task branches under the hercules/ prefix', () => {
    expect(branchFor('ABC-12')).toBe('hercules/ABC-12');
    expect(BRANCH_PREFIX).toBe('hercules/');
  });

  it('rejects an unsafe task id (no path/branch injection, §10)', () => {
    expect(() => branchFor('../evil')).toThrow(IdentifierError);
    expect(() => branchFor('a b')).toThrow(IdentifierError);
    expect(() => branchFor('')).toThrow(IdentifierError);
  });
});

describe('remoteFactoryWorkspace', () => {
  it('is a logical allocation with no host port', () => {
    const ws = remoteFactoryWorkspace({ taskId: 'T-factory', repo: 'app' });
    expect(ws.taskId).toBe('T-factory');
    expect(ws.repo).toBe('app');
    expect(ws.branch).toBe('hercules/T-factory');
    expect(ws.allocation.port).toBe(0);
    expect(ws.allocation.slug).toBe('T-factory');
    expect(ws.dir).toContain('cursor-cloud');
    expect(ws.branchLease.expectedRemoteTip).toBeNull();
  });

  it('rejects an unsafe repo key', () => {
    expect(() => remoteFactoryWorkspace({ taskId: 'T-1', repo: '../evil' })).toThrow(
      IdentifierError,
    );
  });
});
