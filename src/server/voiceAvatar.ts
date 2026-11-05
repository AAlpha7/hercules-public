/**
 * Weekly AI-generated female humanoid avatar for Voice Control (Grok Imagine).
 *
 * Cadence: one image per ISO week, cached under workDir/voice-avatars/.
 * Cost is trivial (≈ free at 1/week). Fallback: client procedural SVG if gen fails.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveSttApiKey } from './stt.js';
import {
  resolveImagineImageModel,
  XAI_IMAGES_GENERATIONS_URL,
  XAI_IMAGINE_IMAGE_MODEL_DEFAULT,
} from './xaiApi.js';

export type VoiceAvatarMeta = {
  readonly weekKey: string;
  readonly name: string;
  readonly prompt: string;
  readonly model: string;
  readonly generatedAt: string;
  readonly file: string; // basename e.g. 2026-W29.png
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

/** Modern AI-assistant looks — deliberately not historical / fantasy / medieval. */
const LOOKS = [
  'smooth luminous porcelain-tech skin, soft icy blue eyes, sleek silver-lavender bob',
  'warm beige synthetic-skin finish, amber irises with faint HUD glints, glossy black asymmetrical cut',
  'cool pearl skin with subtle violet micro-circuit freckles at the temples, deep teal eyes, short platinum crop',
  'honey-gold skin, graphite irises, long straight ink-black hair with one neon-indigo highlight strand',
  'porcelain skin, soft rose-gold eyes, elegant chestnut low ponytail, clean tech aesthetic',
  'light bronze skin, cool green eyes with soft LED catchlights, wavy espresso hair shoulder length',
  'ivory skin, violet-gray eyes, soft white-silver waves, minimalist beauty',
  'warm olive skin, dark espresso eyes, structured pixie with a soft blue sheen',
] as const;

