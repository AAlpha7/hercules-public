/**
 * Authenticated screenshot / video gallery.
 *
 * Shared by the task-sheet evidence-first strip and ReleasesPanel staging
 * thumbs. Releases keep their existing `data-evidence` names
 * (`release-shot-*`, `release-shot-lightbox`).
 */
import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { fetchBlobUrl, releaseScreenshotPath } from './api.js';
import type { EvidenceMedia } from './taskBodySplit.js';

function revokeObjectUrlSafe(url: string): void {
  try {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url);
    }
  } catch {
    /* jsdom / older hosts may lack revokeObjectURL */
  }
}

/** Load an authenticated media path as a blob URL (token never in the URL). */
export function useAuthMediaUrl(path: string | null): string | null {
  // Track which path `url` belongs to so a path change never keeps prior pixels
  // under the next item's label while the new fetch is in flight.
  const [loaded, setLoaded] = useState<{ path: string | null; url: string | null }>({
    path: null,
    url: null,
  });
  useEffect(() => {
    if (!path) {
      setLoaded({ path: null, url: null });
      return;
    }
    let revoked: string | null = null;
    let cancelled = false;
    void fetchBlobUrl(path)
      .then((obj) => {
        if (cancelled) {
          revokeObjectUrlSafe(obj);
          return;
        }
        revoked = obj;
        setLoaded({ path, url: obj });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ path, url: null });
      });
    return () => {
      cancelled = true;
      if (revoked) revokeObjectUrlSafe(revoked);
    };
  }, [path]);
  return loaded.path === path ? loaded.url : null;
}

/** Eager-load this many tiles when IntersectionObserver is missing or inert. */
export const EVIDENCE_EAGER_TILE_COUNT = 6;

/** Staging verify screenshot thumbnail (ReleasesPanel). */
export function StagingShotThumb({
  repoKey,
  name,
  onOpen,
}: {
  repoKey: string;
  name: string;
  onOpen: (path: string) => void;
}): JSX.Element {
  const path = releaseScreenshotPath(repoKey, name);
  const url = useAuthMediaUrl(path);
  return (
    <button
      type="button"
      className="releases-shot-thumb"
      data-evidence={`release-shot-${name.replace(/\.png$/i, '')}`}
      onClick={() => onOpen(path)}
      title={name}
    >
      {url ? <img src={url} alt={name} loading="lazy" /> : <span className="muted">{name}</span>}
      <span className="releases-shot-caption">{name.replace(/\.png$/i, '')}</span>
    </button>
  );
}

/** Full-screen lightbox for a single release screenshot path. */
export function ShotLightbox({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}): JSX.Element {
  const url = useAuthMediaUrl(path);
  return (
    <div
      className="releases-lightbox"
      data-evidence="release-shot-lightbox"
      role="dialog"
      onClick={onClose}
    >
      <button type="button" className="link releases-lightbox-close" onClick={onClose}>
        ×
      </button>
      {url ? (
        <img src={url} alt="" onClick={(e) => e.stopPropagation()} />
      ) : (
        <span className="muted">…</span>
      )}
    </div>
  );
}

