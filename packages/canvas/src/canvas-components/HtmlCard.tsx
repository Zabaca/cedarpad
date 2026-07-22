// Live HTML preview: renders pasted HTML source (a full document or a fragment)
// in a sandboxed iframe. Props: { html: string }. Scripts run isolated from the
// app origin (sandbox="allow-scripts", no allow-same-origin) — the page can be
// fully interactive but can't touch cedarpad's DOM, storage, or cookies.
export default function HtmlCard({ html = '<p style="font-family:sans-serif">Paste HTML to preview it.</p>' }: { html?: string }) {
  return (
    <iframe
      sandbox="allow-scripts"
      srcDoc={html}
      title="HTML preview"
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
        display: 'block',
        background: '#fff',
        borderRadius: 8,
      }}
    />
  );
}
