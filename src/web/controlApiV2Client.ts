/**
 * M11 Control API V2 — browser SPA client.
 *
 * Thin transport over the browser-safe wire contract (`controlApiV2Wire`) and the
 * shared domain canonical serializer (`canonicalSerialize` / `canonicalClone`).
 * Hashing uses WebCrypto (`crypto.subtle.digest('SHA-256', …)`); the `fetch` seam
 * is injected so tests can point it at the in-process Hono app.
 *
 * Non-goals: no retries, no storage, no React. Structural validation is exact-key
 * + hash only — the server is the fail-closed validator; domain identifier/NFC
 * bounds are NOT re-implemented here.
 */

import {
  CanonicalJsonError,
  canonicalClone,
  canonicalSerialize,
} from '../domain/canonicalSerialize.js';
import {
  CONTROL_API_V2_RECEIPT_V1_KEYS,
  CONTROL_API_V2_REFUSAL_V1_KEYS,
  CONTROL_API_V2_REVIEW_VIEW_V1_KEYS,
  CONTROL_API_V2_STATUS_VIEW_V1_KEYS,
  ENGINE_REFUSAL_REASONS,
  EVENT_PAGE_V1_KEYS,
  REFUSAL_CARRIER_REASONS,
  controlApiV2HttpRoute,
  type ConcurrencyTokenV2,
  type ControlApiV2Operation,
  type ControlApiV2PayloadV1,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RefusalV1,
  type ControlApiV2RequestV1,
  type ControlApiV2Resource,
  type ControlApiV2StatusViewV1,
  type CreatePayloadV1,
  type DecisionPayloadV1,
  type EventCursorRequestV1,
  type EventPageV1,
  type IdempotencyKeyV2,
} from '../domain/controlApiV2Wire.js';
import { assertReviewPackageProjectionIntegrity } from './review/reviewIntegrity.js';
import {
  ReviewDtoDecodeError,
  decodeReviewPackageV2,
  type ReviewPackageV2Dto,
} from './review/reviewTypes.js';

export class ControlApiV2BrowserError extends Error {
  override readonly name = 'ControlApiV2BrowserError';

  constructor(
    readonly code: 'webcrypto_unavailable' | 'invalid_response' | 'invalid_input',
    message: string,
  ) {
    super(message);
  }
}

export interface ControlApiV2BrowserFetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type ControlApiV2BrowserFetch = (
  path: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<ControlApiV2BrowserFetchResponse>;

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function omitHash(
  value: Readonly<Record<string, unknown>>,
  keyToOmit: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== keyToOmit),
  );
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ControlApiV2BrowserError(
      'invalid_response',
      `${label} must be an object`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ControlApiV2BrowserError(
      'invalid_response',
      `${label} must use the exact closed schema`,
    );
  }
}

function isEngineRefusalReason(value: unknown): boolean {
  return (ENGINE_REFUSAL_REASONS as readonly unknown[]).includes(value);
}

function isRefusalCarrierReason(value: unknown): boolean {
  return (REFUSAL_CARRIER_REASONS as readonly unknown[]).includes(value);
}

/**
 * `'sha256:'` + lowercase hex of SHA-256 over
 * `utf8(canonicalSerialize(canonicalClone(value)))`.
 * Throws `ControlApiV2BrowserError('webcrypto_unavailable')` when
 * `globalThis.crypto?.subtle?.digest` is not a function; rethrows
 * `CanonicalJsonError` as `ControlApiV2BrowserError('invalid_input')`.
 */
export async function browserHashCanonicalJson(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (typeof subtle?.digest !== 'function') {
    throw new ControlApiV2BrowserError(
      'webcrypto_unavailable',
      'WebCrypto subtle.digest is unavailable',
    );
  }
  let bytes: ArrayBuffer;
  try {
    // Copy into a fresh ArrayBuffer so the BufferSource type is exact (DOM lib).
    const encoded = new TextEncoder().encode(
      canonicalSerialize(canonicalClone(value)),
    );
    bytes = encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer;
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new ControlApiV2BrowserError('invalid_input', error.message);
    }
    throw error;
  }
  const digest = await subtle.digest('SHA-256', bytes);
  return `sha256:${hex(digest)}`;
}

export async function buildIdempotencyKeyBrowser(input: {
  readonly actorIssuer: string;
  readonly actorId: string;
  readonly aggregateId: string;
  readonly clientRequestId: string;
}): Promise<IdempotencyKeyV2> {
  const withoutHash: Omit<IdempotencyKeyV2, 'keyHash'> = {
    actorIssuer: input.actorIssuer,
    actorId: input.actorId,
    aggregateId: input.aggregateId,
    clientRequestId: input.clientRequestId,
  };
  return {
    ...withoutHash,
    keyHash: await browserHashCanonicalJson(withoutHash),
  };
}

