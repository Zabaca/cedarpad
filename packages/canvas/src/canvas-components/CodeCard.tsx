// Code snippet card: monospace with line numbers, no highlighting deps. Props:
// { code: string, lang?, title? }. Very long snippets are clipped with a note.
import * as React from 'react';

const MAX_LINES = 2000;

export default function CodeCard({ title, code = '', lang }: { title?: string; code?: string; lang?: string }) {
  const all = code.split('\n');
  const lines = all.slice(0, MAX_LINES);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--ink, #0f172a)' }}>
      {(title || lang) && (
        <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--line, #e2e8f0)', fontFamily: 'ui-sans-serif, system-ui', fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
          <b>{title ?? ''}</b>
          <span style={{ color: 'var(--muted, #64748b)' }}>{lang}</span>
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: '6px 0' }}>
        {lines.map((l, i) => (
          <div key={i} style={{ display: 'flex', whiteSpace: 'pre' }}>
            <span style={{ width: 44, flex: 'none', textAlign: 'right', paddingRight: 10, color: 'var(--muted, #94a3b8)', userSelect: 'none' }}>{i + 1}</span>
            <span>{l}</span>
          </div>
        ))}
        {all.length > lines.length && (
          <div style={{ padding: '4px 10px', color: 'var(--muted, #64748b)', fontFamily: 'ui-sans-serif' }}>… {all.length - lines.length} more lines</div>
        )}
      </div>
    </div>
  );
}
