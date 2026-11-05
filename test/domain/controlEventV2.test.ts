import { describe, expect, it } from 'vitest';
import {
  assertControlEvent,
  assertControlEventMetadata,
  buildControlEvent,
  ControlEventError,
} from '../../src/domain/controlEvent.js';

function eventInput() {
  return {
    sequence: 1,
    eventId: 'event-1',
    eventType: 'ShadowContractRootProjected' as const,
    aggregateKind: 'task' as const,
    aggregateId: 'task-1',
    actor: { kind: 'control_plane' as const, id: 'shadow-projector' },
    occurredAt: '2026-08-28T00:00:00Z',
    payload: { contract: { taskId: 'task-1', version: 1 }, mutationKind: 'insert_contract_root' },
    previousEventHash: null,
  };
}

describe('V2 control events', () => {
  it('builds a deterministic hash over every event field and validates it', () => {
    const first = buildControlEvent(eventInput());
    const second = buildControlEvent(eventInput());

    expect(first).toEqual(second);
    expect(first.eventHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => assertControlEvent(first)).not.toThrow();

    for (const changed of [
      { ...eventInput(), sequence: 2 },
      { ...eventInput(), eventId: 'event-2' },
      { ...eventInput(), aggregateId: 'task-2' },
      { ...eventInput(), occurredAt: '2026-08-28T00:00:01Z' },
      { ...eventInput(), payload: { changed: true } },
      { ...eventInput(), previousEventHash: `sha256:${'a'.repeat(64)}` },
    ]) {
      expect(buildControlEvent(changed).eventHash).not.toBe(first.eventHash);
    }
  });

  it('rejects a forged hash, unknown fields, and invalid closed values', () => {
    const valid = buildControlEvent(eventInput());
    expect(() => assertControlEvent({ ...valid, eventHash: `sha256:${'f'.repeat(64)}` }))
      .toThrow('hash does not match');
    expect(() => assertControlEvent({ ...valid, extra: true })).toThrow('exact schema');
    expect(() => buildControlEvent({ ...eventInput(), sequence: 0 })).toThrow(ControlEventError);
    expect(() => buildControlEvent({
      ...eventInput(),
      eventType: 'Unknown' as typeof eventInput extends never ? never : 'ShadowContractRootProjected',
    })).toThrow('event type');
  });

  it('fails closed for accessors, class instances, sparse arrays, and non-finite values', () => {
    const withAccessor = { ...eventInput() } as Record<string, unknown>;
    Object.defineProperty(withAccessor, 'payload', { enumerable: true, get: () => ({}) });
    class Payload { readonly value = 1; }
    const sparse: unknown[] = [];
    sparse.length = 1;

    for (const input of [
      withAccessor,
      { ...eventInput(), payload: new Payload() },
      { ...eventInput(), payload: sparse },
      { ...eventInput(), payload: { amount: Number.POSITIVE_INFINITY } },
    ]) {
      expect(() => buildControlEvent(input as ReturnType<typeof eventInput>)).toThrow();
    }
  });

  it('requires exact bounded metadata and actor fields', () => {
    const metadata = {
      eventId: 'event-1',
      actor: { kind: 'control_plane', id: 'shadow-projector' },
      occurredAt: '2026-08-28T00:00:00Z',
    } as const;
    expect(() => assertControlEventMetadata(metadata)).not.toThrow();
    expect(() => assertControlEventMetadata({ ...metadata, extra: true })).toThrow('exact public schema');
    expect(() => assertControlEventMetadata({ ...metadata, eventId: 'x'.repeat(513) }))
      .toThrow('bounded');
    expect(() => assertControlEventMetadata({
      ...metadata,
      actor: { kind: 'unknown', id: 'actor' },
    })).toThrow('actor');
  });
});

describe('M5 private control events', () => {
  it.each([
    ['ArtifactCaptureAuthorized', 'artifact_authorization'],
    ['ArtifactMetadataRecorded', 'artifact_ref'],
    ['EvidenceManifestRecorded', 'evidence_manifest'],
    ['ArtifactMetadataRetired', 'artifact_ref'],
  ] as const)('builds a sealed %s event', (eventType, aggregateKind) => {
    const event = buildControlEvent({
      sequence: 1,
      eventId: `event-${eventType}`,
      eventType,
      aggregateKind,
      aggregateId: 'aggregate-1',
      actor: { kind: 'control_plane', id: 'artifact-archive' },
      occurredAt: '2026-08-28T00:00:00.000Z',
      payload: { mutationKind: eventType },
      previousEventHash: null,
    });
    expect(event.eventHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
