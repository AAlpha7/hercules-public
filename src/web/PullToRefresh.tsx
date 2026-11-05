/**
 * Touch pull-to-refresh wrapper for the task list (phone SPA).
 * Gesture math lives in pullToRefresh.ts; this owns DOM + non-passive touchmove.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { t } from './i18n.js';
import type { Lang } from './prefs.js';
import {
  canBeginPull,
  dampenPull,
  phaseForDistance,
  shouldTriggerOnRelease,
  type PullPhase,
} from './pullToRefresh.js';

export function PullToRefresh({
  lang,
  disabled = false,
  onRefresh,
  children,
}: {
  lang: Lang;
  /** When true (e.g. bottom sheet open), ignore pull gestures. */
  disabled?: boolean;
  onRefresh: () => Promise<void>;
  children: ReactNode;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const startYRef = useRef(0);
  const trackingRef = useRef(false);
  const distanceRef = useRef(0);
  const refreshingRef = useRef(false);
  const disabledRef = useRef(disabled);
  const onRefreshRef = useRef(onRefresh);

  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  disabledRef.current = disabled;
  onRefreshRef.current = onRefresh;
  refreshingRef.current = refreshing;

  const setPullDistance = useCallback((next: number): void => {
    distanceRef.current = next;
    setDistance(next);
  }, []);

  const reset = useCallback((): void => {
    trackingRef.current = false;
    setPullDistance(0);
  }, [setPullDistance]);

  const runRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    refreshingRef.current = true;
    setPullDistance(0);
    try {
      await onRefreshRef.current();
    } catch {
      // onRefresh surfaces errors (setError); keep phase clean and do not
      // leave an unhandled rejection from void runRefresh().
    } finally {
      setRefreshing(false);
      refreshingRef.current = false;
      trackingRef.current = false;
    }
  }, [setPullDistance]);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const scrollTop = (): number =>
      window.scrollY ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0;

    const onTouchStart = (e: TouchEvent): void => {
      if (disabledRef.current || refreshingRef.current) return;
      const touch = e.touches[0];
      if (!touch) return;
      if (scrollTop() > 0) {
        trackingRef.current = false;
        return;
      }
      startYRef.current = touch.clientY;
      trackingRef.current = true;
    };

    const onTouchMove = (e: TouchEvent): void => {
      if (!trackingRef.current || disabledRef.current || refreshingRef.current) return;
      const touch = e.touches[0];
      if (!touch) return;
      const rawDy = touch.clientY - startYRef.current;
      const top = scrollTop();

      if (
        !canBeginPull({
          disabled: disabledRef.current,
          isRefreshing: refreshingRef.current,
          scrollTop: top,
          deltaY: rawDy,
        })
      ) {
        if (rawDy <= 0 || top > 0) {
          setPullDistance(0);
          if (top > 0) trackingRef.current = false;
        }
        return;
      }

      // Own the vertical drag so the page does not rubber-band underneath.
      e.preventDefault();
      setPullDistance(dampenPull(rawDy));
    };

    const onTouchEnd = (): void => {
      if (!trackingRef.current || disabledRef.current) {
        reset();
        return;
      }
      const phase = phaseForDistance(distanceRef.current, refreshingRef.current);
      if (shouldTriggerOnRelease(phase) && !refreshingRef.current) {
        void runRefresh();
        return;
      }
      reset();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    // Non-passive so preventDefault() can block native overscroll while pulling.
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchcancel', onTouchEnd);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [reset, runRefresh, setPullDistance]);

  // Drop in-flight pull if a sheet opens mid-gesture.
  useEffect(() => {
    if (disabled && !refreshing) reset();
  }, [disabled, refreshing, reset]);

  const phase: PullPhase = phaseForDistance(distance, refreshing);
  const labelKey =
    phase === 'refreshing'
      ? 'pullRefreshing'
      : phase === 'armed'
        ? 'pullRelease'
        : 'pullPull';
  const showIndicator = phase !== 'idle';

  return (
    <div
      ref={rootRef}
      className="ptr-root"
      data-evidence="pull-to-refresh"
      data-ptr-phase={phase}
      aria-busy={refreshing}
    >
      <div
        className={`ptr-indicator${showIndicator ? ' is-visible' : ''}${
          phase === 'refreshing' ? ' is-refreshing' : ''
        }${phase === 'armed' ? ' is-armed' : ''}`}
        data-evidence="pull-indicator"
        style={{ height: showIndicator ? Math.max(distance, refreshing ? 48 : 0) : 0 }}
        aria-hidden={!showIndicator}
        role="status"
        aria-live="polite"
      >
        <span className="ptr-spinner" aria-hidden />
        <span className="ptr-label">{t(lang, labelKey)}</span>
      </div>
      <div className="ptr-content" data-evidence="task-list">
        {/* Alias for list feature kind — same live task rows as task-list. */}
        <div className="task-list-root" data-evidence="list">
          {children}
        </div>
      </div>
    </div>
  );
}
