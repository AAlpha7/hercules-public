import { describe, it, expect } from 'vitest';
import { VoiceDiag } from '../../src/web/voiceDiag.js';

describe('VoiceDiag', () => {
  it('records counts and audio delta sizes without interpretation', () => {
    const d = new VoiceDiag();
    d.reset({ sampleRateCtx: 48000, sampleRateSession: 48000 });
    d.note('response.created');
    d.note('response.output_audio.delta', '1200');
    d.note('response.output_audio.delta', '800');
    d.note('speech_started_while_busy', 'active=1');
    d.note('response.done');
    const s = d.snapshot();
    expect(s.sampleRateCtx).toBe(48000);
    expect(s.audioDeltaCount).toBe(2);
    expect(s.audioDeltaBytes).toBe(2000);
    expect(s.speechStartedWhileBusy).toBe(1);
    expect(s.responseCreated).toBe(1);
    expect(s.responseDone).toBe(1);
    expect(d.formatSummary()).toMatch(/audioΔ 2\/2000B/);
    expect(d.formatDump()).toMatch(/speech_started_while_busy/);
  });
});
