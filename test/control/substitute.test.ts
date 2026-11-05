import { describe, it, expect } from 'vitest';
import { substituteAllocation } from '../../src/control/workflow.js';

const alloc = { slug: 'T-1', port: 4100, scratchDir: '/ws/.scratch' };

describe('substituteAllocation (SPEC §8.3)', () => {
  it('replaces {slug}, {port}, {scratch_dir}', () => {
    expect(substituteAllocation('pnpm dev --port {port}', alloc)).toBe('pnpm dev --port 4100');
    expect(substituteAllocation('echo {slug} > {scratch_dir}/id', alloc)).toBe('echo T-1 > /ws/.scratch/id');
  });

  it('replaces every occurrence', () => {
    expect(substituteAllocation('{port}-{port}', alloc)).toBe('4100-4100');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(substituteAllocation('curl localhost:{port}/x {other}', alloc)).toBe(
      'curl localhost:4100/x {other}',
    );
  });
});
