/**
 * Hercules provenance fence lines render as nothing (no text node / blank paragraph).
 */
import './setup.js';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../../../src/web/Markdown.js';

describe('Markdown hercules fence lines', () => {
  it('renders hercules single-line comments as nothing', () => {
    const text = [
      'Before',
      '<!-- hercules:packet v1 nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->',
      '<!-- hercules:prose-begin kind=report nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->',
      'Visible prose',
      '<!-- hercules:prose-end nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->',
      '<!-- hercules:packet-end nonce=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->',
      'After',
    ].join('\n');
    const { container } = render(<Markdown text={text} />);
    const html = container.textContent ?? '';
    expect(html).toContain('Before');
    expect(html).toContain('Visible prose');
    expect(html).toContain('After');
    expect(html).not.toContain('hercules:packet');
    expect(html).not.toContain('hercules:prose');
    expect(html).not.toContain('nonce=');
    // No empty paragraph left behind for the fence lines.
    const paragraphs = [...container.querySelectorAll('p.md-p')].map(
      (p) => p.textContent ?? '',
    );
    expect(paragraphs).toEqual(['Before', 'Visible prose', 'After']);
  });
});
