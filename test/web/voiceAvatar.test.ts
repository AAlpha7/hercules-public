import { describe, it, expect } from 'vitest';
import {
  hashSeed,
  isoWeekKey,
  renderVoiceAvatarSvg,
  voiceAvatarDataUrl,
  voiceAvatarTraits,
} from '../../src/web/voiceAvatar.js';

describe('voiceAvatar (weekly humanoid)', () => {
  it('isoWeekKey is stable for a fixed date', () => {
    // 2026-07-13 is a Monday in ISO week 29 of 2026
    expect(isoWeekKey(new Date('2026-07-13T12:00:00Z'))).toMatch(/^2026-W\d{2}$/);
    expect(isoWeekKey(new Date('2026-07-13T12:00:00Z'))).toBe(
      isoWeekKey(new Date('2026-07-15T12:00:00Z')),
    );
  });

  it('same week → same traits; different week → different face seed', () => {
    const a = voiceAvatarTraits('2026-W28');
    const b = voiceAvatarTraits('2026-W28');
    const c = voiceAvatarTraits('2026-W29');
    expect(a.seed).toBe(b.seed);
    expect(a.name).toBe(b.name);
    expect(a.hair).toBe(b.hair);
    expect(a.seed).not.toBe(c.seed);
  });

  it('renders female humanoid SVG (not a mic glyph)', () => {
    const t = voiceAvatarTraits('2026-W28');
    const svg = renderVoiceAvatarSvg(t);
    expect(svg).toMatch(/<svg/);
    expect(svg).toMatch(/humanoid|co-pilot|voice/i);
    expect(svg).not.toMatch(/🎙|microphone/i);
    expect(svg).toMatch(/ellipse|path/); // portrait geometry
    const url = voiceAvatarDataUrl(t);
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('hashSeed is deterministic', () => {
    expect(hashSeed('hercules-voice:2026-W01')).toBe(hashSeed('hercules-voice:2026-W01'));
    expect(hashSeed('a')).not.toBe(hashSeed('b'));
  });
});
