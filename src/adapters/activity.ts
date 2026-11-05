/** Full retained transcript cap — what the review packet persists (bounded memory). */
export const ACTIVITY_CAP = 500;
/** Live tail — how many recent lines the per-tick SSE stream carries (kept small). */
export const ACTIVITY_TAIL = 40;

/** Append a readable activity line to a bounded ring buffer (last ACTIVITY_CAP). */
export function appendActivity(buffer: string[], line: string): void {
  const clean = line.trim().slice(0, 140);
  if (clean.length === 0) return;
  buffer.push(clean);
  if (buffer.length > ACTIVITY_CAP) buffer.splice(0, buffer.length - ACTIVITY_CAP);
}
