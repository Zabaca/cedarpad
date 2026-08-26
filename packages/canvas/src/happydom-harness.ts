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

// ── An inert EventSource, because happy-dom ships none ─────────────────────
//
// A component that opens an SSE stream in an effect — `Shell.tsx` does, for the
// inbox badge — throws `undefined is not a constructor` the moment it mounts.
// Until now that did not show, because SOME other test file installs a fake
// `EventSource` on `globalThis` and whether it had run yet decided whether
// `Shell.test.tsx` passed. That made 34 tests a function of file ordering, which
// is stable on a dev box and not stable on a fresh checkout: the same commit was
// 2186/0 locally and 2139/34 on the runner, every failure at `Shell.tsx:227`.
//
// Installed here rather than in each test file so a component may mount a stream
// without every one of its callers knowing that it does. Guarded on `undefined`
// so a test that wants to observe its own stream still wins by assigning over
// this — and its `finally` restore puts this back rather than a hole.
//
// Deliberately inert: it connects to nothing and emits nothing. A stub that
// invented frames would make tests pass against traffic no server ever sends.
if ((globalThis as Record<string, unknown>).EventSource === undefined) {
  (globalThis as Record<string, unknown>).EventSource = class InertEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly url: string;
    readyState = 0;
    onopen: ((e: unknown) => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(url: string) {
      this.url = url;
    }
    addEventListener(): void {}
    removeEventListener(): void {}
    close(): void {
      this.readyState = 2;
    }
  };
}
