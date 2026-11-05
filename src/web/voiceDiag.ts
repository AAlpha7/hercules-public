/**
 * Voice Control diagnostics — facts only, no interpretation.
 *
 * Records a ring buffer of WebSocket / audio events so a failing session can
 * be reported without guessing (sample rates, event order, sizes, counts).
 */

export interface VoiceDiagEvent {
  readonly tMs: number;
  readonly type: string;
  readonly detail?: string;
}

export interface VoiceDiagSnapshot {
  readonly startedAtMs: number;
  readonly sampleRateCtx: number | null;
  readonly sampleRateSession: number | null;
  readonly events: readonly VoiceDiagEvent[];
  readonly counts: Readonly<Record<string, number>>;
  readonly audioDeltaBytes: number;
  readonly audioDeltaCount: number;
  readonly speechStartedWhileBusy: number;
  readonly responseCreated: number;
  readonly responseDone: number;
  readonly responseCancelSent: number;
}

const MAX_EVENTS = 200;

export class VoiceDiag {
  private startedAtMs = 0;
  private sampleRateCtx: number | null = null;
  private sampleRateSession: number | null = null;
  private readonly events: VoiceDiagEvent[] = [];
  private readonly counts: Record<string, number> = {};
  private audioDeltaBytes = 0;
  private audioDeltaCount = 0;
  private speechStartedWhileBusy = 0;
  private responseCreated = 0;
  private responseDone = 0;
  private responseCancelSent = 0;
  private t0 = 0;

  reset(opts?: {
    readonly sampleRateCtx?: number;
    readonly sampleRateSession?: number;
  }): void {
    this.t0 = Date.now();
    this.startedAtMs = this.t0;
    this.sampleRateCtx = opts?.sampleRateCtx ?? null;
    this.sampleRateSession = opts?.sampleRateSession ?? null;
    this.events.length = 0;
    for (const k of Object.keys(this.counts)) delete this.counts[k];
    this.audioDeltaBytes = 0;
    this.audioDeltaCount = 0;
    this.speechStartedWhileBusy = 0;
    this.responseCreated = 0;
    this.responseDone = 0;
    this.responseCancelSent = 0;
  }

  setRates(ctx: number, session: number): void {
    this.sampleRateCtx = ctx;
    this.sampleRateSession = session;
  }

  note(type: string, detail?: string): void {
    const tMs = Date.now() - (this.t0 || Date.now());
    this.counts[type] = (this.counts[type] ?? 0) + 1;
    this.events.push(detail !== undefined ? { tMs, type, detail } : { tMs, type });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);

    if (type === 'response.created') this.responseCreated += 1;
    if (type === 'response.done') this.responseDone += 1;
    if (type === 'response.cancel_sent') this.responseCancelSent += 1;
    if (type === 'speech_started_while_busy') this.speechStartedWhileBusy += 1;
    if (type === 'response.output_audio.delta' && detail) {
      const n = Number(detail);
      if (Number.isFinite(n) && n > 0) {
        this.audioDeltaCount += 1;
        this.audioDeltaBytes += n;
      }
    }
  }

  snapshot(): VoiceDiagSnapshot {
    return {
      startedAtMs: this.startedAtMs,
      sampleRateCtx: this.sampleRateCtx,
      sampleRateSession: this.sampleRateSession,
      events: [...this.events],
      counts: { ...this.counts },
      audioDeltaBytes: this.audioDeltaBytes,
      audioDeltaCount: this.audioDeltaCount,
      speechStartedWhileBusy: this.speechStartedWhileBusy,
      responseCreated: this.responseCreated,
      responseDone: this.responseDone,
      responseCancelSent: this.responseCancelSent,
    };
  }

  /** One-line summary for toast / clipboard (ASCII, no secrets). */
  formatSummary(snap: VoiceDiagSnapshot = this.snapshot()): string {
    const rate =
      snap.sampleRateCtx != null || snap.sampleRateSession != null
        ? `rate ctx=${snap.sampleRateCtx ?? '?'} sess=${snap.sampleRateSession ?? '?'}`
        : 'rate=?';
    return (
      `voice-diag ${rate} ` +
      `resp ${snap.responseCreated}/${snap.responseDone} ` +
      `audioΔ ${snap.audioDeltaCount}/${snap.audioDeltaBytes}B ` +
      `speech_busy ${snap.speechStartedWhileBusy} ` +
      `cancel ${snap.responseCancelSent} ` +
      `events ${snap.events.length}`
    );
  }

  /** Multi-line dump for paste into chat / issue. */
  formatDump(snap: VoiceDiagSnapshot = this.snapshot()): string {
    const lines = [
      this.formatSummary(snap),
      '--- events (tMs type detail) ---',
      ...snap.events.map((e) =>
        e.detail !== undefined ? `${e.tMs}\t${e.type}\t${e.detail}` : `${e.tMs}\t${e.type}`,
      ),
    ];
    return lines.join('\n');
  }
}
