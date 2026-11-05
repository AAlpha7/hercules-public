import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('queue-front API surface', () => {
  it('registers queue-front route', () => {
    const src = readFileSync(join(process.cwd(), 'src/server/api.ts'), 'utf8');
    expect(src.includes('/api/tasks/:id/queue-front')).toBe(true);
    expect(src.includes('moveToQueueFront')).toBe(true);
  });
});
