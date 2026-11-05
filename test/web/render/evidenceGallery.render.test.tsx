/**
 * C3.21 — EvidenceGallery: no stale lightbox pixels; lazy tiles stay lazy.
 */
import './setup.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  EvidenceGallery,
  EVIDENCE_EAGER_TILE_COUNT,
} from '../../../src/web/EvidenceGallery.js';
import type { EvidenceMedia } from '../../../src/web/taskBodySplit.js';

const fetchBlobUrl = vi.fn();

vi.mock('../../../src/web/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/web/api.js')>();
  return {
    ...actual,
    fetchBlobUrl: (...args: unknown[]) => fetchBlobUrl(...args),
  };
});

function item(name: string, label = name): EvidenceMedia {
  return {
    kind: 'image',
    name,
    url: `/api/tasks/t/screenshots/${name}`,
    label,
    ok: true,
  };
}

describe('EvidenceGallery lightbox + lazy tiles', () => {
  beforeEach(() => {
    fetchBlobUrl.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('B3: changing lightbox target clears img src until the new fetch resolves', async () => {
    const user = userEvent.setup();
    let resolveSecond: ((url: string) => void) | null = null;
    fetchBlobUrl.mockImplementation((path: string) => {
      if (path.endsWith('a.png')) return Promise.resolve('blob:a');
      if (path.endsWith('b.png')) {
        return new Promise<string>((resolve) => {
          resolveSecond = resolve;
        });
      }
      return Promise.resolve('blob:other');
    });

    const items = [item('a.png', 'label-a'), item('b.png', 'label-b')];
    render(<EvidenceGallery items={items} />);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-evidence="evidence-shot"]').length).toBe(2);
    });

    const tiles = document.querySelectorAll('[data-evidence="evidence-shot"]');
    await user.click(tiles[0] as HTMLElement);

    const lightbox = document.querySelector('[data-evidence="evidence-lightbox"]');
    expect(lightbox).toBeTruthy();
    await waitFor(() => {
      const img = lightbox!.querySelector('img');
      expect(img?.getAttribute('src')).toBe('blob:a');
    });
    expect(lightbox!.textContent).toMatch(/label-a/);

    const next = lightbox!.querySelector('[aria-label="Next"]') as HTMLButtonElement;
    expect(next).toBeTruthy();
    await user.click(next);

    // Label/badge advance immediately; pixels must not keep image 0 under image 1's label.
    expect(lightbox!.textContent).toMatch(/label-b/);
    const imgAfterNav = lightbox!.querySelector('img');
    expect(imgAfterNav).toBeNull();
    expect(lightbox!.textContent).toMatch(/…/);

    await act(async () => {
      resolveSecond!('blob:b');
    });
    await waitFor(() => {
      const img = lightbox!.querySelector('img');
      expect(img?.getAttribute('src')).toBe('blob:b');
    });
  });

  it('N1: non-intersecting IntersectionObserver loads only the first eager tiles', async () => {
    fetchBlobUrl.mockResolvedValue('blob:x');

    class NonIntersectingObserver {
      readonly cb: IntersectionObserverCallback;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
      }
      observe(): void {
        // Never report intersecting — production must not zero-delay fallback.
      }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      root: Element | Document | null = null;
      rootMargin = '';
      thresholds: readonly number[] = [];
    }
    vi.stubGlobal('IntersectionObserver', NonIntersectingObserver);

    const items = Array.from({ length: 30 }, (_, i) => item(`shot-${i}.png`, `shot-${i}`));
    render(<EvidenceGallery items={items} />);

    await waitFor(() => {
      expect(fetchBlobUrl.mock.calls.length).toBeGreaterThan(0);
    });
    // Allow effects to flush.
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchBlobUrl.mock.calls.length).toBeLessThanOrEqual(EVIDENCE_EAGER_TILE_COUNT);
    expect(fetchBlobUrl.mock.calls.length).toBe(EVIDENCE_EAGER_TILE_COUNT);
  });
});
