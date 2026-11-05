import './setup.js';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { formatCliEvidenceReceipt, type CliEvidenceReceipt } from '../../../src/domain/cliEvidence.js';
import { TaskBodyView } from '../../../src/web/taskBody.js';

function receipt(status: 'passed' | 'failed' | 'not_run'): CliEvidenceReceipt {
  return {
    version: 1,
    source: 'workflow',
    status,
    ok: status === 'passed',
    durationMs: 8,
    steps: [],
    ...(status === 'not_run' ? { omissionReason: 'L1 gates failed' } : {}),
  };
}

describe('CLI evidence receipt UI', () => {
  it.each(['passed', 'failed', 'not_run'] as const)('renders %s independently from browser evidence', (status) => {
    render(
      <TaskBodyView
        body={'## Review packet\npacket\n\n' + formatCliEvidenceReceipt(receipt(status))}
      />,
    );
    const surface = document.querySelector('[data-evidence="cli-evidence-receipt"]');
    expect(surface).not.toBeNull();
    expect(screen.getByText('CLI behavioral evidence')).toBeInTheDocument();
    expect(surface?.textContent?.toLowerCase()).toContain(status === 'not_run' ? 'not-run' : status);
  });
});
