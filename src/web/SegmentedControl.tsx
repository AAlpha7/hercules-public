/**
 * Phone-friendly exclusive choice: 2–4 options as equal-width segments.
 * Prefer this over checkbox (modes) or long select (≤4 fixed options).
 */
import type { JSX } from 'react';

export interface SegmentOption<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Optional secondary line under the label (kept short). */
  readonly hint?: string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  size = 'md',
}: {
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (next: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  /** sm = compact chips; md = default phone rows */
  size?: 'sm' | 'md';
}): JSX.Element {
  return (
    <div
      className={`seg-control seg-${size}`}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`seg-item${selected ? ' is-selected' : ''}`}
            disabled={disabled}
            onClick={() => {
              if (!disabled && !selected) onChange(opt.value);
            }}
          >
            <span className="seg-label">{opt.label}</span>
            {opt.hint ? <span className="seg-hint">{opt.hint}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
