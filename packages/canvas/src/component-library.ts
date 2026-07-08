// Client calls for the workspace shared component library (#55). Promote MOVES the
// selected component's module into the shared lib (one live source every canvas can
// place); adopt copies a shared module back so this canvas can diverge. Both stamp the
// active-canvas selection so the single bridge resolves the caller's canvas.

import { withCanvasHeader } from './active-canvas';

async function post(path: string, module: string): Promise<{ reloaded?: number }> {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: withCanvasHeader({ 'content-type': 'application/json' }),
    body: JSON.stringify({ module }),
  });
  const body = (await r.json().catch(() => ({}))) as { reloaded?: number; error?: string };
  if (!r.ok) throw new Error(body.error ?? `request failed (${r.status})`);
  return body;
}

/** Promote a component to the shared library; propagates to every canvas that placed it. */
export const promoteComponent = (module: string) => post('/api/components/promote', module);

/** Copy a shared component into this canvas so it can diverge from the shared source. */
export const adoptSharedComponent = (module: string) => post('/api/components/adopt', module);
