import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phone chat must send a stable clientMessageId so server-side retries are
 * idempotent. Source-level contract (render suite covers chrome separately).
 */
describe('chatTask clientMessageId contract', () => {
  const apiSrc = readFileSync(join(process.cwd(), 'src/web/api.ts'), 'utf8');
  const appSrc = readFileSync(join(process.cwd(), 'src/web/App.tsx'), 'utf8');
  const detailSrc = readFileSync(join(process.cwd(), 'src/web/TaskDetail.tsx'), 'utf8');

  it('exports newClientMessageId and chatTask accepts clientMessageId', () => {
    expect(apiSrc).toMatch(/export function newClientMessageId/);
    expect(apiSrc).toMatch(/clientMessageId/);
    expect(apiSrc).toMatch(/mode: 'duplicate'/);
  });

  it('API rejects malformed clientMessageId (no silent legacy downgrade)', () => {
    const serverApi = readFileSync(join(process.cwd(), 'src/server/api.ts'), 'utf8');
    expect(serverApi).toMatch(/parseClientMessageIdInput/);
    expect(serverApi).toMatch(/status === 'invalid'/);
    expect(serverApi).toMatch(/400/);
  });

  it('App generates one clientMessageId per chat submit and scopes outcome per task', () => {
    expect(appSrc).toMatch(/newClientMessageId\(\)/);
    expect(appSrc).toMatch(/chatTask\(taskId, message, \{ clientMessageId \}\)/);
    expect(appSrc).toMatch(/chatOutcomeByTask/);
    expect(appSrc).toMatch(/chatOutcomeByTask\[detail\.id\]/);
    expect(appSrc).toMatch(/taskChatUiEffect|taskChatUi/);
    const ui = readFileSync(join(process.cwd(), 'src/web/taskChatUi.ts'), 'utf8');
    expect(ui).toMatch(/taskChatUiEffect/);
    expect(ui).toMatch(/Already delivered/);
    expect(ui).toMatch(/Queued — will send when this turn ends/);
    expect(ui).toMatch(/Pending — will include on next dispatch/);
    expect(ui).toMatch(/Steered — task re-queued for the agent/);
  });

  it('TaskDetail exposes stable chat outcome / queue evidence hooks', () => {
    expect(detailSrc).toMatch(/data-evidence="chat-outcome"/);
    expect(detailSrc).toMatch(/data-evidence="chat-queued"/);
    expect(detailSrc).toMatch(/data-evidence="task-chat-panel"/);
  });
});
