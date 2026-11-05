import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWavPcm16 } from '../../src/domain/wav.js';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('WAV encoder (pure)', () => {
  it('produces a valid WAV header for mono PCM', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buf = Buffer.from(encodeWavPcm16(samples, 16000));
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(16000);
    expect(buf.toString('ascii', 36, 40)).toBe('data');
    expect(buf.length).toBe(44 + samples.length * 2);
  });
});

describe('composer uses Grok STT not Web Speech', () => {
  it('ChatComposer records via voiceCapture and posts /api/stt', async () => {
    const src = await readFile(join(ROOT, 'src/web/ChatComposer.tsx'), 'utf8');
    expect(src).toMatch(/transcribeVoice|startVoiceCapture/);
    expect(src).toMatch(/Grok STT|Listening/);
    expect(src).not.toMatch(/SpeechRecognition|webkitSpeechRecognition/);
  });

  it('server exposes Grok STT routes', async () => {
    const api = await readFile(join(ROOT, 'src/server/api.ts'), 'utf8');
    expect(api).toMatch(/\/api\/stt/);
    expect(api).toMatch(/transcribeAudio/);
    const stt = await readFile(join(ROOT, 'src/server/stt.ts'), 'utf8');
    const xai = await readFile(join(ROOT, 'src/server/xaiApi.ts'), 'utf8');
    // URL lives in xaiApi pin module; stt imports XAI_STT_URL.
    expect(xai).toMatch(/api\.x\.ai\/v1\/stt/);
    expect(stt).toMatch(/XAI_STT_URL|transcribeAudio/);
    expect(stt).toMatch(/XAI_API_KEY|resolveXaiCredentials|xaiAuth/);
  });
});
