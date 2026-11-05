/**
 * Composer / task-live UX contracts (static source checks + domain helpers).
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

describe('chat composer + task live UX', () => {
  it('ChatComposer uses multiline Enter semantics and dismissible overlays', async () => {
    const src = await readFile(join(ROOT, 'src/web/ChatComposer.tsx'), 'utf8');
    expect(src).toMatch(/metaKey|ctrlKey/);
    expect(src).toMatch(/startVoiceCapture|transcribeVoice/);
    expect(src).not.toMatch(/SpeechRecognition|webkitSpeechRecognition/);
    expect(src).toMatch(/uploadSessionAttachment/);
    expect(src).toMatch(/Reference task/);
    // Overlays must be closable (Escape / outside / explicit close).
    expect(src).toMatch(/Escape/);
    expect(src).toMatch(/pointerdown/);
    expect(src).toMatch(/compose-overlay-close|Close/);
    expect(src).toMatch(/closeOverlay|setOverlay\('none'\)|Overlay = 'none'/);
    // Must not use .actions (min-width:96px stacks +/mic under Send on phone).
    expect(src).toMatch(/compose-main-actions/);
    expect(src).not.toMatch(/className="actions[^"]*compose-main/);
    expect(src).toMatch(/icon-btn/);
  });

  it('composer CSS keeps icon buttons at 48px without .actions min-width', async () => {
    const css = await readFile(join(ROOT, 'src/web/styles.css'), 'utf8');
    expect(css).toMatch(/\.compose-main-actions\s*\{[^}]*display:\s*flex/s);
    expect(css).toMatch(/\.icon-btn\s*\{[^}]*width:\s*48px/s);
    expect(css).toMatch(/icon-btn-primary|compose-send/);
    expect(css).toMatch(/\.compose-menu-item\s*\{/);
    // Footer More shares chrome with .actions / surface-2
    expect(css).toMatch(/\.session-footer-btn/);
    expect(css).toMatch(/\.icon-btn,\s*\n\.session-back-icon/);
  });

  it('Send is an icon (not a wide text button)', async () => {
    const src = await readFile(join(ROOT, 'src/web/ChatComposer.tsx'), 'utf8');
    expect(src).toMatch(/compose-send|icon-btn-primary/);
    expect(src).toMatch(/aria-label=\{running \? 'Interrupt and send' : 'Send'\}/);
    expect(src).not.toMatch(/>\s*Interrupt & send\s*</);
    expect(src).not.toMatch(/>\s*Send\s*</);
  });

  it('SessionsPanel wires ChatComposer; no footer Back; list via ← or Chat re-tap', async () => {
    const src = await readFile(join(ROOT, 'src/web/SessionsPanel.tsx'), 'utf8');
    expect(src).toMatch(/ChatComposer/);
    expect(src).toMatch(/fetchSessionDiff/);
    // Phone Assistant session shows the cleaned protocol view in Chat too
    // (no raw boot / [Tool results] / <<HERCULES_TOOL>> lines).
    expect(src).toMatch(/isAssistantSession/);
    expect(src).toMatch(/cleanAssistantChatMessages/);
    expect(src).toMatch(/activity-timeline|live steps/);
    expect(src).toMatch(/kind === 'task'/);
    expect(src).toMatch(/session-more-menu|session-more-btn/);
    expect(src).toMatch(/session-back-icon/);
    expect(src).toMatch(/listEpoch/);
    expect(src).toMatch(/focusEpoch/);
    expect(src).toMatch(/selected\.updatedAt/);
    // List-open of task live must force openTaskLive (not bare setSelectedId).
    expect(src).toMatch(/openFromList/);
    expect(src).toMatch(/openTaskLiveSession/);
    expect(src).toMatch(/onSessionSynced/);
    expect(src).not.toMatch(/onClick=\{\(\) => setSelectedId\(s\.id\)\}/);
    // Lifecycle system messages: structured actions → in-chat jump buttons.
    expect(src).toMatch(/onMessageAction|chat-msg-action/);
    expect(src).toMatch(/onOpenTask/);
    // Client backfill for transcripts that predate actions.
    expect(src).toMatch(/withMessageActions|finished this turn/);
    // More is a compact ⋯ icon (c13352c) with accessible labeling + open state.
    expect(src).toMatch(/session-more-icon/);
    expect(src).toMatch(/aria-label=\{moreOpen \? 'Close menu' : 'More actions'\}/);
    // Footer must not carry a labeled Back (redundant with Chat tab + top ←).
    expect(src).not.toMatch(/← Back|session-back(?!-icon)/);
    // Rare actions must not sit as always-visible footer buttons.
    expect(src).not.toMatch(/session-extra-actions/);
  });

  it('task detail opens live session; Chat re-tap forces session list; reopen bumps focusEpoch', async () => {
    const src = await readFile(join(ROOT, 'src/web/App.tsx'), 'utf8');
    const detail = await readFile(join(ROOT, 'src/web/TaskDetail.tsx'), 'utf8');
    expect(src).toMatch(/openTaskLiveSession/);
    expect(detail).toMatch(/Open live session/);
    expect(src).toMatch(/liveSessionFocus/);
    expect(src).toMatch(/sessionsListEpoch|listEpoch/);
    expect(src).toMatch(/setSessionsListEpoch/);
    expect(src).toMatch(/sessionFocusEpoch|setSessionFocusEpoch/);
    // Forced open merges session before paint so chat key sees fresh updatedAt.
    expect(src).toMatch(/upsertSession/);
    expect(src).toMatch(/onSessionSynced/);
    // Sheet drill-in keeps a return stack (chat ↔ task).
    expect(src).toMatch(/closeTaskSheet|pushNavFrame|navStack|openTaskSheet/);
    expect(src).toMatch(/closeSessionsSheet/);
    expect(src).toMatch(/← Chat|navCloseLabel|closeLabel/);
  });

  it('API exposes live-session, attachments, and diff routes', async () => {
    const src = await readFile(join(ROOT, 'src/server/api.ts'), 'utf8');
    expect(src).toMatch(/live-session/);
    expect(src).toMatch(/attachments/);
    expect(src).toMatch(/sessions\/:id\/diff/);
  });
});
