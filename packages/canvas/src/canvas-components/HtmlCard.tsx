// Live HTML preview: renders pasted HTML source (a full document or a fragment)
// in a sandboxed iframe. Props: { html: string }. Scripts run isolated from the
// app origin (sandbox="allow-scripts", no allow-same-origin) — the page can be
// fully interactive but can't touch cedarpad's DOM, storage, or cookies.
//
// Drag vs interact: an iframe swallows pointer events, which would make the card
// impossible to move. Default mode keeps the iframe pointer-inert so the whole
// card drags/selects like any other; the corner button enters interact mode
// (real clicks/scroll inside the page) and flips back to done.
import { useState } from 'react';

export default function HtmlCard({ html = '<p style="font-family:sans-serif">Paste HTML to preview it.</p>' }: { html?: string }) {
  const [interactive, setInteractive] = useState(false);
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#fff', borderRadius: 8 }}>
      <iframe
        sandbox="allow-scripts"
        srcDoc={html}
        title="HTML preview"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
          borderRadius: 8,
          pointerEvents: interactive ? 'auto' : 'none',
        }}
      />
      <button
        type="button"
        onClick={() => setInteractive((v) => !v)}
        title={interactive ? 'Back to drag mode' : 'Click through to the page (buttons, links, scroll)'}
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          padding: '3px 9px',
          borderRadius: 999,
          border: '1px solid rgba(0,0,0,0.15)',
          background: interactive ? '#1f2937' : 'rgba(255,255,255,0.9)',
          color: interactive ? '#fff' : '#374151',
          font: '11px/1.4 ui-sans-serif, system-ui, sans-serif',
          cursor: 'pointer',
          boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
        }}
      >
        {interactive ? 'done' : 'interact'}
      </button>
    </div>
  );
}
