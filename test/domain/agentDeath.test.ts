/**
 * Agent death diagnosis + transient classification (agent-death-resilience).
 *
 * Case study 2026-07-29: bare "exit unknown", no mid-stream retry, poisoned
 * resume sessions kept across human Retry.
 */
import { describe, it, expect } from 'vitest';
import {
  isTransientAgentError,
  summarizeAgentDeath,
  shouldAbandonSessionOnRetry,
  formatAbandonSessionNote,
} from '../../src/domain/agentDeath.js';
import { buildRunFailureSection } from '../../src/domain/runFailure.js';

describe('isTransientAgentError', () => {
  it('matches ACP / xAI mid-stream and 5xx patterns (shared with session manager)', () => {
    expect(isTransientAgentError('Internal error')).toBe(true);
    expect(isTransientAgentError('JSON-RPC Internal error (-32603)')).toBe(true);
    expect(isTransientAgentError('status 502 Bad Gateway')).toBe(true);
    expect(isTransientAgentError('HTTP 503')).toBe(true);
    expect(isTransientAgentError('ECONNRESET')).toBe(true);
    expect(isTransientAgentError('socket hang up mid-stream')).toBe(true);
    expect(isTransientAgentError('provider overloaded')).toBe(true);
    expect(isTransientAgentError('ACP request timeout')).toBe(true);
    expect(isTransientAgentError('stream interrupted')).toBe(true);
  });

  it('does not match permanent / session-poison signals', () => {
    expect(isTransientAgentError('resume session rejected')).toBe(false);
    expect(isTransientAgentError('session not found')).toBe(false);
    expect(isTransientAgentError('authentication failed')).toBe(false);
    expect(isTransientAgentError('max turns reached')).toBe(false);
    expect(isTransientAgentError('')).toBe(false);
  });
});

describe('summarizeAgentDeath', () => {
  it('summarizes xAI 502 mid-stream from stderr', () => {
    expect(
      summarizeAgentDeath({
        stderrTail: 'Error: status 502 Bad Gateway while streaming response',
        exitCode: 1,
      }),
    ).toMatch(/502|mid-stream/i);
  });

  it('summarizes resume session rejected', () => {
    expect(
      summarizeAgentDeath({
        stderrTail: 'Error: resume session rejected — session not found',
        activityTail: ['error: resume failed'],
        exitCode: 1,
      }),
    ).toMatch(/resume session rejected/i);
  });

  it('prefers signal when process was killed without useful stderr', () => {
    expect(
      summarizeAgentDeath({
        exitCode: null,
        exitSignal: 'SIGTERM',
      }),
    ).toMatch(/SIGTERM/);
  });

  it('falls back to exit code rather than bare "exit unknown"', () => {
    // C3.59: 128 + N is a signal death, not an application status.
    expect(summarizeAgentDeath({ exitCode: 137 })).toBe(
      'killed by SIGKILL (exit 137) — adapter process crashed',
    );
    expect(summarizeAgentDeath({ exitCode: 132 })).toBe(
      'killed by SIGILL (exit 132) — adapter process crashed',
    );
    expect(summarizeAgentDeath({ exitCode: 139 })).toMatch(/SIGSEGV/);
    // Ordinary application statuses stay verbatim, and 128 itself is not a signal.
    expect(summarizeAgentDeath({ exitCode: 1 })).toBe('exit 1');
    expect(summarizeAgentDeath({ exitCode: 128 })).toBe('exit 128');
    expect(summarizeAgentDeath({ exitCode: 193 })).toBe('exit 193');
    // Unknown exit with no evidence still gets a concrete phrase — not "exit unknown" alone.
    const s = summarizeAgentDeath({ exitCode: null });
    expect(s.length).toBeGreaterThan(0);
    expect(s).not.toBe('exit unknown');
  });

  it('uses activity error lines when stderr is empty', () => {
    expect(
      summarizeAgentDeath({
        activityTail: ['tool: edit', 'error: connection reset by peer'],
        exitCode: 1,
      }),
    ).toMatch(/connection reset/i);
  });

  it('classifies Grok not-signed-in as adapter auth infra', () => {
    expect(
      summarizeAgentDeath({
        activityTail: [
          'error: Not signed in. To authenticate without a browser, run:',
          'grok login --device-code',
        ],
        exitCode: 1,
      }),
    ).toMatch(/adapter not signed in/i);
  });
});

describe('shouldAbandonSessionOnRetry', () => {
  it('is true for agent_exit failures that still hold an agent_session', () => {
    const body = buildRunFailureSection({
      stamp: 't',
      kind: 'agent_exit',
      attempt: 2,
      maxAttempts: 3,
      exitCode: 1,
    });
    expect(
      shouldAbandonSessionOnRetry({ agentSession: 'sess-poison', body }),
    ).toBe(true);
  });

  it('is false without a session or when last failure is not agent_exit', () => {
    const stall = buildRunFailureSection({
      stamp: 't',
      kind: 'stall',
      attempt: 1,
      maxAttempts: 3,
    });
    expect(shouldAbandonSessionOnRetry({ agentSession: 's', body: stall })).toBe(false);
    expect(
      shouldAbandonSessionOnRetry({
        agentSession: null,
        body: buildRunFailureSection({
          stamp: 't',
          kind: 'agent_exit',
          attempt: 1,
          maxAttempts: 3,
        }),
      }),
    ).toBe(false);
  });
});

describe('formatAbandonSessionNote', () => {
  it('notes that the corrupted session was abandoned', () => {
    const note = formatAbandonSessionNote('sess-dead');
    expect(note).toMatch(/已放弃损坏会话|abandoned/i);
    expect(note).toMatch(/session/i);
    expect(note).not.toContain('sess-dead');
  });
});