/** ISO week key shared with the SPA. */
export function isoWeekKey(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function weekPersona(weekKey: string): { name: string; look: string; seed: number } {
  // v2 seed: refresh weekly faces after prompt/look redesign.
  const seed = hashSeed(`hercules-voice-ai-v2:${weekKey}`);
  return {
    seed,
    name: NAMES[seed % NAMES.length]!,
    look: LOOKS[(seed >>> 4) % LOOKS.length]!,
  };
}

export function buildAvatarPrompt(weekKey: string): { name: string; prompt: string } {
  const { name, look } = weekPersona(weekKey);
  // User-facing art direction (primary). Weekly persona only varies look slightly.
  const prompt =
    `优雅华丽美丽女性AI助理头像。` +
    `Portrait of ${name}: elegant, glamorous, beautiful female AI assistant avatar. ` +
    `Appearance notes: ${look}. ` +
    `Head and shoulders, square 1:1, face centered, looking at camera, soft smile, ` +
    `premium app-icon quality, clean studio light, no text, no watermark. Week ${weekKey}.`;
  return { name, prompt };
}

export function avatarDir(workRoot: string): string {
  return join(workRoot, 'voice-avatars');
}

export async function readCachedAvatar(
  workRoot: string,
  weekKey: string,
): Promise<{ meta: VoiceAvatarMeta; bytes: Buffer; contentType: string } | null> {
  const dir = avatarDir(workRoot);
  const metaPath = join(dir, `${weekKey}.json`);
  try {
    await access(metaPath);
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as VoiceAvatarMeta;
    const file = meta.file && !meta.file.includes('..') ? meta.file : `${weekKey}.png`;
    const bytes = await readFile(join(dir, file));
    if (bytes.length < 100) return null;
    const contentType =
      bytes[0] === 0xff && bytes[1] === 0xd8
        ? 'image/jpeg'
        : bytes[0] === 0x89 && bytes[1] === 0x50
          ? 'image/png'
          : 'application/octet-stream';
    return { meta, bytes, contentType };
  } catch {
    // Legacy path: only .png on disk without usable meta.file
    try {
      const bytes = await readFile(join(dir, `${weekKey}.png`));
      if (bytes.length < 100) return null;
      const contentType =
        bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';
      const { name } = weekPersona(weekKey);
      return {
        meta: {
          weekKey,
          name,
          prompt: '',
          model: 'unknown',
          generatedAt: '',
          file: `${weekKey}.png`,
        },
        bytes,
        contentType,
      };
    } catch {
      return null;
    }
  }
}

export type GenerateImageFn = (input: {
  prompt: string;
  apiKey: string;
  model: string;
}) => Promise<Buffer>;

/** Call xAI Grok Imagine images API → PNG/JPEG bytes. */
export async function generateImageBytes(
  input: { prompt: string; apiKey: string; model: string },
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const res = await fetchImpl(XAI_IMAGES_GENERATIONS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      n: 1,
      response_format: 'b64_json',
      aspect_ratio: '1:1',
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 400);
    throw new Error(`image gen failed (${res.status}): ${detail}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const item = json.data?.[0];
  if (item?.b64_json) {
    return Buffer.from(item.b64_json, 'base64');
  }
  if (item?.url) {
    const img = await fetchImpl(item.url);
    if (!img.ok) throw new Error(`image download failed (${img.status})`);
    return Buffer.from(await img.arrayBuffer());
  }
  throw new Error('image gen returned no b64_json or url');
}

/**
 * Ensure this week's avatar exists on disk. Concurrent callers share one in-flight promise.
 */
const inflight = new Map<string, Promise<VoiceAvatarMeta>>();

export async function ensureWeeklyAvatar(opts: {
  workRoot: string;
  weekKey?: string;
  env?: NodeJS.ProcessEnv;
  generate?: GenerateImageFn;
  force?: boolean;
}): Promise<
  | { ok: true; meta: VoiceAvatarMeta; cached: boolean }
  | { ok: false; error: string; weekKey: string }
> {
  const weekKey = opts.weekKey ?? isoWeekKey();
  const env = opts.env ?? process.env;
  const mapKey = `${opts.workRoot}::${weekKey}`;

  if (!opts.force) {
    const cached = await readCachedAvatar(opts.workRoot, weekKey);
    if (cached) return { ok: true, meta: cached.meta, cached: true };
  }

  const existing = inflight.get(mapKey);
  if (existing) {
    try {
      const meta = await existing;
      return { ok: true, meta, cached: false };
    } catch (err) {
      return {
        ok: false,
        weekKey,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const run = (async (): Promise<VoiceAvatarMeta> => {
    const apiKey = resolveSttApiKey(env);
    if (!apiKey) {
      throw new Error('No XAI_API_KEY / Grok CLI token for image generation');
    }
    // Default: docs-recommended quality tier (not the cheaper legacy-named id).
    const model = resolveImagineImageModel(env) || XAI_IMAGINE_IMAGE_MODEL_DEFAULT;
    const { name, prompt } = buildAvatarPrompt(weekKey);
    const gen = opts.generate ?? generateImageBytes;
    const png = await gen({ prompt, apiKey, model });
    const dir = avatarDir(opts.workRoot);
    await mkdir(dir, { recursive: true });
    // xAI often returns JPEG bytes even when we name the file .png — sniff magic.
    const ext = png[0] === 0xff && png[1] === 0xd8 ? 'jpg' : 'png';
    const file = `${weekKey}.${ext}`;
    const meta: VoiceAvatarMeta = {
      weekKey,
      name,
      prompt,
      model,
      generatedAt: new Date().toISOString(),
      file,
    };
    await writeFile(join(dir, file), png);
    await writeFile(join(dir, `${weekKey}.json`), JSON.stringify(meta, null, 2));
    return meta;
  })();

  inflight.set(mapKey, run);
  try {
    const meta = await run;
    return { ok: true, meta, cached: false };
  } catch (err) {
    return {
      ok: false,
      weekKey,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    inflight.delete(mapKey);
  }
}
