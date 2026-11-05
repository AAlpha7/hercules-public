/**
 * Voice co-pilot face: prefer weekly Grok Imagine PNG; fall back to procedural SVG.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { fetchVoiceAvatarInfo, fetchVoiceAvatarObjectUrl } from './api.js';
import {
  isoWeekKey,
  voiceAvatarDataUrl,
  voiceAvatarTraits,
} from './voiceAvatar.js';

export function VoiceAvatar({
  phase,
  className = '',
}: {
  phase: 'idle' | 'connecting' | 'live';
  className?: string;
}): JSX.Element {
  const weekKey = useMemo(() => isoWeekKey(), []);
  const traits = useMemo(() => voiceAvatarTraits(weekKey), [weekKey]);
  const svgFallback = useMemo(() => voiceAvatarDataUrl(traits), [traits]);
  const [src, setSrc] = useState<string>(svgFallback);
  const [usingAi, setUsingAi] = useState(false);
  const [name, setName] = useState(traits.name);
  const [imgKey, setImgKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    void (async () => {
      try {
        const load = async (info: Awaited<ReturnType<typeof fetchVoiceAvatarInfo>>): Promise<void> => {
          if (!info.ready) return;
          if (info.name) setName(info.name);
          const url = await fetchVoiceAvatarObjectUrl({
            weekKey: info.weekKey,
            ...(info.imagePath ? { imagePath: info.imagePath } : {}),
            ...(info.generatedAt ? { generatedAt: info.generatedAt } : {}),
          });
          if (cancelled) {
            URL.revokeObjectURL(url);
            return;
          }
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          objectUrl = url;
          setSrc(url);
          setUsingAi(true);
          setImgKey((k) => k + 1);
        };

        const info = await fetchVoiceAvatarInfo();
        if (cancelled) return;
        if (info.name) setName(info.name);
        if (!info.ready) {
          // Kick generation is already done by the meta route; keep SVG until ready.
          for (let i = 0; i < 8 && !cancelled; i++) {
            await new Promise((r) => setTimeout(r, 2500));
            const again = await fetchVoiceAvatarInfo().catch(() => null);
            if (cancelled || !again?.ready) continue;
            await load(again);
            return;
          }
          return;
        }
        await load(info);
      } catch {
        // SVG fallback already showing
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [weekKey]);

  return (
    <span
      className={`voice-avatar phase-${phase}${usingAi ? ' is-ai' : ' is-svg'}${className ? ` ${className}` : ''}`}
      title={`${name} · ${weekKey}${usingAi ? ' · Grok Imagine' : ' · SVG fallback'}`}
      aria-hidden
    >
      <img
        key={imgKey}
        src={src}
        alt=""
        width={56}
        height={56}
        draggable={false}
        decoding="async"
        onError={() => {
          setSrc(svgFallback);
          setUsingAi(false);
        }}
      />
    </span>
  );
}
