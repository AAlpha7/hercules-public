import { useEffect, useState, type JSX } from 'react';
import { fetchBlobUrl } from './api.js';
import {
  cardTitleFromRow,
  isTableRow,
  isTableSeparator,
  shouldRenderTableAsCards,
  splitTableRow,
  zipTableRow,
} from './markdownTables.js';

/**
 * A minimal, dependency-free markdown renderer for review packets. Renders to
 * React elements (so it is XSS-safe by construction — text is never injected as
 * HTML). Covers the constructs the daemon emits: fenced code, headings, bullet
 * lists with checkboxes, blockquotes, bold, inline code, and images.
 */
export function Markdown({ text }: { text: string }): JSX.Element {
  const blocks: JSX.Element[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.startsWith('```')) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        code.push(lines[i]!);
        i += 1;
      }
      i += 1; // closing fence
      blocks.push(
        <pre className="md-code" key={key++}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const Tag = (`h${Math.min(level + 1, 6)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
      blocks.push(
        <Tag className="md-h" key={key++}>
          {inline(heading[2]!)}
        </Tag>,
      );
      i += 1;
      continue;
    }

    // Bullet list (consecutive `- ` lines)
    if (/^\s*-\s+/.test(line)) {
      const items: JSX.Element[] = [];
      while (i < lines.length && /^\s*-\s+/.test(lines[i]!)) {
        const content = lines[i]!.replace(/^\s*-\s+/, '');
        const checkbox = /^\[([ xX])\]\s+(.*)$/.exec(content);
        items.push(
          <li key={items.length}>
            {checkbox ? (
              <>
                <span>{checkbox[1]!.trim() ? '☑' : '☐'} </span>
                {inline(checkbox[2]!)}
              </>
            ) : (
              inline(content)
            )}
          </li>,
        );
        i += 1;
      }
      blocks.push(
        <ul className="md-list" key={key++}>
          {items}
        </ul>,
      );
      continue;
    }

    // GFM pipe table: header row, optional separator, then body rows.
    // | a | b |
    // |---|---|
    // | 1 | 2 |
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const headerCells = splitTableRow(line);
      i += 2; // skip header + separator
      const bodyRows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i]!)) {
        bodyRows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      // Phone: wide matrices become stacked cards (columns squeeze text into
      // 1-char-wide cells otherwise — see evidence matrix on ~390px).
      if (shouldRenderTableAsCards(headerCells)) {
        blocks.push(
          <div className="md-kv-cards" key={key++}>
            {bodyRows.map((row, ri) => {
              const pairs = zipTableRow(headerCells, row);
              const { title, rest } = cardTitleFromRow(pairs);
              return (
                <article className="md-kv-card" key={ri}>
                  {title ? <h4 className="md-kv-title">{inline(title)}</h4> : null}
                  <dl className="md-kv-list">
                    {rest.map((p, pi) => (
                      <div className="md-kv-row" key={pi} data-field={p.label.toLowerCase()}>
                        <dt>{inline(p.label)}</dt>
                        <dd>{inline(p.value || '—')}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              );
            })}
          </div>,
        );
        continue;
      }

      blocks.push(
        <div className="md-table-wrap" key={key++}>
          <table className="md-table">
            <thead>
              <tr>
                {headerCells.map((c, ci) => (
                  <th key={ci}>{inline(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td key={ci}>{inline(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Blockquote (consecutive `>` lines) — used to nest L3 report text so
    // embedded ## / ** headings cannot split phone packet sections.
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quote.push(lines[i]!.replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push(
        <blockquote className="md-quote" key={key++}>
          <Markdown text={quote.join('\n')} />
        </blockquote>,
      );
      continue;
    }

    // Hercules provenance / machine fence lines — structural, not display text.
    if (/^\s*<!--\s*hercules:[^>]*-->\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Paragraph
    blocks.push(
      <p className="md-p" key={key++}>
        {inline(line)}
      </p>,
    );
    i += 1;
  }

  return <div className="md">{blocks}</div>;
}

/** Inline formatting: images, bold, and inline code. */
function inline(text: string): JSX.Element {
  const nodes: (JSX.Element | string)[] = [];
  // image | bold | inline code
  const re = /!\[([^\]]*)\]\(([^)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) {
      nodes.push(<AuthImg key={k++} src={m[2]} alt={m[1] ?? ''} />);
    } else if (m[3] !== undefined) {
      nodes.push(<strong key={k++}>{m[3]}</strong>);
    } else if (m[4] !== undefined) {
      nodes.push(<code key={k++}>{m[4]}</code>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

/**
 * An image served from the authenticated API: fetched as a blob with the bearer
 * token (an <img src> can't send headers), then shown via an object URL.
 */
function AuthImg({ src, alt }: { src: string; alt: string }): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!src.startsWith('/api/')) {
      setUrl(src);
      return;
    }
    let revoke: string | null = null;
    fetchBlobUrl(src)
      .then((u) => {
        revoke = u;
        setUrl(u);
      })
      .catch(() => setFailed(true));
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [src]);

  if (failed) return <span className="muted">[image unavailable]</span>;
  if (!url) return <span className="muted">[loading image…]</span>;
  return <img className="md-img" src={url} alt={alt} />;
}