export async function buildConcurrencyTokenBrowser(input: {
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly projectionHash: string;
}): Promise<ConcurrencyTokenV2> {
  const withoutHash: Omit<ConcurrencyTokenV2, 'tokenHash'> = {
    aggregateId: input.aggregateId,
    stateVersion: input.stateVersion,
    projectionHash: input.projectionHash,
  };
  return {
    ...withoutHash,
    tokenHash: await browserHashCanonicalJson(withoutHash),
  };
}

/**
 * Same field set and hashing order as the domain `buildControlApiV2Request`:
 * `payloadHash` over the payload, then `requestHash` over
 * `{schema,resource,operation,aggregateId,idempotencyKey,concurrencyToken,payload,payloadHash,issuedAt}`.
 */
export async function buildControlApiV2RequestBrowser(input: {
  readonly resource: ControlApiV2Resource;
  readonly operation: ControlApiV2Operation;
  readonly aggregateId: string;
  readonly idempotencyKey: null | IdempotencyKeyV2;
  readonly concurrencyToken: null | ConcurrencyTokenV2;
  readonly payload: ControlApiV2PayloadV1;
  readonly issuedAt: string;
}): Promise<ControlApiV2RequestV1> {
  const payloadHash = await browserHashCanonicalJson(input.payload);
  const withoutHash: Omit<ControlApiV2RequestV1, 'requestHash'> = {
    schema: 'hercules-control-api-request/v2',
    resource: input.resource,
    operation: input.operation,
    aggregateId: input.aggregateId,
    idempotencyKey: input.idempotencyKey,
    concurrencyToken: input.concurrencyToken,
    payload: input.payload,
    payloadHash,
    issuedAt: input.issuedAt,
  };
  return {
    ...withoutHash,
    requestHash: await browserHashCanonicalJson(withoutHash),
  };
}

export interface ControlApiV2ReviewViewBrowserV1 {
  readonly schema: 'hercules-control-api-review-view/v2';
  readonly aggregateId: string;
  readonly stateVersion: number;
  readonly reviewPackage: ReviewPackageV2Dto;
  readonly viewHash: string;
}

export type ControlApiV2BrowserResponseV1 =
  | ControlApiV2ReceiptV1
  | ControlApiV2RefusalV1
  | ControlApiV2ReviewViewBrowserV1
  | ControlApiV2StatusViewV1
  | EventPageV1;

async function verifyHash(
  raw: Readonly<Record<string, unknown>>,
  hashKey: string,
  label: string,
): Promise<void> {
  const claimed = raw[hashKey];
  if (typeof claimed !== 'string') {
    throw new ControlApiV2BrowserError(
      'invalid_response',
      `${label} ${hashKey} must be a string`,
    );
  }
  let expected: string;
  try {
    expected = await browserHashCanonicalJson(omitHash(raw, hashKey));
  } catch (error) {
    if (error instanceof ControlApiV2BrowserError) {
      if (error.code === 'invalid_input' || error.code === 'webcrypto_unavailable') {
        throw new ControlApiV2BrowserError(
          'invalid_response',
          `${label} hash verification failed: ${error.message}`,
        );
      }
    }
    throw error;
  }
  if (claimed !== expected) {
    throw new ControlApiV2BrowserError(
      'invalid_response',
      `${label} hash does not match the exact record`,
    );
  }
}

/**
 * Structural exact-key validation (wire `*_KEYS` lists; reject extra/missing
 * keys, wrong schema, non-object) AND hash verification: recompute
 * `receiptHash` / `refusalHash` / `viewHash` (review + status) / `pageHash`
 * over the raw record with the hash field omitted and compare byte-for-byte;
 * for the review view, hash over the RAW `reviewPackage` JSON as received
 * (not the decoded DTO), then decode the package. Any mismatch →
 * `ControlApiV2BrowserError('invalid_response')`. Reason strings must be
 * members of the wire reason arrays.
 */
