/** Phone banner: verification succeeded but post-merge gates failed. */
import type { JSX } from 'react';
import type { MergeFailureReceipt } from '../domain/mergeFailureReceipt.js';

export function MergeGateFailureBanner(props: {
  readonly receipt: MergeFailureReceipt | null;
}): JSX.Element {
  const r = props.receipt;
  return (
    <div className={'banner banner-danger'} data-evidence={'merge-gate-failure-receipt'}>
      <strong>Merge gate failed (verification had succeeded).</strong> Default branch not updated.
      {r ? (
        <div className={'muted'} data-evidence={'merge-gate-failure-summary'}>
          Gate <code>{r.failedGate}</code> exit <code>{String(r.exitStatus ?? 'unknown')}</code>
          {r.truncation.truncated ? ' (output truncated)' : ''}.
          <div data-evidence={'merge-gate-next-action'}>{r.nextAction}</div>
        </div>
      ) : null}
    </div>
  );
}

