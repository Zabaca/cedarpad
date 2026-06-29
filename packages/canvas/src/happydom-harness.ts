// Registers happy-dom's browser globals (window/document/Element/…) for the ONE
// agent-canvas test that needs a DOM: InteractiveBoxShapeUtil.test.tsx, which
// imports tldraw's runtime (it references the DOM at module-eval, so without this
// the import throws under bun). Imported as that file's FIRST import — an ES-module
// side effect, so the globals exist before tldraw is evaluated. Kept per-file (not a
// bunfig preload) so the other agent-canvas tests stay DOM-free.
//
// We snapshot Bun's native WHATWG HTTP primitives and restore them after register():
// happy-dom ships its own fetch/Response/… but the bridge/server tests rely on Bun's.
// happy-dom owns the DOM; Bun keeps HTTP.
import { GlobalRegistrator } from '@happy-dom/global-registrator';

const PRESERVED = ['fetch', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'WebSocket'] as const;

const natives = new Map<string, unknown>();
for (const name of PRESERVED) {
  const value = (globalThis as Record<string, unknown>)[name];
  if (value !== undefined) natives.set(name, value);
}

GlobalRegistrator.register();

for (const [name, value] of natives) {
  (globalThis as Record<string, unknown>)[name] = value;
}
