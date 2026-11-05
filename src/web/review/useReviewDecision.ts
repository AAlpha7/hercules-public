import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  CONTROL_API_V2_WEB_ACTOR_ID,
  CONTROL_API_V2_WEB_ACTOR_ISSUER,
  controlApiV2BrowserClient,
  submitReviewDecision,
} from '../api.js';
import { ControlApiV2BrowserError } from '../controlApiV2Client.js';
import type {
  ControlApiV2ReceiptV1,
  ControlApiV2RequestV1,
} from '../../domain/controlApiV2Wire.js';
import type {
  ReviewDecisionRequestDto,
  ReviewDecisionResponseDto,
} from './reviewDecisionTypes.js';

export type ReviewDecisionAcceptedResponse =
  | ReviewDecisionResponseDto
  | {
      readonly schema: 'hercules-control-api-receipt/v2';
      readonly receipt: ControlApiV2ReceiptV1;
    };

export type ReviewDecisionSubmitState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting'; readonly request: ReviewDecisionRequestDto }
  | {
      readonly kind: 'accepted';
      readonly request: ReviewDecisionRequestDto;
      readonly response: ReviewDecisionAcceptedResponse;
    }
  | {
      readonly kind: 'error';
      readonly request: ReviewDecisionRequestDto;
      readonly message: string;
      readonly retryable: boolean;
    };

export type ReviewDecisionMode =
  | { readonly kind: 'legacy' }
  | {
      readonly kind: 'control_v2';
      readonly aggregateId: string;
      readonly stateVersion: number;
    };

const OUTCOME_UNKNOWN =
  'Decision outcome is unknown. Retry with the same request ID after the authoritative refresh.';

function controlDecisionReason(
  body: {
    readonly schema: string;
    readonly reason?: string | null;
  },
): string | null {
  if (
    body.schema === 'hercules-control-api-receipt/v2' ||
    body.schema === 'hercules-control-api-refusal/v2'
  ) {
    return typeof body.reason === 'string' ? body.reason : null;
  }
  return null;
}

