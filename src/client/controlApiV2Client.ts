/**
 * M11 Control API V2 — Node CLI/test client.
 *
 * A thin transport over the SHARED pure contract in `src/domain/controlApiV2.ts`
 * (`buildControlApiV2Request` / `parseControlApiV2Response` / the
 * `controlApiV2HttpRoute` path mapping). It never imports the SQLite state store
 * or `src/controlapi/`. GET reads carry NO body (the request is built server-side
 * from the path / query); only POST create/decision send a JSON body. The `fetch`
 * seam is injected so tests can point it at the in-process Hono app.
 */

import {
  buildConcurrencyToken,
  buildControlApiV2Request,
  buildIdempotencyKey,
  controlApiV2HttpRoute,
  parseControlApiV2Response,
  type ControlApiV2RequestV1,
  type ControlApiV2ResponseV1,
  type CreatePayloadV1,
  type DecisionPayloadV1,
  type EventCursorRequestV1,
} from '../domain/controlApiV2.js';

export interface ControlApiV2FetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type ControlApiV2Fetch = (
  path: string,
  init: {
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
) => Promise<ControlApiV2FetchResponse>;

export interface ControlApiV2ClientResult {
  readonly status: number;
  readonly body: ControlApiV2ResponseV1;
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

export function createControlApiV2Client(options: {
  readonly base?: string;
  readonly token: string;
  readonly fetch: ControlApiV2Fetch;
}) {
  const base = options.base ?? '';
  const authHeaders: Readonly<Record<string, string>> = {
    authorization: `Bearer ${options.token}`,
  };

  async function send(
    request: ControlApiV2RequestV1,
  ): Promise<ControlApiV2ClientResult> {
    const route = controlApiV2HttpRoute(request.resource, request.aggregateId);
    let path = base + route.path;
    let init: Parameters<ControlApiV2Fetch>[1];
    if (route.method === 'POST') {
      // Mutations carry the client-built request as a JSON body.
      init = {
        method: 'POST',
        headers: { ...authHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      };
    } else {
      // GET reads carry NO body; the event cursor rides the query string.
      if (request.resource === 'event') {
        path = eventPath(base + route.path, request.payload as EventCursorRequestV1);
      }
      init = { method: 'GET', headers: { ...authHeaders } };
    }
    const response = await options.fetch(path, init);
    const raw = await response.json();
    return { status: response.status, body: parseControlApiV2Response(raw) };
  }

  return {
    execute: send,
    async createTask(input: {
      readonly actorIssuer: string;
      readonly actorId: string;
      readonly clientRequestId: string;
      readonly payload: CreatePayloadV1;
      readonly issuedAt: string;
    }): Promise<ControlApiV2ClientResult> {
      return send(
        buildControlApiV2Request({
          resource: 'task',
          operation: 'create',
          aggregateId: '',
          idempotencyKey: buildIdempotencyKey({
            actorIssuer: input.actorIssuer,
            actorId: input.actorId,
            aggregateId: '',
            clientRequestId: input.clientRequestId,
          }),
          concurrencyToken: null,
          payload: input.payload,
          issuedAt: input.issuedAt,
        }),
      );
    },
    async readStatus(input: {
      readonly aggregateId: string;
      readonly issuedAt: string;
    }): Promise<ControlApiV2ClientResult> {
      return send(
        buildControlApiV2Request({
          resource: 'status',
          operation: 'read',
          aggregateId: input.aggregateId,
          idempotencyKey: null,
          concurrencyToken: null,
          payload: { kind: 'read' },
          issuedAt: input.issuedAt,
        }),
      );
    },
    async readReview(input: {
      readonly aggregateId: string;
      readonly issuedAt: string;
    }): Promise<ControlApiV2ClientResult> {
      return send(
        buildControlApiV2Request({
          resource: 'review',
          operation: 'read',
          aggregateId: input.aggregateId,
          idempotencyKey: null,
          concurrencyToken: null,
          payload: { kind: 'read' },
          issuedAt: input.issuedAt,
        }),
      );
    },
    async submitDecision(input: {
      readonly aggregateId: string;
      readonly stateVersion: number;
      readonly projectionHash: string;
      readonly actorIssuer: string;
      readonly actorId: string;
      readonly clientRequestId: string;
      readonly payload: DecisionPayloadV1;
      readonly issuedAt: string;
    }): Promise<ControlApiV2ClientResult> {
      return send(
        buildControlApiV2Request({
          resource: 'decision',
          operation: 'submit',
          aggregateId: input.aggregateId,
          idempotencyKey: buildIdempotencyKey({
            actorIssuer: input.actorIssuer,
            actorId: input.actorId,
            aggregateId: input.aggregateId,
            clientRequestId: input.clientRequestId,
          }),
          concurrencyToken: buildConcurrencyToken({
            aggregateId: input.aggregateId,
            stateVersion: input.stateVersion,
            projectionHash: input.projectionHash,
          }),
          payload: input.payload,
          issuedAt: input.issuedAt,
        }),
      );
    },
    async readEvents(input: {
      readonly cursor: EventCursorRequestV1;
      readonly issuedAt: string;
    }): Promise<ControlApiV2ClientResult> {
      return send(
        buildControlApiV2Request({
          resource: 'event',
          operation: 'read',
          aggregateId: '',
          idempotencyKey: null,
          concurrencyToken: null,
          payload: input.cursor,
          issuedAt: input.issuedAt,
        }),
      );
    },
  };
}

export type ControlApiV2Client = ReturnType<typeof createControlApiV2Client>;
