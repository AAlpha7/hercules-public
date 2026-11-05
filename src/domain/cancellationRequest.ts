import type {
  CancellationActorCategory,
  CancellationLifecyclePhase,
  CancellationSource,
} from './cancellationAudit.js';

/** Provenance for cancel / force-abort audit receipts (privacy-safe). */
export interface CancellationRequestOpts {
  readonly source?: CancellationSource;
  readonly origin?: string;
  readonly correlationId?: string | null;
  readonly actorCategory?: CancellationActorCategory;
  readonly actorId?: string | null;
  readonly reasonCode?: string;
  readonly message?: string;
  readonly lifecyclePhase?: CancellationLifecyclePhase;
  readonly hadActiveSession?: boolean;
  readonly at?: string;
  readonly gitCommitAuthor?: string | null;
}
