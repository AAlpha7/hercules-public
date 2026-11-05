/**
 * Push-to-talk capture → mono WAV (16-bit PCM).
 *
 * Used with server Grok STT (not browser Web Speech). Produces a container
 * format that https://api.x.ai/v1/stt accepts reliably across iOS/Android.
 */
import { encodeWavPcm16 } from '../domain/wav.js';

export class VoiceCaptureError extends Error {
  constructor(
    readonly code: 'denied' | 'unsupported' | 'failed',
    message: string,
  ) {
    super(message);
    this.name = 'VoiceCaptureError';
  }
}

export interface VoiceCapture {
  /** Stop recording and return a WAV blob. */
  stop: () => Promise<Blob>;
  /** Abort without producing audio. */
  abort: () => void;
}

/**
 * Start capturing microphone audio. Call stop() when the user releases / taps again.
 */
export async function startVoiceCapture(): Promise<VoiceCapture> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new VoiceCaptureError(
      'unsupported',
      'Microphone not available in this browser (needs HTTPS + getUserMedia).',
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      throw new VoiceCaptureError('denied', 'Microphone permission denied.');
    }
    throw new VoiceCaptureError(
      'failed',
      `Microphone error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) {
    stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    throw new VoiceCaptureError('unsupported', 'Web Audio API not available.');
  }

  const ctx = new AudioCtx();
  const source = ctx.createMediaStreamSource(stream);
  const chunks: Float32Array[] = [];
  let aborted = false;

  // ScriptProcessor is deprecated but widely available on mobile Safari/Chrome.
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (ev: AudioProcessingEvent) => {
    if (aborted) return;
    const input = ev.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
  };

  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  const cleanup = (): void => {
    try {
      processor.disconnect();
    } catch {
      /* ignore */
    }
    try {
      source.disconnect();
    } catch {
      /* ignore */
    }
    try {
      mute.disconnect();
    } catch {
      /* ignore */
    }
    stream.getTracks().forEach((t: MediaStreamTrack) => t.stop());
    void ctx.close().catch(() => undefined);
  };

  return {
    abort: () => {
      aborted = true;
      cleanup();
    },
    stop: async () => {
      if (aborted) {
        throw new VoiceCaptureError('failed', 'Capture already aborted.');
      }
      aborted = true;
      await new Promise((r) => setTimeout(r, 50));
      const sampleRate = ctx.sampleRate;
      cleanup();
      const pcm = mergeFloat32(chunks);
      if (pcm.length === 0) {
        throw new VoiceCaptureError('failed', 'No audio captured — try again.');
      }
      const bytes = encodeWavPcm16(pcm, sampleRate);
      // Copy into a plain ArrayBuffer — Blob rejects SharedArrayBuffer views under DOM typings.
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return new Blob([ab], { type: 'audio/wav' });
    },
  };
}

function mergeFloat32(parts: readonly Float32Array[]): Float32Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
