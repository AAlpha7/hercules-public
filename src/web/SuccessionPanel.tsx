import { useEffect, useState, type JSX } from 'react';
import {
  fetchWorkspaceSuccession,
  type WorkspaceSuccessionDto,
} from './api.js';

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

export function SuccessionPanel({
  repoKey,
  refreshKey,
}: {
  repoKey: string;
  refreshKey?: string | number;
}): JSX.Element | null {
  const [receipt, setReceipt] = useState<WorkspaceSuccessionDto | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchWorkspaceSuccession(repoKey).then(
      (next) => { if (!cancelled) setReceipt(next); },
      () => { if (!cancelled) setReceipt(null); },
    );
    return () => { cancelled = true; };
  }, [repoKey, refreshKey]);
  if (!receipt) return null;
  return (
    <section className="succession-panel" data-evidence="workspace-succession">
      <h4>Workspace succession</h4>
      <p data-evidence="succession-canonical">
        Canonical base <span className="mono">{shortSha(receipt.canonicalDefaultRevision)}</span>
      </p>
      <p className="muted">
        Previous {shortSha(receipt.priorDefaultRevision)} · gate {shortSha(receipt.gateMergeSha)}
      </p>
      <ul data-evidence="succession-managed">
        {receipt.managed.map((workspace) => (
          <li key={workspace.taskId}>
            <strong>{workspace.taskId}</strong>: {workspace.disposition}
          </li>
        ))}
      </ul>
      <ul data-evidence="succession-classifications">
        {receipt.classifications.map((checkout) => (
          <li key={checkout.registrationId}>
            <strong>{checkout.registrationId}: {checkout.classification}</strong>
            {checkout.concurrentChange ? <span> · changed during observation</span> : null}
            <ul data-evidence="succession-choices">
              {checkout.guidance.map((choice) => (
                <li key={choice.code}>{choice.text}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {receipt.classifications.length === 0 ? (
        <p className="muted" data-evidence="succession-choices">
          Start new work from the canonical base. No owner checkout was observed.
        </p>
      ) : null}
    </section>
  );
}
