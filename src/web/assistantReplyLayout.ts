/**
 * Assistant reply bubble sizing (phone text panel).
 *
 * The cap is relative to the message log's *visible* height — not the panel —
 * so collapsed panel chrome directly buys taller bubbles. A bubble only gets
 * the fullscreen chrome strip when its content is actually clamped.
 */

export const ASSISTANT_REPLY_MAX_VISIBLE_RATIO = 0.75;

/** Keep a readable bubble even when the log is squeezed (keyboard up). */
export const ASSISTANT_REPLY_MIN_CAP_PX = 120;

/** Bubble max-height in px given the message log's visible (client) height. */
export function replyCapPx(logVisibleH: number): number {
  return Math.max(
    ASSISTANT_REPLY_MIN_CAP_PX,
    Math.round(logVisibleH * ASSISTANT_REPLY_MAX_VISIBLE_RATIO),
  );
}

/**
 * True when the reply's scroll box is truly cut off (needs the fullscreen
 * affordance). 1px tolerance absorbs sub-pixel rounding.
 */
export function isReplyClamped(scrollH: number, clientH: number): boolean {
  return scrollH > clientH + 1;
}
