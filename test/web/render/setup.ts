/**
 * Shared setup for jsdom render tests (also loaded by the full/unit suite;
 * cleanup is a no-op when no React tree is mounted).
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// waitFor/findBy default to 1 s; readiness/poll-driven panels flake under a
// loaded host (check:full + a parallel review). 4 s changes no assertion.
configure({ asyncUtilTimeout: 4_000 });

// jsdom's URL lacks createObjectURL / revokeObjectURL — media thumbs need stubs.
if (typeof URL !== 'undefined') {
  if (typeof URL.createObjectURL !== 'function') {
    URL.createObjectURL = () => 'blob:jsdom-stub';
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    URL.revokeObjectURL = () => {};
  }
}

afterEach(() => {
  cleanup();
});
