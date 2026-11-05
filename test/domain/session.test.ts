import { describe, it, expect } from 'vitest';
import {
  decidePermission,
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  isValidSessionId,
  newFreeSessionId,
  newMessageId,
} from '../../src/domain/session.js';

describe('session ids', () => {
  it('accepts free session ids (rc-*)', () => {
    expect(isValidSessionId('rc-abc123xy')).toBe(true);
    expect(isValidSessionId(newFreeSessionId(() => 0.42))).toBe(true);
  });

  it('accepts task-shaped identifiers', () => {
    expect(isValidSessionId('task-4')).toBe(true);
    expect(isValidSessionId('ONBOARD-1')).toBe(true);
  });

  it('rejects unsafe paths', () => {
    expect(isValidSessionId('../etc')).toBe(false);
    expect(isValidSessionId('rc-../x')).toBe(false);
    expect(isValidSessionId('')).toBe(false);
  });

  it('generates message ids', () => {
    expect(newMessageId(() => 0.1)).toMatch(/^m-/);
  });
});

describe('permission modes', () => {
  it('defaults to acceptEdits', () => {
    expect(DEFAULT_PERMISSION_MODE).toBe('acceptEdits');
    expect(isPermissionMode('acceptEdits')).toBe(true);
    expect(isPermissionMode('yolo')).toBe(false);
  });

  it('bypass always allows', () => {
    expect(decidePermission('bypass', 'execute')).toBe('allow');
    expect(decidePermission('bypass', 'delete')).toBe('allow');
  });

  it('acceptEdits allows edit/read, asks execute', () => {
    expect(decidePermission('acceptEdits', 'edit')).toBe('allow');
    expect(decidePermission('acceptEdits', 'read')).toBe('allow');
    expect(decidePermission('acceptEdits', 'execute')).toBe('ask');
    expect(decidePermission('acceptEdits', 'delete')).toBe('ask');
  });

  it('default allows only safe reads', () => {
    expect(decidePermission('default', 'read')).toBe('allow');
    expect(decidePermission('default', 'edit')).toBe('ask');
    expect(decidePermission('default', 'execute')).toBe('ask');
  });
});
