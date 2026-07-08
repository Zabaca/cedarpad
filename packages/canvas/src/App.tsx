import { useCallback, useRef, useState } from 'react';
import { DefaultContextMenu, DefaultContextMenuContent, Tldraw, TldrawUiMenuGroup, TldrawUiMenuItem, type Editor, type TLAnyShapeUtilConstructor, type TLComponents, type TLShapeId, type TLUiContextMenuProps, createBindingId, createShapeId, useEditor } from 'tldraw';
import 'tldraw/tldraw.css';

import { activeCanvasId } from './active-canvas';
import { getActiveChat, setForkHandler } from './agent-link';
import { ChatShapeUtil } from './ChatShape';
import { closeSession, forkSession } from './chat-store';
import { adoptSharedComponent, promoteComponent } from './component-library';
import { ComponentShapeUtil } from './ComponentShape';
import { wireSync } from './sync';

// Registered once, at editor construction: our two custom shapes. `component`
// renders agent-authored React files; `chat` is a chat session living on the canvas.
const customShapeUtils: TLAnyShapeUtilConstructor[] = [ComponentShapeUtil, ChatShapeUtil];

// This is the Render Pad (ADR-0007, PRD #103): the container serves ONLY the tldraw canvas
// + chat now. The rail, canvas selector, and Notebook stage moved to the edge Shell SPA
// (packages/canvas/shell), which iframes this pad at /w/:ws/canvas/:id/pad. Chat stays here.

// Hide tldraw's built-in page dropdown ("Avatar ⌄"): a canvas has no pages. The
// hamburger MainMenu and the undo/redo/delete/duplicate QuickActions are left in place.
// The shared-library UI action (#55): when exactly one `component` shape is selected, add
// "Promote to shared library" (move it to @shared) / "Copy to this canvas" (diverge from
// shared) to the right-click menu — the UI mirror of the agent's promote/adopt tools.
function CanvasContextMenu(props: TLUiContextMenuProps) {
  const editor = useEditor();
  const selected = editor.getSelectedShapes();
  const only = selected.length === 1 ? selected[0] : undefined;
  const module = only?.type === 'component' ? (only.props as { module: string }).module : undefined;
  return (
    <DefaultContextMenu {...props}>
      {module && (
        <TldrawUiMenuGroup id="shared-library">
          <TldrawUiMenuItem
            id="promote-component"
            label={`Promote "${module}" to shared library`}
            icon="external-link"
            readonlyOk={false}
            onSelect={() => void promoteComponent(module).catch((e) => window.alert(`Promote failed: ${(e as Error).message}`))}
          />
          <TldrawUiMenuItem
            id="adopt-component"
            label={`Copy "${module}" to this canvas`}
            icon="duplicate"
            readonlyOk={false}
            onSelect={() => void adoptSharedComponent(module).catch((e) => window.alert(`Copy failed: ${(e as Error).message}`))}
          />
        </TldrawUiMenuGroup>
      )}
      <DefaultContextMenuContent />
    </DefaultContextMenu>
  );
}

const tldrawComponents: TLComponents = { PageMenu: null, ContextMenu: CanvasContextMenu };

// Persist the camera (pan + zoom) PER CANVAS across reloads, so a canvas returns to
// where you left it rather than the default center. Canvas shapes live in the
// in-memory bridge, so the camera is the one piece of view state the client owns.
// Stored as a { canvasId -> {x,y,z} } map.
const CAM_KEY = 'agent-canvas:cameras';

type Cam = { x: number; y: number; z: number };
type CamMap = Record<string, Cam>;

function loadCameras(): CamMap {
  try {
    const raw = localStorage.getItem(CAM_KEY);
    const o = raw ? (JSON.parse(raw) as unknown) : null;
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as CamMap) : {};
  } catch {
    return {};
  }
}

const isCam = (c: unknown): c is Cam =>
  !!c && typeof c === 'object' && ['x', 'y', 'z'].every((k) => Number.isFinite((c as Record<string, unknown>)[k]));

function applyCamera(editor: Editor, cams: CamMap, key: string): void {
  const c = cams[key];
  if (isCam(c)) editor.setCamera({ x: c.x, y: c.y, z: c.z }, { immediate: true });
}

