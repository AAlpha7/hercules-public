import { useEffect, useRef, useState, type JSX } from 'react';
import {
  ApiError,
  fetchReviewEvidence,
  fetchReviewEvidenceImage,
} from '../api.js';
import type { EvidenceSummaryDto, ReviewPackageV2Dto } from './reviewTypes.js';
import type { ReviewEvidenceContentDto } from './reviewEvidenceTypes.js';

type DrawerState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'content'; readonly content: ReviewEvidenceContentDto; readonly imageUrl: string | null }
  | { readonly kind: 'error'; readonly message: string };

const UNAVAILABLE_LABELS: Readonly<Record<
  Extract<ReviewEvidenceContentDto, { kind: 'unavailable' }>['reason'],
  string
>> = {
  content_unavailable: 'Content is unavailable.',
  redacted: 'Content is redacted.',
  restricted: 'Content is restricted.',
  access_denied: 'Access was denied.',
  unsupported_media: 'This media type is not supported.',
};

export function EvidenceDrawer({
  packageValue,
  evidence,
  onClose,
  onUnauthorized,
  onStale,
}: {
  readonly packageValue: ReviewPackageV2Dto;
  readonly evidence: EvidenceSummaryDto;
  readonly onClose: () => void;
  readonly onUnauthorized: () => void;
  readonly onStale: () => void;
}): JSX.Element {
  const requestSequence = useRef(0);
  const [state, setState] = useState<DrawerState>({ kind: 'loading' });

  useEffect(() => {
    const requestId = ++requestSequence.current;
    const controller = new AbortController();
    let imageUrl: string | null = null;
    setState({ kind: 'loading' });
    void fetchReviewEvidence(
      packageValue.task.id,
      packageValue.projectionHash,
      evidence,
      { signal: controller.signal },
    ).then(async (content) => {
      if (controller.signal.aborted || requestSequence.current !== requestId) return;
      if (content.kind === 'image') {
        const media = content.mediaType;
        if (media.startsWith('image/') || media.startsWith('video/')) {
          imageUrl = await fetchReviewEvidenceImage(
            content.authenticatedPath,
            content.mediaType,
            { signal: controller.signal },
          );
        }
      }
      if (controller.signal.aborted || requestSequence.current !== requestId) {
        if (imageUrl !== null) URL.revokeObjectURL(imageUrl);
        return;
      }
      setState({ kind: 'content', content, imageUrl });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || requestSequence.current !== requestId) return;
      if (error instanceof ApiError && error.status === 401) onUnauthorized();
      if (error instanceof ApiError && error.status === 409) {
        setState({ kind: 'error', message: 'Review evidence is stale. Refreshing the review.' });
        onStale();
        return;
      }
      setState({ kind: 'error', message: 'Evidence content could not be verified.' });
    });
    return () => {
      controller.abort();
      if (imageUrl !== null) URL.revokeObjectURL(imageUrl);
    };
  }, [evidence, onStale, onUnauthorized, packageValue.projectionHash, packageValue.task.id]);

  return (
    <aside
      className="outcome-review-evidence-drawer"
      role="dialog"
      aria-modal="false"
      aria-labelledby="outcome-review-evidence-title"
      data-evidence="review-evidence-drawer"
    >
      <header className="outcome-review-evidence-head">
        <div>
          <h4 id="outcome-review-evidence-title">Evidence</h4>
          <code title={evidence.artifactRefId}>{evidence.artifactRefId}</code>
        </div>
        <button type="button" className="outcome-review-icon-button" onClick={onClose} aria-label="Close evidence">
          X
        </button>
      </header>
      <dl className="outcome-review-evidence-metadata">
        <div><dt>Surface</dt><dd>{evidence.surface}</dd></div>
        <div><dt>Trust</dt><dd>{evidence.trustClass}</dd></div>
        <div><dt>Redaction</dt><dd>{evidence.redactionState}</dd></div>
        <div><dt>Digest</dt><dd title={evidence.sha256}>{evidence.sha256}</dd></div>
      </dl>
      <div className="outcome-review-evidence-content">
        {state.kind === 'loading' ? <div role="status">Loading verified evidence…</div> : null}
        {state.kind === 'error' ? <div role="alert">{state.message}</div> : null}
        {state.kind === 'content' && state.content.kind === 'unavailable' ? (
          <div role="status">{UNAVAILABLE_LABELS[state.content.reason]}</div>
        ) : null}
        {state.kind === 'content' && state.content.kind === 'text' ? (
          <pre>{state.content.text}</pre>
        ) : null}
        {state.kind === 'content' && state.content.kind === 'image' ? (
          state.content.mediaType.startsWith('video/') && state.imageUrl !== null ? (
            <video
              src={state.imageUrl}
              controls
              preload="metadata"
              playsInline
              aria-label={`Evidence ${evidence.artifactRefId}`}
            />
          ) : state.content.mediaType.startsWith('image/') && state.imageUrl !== null ? (
            <img src={state.imageUrl} alt={`Evidence ${evidence.artifactRefId}`} />
          ) : !state.content.mediaType.startsWith('image/') &&
            !state.content.mediaType.startsWith('video/') ? (
            <div role="status">不支持的媒体类型: {state.content.mediaType}</div>
          ) : null
        ) : null}
      </div>
    </aside>
  );
}
