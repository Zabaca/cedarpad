// A custom component that drives the tldraw editor directly: on click it creates
// two real tldraw rectangles and a real arrow BOUND to both, so the arrow follows
// when you drag either box. Demonstrates the full stack working together:
//   - useEditor() resolves the live editor via React context (the component is the
//     content of a custom ShapeUtil, so it renders inside the <Tldraw> tree)
//   - editor.createShapes makes real shapes (not our simplified model) that sync up
//   - editor.createBindings makes arrow bindings (the bound-arrow feature)
// Everything created here round-trips through the normal sync listener.
import { useState } from 'react';
import { createBindingId, createShapeId, toRichText, useEditor } from 'tldraw';

export default function ShapeConnector() {
  const editor = useEditor();
  const [n, setN] = useState(0);

  const connect = () => {
    // Drop the pair in the middle of whatever the user is currently looking at,
    // stepping down a row each time so repeats don't stack.
    const vb = editor.getViewportPageBounds();
    const cx = vb.x + vb.w / 2;
    const cy = vb.y + vb.h / 2 + n * 140;

    const a = createShapeId();
    const b = createShapeId();
    editor.createShapes([
      { id: a, type: 'geo', x: cx - 320, y: cy - 45, props: { geo: 'rectangle', w: 170, h: 90, color: 'blue', richText: toRichText(`Source ${n + 1}`) } },
      { id: b, type: 'geo', x: cx + 150, y: cy - 45, props: { geo: 'rectangle', w: 170, h: 90, color: 'green', richText: toRichText(`Target ${n + 1}`) } },
    ]);

    const arrow = createShapeId();
    editor.createShapes([{ id: arrow, type: 'arrow', x: 0, y: 0, props: { color: 'black' } }]);
    editor.createBindings([
      { id: createBindingId(), type: 'arrow', fromId: arrow, toId: a, props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
      { id: createBindingId(), type: 'arrow', fromId: arrow, toId: b, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
    ]);

    editor.select(a, b, arrow);
    setN((x) => x + 1);
  };

  return (
    <div style={{ height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12, padding: 22, background: '#0f172a', color: '#e2e8f0', fontFamily: 'ui-sans-serif, system-ui' }}>
      <div style={{ fontSize: 11, letterSpacing: 2, fontWeight: 700, color: '#64748b' }}>TLDRAW · LIVE EDITOR</div>
      <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.4 }}>Create two shapes and connect them with a bound arrow</div>
      <div style={{ fontSize: 12.5, color: '#94a3b8', lineHeight: 1.5 }}>
        Click to drop a Source and Target box joined by an arrow. Drag either box on the canvas, the arrow follows.
      </div>
      <button
        onClick={connect}
        style={{ alignSelf: 'flex-start', cursor: 'pointer', border: 'none', borderRadius: 10, padding: '11px 20px', fontSize: 14, fontWeight: 700, color: '#06281a', background: '#34d399' }}
      >
        + Connect two shapes
      </button>
      <div style={{ fontSize: 12, color: '#64748b' }}>Created {n} connected pair{n === 1 ? '' : 's'} this session.</div>
    </div>
  );
}
