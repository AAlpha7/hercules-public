/**
 * Sheet navigation return stack (phone Remote Control).
 *
 * Sheets are mutually exclusive (task XOR sessions XOR repos XOR create).
 * When drilling A → B, push A; closing B restores A. Explicit tab changes
 * clear the stack (new root destination).
 */

export type NavReturn =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'task'; readonly taskId: string }
  /** Releases sheet; scrollTop restores the reading position on return. */
  | { readonly kind: 'releases'; readonly scrollTop: number };

const CAP = 8;

export function pushNav(stack: readonly NavReturn[], frame: NavReturn): NavReturn[] {
  return [...stack.slice(-(CAP - 1)), frame];
}

export function popNav(stack: readonly NavReturn[]): {
  readonly stack: NavReturn[];
  readonly frame: NavReturn | null;
} {
  if (stack.length === 0) return { stack: [], frame: null };
  return {
    stack: stack.slice(0, -1),
    frame: stack[stack.length - 1] ?? null,
  };
}

export function peekNav(stack: readonly NavReturn[]): NavReturn | null {
  return stack.length === 0 ? null : (stack[stack.length - 1] ?? null);
}

/** Close / Back label for the current sheet given the top of the return stack. */
export function navCloseLabel(frame: NavReturn | null): string {
  if (!frame) return 'Close';
  if (frame.kind === 'session' || frame.kind === 'sessions') return '← Chat';
  if (frame.kind === 'task') return '← Task';
  if (frame.kind === 'releases') return '← Releases';
  return 'Back';
}
