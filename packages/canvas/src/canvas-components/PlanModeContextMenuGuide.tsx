export default function PlanModeContextMenuGuide() {
  const code = `// In your tldraw App component (e.g. src/App.tsx or src/canvas/CanvasApp.tsx)
// Add this to the <Tldraw> overrides:

import { TldrawUiOverrides, menuGroup, menuItem } from '@tldraw/tldraw'
import { placeComponent } from './canvas-bridge' // your bridge helper

const uiOverrides: TldrawUiOverrides = {
  contextMenu(editor, schema) {
    // Only show when shapes are selected
    if (editor.getSelectedShapeIds().length === 0) return schema

    return [
      ...schema,
      menuGroup('plan-mode',
        menuItem({
          id: 'review-with-plan',
          label: 'Review with plan',
          icon: 'tool-arrow',       // or any tldraw icon name
          readonlyOk: false,
          onSelect: async () => {
            const ids   = editor.getSelectedShapeIds()
            const boxes = ids.map(id => editor.getShapePageBounds(id)!)
            const xMin  = Math.min(...boxes.map(b => b.x))
            const yMax  = Math.max(...boxes.map(b => b.y + b.h))

            // POST a PlanMode component near the selected shapes
            await fetch('/api/canvas/shapes', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'component',
                module: 'PlanMode',
                x: xMin,
                y: yMax + 24,
                w: 480,
                h: 560,
                data: {
                  title: 'Plan for selected shapes',
                  description: \`Scoped to \${ids.length} shape\${ids.length !== 1 ? 's' : ''}\`,
                  steps: [],
                },
              }),
            })
          },
        })
      ),
    ]
  },
}

// Then pass it to <Tldraw overrides={uiOverrides} .../>`;

  const file = `// Minimal self-contained version if you only have one file:
// Find your <Tldraw> render and add:
<Tldraw
  overrides={uiOverrides}
  // ...your existing props
/>`;

  return (
    <div style={{
      fontFamily: 'system-ui', height: '100%', overflow: 'auto',
      background: '#0f172a', color: '#e2e8f0', display: 'flex', flexDirection: 'column',
    }}>
      {/* Header */}
      <div style={{ padding: '18px 20px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ background: '#f59e0b', color: '#1c1917', fontSize: 9, fontWeight: 800, padding: '2px 8px', borderRadius: 4, letterSpacing: 1 }}>STEP 4</span>
          <span style={{ fontSize: 9, fontWeight: 600, color: '#64748b', letterSpacing: 1 }}>CONTEXT MENU</span>
        </div>
        <div style={{ fontWeight: 800, fontSize: 14, color: '#f8fafc' }}>Add "Review with plan" to tldraw context menu</div>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6, lineHeight: 1.6 }}>
          Apply to your <code style={{ background: '#1e293b', padding: '1px 5px', borderRadius: 3, fontSize: 10, color: '#7dd3fc' }}>&lt;Tldraw&gt;</code> wrapper component.
          Find with: <code style={{ background: '#1e293b', padding: '1px 5px', borderRadius: 3, fontSize: 10, color: '#7dd3fc' }}>grep -r "&lt;Tldraw" src/</code>
        </div>
      </div>

      {/* Code block */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#64748b', marginBottom: 10 }}>Implementation</div>
        <pre style={{
          background: '#020617', border: '1px solid #1e293b', borderRadius: 10,
          padding: '14px 16px', fontSize: 10.5, lineHeight: 1.7, color: '#e2e8f0',
          overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
        }}>{code}</pre>

        <div style={{ marginTop: 16, fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase', color: '#64748b', marginBottom: 10 }}>Wire it in</div>
        <pre style={{
          background: '#020617', border: '1px solid #1e293b', borderRadius: 10,
          padding: '14px 16px', fontSize: 10.5, lineHeight: 1.7, color: '#e2e8f0',
          overflow: 'auto', margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
        }}>{file}</pre>

        <div style={{ marginTop: 16, background: '#1e293b', borderRadius: 10, padding: '12px 16px' }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', marginBottom: 6 }}>After it's wired</div>
          <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.7 }}>
            Right-clicking any selected shape will show <strong style={{ color: '#e2e8f0' }}>Review with plan</strong> in the context menu.
            It drops a blank PlanMode card just below the selection — then the agent (or you) fills in the steps.
          </div>
        </div>
      </div>
    </div>
  );
}
