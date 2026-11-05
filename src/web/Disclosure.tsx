import { useId, useState, type JSX, type ReactNode } from 'react';

export type DisclosureTone =
  | 'default'
  | 'accent'
  | 'success'
  | 'warn'
  | 'danger'
  | 'muted'
  | 'steer'
  | 'full';

/**
 * Mobile-friendly expand/collapse block. Evidence-heavy packet sections default
 * collapsed so the human sees hierarchy first (DoD / verdict), then opens detail.
 */
export function Disclosure({
  title,
  subtitle,
  defaultOpen = false,
  tone = 'default',
  badge,
  children,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly defaultOpen?: boolean;
  readonly tone?: DisclosureTone;
  readonly badge?: string;
  readonly children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className={`disc disc-${tone}${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="disc-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="disc-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
        <span className="disc-titles">
          <span className="disc-title">{title}</span>
          {subtitle ? <span className="disc-sub muted">{subtitle}</span> : null}
        </span>
        {badge ? <span className="disc-badge">{badge}</span> : null}
      </button>
      {open ? (
        <div className="disc-body" id={panelId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
