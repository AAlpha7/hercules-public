import { describe, expect, it } from 'vitest';
import {
  collectCliHollowShots,
  collectL2HollowShots,
  detectHollowEvidence,
  extractHerculesScenarioIds,
} from '../../src/domain/hollowEvidence.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('detectHollowEvidence', () => {
  it('fails when identical sha256 appears across distinct L2 screenshot scenarios', () => {
    const shots = collectL2HollowShots([
      {
        kind: 'screenshot',
        ok: true,
        screenshot: 'login.png',
        screenshotSha256: HASH_A,
        raw: 'screenshot login',
      },
      {
        kind: 'screenshot',
        ok: true,
        screenshot: 'settings.png',
        screenshotSha256: HASH_A,
        raw: 'screenshot settings',
      },
    ]);
    const report = detectHollowEvidence(shots);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]?.scenarios).toEqual(['login', 'settings']);
    expect(report.packetLine).toMatch(
      /❌ hollow evidence — 2 screenshots identical across scenarios \(login, settings\)/,
    );
  });

  it('multi-shot scenarios sharing only their first (landing) frame are not hollow (a downstream project 2026-09-10)', () => {
    const HOME = 'c'.repeat(64);
    const shots = [
      { scenario: 'affordance-audit', sha256: HOME, name: 'affordance-audit-01-home.png' },
      { scenario: 'affordance-audit', sha256: 'd'.repeat(64), name: 'affordance-audit-02-audit.png' },
      { scenario: 'chat-sheet-flow', sha256: HOME, name: 'chat-sheet-flow-01-home.png' },
      { scenario: 'chat-sheet-flow', sha256: 'e'.repeat(64), name: 'chat-sheet-flow-02-sheet.png' },
      { scenario: 'chat-sheet-scroll-lock', sha256: HOME, name: 'chat-sheet-scroll-lock-01-home.png' },
      { scenario: 'chat-sheet-scroll-lock', sha256: 'e'.repeat(64), name: 'chat-sheet-scroll-lock-02-sheet.png' },
      { scenario: 'chat-sheet-scroll-lock', sha256: 'f'.repeat(64), name: 'chat-sheet-scroll-lock-03-locked.png' },
    ];
    // Shared landing frame + a nested flow (scroll-lock extends chat-sheet-flow): nothing hollow.
    expect(detectHollowEvidence(shots).hits).toEqual([]);
    // Exact duplicate rest-sets across two scenarios ARE hollow.
    const copied = [
      ...shots,
      { scenario: 'copied-flow', sha256: HOME, name: 'copied-flow-01-home.png' },
      { scenario: 'copied-flow', sha256: 'e'.repeat(64), name: 'copied-flow-02-sheet.png' },
      { scenario: 'copied-flow', sha256: 'f'.repeat(64), name: 'copied-flow-03-locked.png' },
    ];
    const report = detectHollowEvidence(copied);
    expect(report.hits.map((h) => h.scenarios)).toEqual([
      ['chat-sheet-scroll-lock', 'copied-flow'],
      ['chat-sheet-scroll-lock', 'copied-flow'],
    ]);
    expect(report.packetLine).toMatch(/4 screenshots identical across scenarios \(chat-sheet-scroll-lock, copied-flow\)/);
    // A single-shot scenario never mixes with multi-shot ones, but two
    // single-shot scenarios with the same bytes still fail.
    expect(detectHollowEvidence([
      ...shots,
      { scenario: 'l2-home', sha256: HOME, name: 'home.png' },
    ]).hits).toEqual([]);
    expect(detectHollowEvidence([
      ...shots,
      { scenario: 'l2-home', sha256: HOME, name: 'home.png' },
      { scenario: 'l2-settings', sha256: HOME, name: 'settings.png' },
    ]).hits.map((h) => h.scenarios)).toEqual([['l2-home', 'l2-settings']]);
  });

  it('allows identical sha256 within a single CLI step / scenario', () => {
    const shots = collectCliHollowShots([
      {
        id: 'web-console-flow',
        stdoutTail: 'ok\n',
        artifacts: [
          { name: 'a.png', kind: 'image', sha256: HASH_A },
          { name: 'a-retry.png', kind: 'image', sha256: HASH_A },
        ],
      },
    ]);
    expect(detectHollowEvidence(shots).hits).toEqual([]);
  });

  it('fails when identical CLI artifacts come from different steps', () => {
    const shots = collectCliHollowShots([
      {
        id: 'login-flow',
        stdoutTail: '',
        artifacts: [{ name: 'cli-login.png', kind: 'image', sha256: HASH_A }],
      },
      {
        id: 'settings-flow',
        stdoutTail: '',
        artifacts: [{ name: 'cli-settings.png', kind: 'image', sha256: HASH_A }],
      },
    ]);
    const report = detectHollowEvidence(shots);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]?.scenarios).toEqual(['login-flow', 'settings-flow']);
  });

  it('fails when one CLI step attributes identical images to different hercules-scenario ids', () => {
    const shots = collectCliHollowShots([
      {
        id: 'web-console-flow',
        stdoutTail:
          'hercules-scenario: login surfaces=web/**\n' +
          'hercules-scenario: settings surfaces=web/**\n',
        artifacts: [
          { name: 'cli-login.png', kind: 'image', sha256: HASH_A },
          { name: 'cli-settings.png', kind: 'image', sha256: HASH_A },
        ],
      },
    ]);
    const report = detectHollowEvidence(shots);
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]?.scenarios).toEqual(['login', 'settings']);
  });

  it('does not flag distinct hashes across scenarios', () => {
    const shots = collectL2HollowShots([
      {
        kind: 'screenshot',
        ok: true,
        screenshot: 'a.png',
        screenshotSha256: HASH_A,
        raw: 'screenshot a',
      },
      {
        kind: 'screenshot',
        ok: true,
        screenshot: 'b.png',
        screenshotSha256: HASH_B,
        raw: 'screenshot b',
      },
    ]);
    expect(detectHollowEvidence(shots).hits).toEqual([]);
  });
});

describe('extractHerculesScenarioIds', () => {
  it('collects distinct scenario ids', () => {
    expect(
      extractHerculesScenarioIds(
        'hercules-scenario: login\nok\nhercules-scenario: settings surfaces=x\n',
      ),
    ).toEqual(['login', 'settings']);
  });
});
