import { describe, it, expect } from 'vitest';
import {
  buildLeaseRecord,
  classifyLeaseOwner,
  classifyLegacyOwnerPid,
  formatLeaseConflictDiagnostic,
  formatDaemonLeaseIoDiagnostic,
  mayReleaseLease,
  parseLeaseRecord,
  parseLegacyOwnerPid,
  scopeFingerprint,
  serializeLeaseRecord,
  type DaemonLeaseIdentity,
  type DaemonLeaseRecord,
} from '../../src/domain/daemonLease.js';

const us: DaemonLeaseIdentity = {
  instanceId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  pid: 4242,
  starttime: '1000',
  bootId: 'boot-1',
};

function foreign(over: Partial<DaemonLeaseRecord> = {}): DaemonLeaseRecord {
  return {
    version: 1,
    instanceId: 'ffffffff-1111-2222-3333-444444444444',
    pid: 7,
    starttime: '500',
    bootId: 'boot-1',
    controlRepo: '/home/op/ctrl',
    workRoot: '/home/op/work',
    acquiredAtMs: 1700000000000,
    ...over,
  };
}

describe('daemonLease domain', () => {
  it('round-trips and rejects bad input', () => {
    const rec = buildLeaseRecord(us, { controlRepo: '/c', workRoot: '/w' }, 99);
    expect(parseLeaseRecord(serializeLeaseRecord(rec))).toEqual(rec);
    expect(parseLeaseRecord('')).toBeNull();
    expect(parseLeaseRecord('{')).toBeNull();
    expect(parseLegacyOwnerPid('1')).toBe(1);
    expect(parseLegacyOwnerPid('nope')).toBeNull();
  });

  it('classifies ours, live foreign, dead stale, recycled pid, boot change', () => {
    const ours = buildLeaseRecord(us, { controlRepo: '/c', workRoot: '/w' }, 1);
    expect(classifyLeaseOwner(null, us, { pidAlive: false, currentStarttime: null, currentBootId: 'boot-1' }).kind).toBe('absent');
    expect(classifyLeaseOwner(ours, us, { pidAlive: true, currentStarttime: '1000', currentBootId: 'boot-1' }).kind).toBe('ours');
    expect(classifyLeaseOwner(foreign(), us, { pidAlive: true, currentStarttime: '500', currentBootId: 'boot-1' }).kind).toBe('live_foreign');
    expect(classifyLeaseOwner(foreign(), us, { pidAlive: false, currentStarttime: null, currentBootId: 'boot-1' }).kind).toBe('stale');
    expect(classifyLeaseOwner(foreign({ starttime: '111' }), us, { pidAlive: true, currentStarttime: '999', currentBootId: 'boot-1' }).kind).toBe('stale');
    expect(classifyLeaseOwner(foreign({ bootId: 'old' }), us, { pidAlive: true, currentStarttime: '500', currentBootId: 'new' }).kind).toBe('stale');
    expect(classifyLeaseOwner(foreign({ starttime: '' }), us, { pidAlive: true, currentStarttime: null, currentBootId: 'boot-1' }).kind).toBe('live_foreign');
  });

  it('classifies legacy pid locks fail-closed', () => {
    expect(classifyLegacyOwnerPid(1, 4242, true).kind).toBe('live_foreign');
    expect(classifyLegacyOwnerPid(999999, 4242, false).kind).toBe('stale');
    expect(classifyLegacyOwnerPid(4242, 4242, true).kind).toBe('ours');
  });

  it('releases only for owning instanceId', () => {
    const ours = buildLeaseRecord(us, { controlRepo: '/c', workRoot: '/w' }, 1);
    expect(mayReleaseLease(ours, us)).toBe(true);
    expect(mayReleaseLease(foreign(), us)).toBe(false);
    expect(mayReleaseLease(null, us)).toBe(false);
  });

  it('fingerprints scopes and never echoes raw paths in conflict diagnostics', () => {
    const secretPath = '/home/ubuntu/secret-token/ctrl';
    const fp = scopeFingerprint(secretPath);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    const msg = formatLeaseConflictDiagnostic({
      scopeControl: '/home/ubuntu/projects/live-ctrl',
      scopeWork: '/home/ubuntu/hercules-work',
      owner: foreign({
        controlRepo: '/home/ubuntu/projects/live-ctrl',
        workRoot: '/home/ubuntu/hercules-work',
        instanceId: 'abcdef12-3456-7890-abcd-ef1234567890',
      }),
      scopeKind: 'work',
    });
    expect(msg).toMatch(/daemon lease conflict/);
    expect(msg).toContain('controlFp=');
    expect(msg).toContain('workFp=');
    expect(msg).not.toContain('/home/ubuntu');
    expect(msg).not.toContain('secret-token');
    expect(msg).toContain('abcdef12...');
    expect(msg).not.toContain('abcdef12-3456-7890-abcd-ef1234567890');
  });

  it('io diagnostics emit only op, scope, fingerprint, and errno', () => {
    const secretPath = '/home/ubuntu/secret-token/ctrl';
    const msg = formatDaemonLeaseIoDiagnostic({
      operation: 'mkdir',
      scopeKind: 'work',
      path: secretPath,
      code: 'ENOTDIR',
    });
    expect(msg).toBe(
      'daemon lease io: op=mkdir scope=work fp=' +
        scopeFingerprint(secretPath) +
        ' code=ENOTDIR',
    );
    expect(msg).not.toContain('secret-token');
    expect(msg).not.toContain('/home');
  });
});
