import type { JSX } from 'react';
import { statusPresentation, type PresentedStatus } from './reviewViewModel.js';

const ICONS: Record<ReturnType<typeof statusPresentation>['icon'], string> = {
  check: '✓',
  branch: '⑂',
  search: '⌕',
  user: '●',
  message: '□',
  x: '×',
  minus: '−',
};

export function StatusToken({ status }: { status: PresentedStatus }): JSX.Element {
  const presentation = statusPresentation(status);
  return (
    <span
      className={`outcome-review-status outcome-review-tone-${presentation.tone}`}
      aria-label={presentation.label}
    >
      <span aria-hidden>{ICONS[presentation.icon]}</span>
      <span>{presentation.label}</span>
    </span>
  );
}
