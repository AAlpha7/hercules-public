/**
 * @vitest-environment jsdom
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hashCanonicalJson,
  canonicalSerialize,
} from '../../src/domain/canonicalJson.js';
import {
  buildControlApiV2Request,
  buildIdempotencyKey,
  buildConcurrencyToken,
  computeReceiptHash,
  computeRefusalHash,
  computeStatusViewHash,
  computeEventPageHash,
  computeReviewViewHash,
  type ControlApiV2ReceiptV1,
  type ControlApiV2RefusalV1,
  type ControlApiV2StatusViewV1,
  type ControlApiV2ReviewViewV1,
  type EventPageV1,
} from '../../src/domain/controlApiV2.js';
import { projectAndAssertReviewPackageV2 } from '../../src/domain/reviewPackageV2.js';
import { buildEligibleControlApiV2ReviewSource } from '../../src/isolation/controlApiV2ReviewSeed.js';
import {
  ControlApiV2BrowserError,
  browserHashCanonicalJson,
  buildControlApiV2RequestBrowser,
  parseControlApiV2ResponseBrowser,
} from '../../src/web/controlApiV2Client.js';

const NOW = '2026-09-01T00:00:00.000Z';
const HASH_A =
  'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B =
  'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

beforeEach(() => {
  // jsdom may lack crypto.subtle — stub IN THE TEST ONLY (client never touches Node).
  if (typeof globalThis.crypto?.subtle?.digest !== 'function') {
    vi.stubGlobal('crypto', webcrypto);
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('browserHashCanonicalJson', () => {
  it('matches domain hashCanonicalJson for a nested fixture', async () => {
    const fixture = {
      schema: 'fixture',
      nested: { a: 1, b: [true, null, 'x'] },
      z: 'tail',
    };
    expect(await browserHashCanonicalJson(fixture)).toBe(hashCanonicalJson(fixture));
  });

  it('rejects sparse array / NaN / cyclic object with invalid_input', async () => {
    const sparse: unknown[] = [];
    sparse[1] = 'gap';
    await expect(browserHashCanonicalJson(sparse)).rejects.toMatchObject({
      name: 'ControlApiV2BrowserError',
      code: 'invalid_input',
    });
    await expect(browserHashCanonicalJson({ n: Number.NaN })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    await expect(browserHashCanonicalJson(cyclic)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('throws webcrypto_unavailable when crypto.subtle.digest is missing', async () => {
    vi.stubGlobal('crypto', {});
    await expect(browserHashCanonicalJson({ ok: true })).rejects.toMatchObject({
      name: 'ControlApiV2BrowserError',
      code: 'webcrypto_unavailable',
    });
  });
});

describe('buildControlApiV2RequestBrowser', () => {
  it('is canonicalSerialize-byte-equal to domain buildControlApiV2Request for create', async () => {
    const payload = {
      kind: 'create' as const,
      taskContractHash: HASH_A,
      intentDigest: HASH_B,
    };
    const domain = buildControlApiV2Request({
      resource: 'task',
      operation: 'create',
      aggregateId: '',
      idempotencyKey: buildIdempotencyKey({
        actorIssuer: 'issuer',
        actorId: 'actor-1',
        aggregateId: '',
        clientRequestId: 'req-create',
      }),
      concurrencyToken: null,
      payload,
      issuedAt: NOW,
    });
    const browser = await buildControlApiV2RequestBrowser({
      resource: 'task',
      operation: 'create',
      aggregateId: '',
      idempotencyKey: buildIdempotencyKey({
        actorIssuer: 'issuer',
        actorId: 'actor-1',
        aggregateId: '',
        clientRequestId: 'req-create',
      }),
      concurrencyToken: null,
      payload,
      issuedAt: NOW,
    });
    expect(canonicalSerialize(browser)).toBe(canonicalSerialize(domain));
  });

  it('is canonicalSerialize-byte-equal to domain buildControlApiV2Request for decision', async () => {
    const payload = {
      kind: 'decision' as const,
      action: 'approve_outcome' as const,
      reason: 'ok',
      acknowledgedRiskCodes: [] as const,
    };
    const domain = buildControlApiV2Request({
      resource: 'decision',
      operation: 'submit',
      aggregateId: 'task-x',
      idempotencyKey: buildIdempotencyKey({
        actorIssuer: 'issuer',
        actorId: 'actor-1',
        aggregateId: 'task-x',
        clientRequestId: 'req-decision',
      }),
      concurrencyToken: buildConcurrencyToken({
        aggregateId: 'task-x',
        stateVersion: 1,
        projectionHash: HASH_A,
      }),
      payload,
      issuedAt: NOW,
    });
    const browser = await buildControlApiV2RequestBrowser({
      resource: 'decision',
      operation: 'submit',
      aggregateId: 'task-x',
      idempotencyKey: buildIdempotencyKey({
        actorIssuer: 'issuer',
        actorId: 'actor-1',
        aggregateId: 'task-x',
        clientRequestId: 'req-decision',
      }),
      concurrencyToken: buildConcurrencyToken({
        aggregateId: 'task-x',
        stateVersion: 1,
        projectionHash: HASH_A,
      }),
      payload,
      issuedAt: NOW,
    });
    expect(canonicalSerialize(browser)).toBe(canonicalSerialize(domain));
  });
});

describe('parseControlApiV2ResponseBrowser', () => {
  function committedReceipt(): ControlApiV2ReceiptV1 {
    const withoutHash: Omit<ControlApiV2ReceiptV1, 'receiptHash'> = {
      schema: 'hercules-control-api-receipt/v2',
      outcome: 'committed',
      resource: 'task',
      aggregateId: 'task-1',
      keyHash: HASH_A,
      requestHash: HASH_B,
      stateVersion: 1,
      eventSequence: 1,
      reason: null,
      decidedAt: NOW,
    };
    return { ...withoutHash, receiptHash: computeReceiptHash(withoutHash) };
  }

  function refusal(): ControlApiV2RefusalV1 {
    const withoutHash: Omit<ControlApiV2RefusalV1, 'refusalHash'> = {
      schema: 'hercules-control-api-refusal/v2',
      resource: 'task',
      aggregateId: 'task-1',
      requestHash: HASH_B,
      reason: 'unknown_aggregate',
      decidedAt: NOW,
    };
    return { ...withoutHash, refusalHash: computeRefusalHash(withoutHash) };
  }

  function statusView(): ControlApiV2StatusViewV1 {
    const withoutHash: Omit<ControlApiV2StatusViewV1, 'viewHash'> = {
      schema: 'hercules-control-api-status-view/v2',
      aggregateId: 'task-1',
      stateVersion: 1,
      taskStatus: 'review',
      latestEventSequence: 2,
    };
    return { ...withoutHash, viewHash: computeStatusViewHash(withoutHash) };
  }

  function eventPage(): EventPageV1 {
    const withoutHash: Omit<EventPageV1, 'pageHash'> = {
      schema: 'hercules-control-api-event-page/v2',
      afterSequence: 0,
      events: [],
      nextAfterSequence: 0,
      endOfStream: true,
    };
    return { ...withoutHash, pageHash: computeEventPageHash(withoutHash) };
  }

  function reviewView(): ControlApiV2ReviewViewV1 {
    const reviewPackage = projectAndAssertReviewPackageV2(
      buildEligibleControlApiV2ReviewSource('task-1'),
    );
    const withoutHash: Omit<ControlApiV2ReviewViewV1, 'viewHash'> = {
      schema: 'hercules-control-api-review-view/v2',
      aggregateId: 'task-1',
      stateVersion: 1,
      reviewPackage,
    };
    return { ...withoutHash, viewHash: computeReviewViewHash(withoutHash) };
  }

  it('accepts domain-built receipt / refusal / status / event page / review view', async () => {
    await expect(parseControlApiV2ResponseBrowser(committedReceipt())).resolves.toMatchObject({
      schema: 'hercules-control-api-receipt/v2',
      receiptHash: committedReceipt().receiptHash,
    });
    await expect(parseControlApiV2ResponseBrowser(refusal())).resolves.toMatchObject({
      schema: 'hercules-control-api-refusal/v2',
    });
    await expect(parseControlApiV2ResponseBrowser(statusView())).resolves.toMatchObject({
      schema: 'hercules-control-api-status-view/v2',
    });
    await expect(parseControlApiV2ResponseBrowser(eventPage())).resolves.toMatchObject({
      schema: 'hercules-control-api-event-page/v2',
    });
    const view = reviewView();
    const parsed = await parseControlApiV2ResponseBrowser(
      JSON.parse(JSON.stringify(view)) as unknown,
    );
    expect(parsed.schema).toBe('hercules-control-api-review-view/v2');
    if (parsed.schema === 'hercules-control-api-review-view/v2') {
      expect(parsed.viewHash).toBe(view.viewHash);
      expect(parsed.reviewPackage.projectionHash).toBe(view.reviewPackage.projectionHash);
    }
  });

  it('rejects a self-consistently hashed review view whose scalars are malformed', async () => {
    const view = reviewView();
    const malformed = { ...view, stateVersion: '1' as unknown as number };
    const { viewHash: _omit, ...withoutHash } = malformed;
    const rehashed = { ...withoutHash, viewHash: computeReviewViewHash(withoutHash) };
    await expect(
      parseControlApiV2ResponseBrowser(JSON.parse(JSON.stringify(rehashed)) as unknown),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    const status = statusView();
    const negativeStatus = { ...status, stateVersion: -1 };
    const { viewHash: _omit3, ...negativeWithout } = negativeStatus;
    await expect(
      parseControlApiV2ResponseBrowser({
        ...negativeWithout,
        viewHash: computeStatusViewHash(negativeWithout),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
    const malformedStatus = { ...status, latestEventSequence: 1.5 };
    const { viewHash: _omit2, ...statusWithout } = malformedStatus;
    await expect(
      parseControlApiV2ResponseBrowser({
        ...statusWithout,
        viewHash: computeStatusViewHash(statusWithout),
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects extra key, missing key, tampered hash, unknown reason, non-object', async () => {
    const receipt = committedReceipt();
    await expect(
      parseControlApiV2ResponseBrowser({ ...receipt, extra: true }),
    ).rejects.toBeInstanceOf(ControlApiV2BrowserError);

    const { decidedAt: _omit, ...missing } = receipt;
    await expect(parseControlApiV2ResponseBrowser(missing)).rejects.toMatchObject({
      code: 'invalid_response',
    });

    await expect(
      parseControlApiV2ResponseBrowser({
        ...receipt,
        receiptHash:
          'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });

    await expect(
      parseControlApiV2ResponseBrowser({
        ...refusal(),
        reason: 'not_a_real_reason',
      }),
    ).rejects.toMatchObject({ code: 'invalid_response' });

    await expect(parseControlApiV2ResponseBrowser(null)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    await expect(parseControlApiV2ResponseBrowser('nope')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
