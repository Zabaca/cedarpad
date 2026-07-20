// Fast data-table card: renders tabular data (pasted spreadsheets, CSV/TSV, query
// results) with windowed rows, so tens of thousands of rows stay smooth. Props:
// { title?, columns: string[], rows: string[][], totalRows? (set when truncated) }.
import * as React from 'react';

const ROW_H = 28;
const OVERSCAN = 10;

/** The half-open row window [start, end) worth rendering for a scroll position. */
export function visibleSlice(scrollTop: number, viewH: number, rowH: number, total: number, overscan = OVERSCAN): { start: number; end: number } {
  const visRows = Math.ceil(viewH / rowH);
  const start = Math.max(0, Math.min(Math.floor(scrollTop / rowH) - overscan, total - visRows));
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / rowH) + overscan);
  return { start, end };
}

const isNumeric = (s: string) => {
  const t = String(s).trim().replace(/[$,%]/g, '');
  return t !== '' && !Number.isNaN(Number(t));
};

/** Per-column width (ch) and alignment, estimated from the header + a sample of rows. */
export function columnLayout(columns: string[], rows: string[][]): Array<{ ch: number; numeric: boolean }> {
  const sample = rows.slice(0, 100);
  return columns.map((c, i) => {
    let max = c.length;
    let numeric = sample.length > 0;
    for (const r of sample) {
      const cell = String(r[i] ?? '');
      if (cell.length > max) max = cell.length;
      if (cell.trim() !== '' && !isNumeric(cell)) numeric = false;
    }
    return { ch: Math.min(40, Math.max(4, max + 1)), numeric };
  });
}

export default function DataTable({
  title,
  columns = [],
  rows = [],
  totalRows,
}: {
  title?: string;
  columns?: string[];
  rows?: string[][];
  totalRows?: number;
}) {
  const [view, setView] = React.useState({ top: 0, h: 360 });
  const scroller = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setView((v) => (el.clientHeight === v.h ? v : { ...v, h: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const layout = React.useMemo(() => columnLayout(columns, rows), [columns, rows]);
  const template = layout.map((c) => `minmax(${c.ch}ch, auto)`).join(' ');
  const { start, end } = visibleSlice(view.top, view.h, ROW_H, rows.length);

  const cellStyle = (i: number): React.CSSProperties => ({
    padding: '0 10px',
    lineHeight: `${ROW_H}px`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: layout[i]?.numeric ? 'right' : 'left',
    fontVariantNumeric: 'tabular-nums',
  });

  const count = totalRows && totalRows > rows.length ? `first ${rows.length.toLocaleString()} of ${totalRows.toLocaleString()}` : `${rows.length.toLocaleString()} rows`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', font: '12px/1.4 ui-sans-serif, system-ui, sans-serif', color: 'var(--text, #e5e7eb)' }}>
      {title && <div style={{ padding: '8px 10px 4px', fontWeight: 700, fontSize: 13 }}>{title}</div>}
      <div
        ref={scroller}
        onScroll={(e) => setView((v) => ({ ...v, top: (e.target as HTMLDivElement).scrollTop }))}
        style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: template, position: 'sticky', top: 0, zIndex: 1, background: 'var(--surface, #fff)', borderBottom: '1px solid var(--line, #e2e8f0)', fontWeight: 600, width: 'fit-content', minWidth: '100%' }}>
          {columns.map((c, i) => (
            <div key={i} style={cellStyle(i)} title={c}>
              {c}
            </div>
          ))}
        </div>
        <div style={{ height: start * ROW_H }} />
        {rows.slice(start, end).map((r, off) => {
          const idx = start + off;
          return (
            <div
              key={idx}
              data-row={idx}
              style={{ display: 'grid', gridTemplateColumns: template, background: idx % 2 ? 'color-mix(in srgb, var(--line, #e2e8f0) 22%, transparent)' : 'transparent', width: 'fit-content', minWidth: '100%' }}
            >
              {columns.map((_, i) => (
                <div key={i} style={cellStyle(i)} title={String(r[i] ?? '')}>
                  {String(r[i] ?? '')}
                </div>
              ))}
            </div>
          );
        })}
        <div style={{ height: Math.max(0, rows.length - end) * ROW_H }} />
      </div>
      <div style={{ padding: '4px 10px', borderTop: '1px solid var(--line, #e2e8f0)', color: 'var(--muted, #64748b)', fontSize: 11 }}>{count}</div>
    </div>
  );
}