// A strictly-increasing chat number that never reuses a value. Seeded above both
// the persisted high-water mark and any existing chat's number, so it stays unique
// even after clearing localStorage or reloading a canvas full of chats. The old
// `count + 1` scheme recomputed an ordinal from the live count, so deleting then
// recreating reused numbers and produced duplicate "Chat N" titles.
const CHAT_SEQ_KEY = 'agent-canvas:chat-seq';

// Set once we've auto-seeded a starter chat. Its presence means "this browser has
// been here before", so a deliberately-emptied canvas is never re-seeded on reload.
const SEEDED_KEY = 'agent-canvas:seeded';

function nextChatNumber(editor: Editor): number {
  let stored = 0;
  try {
    stored = parseInt(localStorage.getItem(CHAT_SEQ_KEY) ?? '0', 10) || 0;
  } catch {
    /* storage unavailable */
  }
  const existing = editor
    .getCurrentPageShapes()
    .filter((s) => s.type === 'chat')
    .map((s) => parseInt(String((s.props as { title?: string }).title ?? '').replace(/\D+/g, ''), 10) || 0);
  const n = Math.max(stored, 0, ...existing) + 1;
  try {
    localStorage.setItem(CHAT_SEQ_KEY, String(n));
  } catch {
    /* storage unavailable */
  }
  return n;
}

const CHAT_W = 380;
const CHAT_H = 460;

// Resolve the shape a new chat should hang off of: the single selected shape if
// there is one, else the currently-focused chat (if it's still on the canvas).
// Returns undefined when there's nothing to anchor to (first chat, blank canvas).
function anchorShapeId(editor: Editor): TLShapeId | undefined {
  const sel = editor.getSelectedShapes();
  if (sel.length === 1) return sel[0]?.id;
  const active = getActiveChat() as TLShapeId;
  return editor.getShape(active) ? active : undefined;
}

// Find a clear top-left for a CHAT_W x CHAT_H card starting at (x, y), stepping
// down past any shape it would overlap so repeated children of one anchor don't
// stack exactly on top of each other.
function freeSpot(editor: Editor, x: number, y: number): { x: number; y: number } {
  const others = editor
    .getCurrentPageShapes()
    .map((s) => editor.getShapePageBounds(s.id))
    .filter((b): b is NonNullable<typeof b> => !!b);
  const overlaps = (ty: number) =>
    others.some((b) => x < b.x + b.w && x + CHAT_W > b.x && ty < b.y + b.h && ty + CHAT_H > b.y);
  let ty = y;
  for (let guard = 0; guard < 50 && overlaps(ty); guard += 1) ty += CHAT_H + 40;
  return { x, y: ty };
}

