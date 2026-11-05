/**
 * Assistant reply: cap at 75% of the message-log visible area (not the panel),
 * fullscreen affordance only when the content is actually clamped.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ASSISTANT_REPLY_MAX_VISIBLE_RATIO,
  isReplyClamped,
  replyCapPx,
} from '../../src/web/assistantReplyLayout.js';

const ROOT = join(import.meta.dirname, '../..');

describe('assistant reply visible-area cap', () => {
  it('caps at 75% of the message-log visible height with a usable floor', () => {
    expect(ASSISTANT_REPLY_MAX_VISIBLE_RATIO).toBe(0.75);
    expect(replyCapPx(400)).toBe(300);
    expect(replyCapPx(600)).toBe(450);
    // Tiny log (keyboard up, small phone) still leaves a readable bubble.
    expect(replyCapPx(100)).toBe(120);
    expect(replyCapPx(0)).toBe(120);
  });

  it('detects clamping only when content truly overflows the scroll box', () => {
    expect(isReplyClamped(300, 300)).toBe(false);
    expect(isReplyClamped(301, 300)).toBe(false); // sub-pixel tolerance
    expect(isReplyClamped(302, 300)).toBe(true);
    expect(isReplyClamped(0, 0)).toBe(false);
  });

  it('CSS caps bubbles relative to the log visible height var, not the panel', async () => {
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(
      /\.voice-text-assistant\s*\{[^}]*max-height:\s*calc\(\s*var\(--assistant-log-h[^)]*\)\s*\*\s*0\.75\s*\)/s,
    );
    expect(css).not.toMatch(
      /\.voice-text-assistant\s*\{[^}]*var\(--assistant-panel-h/s,
    );
    expect(css).toMatch(/\.voice-text-assistant\.is-overlay/);
    // viewport-fit=cover: fullscreen chrome must clear the notch.
    expect(css).toMatch(
      /\.voice-text-assistant\.is-overlay\s*\{[^}]*env\(safe-area-inset-top/s,
    );
    // Long user prompts scroll instead of eating the log.
    expect(css).toMatch(/\.voice-text-user\s*\{[^}]*max-height:[^}]*--assistant-log-h/s);
  });

  it('bubble shows fullscreen chrome only when clamped (or already fullscreen)', async () => {
    const src = await readFile(join(ROOT, 'src/web/AssistantReplyBubble.tsx'), 'utf8');
    // Measures its own scroll box; reacts to content growth + resizes.
    expect(src).toMatch(/isReplyClamped/);
    expect(src).toMatch(/ResizeObserver/);
    // Chrome strip is conditional — a short reply is a plain markdown bubble.
    expect(src).toMatch(/\{\s*\(clamped \|\| full\)\s*&&/);
    // Fullscreen must escape the panel: backdrop-filter on .voice-text-panel
    // makes it the containing block for position:fixed, so portal to body.
    expect(src).toMatch(/createPortal/);
    expect(src).toMatch(/onDoubleClick=\{onChromeDoubleClick\}/);
    expect(src).toMatch(/voice-reply-chrome/);
    expect(src).toMatch(/voice-reply-expand-btn/);
    expect(src).toMatch(/className="voice-reply-body"/);
  });

  it('VoiceControl publishes the log visible height as --assistant-log-h', async () => {
    const vc = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    expect(vc).toMatch(/--assistant-log-h/);
    expect(vc).toMatch(/ResizeObserver/);
  });

  it('panel live steps auto-scroll to the newest line while streaming', async () => {
    // .voice-text-activity is an inner scroll box (7.5rem cap) — without a
    // pin, new steps land below its fold and the user never sees them.
    const vc = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    expect(vc).toMatch(/activityListRef/);
    expect(vc).toMatch(/activityListRef\.current[\s\S]{0,80}scrollTop = [\s\S]{0,40}scrollHeight/);
    // The pin effect must follow the activity stream (not only messages).
    expect(vc).toMatch(/\[[^\]]*activityLines\.length[^\]]*activityTail[^\]]*\]/);
  });

  it('outside-tap collapse ignores the portaled fullscreen overlay', async () => {
    // The overlay portals to <body> (outside shellRef); tapping 收起 must not
    // collapse the whole dock.
    const vc = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    expect(vc).toMatch(/closest\(['"]\.voice-text-assistant\.is-overlay['"]\)/);
  });
});

describe('assistant panel chrome collapse', () => {
  it('rarely-used controls live in a ⋯-toggled settings strip, collapsed by default', async () => {
    const vc = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    // One persistent head row + a more (⋯) toggle.
    expect(vc).toMatch(/voice-text-more/);
    expect(vc).toMatch(/settingsOpen/);
    expect(vc).toMatch(/useState\(false\).*settingsOpen|\[settingsOpen, setSettingsOpen\] = useState\(false\)/);
    // Settings strip holds: subtitle, mode seg, permissions, open-in-chat.
    const strip = vc.slice(vc.indexOf('voice-text-settings'), vc.indexOf('voice-text-log'));
    expect(strip).toMatch(/voice-text-sub/);
    expect(strip).toMatch(/voice-mode-seg/);
    expect(strip).toMatch(/assistant-perm-mode/);
    expect(strip).toMatch(/在 Chat 打开/);
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/\.voice-text-settings/);
    expect(css).toMatch(/\.voice-text-more/);
  });
});
