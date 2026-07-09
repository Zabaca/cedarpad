// Zero-dependency markdown renderer for chat bubbles.
// Handles: headings, bold/italic, inline-code, fenced-code, tables,
// ordered/unordered lists, links, horizontal rules, paragraphs.
// Returns React elements — no dangerouslySetInnerHTML, no external deps.

import * as React from 'react';

// ---- inline tokeniser -------------------------------------------------------

// Matches **bold**, *italic*, `code`, [label](url) in priority order.
const INLINE_RE = /\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)/g;

function tokeniseInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let pos = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > pos) out.push(text.slice(pos, m.index));
    const [full, bold, italic, code, linkLabel, linkHref] = m as unknown as [string, string|undefined, string|undefined, string|undefined, string|undefined, string|undefined];
    if (bold    !== undefined) out.push(<strong key={m.index}><IL text={bold} /></strong>);
    else if (italic !== undefined) out.push(<em key={m.index}><IL text={italic} /></em>);
    else if (code   !== undefined) out.push(<code key={m.index} className="md-ic">{code}</code>);
    else out.push(<a key={m.index} href={linkHref ?? '#'} target="_blank" rel="noreferrer noopener">{linkLabel}</a>);
    pos = m.index + full.length;
  }
  if (pos < text.length) out.push(text.slice(pos));
  return out;
}

function IL({ text }: { text: string }): React.ReactElement {
  return <>{tokeniseInline(text)}</>;
}

// ---- block types ------------------------------------------------------------

type HBlock  = { t: 'h';     level: 1|2|3|4|5|6; text: string };
type FBlock  = { t: 'fence'; lang: string; code: string };
type TBlock  = { t: 'table'; rows: string[][] };
type LBlock  = { t: 'list';  ordered: boolean; items: string[] };
type HrBlock = { t: 'hr' };
type PBlock  = { t: 'para';  lines: string[] };
type Block   = HBlock | FBlock | TBlock | LBlock | HrBlock | PBlock;

// ---- block parser -----------------------------------------------------------

const H_RE     = /^(#{1,6})\s+(.+)$/;
const HR_RE    = /^[-*_]{3,}$/;
const OL_RE    = /^\d+\.\s+/;
const UL_RE    = /^[-*+]\s+/;
const FENCE_RE = /^```/;

function parseBlocks(md: string): Block[] {
  const lines = md.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // Heading
    const hm = H_RE.exec(line);
    if (hm) {
      blocks.push({ t: 'h', level: (hm[1]?.length ?? 1) as 1|2|3|4|5|6, text: hm[2] ?? '' });
      i++; continue;
    }

    // Horizontal rule (before list check — "---" is ambiguous)
    if (HR_RE.test(trimmed)) {
      blocks.push({ t: 'hr' });
      i++; continue;
    }

    // Fenced code block
    if (FENCE_RE.test(line)) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i++;
      }
      i++; // consume closing ```
      blocks.push({ t: 'fence', lang, code: code.join('\n') });
      continue;
    }

    // Table (every consecutive row must start with |)
    if (line.startsWith('|')) {
      const raw: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('|')) {
        raw.push(lines[i] ?? '');
        i++;
      }
      // Strip separator rows (|---|---|), parse remaining cells
      const rows = raw
        .filter(l => !/^\|[\s\-:|]+\|?$/.test(l))
        .map(l => l.replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
      if (rows.length) blocks.push({ t: 'table', rows });
      continue;
    }

    // Ordered list
    if (OL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL_RE.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(OL_RE, ''));
        i++;
      }
      blocks.push({ t: 'list', ordered: true, items });
      continue;
    }

    // Unordered list
    if (UL_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL_RE.test(lines[i] ?? '')) {
        items.push((lines[i] ?? '').replace(UL_RE, ''));
        i++;
      }
      blocks.push({ t: 'list', ordered: false, items });
      continue;
    }

    // Paragraph — collect until blank line or block-start
    const para: string[] = [];
    while (i < lines.length) {
      const cur = lines[i] ?? '';
      if (
        !cur.trim() ||
        H_RE.test(cur) ||
        FENCE_RE.test(cur) ||
        cur.startsWith('|') ||
        OL_RE.test(cur) ||
        UL_RE.test(cur) ||
        HR_RE.test(cur.trim())
      ) break;
      para.push(cur);
      i++;
    }
    if (para.length) blocks.push({ t: 'para', lines: para });
  }

  return blocks;
}

// ---- block renderer ---------------------------------------------------------

function renderBlock(block: Block, idx: number): React.ReactNode {
  switch (block.t) {
    case 'h':
      return React.createElement(`h${block.level}`, { key: idx, className: 'md-h' }, <IL text={block.text} />);

    case 'fence':
      return (
        <pre key={idx} className="md-pre">
          <code>{block.code}</code>
        </pre>
      );

    case 'table': {
      const [header, ...body] = block.rows;
      return (
        <div key={idx} className="md-table-wrap">
          <table className="md-table">
            {header && (
              <thead>
                <tr>{header.map((c, ci) => <th key={ci}><IL text={c} /></th>)}</tr>
              </thead>
            )}
            <tbody>
              {body.map((row, ri) => (
                <tr key={ri}>{row.map((c, ci) => <td key={ci}><IL text={c} /></td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    case 'list':
      return block.ordered
        ? <ol key={idx} className="md-list">{block.items.map((item, ii) => <li key={ii}><IL text={item} /></li>)}</ol>
        : <ul key={idx} className="md-list">{block.items.map((item, ii) => <li key={ii}><IL text={item} /></li>)}</ul>;

    case 'hr':
      return <hr key={idx} className="md-hr" />;

    case 'para':
      return (
        <p key={idx} className="md-p">
          {block.lines.map((line, li) => (
            <React.Fragment key={li}>
              {li > 0 && <br />}
              <IL text={line} />
            </React.Fragment>
          ))}
        </p>
      );
  }
}

// ---- public component -------------------------------------------------------

export const MarkdownMessage = React.memo(function MarkdownMessage({ text }: { text: string }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return <div className="md">{blocks.map(renderBlock)}</div>;
});
