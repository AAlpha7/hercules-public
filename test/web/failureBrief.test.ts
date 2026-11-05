/**
 * CEO-grade failure surface: translate the LAST recorded failure kind into a
 * plain zh sentence + a recommendation, instead of assuming git/gates
 * literacy. Pure body parsing — the packet already records the facts.
 */
import { describe, it, expect } from 'vitest';
import { failureBrief } from '../../src/web/failureBrief.js';

describe('failureBrief', () => {
  it('translates the last failure kind with advice', () => {
    const body = [
      '## Run failure (x)\n**Kind:** `provision`\n',
      '## Auto-rework\n**Failure kind:** `verify_l1`\n**Attempt:** 3 / 3\n',
    ].join('\n');
    const b = failureBrief(body, 3)!;
    expect(b.kind).toBe('verify_l1');
    expect(b.kindZh).toMatch(/门禁|测试|构建/);
    expect(b.adviceZh).toMatch(/重试|打回|Retry/i);
    expect(b.attempts).toBe(3);
  });

  it('covers env-flavored kinds with "environment, retry is cheap" advice', () => {
    const b = failureBrief('**Failure kind:** `provision`', 1)!;
    expect(b.kindZh).toMatch(/环境/);
    expect(b.adviceZh).toMatch(/环境|重试/);
  });

  it('null when no failure record exists', () => {
    expect(failureBrief('## Task\nhello', 0)).toBeNull();
  });
});
