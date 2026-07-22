// Live HTML preview: renders pasted HTML source (a full document or a fragment)
// in a sandboxed iframe. Props: { html: string }. Scripts run isolated from the
// app origin (sandbox="allow-scripts", no allow-same-origin) — the page can be
// fully interactive but can't touch cedarpad's DOM, storage, or cookies.
//
// Drag vs interact: an iframe swallows pointer events, so a full-bleed iframe
// can't be dragged — and pointer-inerting it kills scrolling inside the page
// (wheel can't be forwarded into an opaque-origin frame). So the page stays
// live the whole time and the card moves by its slim grab bar, like a window.
export default function HtmlCard({ html = '<p style="font-family:sans-serif">Paste HTML to preview it.</p>' }: { html?: string }) {
  const BAR = 20;
  return (
    <div style={{ width: '100%', height: '100%', background: '#fff', borderRadius: 8, display: 'flex', flexDirection: 'column' }}>
      <div
        title="Drag to move"
        style={{
          height: BAR,
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 8px',
          background: '#f3f4f6',
          borderBottom: '1px solid #e5e7eb',
          borderRadius: '8px 8px 0 0',
          cursor: 'grab',
          userSelect: 'none',
          font: '10px/1 ui-monospace, monospace',
          color: '#9ca3af',
          letterSpacing: '0.06em',
        }}
      >
        <span style={{ letterSpacing: 2 }}>⠿</span>
        <span>html</span>
      </div>
      <iframe
        sandbox="allow-scripts"
        srcDoc={html}
        title="HTML preview"
        style={{ width: '100%', flex: 1, minHeight: 0, border: 'none', display: 'block', borderRadius: '0 0 8px 8px' }}
      />
    </div>
  );
}
