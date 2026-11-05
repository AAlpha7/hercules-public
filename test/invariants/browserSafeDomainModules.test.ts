/**
 * C4 wire extract — browser-safe domain modules must stay node-free and
 * reachable through the existing controlApiV2 / canonicalJson re-export paths.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const DOMAIN = join(ROOT, 'src/domain');

const BROWSER_SAFE_MODULES = [
  'canonicalSerialize.ts',
  'controlApiV2Wire.ts',
] as const;

const FORBIDDEN_SUBSTRINGS = [
  'node:',
  'Buffer',
  'createHash',
  'process.',
  'require(',
  'import(',
] as const;

const ALLOWED_SPECIFIERS = new Set([
  './canonicalSerialize.js',
  './controlApiV2Wire.js',
]);

/** Runtime (value) symbols moved into controlApiV2Wire.ts. */
const MOVED_VALUE_SYMBOLS = [
  'ADMISSION_LEDGER_ENTRY_V1_KEYS',
  'ADMISSION_VERDICT_V1_KEYS',
  'CONCURRENCY_TOKEN_V2_KEYS',
  'CONTROL_API_V2_OPERATIONS',
  'CONTROL_API_V2_RECEIPT_OUTCOMES',
  'CONTROL_API_V2_RECEIPT_V1_KEYS',
  'CONTROL_API_V2_REFUSAL_V1_KEYS',
  'CONTROL_API_V2_REQUEST_V1_KEYS',
  'CONTROL_API_V2_RESOURCES',
  'CONTROL_API_V2_REVIEW_VIEW_V1_KEYS',
  'CONTROL_API_V2_STATUS_VIEW_V1_KEYS',
  'CONTROL_EVENT_VIEW_KEYS',
  'CREATE_PAYLOAD_V1_KEYS',
  'ControlApiV2Error',
  'DECISION_PAYLOAD_V1_KEYS',
  'ENGINE_REFUSAL_REASONS',
  'EVENT_CURSOR_REQUEST_V1_KEYS',
  'EVENT_PAGE_V1_KEYS',
  'IDEMPOTENCY_KEY_V2_KEYS',
  'M6_OUTCOME_DECISIONS',
  'MAX_EVENT_PAGE',
  'READ_PAYLOAD_V1_KEYS',
  'RECEIPT_REFUSAL_REASONS',
  'REFUSAL_CARRIER_REASONS',
  'ROUTE_REFUSAL_REASONS',
  'controlApiV2EventQuery',
  'controlApiV2HttpRoute',
  'controlApiV2HttpStatusForReason',
] as const;

/** Type-only symbols moved into controlApiV2Wire.ts. */
const MOVED_TYPE_SYMBOLS = [
  'AdmissionLedgerEntryV1',
  'AdmissionVerdictV1',
  'ConcurrencyTokenV2',
  'ControlApiV2DecisionActionV1',
  'ControlApiV2ErrorCode',
  'ControlApiV2HttpRouteV1',
  'ControlApiV2Operation',
  'ControlApiV2PayloadV1',
  'ControlApiV2ReceiptOutcomeV1',
  'ControlApiV2ReceiptV1',
  'ControlApiV2RefusalV1',
  'ControlApiV2RequestV1',
  'ControlApiV2Resource',
  'ControlApiV2StatusViewV1',
  'ControlEventView',
  'CreatePayloadV1',
  'DecisionPayloadV1',
  'EngineRefusalReasonV1',
  'EventCursorRequestV1',
  'EventPageV1',
  'IdempotencyKeyV2',
  'ReadPayloadV1',
  'ReceiptRefusalReasonV1',
  'RefusalCarrierReasonV1',
  'RouteRefusalReasonV1',
] as const;

const IMPORT_EXPORT_FROM_RE =
  /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

describe('browser-safe domain modules (C4 wire extract)', () => {
  it('keeps canonicalSerialize and controlApiV2Wire free of Node/runtime I/O', () => {
    for (const name of BROWSER_SAFE_MODULES) {
      const source = readFileSync(join(DOMAIN, name), 'utf8');
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        expect(source.includes(needle), `${name} must not contain ${needle}`).toBe(
          false,
        );
      }
    }
  });

  it('allows only browser-safe relative imports between the two wire modules', () => {
    for (const name of BROWSER_SAFE_MODULES) {
      const source = readFileSync(join(DOMAIN, name), 'utf8');
      const specifiers: string[] = [];
      for (const match of source.matchAll(IMPORT_EXPORT_FROM_RE)) {
        const specifier = match[1];
        if (specifier !== undefined) specifiers.push(specifier);
      }
      for (const specifier of specifiers) {
        expect(
          ALLOWED_SPECIFIERS.has(specifier),
          `${name} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });

  it('re-exports every moved wire symbol from controlApiV2.ts', async () => {
    const mod = await import('../../src/domain/controlApiV2.js');
    const keys = new Set(Object.keys(mod));
    for (const name of MOVED_VALUE_SYMBOLS) {
      expect(keys.has(name), `missing runtime export ${name}`).toBe(true);
    }

    const source = readFileSync(join(DOMAIN, 'controlApiV2.ts'), 'utf8');
    const typeReExportBlocks = [
      ...source.matchAll(/export type\s*\{([^}]+)\}\s*from\s*['"]\.\/controlApiV2Wire\.js['"]/g),
    ];
    expect(typeReExportBlocks.length).toBeGreaterThan(0);
    const typeReExportText = typeReExportBlocks.map((m) => m[1] ?? '').join(',');
    for (const name of MOVED_TYPE_SYMBOLS) {
      expect(
        new RegExp(`\\b${name}\\b`).test(typeReExportText),
        `missing type re-export ${name}`,
      ).toBe(true);
    }
  });

  it('re-exports serializer symbols from canonicalJson.ts', async () => {
    const mod = await import('../../src/domain/canonicalJson.js');
    expect(mod).toHaveProperty('canonicalSerialize');
    expect(mod).toHaveProperty('canonicalClone');
    expect(mod).toHaveProperty('CanonicalJsonError');
    expect(mod).toHaveProperty('hashCanonicalJson');
  });
});
