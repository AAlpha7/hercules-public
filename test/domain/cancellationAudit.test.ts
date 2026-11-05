import { describe, it, expect } from 'vitest';
import {
  buildCancellationAuditReceipt,
  deriveCancellationLifecyclePhase,
  normalizeCancellationActorId,
  redactCancellationMessage,
  bodyHasCancellationAudit,
} from '../../src/domain/cancellationAudit.js';
import {
  appendCancellationAuditReceipt,
  formatCancellationAuditReceipt,
  parseCancellationAuditReceipts,
  latestCancellationAudit,
} from '../../src/domain/cancellationAuditIo.js';

const AT = '2026-08-04T18:00:00.000Z';

describe('cancellation audit receipts', () => {
  it('builds a human UI cancel receipt with operator category and no git author', () => {
    const r = buildCancellationAuditReceipt({
      kind: 'cancel',
      source: 'human_ui',
      at: AT,
      lifecyclePhase: 'pre_session',
      hadActiveSession: false,
      correlationId: 'req-abc-1',
      message: 'Operator requested cancellation.',
      gitCommitAuthor: 'Hercules',
    });
    expect(r.source).toBe('human_ui');
    expect(r.reasonCode).toBe('human_cancel');
    expect(r.actor.category).toBe('operator');
    expect(r.actor.id).toBeNull();
    expect(r.lifecyclePhase).toBe('pre_session');
    expect(r.hadActiveSession).toBe(false);
    expect(r.origin).toBe('ui');
    expect(r.correlationId).toBe('req-abc-1');
  });

  it('never accepts Hercules/ubuntu git authors as actor id', () => {
    expect(normalizeCancellationActorId('Hercules')).toBeNull();
    expect(normalizeCancellationActorId('ubuntu')).toBeNull();
    const r = buildCancellationAuditReceipt({
      kind: 'cancel',
      source: 'unknown',
      at: AT,
      hadActiveSession: false,
      actorId: 'Hercules',
      gitCommitAuthor: 'Hercules',
    });
    expect(r.actor.id).toBeNull();
    expect(r.actor.category).toBe('unavailable');
    expect(r.reasonCode).toBe('attribution_unavailable');
  });

  it('redacts secrets and host paths from messages', () => {
    const msg = redactCancellationMessage(
      'cancel with Bearer sk-abc12345deadbeef and path /home/ubuntu/secret/token',
    );
    expect(msg).not.toMatch(/sk-abc/);
    expect(msg).not.toContain('/home/ubuntu');
    expect(msg.toLowerCase()).toMatch(/redacted|path/);
  });

  it('derives lifecycle phase: pre_session vs agent_running', () => {
    expect(deriveCancellationLifecyclePhase({ state: 'todo', agentSession: null }))
      .toBe('pre_session');
    expect(deriveCancellationLifecyclePhase({ state: 'in_progress' }))
      .toBe('agent_running');
    expect(deriveCancellationLifecyclePhase({
      state: 'todo',
      runtimePhase: 'verifying',
    })).toBe('verifying');
  });

  it('records daemon safety force-abort distinctly', () => {
    const r = buildCancellationAuditReceipt({
      kind: 'force_abort',
      source: 'daemon_safety',
      at: AT,
      lifecyclePhase: 'stopping',
      hadActiveSession: true,
      reasonCode: 'daemon_grace_timeout',
      message: 'Grace period expired; daemon forced SIGKILL.',
    });
    expect(r.source).toBe('daemon_safety');
    expect(r.actor.category).toBe('daemon');
    expect(r.reasonCode).toBe('daemon_grace_timeout');
    expect(formatCancellationAuditReceipt(r)).toContain('daemon_safety');
  });

  it('round-trips format/parse for agent-running cancel', () => {
    const r = buildCancellationAuditReceipt({
      kind: 'cancel',
      source: 'human_api',
      at: AT,
      lifecyclePhase: 'agent_running',
      hadActiveSession: true,
      actorId: 'ops-phone-1',
      correlationId: 'corr-9',
    });
    const body = appendCancellationAuditReceipt(
      '## Goal' + String.fromCharCode(10) + 'Do work',
      r,
    );
    expect(bodyHasCancellationAudit(body)).toBe(true);
    const parsed = parseCancellationAuditReceipts(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.kind).toBe('cancel');
    expect(parsed[0]!.source).toBe('human_api');
    expect(parsed[0]!.hadActiveSession).toBe(true);
    expect(parsed[0]!.lifecyclePhase).toBe('agent_running');
    expect(parsed[0]!.actor.id).toBe('ops-phone-1');
    expect(latestCancellationAudit(body)?.correlationId).toBe('corr-9');
  });

  it('records external_state and agent sources distinctly', () => {
    const external = buildCancellationAuditReceipt({
      kind: 'cancel',
      source: 'external_state',
      at: AT,
      lifecyclePhase: 'terminal',
      hadActiveSession: false,
    });
    expect(external.reasonCode).toBe('external_state_change');
    expect(external.actor.category).toBe('unavailable');

    const agent = buildCancellationAuditReceipt({
      kind: 'cancel',
      source: 'agent',
      at: AT,
      lifecyclePhase: 'agent_running',
      hadActiveSession: true,
    });
    expect(agent.reasonCode).toBe('agent_request');
    expect(agent.actor.category).toBe('agent');
  });
});
