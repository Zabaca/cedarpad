// Real npm import example: mermaid is just a dependency now (no sandbox shim).
// Props: { chart: string } — Mermaid source. Always render with mermaid.render()
// and inject the returned svg (mermaid.run / <pre class="mermaid"> collapses to 0x0
// inside a canvas shape).
import mermaid from 'mermaid';
import { useEffect, useRef } from 'react';

export default function MermaidDiagram({ chart = 'graph LR; A-->B' }: { chart?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    mermaid.initialize({ startOnLoad: false, theme: 'base' });
    mermaid
      .render('m' + Math.random().toString(36).slice(2), chart)
      .then(({ svg }) => {
        if (alive && ref.current) ref.current.innerHTML = svg;
      })
      .catch((e: Error) => {
        if (alive && ref.current) ref.current.textContent = e.message;
      });
    return () => {
      alive = false;
    };
  }, [chart]);
  return <div ref={ref} style={{ padding: 16 }} />;
}
