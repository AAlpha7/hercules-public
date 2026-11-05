/**
 * Integration: Hercules mint → xAI Realtime WS → at least one audio delta.
 *
 * Runs only when credentials exist (XAI_API_KEY / GROK_API_KEY / ~/.grok/auth.json).
 * CI without secrets skips — this is how we automate "agent can speak" without a phone.
 */
import { describe, it, expect } from 'vitest';
import { isVoiceConfigured, mintVoiceClientSecret } from '../../src/server/voice.js';
import WebSocket from 'ws';

const hasCreds = isVoiceConfigured();

describe.runIf(hasCreds)('voice realtime integration (live xAI)', () => {
  it(
    'mints ephemeral token and receives spoken audio deltas for a text turn',
    async () => {
      const minted = await mintVoiceClientSecret();
      expect(minted.clientSecret.length).toBeGreaterThan(20);
      expect(minted.wsUrl).toMatch(/realtime/);

      const url = `${minted.wsUrl}?model=${encodeURIComponent(minted.model)}`;
      const ws = new WebSocket(url, [`xai-client-secret.${minted.clientSecret}`]);

      let audioDeltas = 0;
      let transcript: string | null = null;
      let errorMsg: string | null = null;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          reject(new Error('voice realtime timed out waiting for response.done'));
        }, 30_000);

        ws.on('open', () => {
          ws.send(
            JSON.stringify({
              type: 'session.update',
              session: {
                instructions: 'Reply with one short word only. No tools.',
                voice: 'eve',
                turn_detection: { type: 'server_vad' },
                audio: {
                  input: { format: { type: 'audio/pcm', rate: 24_000 } },
                  output: { format: { type: 'audio/pcm', rate: 24_000 } },
                },
                tools: [],
                tool_choice: 'none',
              },
            }),
          );
        });

        ws.on('message', (raw) => {
          let ev: {
            type?: string;
            delta?: string;
            transcript?: string;
            error?: { message?: string };
          };
          try {
            ev = JSON.parse(String(raw)) as typeof ev;
          } catch {
            return;
          }
          if (ev.type === 'session.updated') {
            ws.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: 'hi' }],
                },
              }),
            );
            ws.send(JSON.stringify({ type: 'response.create' }));
          }
          if (ev.type === 'response.output_audio.delta' && ev.delta) {
            audioDeltas += 1;
          }
          if (ev.type === 'response.output_audio_transcript.done') {
            transcript = ev.transcript ?? null;
          }
          if (ev.type === 'error') {
            errorMsg = ev.error?.message ?? 'error';
          }
          if (ev.type === 'response.done') {
            clearTimeout(timer);
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            resolve();
          }
        });

        ws.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      expect(errorMsg).toBeNull();
      expect(audioDeltas).toBeGreaterThan(0);
      // Transcript may be empty on some models; audio is the hard gate.
      if (transcript !== null) {
        expect(typeof transcript).toBe('string');
      }
    },
    45_000,
  );
});

describe.runIf(!hasCreds)('voice realtime integration (skipped)', () => {
  it('skips when no xAI credentials on the machine', () => {
    expect(hasCreds).toBe(false);
  });
});
