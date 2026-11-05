import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className,
  disabled,
  loading,
  'data-evidence': dataEvidence,
}: {
  /** Idle face — string or structured content (e.g. bottom-nav icon + label). */
  label: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
  loading?: boolean;
  /** L2 evidence hook (declarative click target). */
  'data-evidence'?: string;
}): JSX.Element {
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const disarm = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // While armed, a tap/click anywhere outside the button disarms it (back to the
  // label) — alongside the 3s timeout. The listener is added after the arming
  // render, so the arming click itself never triggers it.
  useEffect(() => {
    if (!armed) return;
    const onOutside = (e: PointerEvent): void => {
      const target = e.target;
      if (target instanceof Node && btnRef.current && !btnRef.current.contains(target)) {
        disarm();
      }
    };
    document.addEventListener('pointerdown', onOutside, true);
    return () => document.removeEventListener('pointerdown', onOutside, true);
  }, [armed]);

  const onClick = (): void => {
    if (disabled || loading) return;
    if (armed) { disarm(); onConfirm(); return; }
    setArmed(true);
    timer.current = setTimeout(disarm, 3000);
  };

  return (
    <button
      ref={btnRef}
      className={`${className ?? ''} ${armed ? 'confirm-armed' : ''}`.trim()}
      onClick={onClick}
      disabled={disabled || loading}
      {...(dataEvidence ? { 'data-evidence': dataEvidence } : {})}
    >
      {loading ? <span className="spinner" /> : armed ? confirmLabel : label}
    </button>
  );
}
