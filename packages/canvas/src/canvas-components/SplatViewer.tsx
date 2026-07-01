import * as React from 'react';

// TEMPORARILY DISABLED. The live WebGL2 splat renderer was crashing the whole Avatar
// page on mount (GPU-context loss / the synchronous 3.8MB .ply parse, neither catchable
// by the component error boundary, so it blanked the entire page instead of just this
// card). Stubbed to a harmless placeholder so the page (123 shapes) loads.
//
// Re-enable when fixed:  git checkout d9f0527 -- src/canvas-components/SplatViewer.tsx
export default function SplatViewer() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        padding: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        background: '#0d1017',
        color: '#94a3b8',
        font: '13px/1.5 ui-sans-serif, system-ui',
        borderRadius: 8,
      }}
    >
      SplatViewer is temporarily disabled (it was crashing the page). The .ply and the
      original code are safe in git; restore to re-enable.
    </div>
  );
}
