/**
 * Regression: phone SPA polish contracts (flush sheets, compact chat, voice dock).
 * Mirrors scripts/ux-browser-audit.mjs acceptance metrics as source-level gates.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clampVoiceDockPos } from '../../src/web/VoiceControl.js';
import { DEFAULT_VOICE_DOCK } from '../../src/web/prefs.js';

const ROOT = join(import.meta.dirname, '../..');

describe('session + voice UX fixes', () => {
  it('API has one PATCH /api/sessions/:id that handles mode + pin + archive', async () => {
    const src = await readFile(join(ROOT, 'src/server/api.ts'), 'utf8');
    const patches = src.match(/app\.patch\(\s*['"]\/api\/sessions\/:id['"]/g) ?? [];
    expect(patches).toHaveLength(1);
    // Must accept all three fields in the surviving handler.
    expect(src).toMatch(/permissionMode/);
    expect(src).toMatch(/setPinned/);
    expect(src).toMatch(/setArchived/);
    expect(src).toMatch(/patch requires permissionMode and\/or pinned and\/or archived/);
  });

  it('open chat sheet has no top padding gap above chrome', async () => {
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/\.sheet-tall:has\(\.session-chat\)/);
    expect(css).toMatch(/padding:\s*0/);
    // Global chat-log 48vh cap must be cleared inside session chat.
    expect(css).toMatch(/\.session-chat\s+\.chat-log[\s\S]*?max-height:\s*none/);
  });

  it('settings sheet is flush (no grip / top gradient gap)', async () => {
    const app = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    expect(app).toMatch(/sheet sheet-flush/);
    expect(app).toMatch(/data-sheet="settings"/);
    // Grip removed from settings host (was creating empty strip above title).
    const settingsBlock = app.slice(
      app.indexOf('settingsOpen'),
      app.indexOf('sessionsOpen'),
    );
    expect(settingsBlock).not.toMatch(/sheet-grip/);
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/\.sheet\.sheet-flush/);
  });

  it('sessions list is compact (no long hero blurb / grip)', async () => {
    const src = await readFile(join(ROOT, 'src/web/SessionsPanel.tsx'), 'utf8');
    expect(src).toMatch(/sessions-list-panel/);
    expect(src).not.toMatch(/Free agent chats on a repo worktree/);
    // The list panel block itself should not include a grip.
    const start = src.indexOf('className="sessions-list-panel"');
    const end = src.indexOf('function modeShort');
    const listBlock = src.slice(start, end > start ? end : start + 1200);
    expect(listBlock).not.toMatch(/sheet-grip/);
  });

  it('session chat opens scrolled to the latest message', async () => {
    const src = await readFile(join(ROOT, 'src/web/SessionsPanel.tsx'), 'utf8');
    expect(src).toMatch(/stickToBottomRef/);
    // Force pin on open (session.id), not only when already near bottom.
    expect(src).toMatch(/Opening a chat always lands on the latest message/);
    expect(src).toMatch(/session\.id/);
    expect(src).toMatch(/root\.scrollTop = root\.scrollHeight/);
  });

  it('session chat keeps compact chrome; rare controls collapse by default', async () => {
    const src = await readFile(join(ROOT, 'src/web/SessionsPanel.tsx'), 'utf8');
    expect(src).toMatch(/session-chat-chrome/);
    expect(src).toMatch(/session-chat-compact/);
    expect(src).toMatch(/session-mode-chip/);
    expect(src).toMatch(/permOpen/);
    expect(src).toMatch(/perm-mode-expand/);
    expect(src).toMatch(/Permission mode/);
    // Footer bar removed — More lives in top chrome.
    expect(src).not.toMatch(/session-footer-bar/);
    // Live steps start collapsed.
    expect(src).toMatch(/liveStepsOpen/);
    // Archive leaves the open chat and upserts via onSessionSynced.
    expect(src).toMatch(/patch\.archived === true/);
    expect(src).toMatch(/onSessionSynced\?\.\(fresh\)/);
  });

  it('task Live activity scrolls when activity lines change (not only on mount)', async () => {
    const src = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/activityLogRef/);
    expect(src).toMatch(/activityTail/);
    expect(src).toMatch(/el\.scrollTop = el\.scrollHeight/);
    expect(src).toMatch(/data-evidence="live-activity-log"/);
  });

  it('voice dock is collapsible, movable, and persists prefs', async () => {
    const vc = await readFile(join(ROOT, 'src/web/VoiceControl.tsx'), 'utf8');
    expect(vc).toMatch(/loadVoiceDock|saveVoiceDock/);
    expect(vc).toMatch(/is-collapsed|data-collapsed/);
    expect(vc).toMatch(/voice-orb-dot/);
    expect(vc).toMatch(/onPointerDown|onPointerMove/);
    expect(vc).toMatch(/voice-dock/);
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/\.voice-dock\s*\{/);
    expect(css).toMatch(/\.voice-orb\.is-collapsed/);
    expect(css).toMatch(/\.session-chat-chrome/);
  });

  it('clampVoiceDockPos keeps expanded dock fully above bottom chrome (AC3)', () => {
    // Drive the real exported helper with phone-sized viewport + bottom-nav band.
    const size = 60;
    const vh = 844;
    const bottomChrome = 72;
    const pos = clampVoiceDockPos(0.95, 0.99, size, {
      width: 390,
      height: vh,
      bottomChrome,
      topChrome: 48,
    });
    const centerY = pos.y * vh;
    const maxCenter = vh - bottomChrome - 10 - size / 2;
    expect(centerY).toBeLessThanOrEqual(maxCenter + 0.5);
    expect(pos.y).toBeLessThan(0.95);
  });

  it('default voice dock is collapsed so it does not block compose (AC3)', () => {
    expect(DEFAULT_VOICE_DOCK.collapsed).toBe(true);
  });

  it('ux audit script encodes acceptance thresholds (AC1–AC4)', async () => {
    const audit = await readFile(join(ROOT, 'scripts/ux-browser-audit.mjs'), 'utf8');
    expect(audit).toMatch(/MAX_TOP_GAP_PX\s*=\s*20/);
    expect(audit).toMatch(/vhShareScroll[\s\S]*?<\s*50/);
    expect(audit).toMatch(/nearBottom/);
    expect(audit).toMatch(/sheet-flush|flush/);
    expect(audit).toMatch(/overlapsNav/);
    expect(audit).toMatch(/zDock/);
    expect(audit).toMatch(/nav-settings|nav-repos|nav-chat/);
  });
});

describe('live steps counter at tail cap (2026-07-18)', () => {
  it('shows 40+ instead of bouncing between 40 and 41', async () => {
    // recentActivity is a 40-line tail plus an optional streaming draft line,
    // so the raw length oscillates 40↔41 forever once capped — the label must
    // say "40+" (tail truncated) instead of a bouncing count.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const src = await readFile(join(ROOT, 'src/web/SessionsPanel.tsx'), 'utf8');
    expect(src).toMatch(/40\+|LIVE_STEPS_TAIL_CAP/);
    expect(src).not.toMatch(/live steps\{activity\.length > 0 \? ` · \$\{activity\.length\}`/);
  });
});
