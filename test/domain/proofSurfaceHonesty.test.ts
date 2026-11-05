import { describe, expect, it } from 'vitest';
import { isAutomatedGreen, type DodDimensions } from '../../src/domain/acceptance.js';
import { packetStatusLine } from '../../src/verification/packet.js';
import type { ReviewPacket } from '../../src/domain/verification.js';

function dims(
  partial: Pick<DodDimensions, 'mechanical' | 'reviewer' | 'human'> &
    Partial<Pick<DodDimensions, 'criteria' | 'warnings'>>,
): DodDimensions {
  return {
    criteria: partial.criteria ?? [],
    warnings: partial.warnings ?? [],
    mechanical: partial.mechanical,
    reviewer: partial.reviewer,
    human: partial.human,
  };
}

function basePacket(over: Partial<ReviewPacket> & { dod: DodDimensions; green: boolean }): ReviewPacket {
  const { dod, green, ...rest } = over;
  return {
    taskId: 't1',
    branch: 'hercules/t1',
    filesTouched: ['src/a.ts'],
    gates: [],
    autoRework: false,
    evidenceMatrix: [],
    ...rest,
    dod,
    green,
  } as ReviewPacket;
}

describe('proof surface honesty (deploy trust)', () => {
  it('isAutomatedGreen is false when mechanical failed', () => {
    expect(
      isAutomatedGreen(
        dims({ mechanical: 'fail', reviewer: 'pass', human: 'pending' }),
      ),
    ).toBe(false);
  });

  it('isAutomatedGreen is false when reviewer skipped on real-diff work', () => {
    expect(
      isAutomatedGreen(
        dims({ mechanical: 'pass', reviewer: 'skipped', human: 'n/a' }),
      ),
    ).toBe(false);
  });

  it('isAutomatedGreen allows human pending when mech+reviewer pass', () => {
    expect(
      isAutomatedGreen(
        dims({ mechanical: 'pass', reviewer: 'pass', human: 'pending' }),
      ),
    ).toBe(true);
  });

  it('packetStatusLine never says automated proof complete when not green', () => {
    const p = basePacket({
      green: false,
      autoRework: false,
      dod: dims({ mechanical: 'fail', reviewer: 'skipped', human: 'pending' }),
    });
    const line = packetStatusLine(p);
    expect(line).not.toMatch(/automated proof complete/i);
    expect(line).toMatch(/mechanical/);
    expect(line).toMatch(/fail/);
  });

  it('packetStatusLine says automated proof complete only when green', () => {
    const p = basePacket({
      green: true,
      autoRework: false,
      dod: dims({ mechanical: 'pass', reviewer: 'pass', human: 'pending' }),
    });
    const line = packetStatusLine(p);
    expect(line).toMatch(/automated proof complete/i);
    expect(line).toMatch(/human Approve still required/i);
  });

  it('packetStatusLine says automated checks green with named gaps when an axis is n/a', () => {
    const p = basePacket({
      green: true,
      autoRework: false,
      filesTouched: [],
      reviewerSkipReason: 'no file changes (read-only / Q&A)',
      dod: dims({ mechanical: 'n/a', reviewer: 'n/a', human: 'pending' }),
    });
    const line = packetStatusLine(p);
    expect(line).toMatch(/automated checks green/i);
    expect(line).not.toMatch(/automated proof complete/i);
    expect(line).toMatch(/mechanical n\/a \(no bound mechanical criteria\)/);
    expect(line).toMatch(/reviewer n\/a \(no file changes\)/);
  });
});