export function useReviewDecision(input: Readonly<{
  taskId: string;
  projectionHash: string | null;
  onUnauthorized: () => void;
  onAuthoritativeRefetch: () => void;
  mode?: ReviewDecisionMode;
}>): Readonly<{
  state: ReviewDecisionSubmitState;
  submit: (request: ReviewDecisionRequestDto) => void;
  retry: () => void;
}> {
  const [state, setState] = useState<ReviewDecisionSubmitState>({ kind: 'idle' });
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const modeRef = useRef<ReviewDecisionMode>(input.mode ?? { kind: 'legacy' });
  modeRef.current = input.mode ?? { kind: 'legacy' };
  const preparedByClientRequestId = useRef(
    new Map<string, ControlApiV2RequestV1>(),
  );
  /** clientRequestIds submitted through the LEGACY route (their retry stays on that route). */
  const legacyAttempts = useRef(new Set<string>());
  const inputRef = useRef(input);
  inputRef.current = input;

  const finishControlResult = useCallback((
    request: ReviewDecisionRequestDto,
    requestId: number,
    controller: AbortController,
    result: { readonly body: { readonly schema: string; readonly outcome?: string; readonly reason?: string | null } },
  ): void => {
    if (controller.signal.aborted || sequence.current !== requestId) return;
    pending.current = false;
    const body = result.body;
    if (
      body.schema === 'hercules-control-api-receipt/v2' &&
      body.outcome === 'committed'
    ) {
      setState({
        kind: 'accepted',
        request,
        response: {
          schema: 'hercules-control-api-receipt/v2',
          receipt: body as ControlApiV2ReceiptV1,
        },
      });
      inputRef.current.onAuthoritativeRefetch();
      return;
    }
    const reason = controlDecisionReason(body);
    if (reason === 'stale_version' || reason === 'stale_projection') {
      setState({
        kind: 'error',
        request,
        message: 'The review changed before this decision was accepted.',
        retryable: false,
      });
      inputRef.current.onAuthoritativeRefetch();
      return;
    }
    if (reason === 'need_more_evidence' || reason === 'ineligible_decision') {
      setState({
        kind: 'error',
        request,
        message: 'More evidence is required before this decision can be accepted.',
        retryable: false,
      });
      inputRef.current.onAuthoritativeRefetch();
      return;
    }
    if (reason === 'idempotency_conflict') {
      setState({
        kind: 'error',
        request,
        message: 'This request ID was already used for a different decision.',
        retryable: false,
      });
      return;
    }
    if (
      reason === 'invalid_input_schema' ||
      reason === 'unknown_aggregate' ||
      reason === 'broken_event_chain'
    ) {
      setState({
        kind: 'error',
        request,
        message: `The decision was not accepted (${reason}).`,
        retryable: false,
      });
      if (reason === 'unknown_aggregate') {
        inputRef.current.onAuthoritativeRefetch();
      }
      return;
    }
    setState({
      kind: 'error',
      request,
      message: OUTCOME_UNKNOWN,
      retryable: true,
    });
    inputRef.current.onAuthoritativeRefetch();
  }, []);

  const finishControlError = useCallback((
    request: ReviewDecisionRequestDto,
    requestId: number,
    controller: AbortController,
    error: unknown,
    attempted = true,
  ): void => {
    if (controller.signal.aborted || sequence.current !== requestId) return;
    pending.current = false;
    if (!attempted) {
      // Nothing reached the wire, so the outcome is known: not retryable
      // (a retry would have no prepared request to resend).
      if (error instanceof ApiError && error.status === 401) {
        inputRef.current.onUnauthorized();
      }
      setState({
        kind: 'error',
        request,
        message:
          error instanceof ControlApiV2BrowserError && error.code === 'webcrypto_unavailable'
            ? 'Control API review needs a secure context.'
            : error instanceof Error
              ? error.message
              : 'The decision was not accepted.',
        retryable: false,
      });
      return;
    }
    if (error instanceof ApiError && error.status === 401) {
      inputRef.current.onUnauthorized();
    }
    if (error instanceof ControlApiV2BrowserError) {
      if (error.code === 'webcrypto_unavailable') {
        setState({
          kind: 'error',
          request,
          message: 'Control API review needs a secure context.',
          retryable: false,
        });
        return;
      }
      if (error.code === 'invalid_response') {
        setState({
          kind: 'error',
          request,
          message: OUTCOME_UNKNOWN,
          retryable: true,
        });
        inputRef.current.onAuthoritativeRefetch();
        return;
      }
      setState({
        kind: 'error',
        request,
        message: error.message,
        retryable: false,
      });
      return;
    }
    const status = error instanceof ApiError ? error.status : null;
    const retryable = status === null || status === 0 || status >= 500;
    setState({
      kind: 'error',
      request,
      message: retryable
        ? OUTCOME_UNKNOWN
        : error instanceof Error
          ? error.message
          : 'The decision was not accepted.',
      retryable,
    });
    if (retryable) inputRef.current.onAuthoritativeRefetch();
  }, []);

  const executePrepared = useCallback((
    request: ReviewDecisionRequestDto,
    prepared: ControlApiV2RequestV1,
  ): void => {
    if (pending.current || request.taskId !== inputRef.current.taskId) return;
    pending.current = true;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const requestId = ++sequence.current;
    setState({ kind: 'submitting', request });
    void controlApiV2BrowserClient()
      .execute(prepared, { signal: controller.signal })
      .then((result) => {
        finishControlResult(request, requestId, controller, result);
      })
      .catch((error: unknown) => {
        finishControlError(request, requestId, controller, error);
      });
  }, [finishControlError, finishControlResult]);

  const runLegacy = useCallback((request: ReviewDecisionRequestDto): void => {
    if (pending.current || request.taskId !== inputRef.current.taskId) return;
    legacyAttempts.current.add(request.clientRequestId);
    pending.current = true;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    const requestId = ++sequence.current;
    setState({ kind: 'submitting', request });
    void submitReviewDecision(request, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted || sequence.current !== requestId) return;
        pending.current = false;
        setState({ kind: 'accepted', request, response });
        inputRef.current.onAuthoritativeRefetch();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || sequence.current !== requestId) return;
        pending.current = false;
        if (error instanceof ApiError && error.status === 401) {
          inputRef.current.onUnauthorized();
        }
        const status = error instanceof ApiError ? error.status : null;
        // Once POST was attempted, network, 5xx, or response-validation failures
        // are outcome-unknown. Only the exact same idempotency key may retry.
        const retryable = status === null || status === 0 || status >= 500;
        const message = retryable
          ? OUTCOME_UNKNOWN
          : status === 409
            ? 'The review changed before this decision was accepted.'
            : status === 422
              ? 'More evidence is required before this decision can be accepted.'
              : error instanceof Error
                ? error.message
                : 'The decision was not accepted.';
        setState({ kind: 'error', request, message, retryable });
        if (status === 409 || status === 422 || retryable) {
          inputRef.current.onAuthoritativeRefetch();
        }
      });
  }, []);

  const run = useCallback((request: ReviewDecisionRequestDto): void => {
    if (pending.current || request.taskId !== inputRef.current.taskId) return;
    const mode = modeRef.current;
    if (mode.kind === 'control_v2') {
      const reasonText = (request.reason?.trim() ?? '').normalize('NFC');
      if (reasonText.length === 0) {
        setState({
          kind: 'error',
          request,
          message: 'A reason is required for Control API decisions.',
          retryable: false,
        });
        return;
      }
      pending.current = true;
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      const requestId = ++sequence.current;
      setState({ kind: 'submitting', request });
      void (async () => {
        let prepared: ControlApiV2RequestV1 | null = null;
        try {
          prepared = await controlApiV2BrowserClient().prepareDecision({
            aggregateId: mode.aggregateId,
            stateVersion: mode.stateVersion,
            projectionHash: request.projectionHash,
            actorIssuer: CONTROL_API_V2_WEB_ACTOR_ISSUER,
            actorId: CONTROL_API_V2_WEB_ACTOR_ID,
            clientRequestId: request.clientRequestId,
            payload: {
              kind: 'decision',
              action: request.action,
              reason: reasonText,
              acknowledgedRiskCodes: [
                ...new Set(request.acknowledgedRiskCodes.map((code) => code.normalize('NFC'))),
              ].sort(),
            },
            issuedAt: new Date().toISOString(),
          });
          if (controller.signal.aborted || sequence.current !== requestId) return;
          preparedByClientRequestId.current.set(request.clientRequestId, prepared);
          const result = await controlApiV2BrowserClient().execute(prepared, {
            signal: controller.signal,
          });
          finishControlResult(request, requestId, controller, result);
        } catch (error: unknown) {
          finishControlError(request, requestId, controller, error, prepared !== null);
        }
      })();
      return;
    }

    runLegacy(request);
  }, [finishControlError, finishControlResult, runLegacy]);

  const retry = useCallback((): void => {
    const current = stateRef.current;
    if (current.kind !== 'error' || !current.retryable) return;
    // A retry is the SAME attempt: if this clientRequestId was prepared for the
    // control route, resend that exact request object even if the presentation
    // mode has since changed (issuedAt is inside requestHash — never rebuild).
    const prepared = preparedByClientRequestId.current.get(
      current.request.clientRequestId,
    );
    if (prepared !== undefined) {
      executePrepared(current.request, prepared);
      return;
    }
    // A legacy attempt retries through the legacy route even if the
    // presentation has since switched to the control surface.
    if (legacyAttempts.current.has(current.request.clientRequestId)) {
      runLegacy(current.request);
    }
  }, [executePrepared, runLegacy]);

  useEffect(() => {
    active.current?.abort();
    active.current = null;
    pending.current = false;
    preparedByClientRequestId.current.clear();
    legacyAttempts.current.clear();
    setState({ kind: 'idle' });
    return () => {
      active.current?.abort();
      pending.current = false;
    };
  }, [input.taskId]);

  useEffect(() => {
    const current = stateRef.current;
    if (
      input.projectionHash !== null &&
      current.kind !== 'idle' &&
      current.kind !== 'submitting' &&
      !(current.kind === 'error' && current.retryable) &&
      current.request.projectionHash !== input.projectionHash
    ) setState({ kind: 'idle' });
  }, [input.projectionHash]);

  return { state, submit: run, retry };
}