export default function App() {
  const cleanup = useRef<(() => void) | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [ready, setReady] = useState(false);

  // Drop a fresh chat card. If a shape is selected (or a chat is focused), the new
  // card lands just to the right of it and is joined by a bound arrow — so chats
  // grow into a connected graph rather than scattered cards. With no anchor (first
  // chat / blank canvas) it lands in the middle of the current view, unconnected.
  const newChat = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const id = createShapeId();
    const anchor = anchorShapeId(editor);
    const ab = anchor ? editor.getShapePageBounds(anchor) : null;

    let x: number;
    let y: number;
    if (ab) {
      ({ x, y } = freeSpot(editor, ab.x + ab.w + 80, ab.y + ab.h / 2 - CHAT_H / 2));
    } else {
      const vb = editor.getViewportPageBounds();
      x = vb.x + vb.w / 2 - CHAT_W / 2;
      y = vb.y + vb.h / 2 - CHAT_H / 2;
    }

    editor.createShape({ id, type: 'chat', x, y, props: { w: CHAT_W, h: CHAT_H, title: `Chat ${nextChatNumber(editor)}` } });

    // Connect the new chat to its anchor with an arrow bound at both ends, so the
    // link follows either card when dragged and shows up as a real graph edge
    // (arrow.startShapeId = anchor, endShapeId = new chat).
    if (anchor) {
      const arrow = createShapeId();
      editor.createShape({ id: arrow, type: 'arrow', x: 0, y: 0, props: { color: 'black' } });
      editor.createBindings([
        { id: createBindingId(), type: 'arrow', fromId: arrow, toId: anchor, props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
        { id: createBindingId(), type: 'arrow', fromId: arrow, toId: id, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
      ]);
    }
    editor.select(id);
  }, []);

  // Fork a chat: same placement + bound-arrow logic as newChat, but the anchor is
  // FORCED to the parent chat (not the focused/selected shape), the title is marked
  // "(fork)", and the new session is seeded from the parent (transcript + SDK session)
  // with a one-shot fork armed so its first turn branches the parent instead of
  // appending to it. The parent session is untouched. No-op if the parent is gone.
  const forkChat = useCallback((parentId: TLShapeId) => {
    const editor = editorRef.current;
    if (!editor) return;
    const ab = editor.getShapePageBounds(parentId);
    if (!ab) return; // parent shape isn't on the canvas

    const id = createShapeId();
    const { x, y } = freeSpot(editor, ab.x + ab.w + 80, ab.y + ab.h / 2 - CHAT_H / 2);
    editor.createShape({ id, type: 'chat', x, y, props: { w: CHAT_W, h: CHAT_H, title: `Chat ${nextChatNumber(editor)} (fork)` } });

    const arrow = createShapeId();
    editor.createShape({ id: arrow, type: 'arrow', x: 0, y: 0, props: { color: 'black' } });
    editor.createBindings([
      { id: createBindingId(), type: 'arrow', fromId: arrow, toId: parentId, props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
      { id: createBindingId(), type: 'arrow', fromId: arrow, toId: id, props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false } },
    ]);

    forkSession(parentId, id); // seed the forked session from the parent BEFORE selecting
    editor.select(id);
  }, []);

  const onMount = useCallback(
    (editor: Editor) => {
      cleanup.current?.(); // clean a prior mount (StrictMode double-invoke)
      editorRef.current = editor;
      setReady(true);
      const unsync = wireSync(editor);
      setForkHandler((pid) => forkChat(pid as TLShapeId)); // chat cards' fork button routes here

      // Per-canvas camera: restore the one we land on, then save (debounced) on move.
      const camKey = activeCanvasId();
      const cameras = loadCameras();
      applyCamera(editor, cameras, camKey);

      let camTimer: ReturnType<typeof setTimeout> | null = null;
      const uncam = editor.store.listen(
        () => {
          if (camTimer) clearTimeout(camTimer);
          camTimer = setTimeout(() => {
            const c = editor.getCamera();
            cameras[camKey] = { x: c.x, y: c.y, z: c.z };
            try {
              localStorage.setItem(CAM_KEY, JSON.stringify(cameras));
            } catch {
              /* storage full/unavailable: skip */
            }
          }, 200);
        },
        { scope: 'session' },
      );

      // End a chat session when its card is deleted (any source, including a
      // delete that arrives from another client over sync).
      const unlisten = editor.store.listen(
        (entry) => {
          for (const rec of Object.values(entry.changes.removed)) {
            if (rec.typeName === 'shape' && (rec as { type?: string }).type === 'chat') closeSession(rec.id);
          }
        },
        { scope: 'document' },
      );

      // Seed a starter chat on genuine first run only. We drop one in if the canvas
      // has loaded with no chat AND this browser has never been seeded before, then
      // mark it seeded — so deleting your last chat and refreshing leaves the canvas
      // empty instead of resurrecting a chat every load.
      const t = setTimeout(() => {
        let seeded = false;
        try {
          seeded = localStorage.getItem(SEEDED_KEY) === '1';
        } catch {
          /* storage unavailable: treat as not seeded */
        }
        if (!seeded && !editor.getCurrentPageShapes().some((s) => s.type === 'chat')) newChat();
        try {
          localStorage.setItem(SEEDED_KEY, '1');
        } catch {
          /* storage unavailable: skip */
        }
      }, 700);

      cleanup.current = () => {
        clearTimeout(t);
        if (camTimer) clearTimeout(camTimer);
        setForkHandler(null);
        uncam();
        unlisten();
        unsync();
      };
    },
    [newChat, forkChat],
  );

  return (
    <div className="app">
      <div className="tl-stage">
        <Tldraw shapeUtils={customShapeUtils} components={tldrawComponents} onMount={onMount} />
      </div>
      <button type="button" className="new-chat-fab" onClick={newChat} disabled={!ready} title="Create a new chat session">
        ＋ New chat
      </button>
    </div>
  );
}
