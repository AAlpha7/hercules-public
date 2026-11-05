import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildAvatarPrompt,
  ensureWeeklyAvatar,
  isoWeekKey,
  readCachedAvatar,
  weekPersona,
} from '../../src/server/voiceAvatar.js';

describe('weekly AI voice avatar', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hercules-avatar-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('isoWeekKey + persona are deterministic per week', () => {
    const k = isoWeekKey(new Date('2026-07-13T12:00:00Z'));
    expect(k).toMatch(/^2026-W\d{2}$/);
    const a = weekPersona(k);
    const b = weekPersona(k);
    expect(a.name).toBe(b.name);
    expect(a.look).toBe(b.look);
    const p = buildAvatarPrompt(k).prompt;
    expect(p).toContain('优雅华丽美丽女性AI助理头像');
    expect(p).toMatch(/AI assistant|女性AI/i);
    expect(p).toContain(k);
  });

  it('ensureWeeklyAvatar caches PNG on disk (mock generate)', async () => {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(200).fill(1)]);
    let calls = 0;
    const weekKey = '2026-W29';
    const first = await ensureWeeklyAvatar({
      workRoot: dir,
      weekKey,
      env: { XAI_API_KEY: 'test-key' },
      generate: async () => {
        calls += 1;
        return fakePng;
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.cached).toBe(false);
    expect(calls).toBe(1);
    expect(first.meta.weekKey).toBe(weekKey);

    const second = await ensureWeeklyAvatar({
      workRoot: dir,
      weekKey,
      env: { XAI_API_KEY: 'test-key' },
      generate: async () => {
        calls += 1;
        return fakePng;
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);

    const disk = await readCachedAvatar(dir, weekKey);
    expect(disk?.bytes.equals(fakePng)).toBe(true);
    expect(disk?.contentType).toMatch(/image\//);
    const metaRaw = await readFile(join(dir, 'voice-avatars', `${weekKey}.json`), 'utf8');
    expect(JSON.parse(metaRaw).name).toBeTruthy();
  });

  it('returns error without credentials', async () => {
    const r = await ensureWeeklyAvatar({
      workRoot: dir,
      weekKey: '2026-W01',
      env: { HOME: '/nope-missing-home' },
    });
    expect(r.ok).toBe(false);
  });
});
