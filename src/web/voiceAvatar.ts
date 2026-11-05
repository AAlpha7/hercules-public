/**
 * Voice co-pilot avatar — female humanoid portrait, weekly refresh.
 *
 * A personable face mark, not a mic glyph.
 * Refresh cadence: ISO week (year-Www). Same week → same face for everyone
 * on this deploy (deterministic seed). No network required (inline SVG).
 */

export type VoiceAvatarTraits = {
  readonly weekKey: string;
  readonly seed: number;
  /** Soft display name for the week's persona. */
  readonly name: string;
  readonly skin: string;
  readonly skinShadow: string;
  readonly hair: string;
  readonly hairHi: string;
  readonly eyes: string;
  readonly lips: string;
  readonly blush: string;
  readonly accent: string;
  readonly accent2: string;
  readonly bg0: string;
  readonly bg1: string;
  /** Hair silhouette variant 0..3 */
  readonly hairStyle: number;
  /** Eye shape openness 0..2 */
  readonly eyeStyle: number;
};

const NAMES = [
  'Lyra',
  'Iris',
  'Nova',
  'Aria',
  'Vera',
  'Lune',
  'Sage',
  'Nyx',
  'Cora',
  'Mira',
  'Elara',
  'Vesper',
] as const;

const SKINS = [
  { skin: '#f3c7a8', shadow: '#d9a07e' },
  { skin: '#e8b898', shadow: '#c99272' },
  { skin: '#f6d5b8', shadow: '#e0b48f' },
  { skin: '#d4a574', shadow: '#b88858' },
  { skin: '#f0c4b0', shadow: '#d4a090' },
  { skin: '#c9956c', shadow: '#a87850' },
] as const;

const HAIRS = [
  { hair: '#1a1228', hi: '#3d2a5c' },
  { hair: '#2b1a12', hi: '#5c3d28' },
  { hair: '#0f1a2e', hi: '#2a4a6e' },
  { hair: '#3a1520', hi: '#6e2a40' },
  { hair: '#1c2838', hi: '#4a6080' },
  { hair: '#241810', hi: '#4a3520' },
  { hair: '#4a2060', hi: '#7a40a0' },
  { hair: '#102820', hi: '#2a5848' },
] as const;

const EYES = ['#2a4a6e', '#3a5a40', '#4a3060', '#1a3048', '#5a3848', '#204858'] as const;
const LIPS = ['#c46a78', '#b85a68', '#d47888', '#a85060'] as const;
const ACCENTS = [
  { a: '#6b9bff', b: '#a78bfa' },
  { a: '#3dde9a', b: '#6b9bff' },
  { a: '#f5b54a', b: '#ff8a9a' },
  { a: '#a78bfa', b: '#ff8a9a' },
  { a: '#5ec8ff', b: '#7c5cff' },
  { a: '#ff8a9a', b: '#f5b54a' },
] as const;
const BGS = [
  { b0: '#121a2a', b1: '#0a101c' },
  { b0: '#1a1428', b1: '#0c0a16' },
  { b0: '#101c1a', b1: '#080f10' },
  { b0: '#1c1218', b1: '#10080c' },
] as const;

/** ISO week key: 2026-W28 */
export function isoWeekKey(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday in current week decides the year
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  const year = d.getUTCFullYear();
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Deterministic 32-bit hash */
export function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: readonly T[], seed: number, salt: number): T {
  const idx = ((seed + Math.imul(salt, 2654435761)) >>> 0) % arr.length;
  return arr[idx]!;
}

export function voiceAvatarTraits(
  weekKey: string = isoWeekKey(),
  salt = 'hercules-voice',
): VoiceAvatarTraits {
  const seed = hashSeed(`${salt}:${weekKey}`);
  const skin = pick(SKINS, seed, 1);
  const hair = pick(HAIRS, seed, 2);
  const accent = pick(ACCENTS, seed, 3);
  const bg = pick(BGS, seed, 4);
  return {
    weekKey,
    seed,
    name: pick(NAMES, seed, 5),
    skin: skin.skin,
    skinShadow: skin.shadow,
    hair: hair.hair,
    hairHi: hair.hi,
    eyes: pick(EYES, seed, 6),
    lips: pick(LIPS, seed, 7),
    blush: 'rgba(220,120,130,0.35)',
    accent: accent.a,
    accent2: accent.b,
    bg0: bg.b0,
    bg1: bg.b1,
    hairStyle: seed % 4,
    eyeStyle: (seed >>> 3) % 3,
  };
}