export async function parseControlApiV2ResponseBrowser(
  raw: unknown,
): Promise<ControlApiV2BrowserResponseV1> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ControlApiV2BrowserError(
      'invalid_response',
      'control api v2 response must be an object',
    );
  }
  const record = raw as Readonly<Record<string, unknown>>;
  const schema = record['schema'];

  if (schema === 'hercules-control-api-receipt/v2') {
    assertExactKeys(raw, CONTROL_API_V2_RECEIPT_V1_KEYS, 'control api v2 receipt');
    const reason = record['reason'];
    if (reason !== null && !isEngineRefusalReason(reason)) {
      throw new ControlApiV2BrowserError(
        'invalid_response',
        'control api v2 receipt reason is unrecognized',
      );
    }
    await verifyHash(record, 'receiptHash', 'control api v2 receipt');
    return raw as unknown as ControlApiV2ReceiptV1;
  }

  if (schema === 'hercules-control-api-refusal/v2') {
    assertExactKeys(raw, CONTROL_API_V2_REFUSAL_V1_KEYS, 'control api v2 refusal');
    if (!isRefusalCarrierReason(record['reason'])) {
      throw new ControlApiV2BrowserError(
        'invalid_response',
        'control api v2 refusal reason is unrecognized',
      );
    }
    await verifyHash(record, 'refusalHash', 'control api v2 refusal');
    return raw as unknown as ControlApiV2RefusalV1;
  }

  if (schema === 'hercules-control-api-review-view/v2') {
    assertExactKeys(
      raw,
      CONTROL_API_V2_REVIEW_VIEW_V1_KEYS,
      'control api v2 review view',
    );
    // Hash over the RAW reviewPackage JSON as received, then decode.
    await verifyHash(record, 'viewHash', 'control api v2 review view');
    let reviewPackage: ReviewPackageV2Dto;
    try {
      reviewPackage = decodeReviewPackageV2(record['reviewPackage']);
      await assertReviewPackageProjectionIntegrity(reviewPackage);
    } catch (error) {
      if (
        error instanceof ReviewDtoDecodeError ||
        error instanceof ControlApiV2BrowserError
      ) {
        throw new ControlApiV2BrowserError(
          'invalid_response',
          `control api v2 review package is invalid: ${error.message}`,
        );
      }
      throw error;
    }
    const aggregateId = record['aggregateId'];
    const stateVersion = record['stateVersion'];
    const viewHash = record['viewHash'];
    if (
      typeof aggregateId !== 'string' ||
      typeof viewHash !== 'string' ||
      typeof stateVersion !== 'number' ||
      !Number.isSafeInteger(stateVersion) ||
      stateVersion < 0
    ) {
      throw new ControlApiV2BrowserError(
        'invalid_response',
        'control api v2 review view scalars are invalid',
      );
    }
    return {
      schema: 'hercules-control-api-review-view/v2',
      aggregateId,
      stateVersion,
      reviewPackage,
      viewHash,
    };
  }

  if (schema === 'hercules-control-api-status-view/v2') {
    assertExactKeys(
      raw,
      CONTROL_API_V2_STATUS_VIEW_V1_KEYS,
      'control api v2 status view',
    );
    await verifyHash(record, 'viewHash', 'control api v2 status view');
    if (
      typeof record['aggregateId'] !== 'string' ||
      typeof record['taskStatus'] !== 'string' ||
      typeof record['viewHash'] !== 'string' ||
      !Number.isSafeInteger(record['stateVersion']) ||
      (record['stateVersion'] as number) < 0 ||
      !Number.isSafeInteger(record['latestEventSequence']) ||
      (record['latestEventSequence'] as number) < 0
    ) {
      throw new ControlApiV2BrowserError(
        'invalid_response',
        'control api v2 status view scalars are invalid',
      );
    }
    return raw as unknown as ControlApiV2StatusViewV1;
  }

  if (schema === 'hercules-control-api-event-page/v2') {
    assertExactKeys(raw, EVENT_PAGE_V1_KEYS, 'event page');
    await verifyHash(record, 'pageHash', 'event page');
    return raw as unknown as EventPageV1;
  }

  throw new ControlApiV2BrowserError(
    'invalid_response',
    'control api v2 response schema is unrecognized',
  );
}

export interface ControlApiV2BrowserResult {
  readonly status: number;
  readonly body: ControlApiV2BrowserResponseV1;
}

/** Append the event cursor as query params (a GET read carries no body). */
function eventPath(basePath: string, cursor: EventCursorRequestV1): string {
  const params = new URLSearchParams();
  params.set('afterSequence', String(cursor.afterSequence));
  params.set('limit', String(cursor.limit));
  // Omit the param when null (the server maps an absent/empty value to null);
  // sending a literal 'null' would be read as a hash string.
  if (cursor.expectedPreviousEventHash !== null) {
    params.set('expectedPreviousEventHash', cursor.expectedPreviousEventHash);
  }
  return `${basePath}?${params.toString()}`;
}