function EvidenceTile({
  item,
  onOpen,
  eager,
}: {
  item: EvidenceMedia;
  onOpen: () => void;
  /** Load immediately (first few tiles / scroll fallback) — not all tiles. */
  eager: boolean;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [visible, setVisible] = useState(false);
  const url = useAuthMediaUrl(visible ? item.url : null);

  useEffect(() => {
    if (eager) {
      setVisible(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    // No IntersectionObserver: remaining tiles wait for strip scroll/interaction
    // (parent sets eager). Do not fetch every tile up front.
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { root: null, rootMargin: '40px', threshold: 0.01 },
    );
    io.observe(el);
    // No zero-delay fallback — that defeated lazy loading in production.
    return () => {
      io.disconnect();
    };
  }, [eager]);

  const badge =
    item.ok === true ? '✓' : item.ok === false ? '✗' : null;

  return (
    <button
      ref={ref}
      type="button"
      className="evidence-shot-thumb"
      data-evidence={item.kind === 'video' ? 'evidence-video' : 'evidence-shot'}
      data-ok={item.ok === null ? undefined : item.ok ? '1' : '0'}
      onClick={onOpen}
      title={item.label}
    >
      {item.kind === 'video' ? (
        url ? (
          <video src={url} muted preload="metadata" playsInline />
        ) : (
          <span className="muted">video</span>
        )
      ) : url ? (
        <img src={url} alt={item.label} loading="lazy" />
      ) : (
        <span className="muted">…</span>
      )}
      {badge ? (
        <span className={`evidence-shot-badge ${item.ok ? 'is-ok' : 'is-fail'}`}>{badge}</span>
      ) : null}
      {/* Caption lives in title + lightbox only — keeps the phone strip ≤56px. */}
    </button>
  );
}

function EvidenceLightbox({
  items,
  index,
  onClose,
  onNav,
}: {
  items: readonly EvidenceMedia[];
  index: number;
  onClose: () => void;
  onNav: (next: number) => void;
}): JSX.Element {
  const item = items[index]!;
  const url = useAuthMediaUrl(item.url);
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  return (
    <div
      className="evidence-lightbox"
      data-evidence="evidence-lightbox"
      role="dialog"
      aria-label={item.label}
      onClick={onClose}
    >
      <button type="button" className="link evidence-lightbox-close" onClick={onClose}>
        ×
      </button>
      <div className="evidence-lightbox-label" onClick={(e) => e.stopPropagation()}>
        {item.label}
        {item.ok === true ? ' ✓' : item.ok === false ? ' ✗' : ''}
      </div>
      {hasPrev ? (
        <button
          type="button"
          className="evidence-lightbox-nav evidence-lightbox-prev"
          aria-label="Previous"
          onClick={(e) => {
            e.stopPropagation();
            onNav(index - 1);
          }}
        >
          ‹
        </button>
      ) : null}
      {hasNext ? (
        <button
          type="button"
          className="evidence-lightbox-nav evidence-lightbox-next"
          aria-label="Next"
          onClick={(e) => {
            e.stopPropagation();
            onNav(index + 1);
          }}
        >
          ›
        </button>
      ) : null}
      <div className="evidence-lightbox-body" onClick={(e) => e.stopPropagation()}>
        {item.kind === 'video' ? (
          url ? (
            <video src={url} controls preload="metadata" playsInline />
          ) : (
            <span className="muted">…</span>
          )
        ) : url ? (
          <img src={url} alt={item.label} />
        ) : (
          <span className="muted">…</span>
        )}
      </div>
    </div>
  );
}

/** Horizontal evidence strip + lightbox for the task sheet. */
export function EvidenceGallery({
  items,
  openIndex: controlledOpenIndex,
  onOpenIndexChange,
}: {
  readonly items: readonly EvidenceMedia[];
  /** Optional controlled lightbox index (needs-you evidence links). */
  readonly openIndex?: number | null;
  readonly onOpenIndexChange?: (index: number | null) => void;
}): JSX.Element {
  const [internalOpen, setInternalOpen] = useState<number | null>(null);
  const controlled = onOpenIndexChange !== undefined;
  const openIndex = controlled ? (controlledOpenIndex ?? null) : internalOpen;
  const setOpenIndex = (index: number | null): void => {
    if (controlled) onOpenIndexChange(index);
    else setInternalOpen(index);
  };
  const stripRef = useRef<HTMLDivElement | null>(null);
  /** Without IO support, unlock remaining tiles after scroll / pointer on the strip. */
  const [unlockRest, setUnlockRest] = useState(false);

  useEffect(() => {
    if (typeof IntersectionObserver !== 'undefined') return;
    const el = stripRef.current;
    if (!el) return;
    const unlock = (): void => setUnlockRest(true);
    el.addEventListener('scroll', unlock, { passive: true });
    el.addEventListener('pointerdown', unlock);
    return () => {
      el.removeEventListener('scroll', unlock);
      el.removeEventListener('pointerdown', unlock);
    };
  }, []);

  return (
    <>
      <div
        ref={stripRef}
        className="evidence-shot-strip"
        data-evidence="evidence-gallery"
      >
        {items.map((item, i) => (
          <EvidenceTile
            key={item.name}
            item={item}
            eager={unlockRest || i < EVIDENCE_EAGER_TILE_COUNT}
            onOpen={() => setOpenIndex(i)}
          />
        ))}
      </div>
      {openIndex !== null && items[openIndex] ? (
        <EvidenceLightbox
          items={items}
          index={openIndex}
          onClose={() => setOpenIndex(null)}
          onNav={setOpenIndex}
        />
      ) : null}
    </>
  );
}

/** Credibility chips row. */
export function CredibilityChips({
  chips,
}: {
  readonly chips: readonly { readonly kind: string; readonly label: string }[];
}): JSX.Element | null {
  if (chips.length === 0) return null;
  return (
    <div className="evidence-chips" data-evidence="evidence-chips">
      {chips.map((c) => (
        <span
          key={c.kind}
          className="evidence-chip"
          data-evidence="evidence-chip"
          data-kind={c.kind}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

/** Phone vertical budget for the whole evidence-first section (tiles + chips). */
export const EVIDENCE_FIRST_PHONE_MAX_PX = 96;

/** Evidence-first block: gallery (or muted note) + chips. */
export function EvidenceFirstSection({
  items,
  chips,
  emptyNote,
  openIndex,
  onOpenIndexChange,
}: {
  readonly items: readonly EvidenceMedia[];
  readonly chips: readonly { readonly kind: string; readonly label: string }[];
  readonly emptyNote: string;
  readonly openIndex?: number | null;
  readonly onOpenIndexChange?: (index: number | null) => void;
}): JSX.Element {
  // ≤2 tiles: chips share the tile row so the stack stays one line tall.
  const inlineChips = items.length > 0 && items.length <= 2;
  return (
    <section
      className={`evidence-first${inlineChips ? ' evidence-first--inline' : ''}`}
      data-evidence="evidence-first"
      data-budget-max={String(EVIDENCE_FIRST_PHONE_MAX_PX)}
    >
      {items.length > 0 ? (
        <EvidenceGallery
          items={items}
          {...(openIndex !== undefined ? { openIndex } : {})}
          {...(onOpenIndexChange ? { onOpenIndexChange } : {})}
        />
      ) : (
        <p className="muted evidence-empty-note">{emptyNote}</p>
      )}
      <CredibilityChips chips={chips} />
    </section>
  );
}

/** Helper so ReleasesPanel can keep importing thumbs without a local copy. */
export function ReleasesShotRow({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return <div className="releases-shot-row">{children}</div>;
}
