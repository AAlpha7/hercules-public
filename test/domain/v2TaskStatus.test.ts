import { describe, expect, it } from 'vitest';
import { TASK_STATES } from '../../src/domain/task.js';
import {
  isV2TaskStatus,
  LEGACY_TASK_STATE_TO_V2_STATUS,
  toV2TaskStatus,
  V2_TASK_STATUSES,
} from '../../src/domain/v2TaskStatus.js';

describe('v2TaskStatus', () => {
  it('maps every TASK_STATES member via the closed total identity mapping', () => {
    expect(V2_TASK_STATUSES).toEqual(TASK_STATES);
    expect(Object.keys(LEGACY_TASK_STATE_TO_V2_STATUS).sort()).toEqual([...TASK_STATES].sort());
    for (const state of TASK_STATES) {
      expect(toV2TaskStatus(state)).toBe(state);
      expect(LEGACY_TASK_STATE_TO_V2_STATUS[state]).toBe(state);
      expect(isV2TaskStatus(state)).toBe(true);
    }
  });

  it('rejects non-members from isV2TaskStatus and toV2TaskStatus', () => {
    for (const value of [null, undefined, 1, '', 'Todo', 'queued', 'archive']) {
      expect(isV2TaskStatus(value)).toBe(false);
    }
    expect(() => toV2TaskStatus('not-a-state' as never)).toThrow(TypeError);
  });
});