export function createControlApiV2BrowserClient(options: {
  readonly base?: string;
  readonly token: string;
  readonly fetch: ControlApiV2BrowserFetch;
}) {
  const base = options.base ?? '';
  const authHeaders: Readonly<Record<string, string>> = {
    authorization: `Bearer ${options.token}`,
  };

  async function send(
    request: ControlApiV2RequestV1,
    callOptions?: { readonly signal?: AbortSignal },
  ): Promise<ControlApiV2BrowserResult> {
    const route = controlApiV2HttpRoute(request.resource, request.aggregateId);
    let path = base + route.path;
    let init: Parameters<ControlApiV2BrowserFetch>[1];
    if (route.method === 'POST') {
      init = {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      };
    } else {
      if (request.resource === 'event') {
        path = eventPath(base + route.path, request.payload as EventCursorRequestV1);
      }
      init = { method: 'GET', headers: { ...authHeaders } };
    }
    if (callOptions?.signal !== undefined) {
      init = { ...init, signal: callOptions.signal };
    }
    const response = await options.fetch(path, init);
    const raw = await response.json();
    return {
      status: response.status,
      body: await parseControlApiV2ResponseBrowser(raw),
    };
  }

  async function prepareCreate(input: {
    actorIssuer: string;
    actorId: string;
    clientRequestId: string;
    payload: CreatePayloadV1;
    issuedAt: string;
  }): Promise<ControlApiV2RequestV1> {
    return buildControlApiV2RequestBrowser({
      resource: 'task',
      operation: 'create',
      aggregateId: '',
      idempotencyKey: await buildIdempotencyKeyBrowser({
        actorIssuer: input.actorIssuer,
        actorId: input.actorId,
        aggregateId: '',
        clientRequestId: input.clientRequestId,
      }),
      concurrencyToken: null,
      payload: input.payload,
      issuedAt: input.issuedAt,
    });
  }

  async function prepareDecision(input: {
    aggregateId: string;
    stateVersion: number;
    projectionHash: string;
    actorIssuer: string;
    actorId: string;
    clientRequestId: string;
    payload: DecisionPayloadV1;
    issuedAt: string;
  }): Promise<ControlApiV2RequestV1> {
    return buildControlApiV2RequestBrowser({
      resource: 'decision',
      operation: 'submit',
      aggregateId: input.aggregateId,
      idempotencyKey: await buildIdempotencyKeyBrowser({
        actorIssuer: input.actorIssuer,
        actorId: input.actorId,
        aggregateId: input.aggregateId,
        clientRequestId: input.clientRequestId,
      }),
      concurrencyToken: await buildConcurrencyTokenBrowser({
        aggregateId: input.aggregateId,
        stateVersion: input.stateVersion,
        projectionHash: input.projectionHash,
      }),
      payload: input.payload,
      issuedAt: input.issuedAt,
    });
  }

  return {
    /** Send an already-built request verbatim (retry MUST reuse the same object). */
    execute: send,
    prepareCreate,
    prepareDecision,
    async createTask(
      input: Parameters<typeof prepareCreate>[0],
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<ControlApiV2BrowserResult> {
      return send(await prepareCreate(input), callOptions);
    },
    async submitDecision(
      input: Parameters<typeof prepareDecision>[0],
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<ControlApiV2BrowserResult> {
      return send(await prepareDecision(input), callOptions);
    },
    async readStatus(
      input: { aggregateId: string; issuedAt: string },
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<ControlApiV2BrowserResult> {
      return send(
        await buildControlApiV2RequestBrowser({
          resource: 'status',
          operation: 'read',
          aggregateId: input.aggregateId,
          idempotencyKey: null,
          concurrencyToken: null,
          payload: { kind: 'read' },
          issuedAt: input.issuedAt,
        }),
        callOptions,
      );
    },
    async readReview(
      input: { aggregateId: string; issuedAt: string },
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<ControlApiV2BrowserResult> {
      return send(
        await buildControlApiV2RequestBrowser({
          resource: 'review',
          operation: 'read',
          aggregateId: input.aggregateId,
          idempotencyKey: null,
          concurrencyToken: null,
          payload: { kind: 'read' },
          issuedAt: input.issuedAt,
        }),
        callOptions,
      );
    },
    async readEvents(
      input: { cursor: EventCursorRequestV1; issuedAt: string },
      callOptions?: { readonly signal?: AbortSignal },
    ): Promise<ControlApiV2BrowserResult> {
      return send(
        await buildControlApiV2RequestBrowser({
          resource: 'event',
          operation: 'read',
          aggregateId: '',
          idempotencyKey: null,
          concurrencyToken: null,
          payload: input.cursor,
          issuedAt: input.issuedAt,
        }),
        callOptions,
      );
    },
    /** Build an event cursor (`cursorHash` over schema/afterSequence/expectedPreviousEventHash/limit). */
    async buildEventCursor(input: {
      afterSequence: number;
      expectedPreviousEventHash: string | null;
      limit: number;
    }): Promise<EventCursorRequestV1> {
      const withoutHash: Omit<EventCursorRequestV1, 'cursorHash'> = {
        schema: 'hercules-control-api-event-cursor/v2',
        afterSequence: input.afterSequence,
        expectedPreviousEventHash: input.expectedPreviousEventHash,
        limit: input.limit,
      };
      return {
        ...withoutHash,
        cursorHash: await browserHashCanonicalJson(withoutHash),
      };
    },
  };
}

export type ControlApiV2BrowserClient = ReturnType<
  typeof createControlApiV2BrowserClient
>;