/** Inline SVG data URL for <img src>. */
export function voiceAvatarDataUrl(traits: VoiceAvatarTraits = voiceAvatarTraits()): string {
  const svg = renderVoiceAvatarSvg(traits);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function renderVoiceAvatarSvg(t: VoiceAvatarTraits): string {
  const hairBack = hairBackPath(t.hairStyle);
  const hairFront = hairFrontPath(t.hairStyle);
  const eyeY = 118 + t.eyeStyle;
  const eyeOpen = 5 + t.eyeStyle;
  const uid = `va${t.seed.toString(16)}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-labelledby="t d">
  <title id="t">${escapeXml(t.name)} — Hercules voice co-pilot</title>
  <desc id="d">Female humanoid avatar for week ${escapeXml(t.weekKey)}</desc>
  <defs>
    <linearGradient id="${uid}-bg" x1="40" y1="20" x2="220" y2="240" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${t.bg0}"/>
      <stop offset="100%" stop-color="${t.bg1}"/>
    </linearGradient>
    <radialGradient id="${uid}-aura" cx="50%" cy="40%" r="55%">
      <stop offset="0%" stop-color="${t.accent}" stop-opacity="0.55"/>
      <stop offset="55%" stop-color="${t.accent2}" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="${t.bg1}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${uid}-skin" x1="90" y1="70" x2="170" y2="190" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${t.skin}"/>
      <stop offset="100%" stop-color="${t.skinShadow}"/>
    </linearGradient>
    <linearGradient id="${uid}-hair" x1="80" y1="40" x2="180" y2="160" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="${t.hairHi}"/>
      <stop offset="100%" stop-color="${t.hair}"/>
    </linearGradient>
    <clipPath id="${uid}-clip">
      <circle cx="128" cy="128" r="120"/>
    </clipPath>
  </defs>
  <circle cx="128" cy="128" r="128" fill="url(#${uid}-bg)"/>
  <circle cx="128" cy="118" r="110" fill="url(#${uid}-aura)"/>
  <g clip-path="url(#${uid}-clip)">
    <!-- shoulders / collar -->
    <ellipse cx="128" cy="248" rx="92" ry="48" fill="${t.accent}" opacity="0.35"/>
    <path d="M48 230c22-36 50-52 80-52s58 16 80 52" fill="${t.bg0}" opacity="0.9"/>
    <path d="M78 220c14-18 30-26 50-26s36 8 50 26" fill="${t.accent2}" opacity="0.25"/>
    <!-- hair back -->
    <path d="${hairBack}" fill="url(#${uid}-hair)"/>
    <!-- neck -->
    <path d="M108 168c4 22 12 34 20 34s16-12 20-34" fill="url(#${uid}-skin)"/>
    <!-- face -->
    <ellipse cx="128" cy="122" rx="52" ry="62" fill="url(#${uid}-skin)"/>
    <!-- blush -->
    <ellipse cx="96" cy="132" rx="12" ry="7" fill="${t.blush}"/>
    <ellipse cx="160" cy="132" rx="12" ry="7" fill="${t.blush}"/>
    <!-- eyes -->
    <ellipse cx="108" cy="${eyeY}" rx="8" ry="${eyeOpen}" fill="#fff" opacity="0.92"/>
    <ellipse cx="148" cy="${eyeY}" rx="8" ry="${eyeOpen}" fill="#fff" opacity="0.92"/>
    <ellipse cx="108" cy="${eyeY}" rx="5" ry="${eyeOpen - 1}" fill="${t.eyes}"/>
    <ellipse cx="148" cy="${eyeY}" rx="5" ry="${eyeOpen - 1}" fill="${t.eyes}"/>
    <circle cx="110" cy="${eyeY - 1}" r="1.6" fill="#fff" opacity="0.9"/>
    <circle cx="150" cy="${eyeY - 1}" r="1.6" fill="#fff" opacity="0.9"/>
    <!-- brows -->
    <path d="M96 ${eyeY - 14}c8-6 16-6 24 0" fill="none" stroke="${t.hair}" stroke-width="2.4" stroke-linecap="round" opacity="0.75"/>
    <path d="M136 ${eyeY - 14}c8-6 16-6 24 0" fill="none" stroke="${t.hair}" stroke-width="2.4" stroke-linecap="round" opacity="0.75"/>
    <!-- nose hint -->
    <path d="M128 122c2 8 2 14 0 18" fill="none" stroke="${t.skinShadow}" stroke-width="2" stroke-linecap="round" opacity="0.45"/>
    <!-- lips -->
    <path d="M114 152c8 8 18 8 28 0-8 6-18 6-28 0Z" fill="${t.lips}" opacity="0.9"/>
    <!-- hair front -->
    <path d="${hairFront}" fill="url(#${uid}-hair)"/>
    <!-- soft highlight -->
    <ellipse cx="112" cy="96" rx="18" ry="10" fill="#fff" opacity="0.12"/>
  </g>
  <!-- ring -->
  <circle cx="128" cy="128" r="122" fill="none" stroke="${t.accent}" stroke-width="3" opacity="0.35"/>
  <circle cx="128" cy="128" r="126" fill="none" stroke="${t.accent2}" stroke-width="1.5" opacity="0.25"/>
</svg>`;
}

function hairBackPath(style: number): string {
  switch (style % 4) {
    case 1: // long waves
      return 'M48 90c8-48 40-70 80-70s72 22 80 70c4 28 8 70-6 100-10 22-28 30-48 28-12 18-36 22-52 8-22 10-44 2-54-20-14-30-12-72 0-116Z';
    case 2: // bob
      return 'M58 88c10-44 36-62 70-62s60 18 70 62c6 24 4 58-10 78-16 22-36 18-50 8-14 12-36 14-54-2-18 6-34-8-36-34-2-28 4-50 10-50Z';
    case 3: // high ponytail mass
      return 'M62 96c12-50 40-72 66-72s54 22 66 72c8 30 2 62-14 78-12 12-28 8-40 0-8 20-28 36-46 20-20 8-38-6-42-30-6-28-2-58 10-68Zm40-40c20-28 48-24 58 6 6 18-2 34-14 40-16-18-30-28-44-46Z';
    default: // soft long
      return 'M52 95c10-50 38-74 76-74s66 24 76 74c6 32 4 74-8 102-10 24-30 32-52 26-16 16-40 18-58 2-20 8-40-2-50-24-14-32-8-74 16-106Z';
  }
}

function hairFrontPath(style: number): string {
  switch (style % 4) {
    case 1:
      return 'M78 78c18-22 36-30 50-28 4 18 2 36-6 48-12-6-28-10-44-20Zm100 0c-18-22-36-30-50-28-4 18-2 36 6 48 12-6 28-10 44-20Z';
    case 2:
      return 'M74 86c22-28 48-36 68-28 0 16-4 32-14 42-12-8-28-12-54-14Zm108 0c-22-28-48-36-68-28 0 16 4 32 14 42 12-8 28-12 54-14Z';
    case 3:
      return 'M80 70c16-16 32-20 48-14 2 14 0 30-8 42-14-4-26-12-40-28Zm96 0c-16-16-32-20-48-14-2 14 0 30 8 42 14-4 26-12 40-28Z';
    default:
      return 'M76 82c20-24 42-32 58-26 2 16-2 34-12 46-14-6-28-12-46-20Zm104 0c-20-24-42-32-58-26-2 16 2 34 12 46 14-6 28-12 46-20Z';
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}
