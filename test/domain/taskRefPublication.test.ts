import { describe, expect, it } from 'vitest';
import {
  appendTaskRefOwnershipPark,
  buildTaskRefOwnershipReceipt,
  formatTaskRefOwnershipSection,
  observeTaskRefOwnership,
  redactTaskRefPublicationText,
  TASK_REF_OWNERSHIP_HEADING,
} from '../../src/domain/taskRefPublication.js';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('observeTaskRefOwnership', () => {
  it('holds when expected equals actual', () => {
    expect(
      observeTaskRefOwnership({ expectedRemoteTip: A, actualRemoteTip: A }),
    ).toEqual({
      status: 'held',
      expectedRemoteTip: A,
      actualRemoteTip: A,
      held: true,
      parkWithoutAttemptBurn: false,
      adoptRemoteTip: false,
    });
  });

  it('holds creation lease when both tips are absent', () => {
    expect(
      observeTaskRefOwnership({ expectedRemoteTip: null, actualRemoteTip: null }),
    ).toMatchObject({
      status: 'absent',
      held: true,
      parkWithoutAttemptBurn: false,
      adoptRemoteTip: false,
    });
  });

  it('parks foreign movement without tip adoption or attempt burn', () => {
    const obs = observeTaskRefOwnership({
      expectedRemoteTip: A,
      actualRemoteTip: B,
    });
    expect(obs).toEqual({
      status: 'foreign_moved',
      expectedRemoteTip: A,
      actualRemoteTip: B,
      held: false,
      parkWithoutAttemptBurn: true,
      adoptRemoteTip: false,
    });
  });

  it('parks unexpected and missing tips without adopting', () => {
    expect(
      observeTaskRefOwnership({ expectedRemoteTip: null, actualRemoteTip: A }),
    ).toMatchObject({
      status: 'unexpected',
      parkWithoutAttemptBurn: true,
      adoptRemoteTip: false,
    });
    expect(
      observeTaskRefOwnership({ expectedRemoteTip: A, actualRemoteTip: null }),
    ).toMatchObject({
      status: 'missing',
      parkWithoutAttemptBurn: true,
      adoptRemoteTip: false,
    });
  });

  it('treats undefined expected lease as not-yet-observed (held)', () => {
    expect(
      observeTaskRefOwnership({
        expectedRemoteTip: undefined,
        actualRemoteTip: A,
      }),
    ).toMatchObject({
      status: 'held',
      held: true,
      parkWithoutAttemptBurn: false,
    });
  });
});

describe('task-ref ownership receipts', () => {
  it('redacts credentials and URLs from detail text', () => {
    const raw =
      'push failed https://user:secret-token@github.com/org/repo.git Bearer sk-abc123456789';
    const redacted = redactTaskRefPublicationText(raw);
    expect(redacted).not.toMatch(/secret-token/);
    expect(redacted).not.toMatch(/sk-abc123456789/);
    expect(redacted).not.toMatch(/https:\/\/user:/);
    expect(redacted).toMatch(/\[url\]|\[REDACTED\]/);
  });

  it('builds a no-burn park receipt that never adopts the foreign tip', () => {
    const observation = observeTaskRefOwnership({
      expectedRemoteTip: A,
      actualRemoteTip: B,
    });
    const receipt = buildTaskRefOwnershipReceipt({
      stamp: '2026-08-08T00:00:00.000Z',
      taskId: 'T-1',
      branch: 'hercules/T-1',
      observation,
      detail:
        'foreign writer at https://ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/x/y.git',
    });
    expect(receipt.burnedAttempt).toBe(false);
    expect(receipt.adoptRemoteTip).toBe(false);
    expect(receipt.status).toBe('foreign_moved');
    expect(receipt.detail).not.toMatch(/ghp_/);
    expect(receipt.detail).not.toMatch(/github\.com\/x\/y/);

    const section = formatTaskRefOwnershipSection(receipt);
    expect(section).toContain(TASK_REF_OWNERSHIP_HEADING);
    expect(section).toContain('soft (no burn)');
    expect(section).toContain('**Adopt remote tip:** no');
    expect(section).not.toMatch(/ghp_/);

    const body = appendTaskRefOwnershipPark('task body', receipt);
    expect(body).toContain('task body');
    expect(body).toContain(TASK_REF_OWNERSHIP_HEADING);
  });
});
