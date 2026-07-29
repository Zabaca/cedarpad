import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DefaultContextMenu, DefaultContextMenuContent, DefaultMenuPanel, DefaultNavigationPanel, DefaultPeopleMenu, DefaultSharePanel, DefaultStylePanel, DefaultToolbar, NoteShapeUtil, Tldraw, TldrawUiMenuGroup, TldrawUiMenuItem, type Editor, type TLAnyShapeUtilConstructor, type TLComponents, type TLShapeId, type TLUiContextMenuProps, createBindingId, createShapeId, defaultHandleExternalTextContent, defaultHandleExternalUrlContent, useEditor } from 'tldraw';
import { useSync } from '@tldraw/sync';
import 'tldraw/tldraw.css';

import { activeCanvasId } from './active-canvas';
import { getActiveChat, setForkHandler } from './agent-link';
import { ChatShapeUtil } from './ChatShape';
import { SHAPE_SIZE_DEFAULTS } from './shapes';
import { armFirstPrompt, closeSession, forkSession } from '../shared/chat-store';
import { ChatStarter } from './ChatStarter';
import { DOCK_CHAT_DELETED, postDockMessage } from '../shared/dock-messages';
import { adoptSharedComponent, promoteComponent } from './component-library';
import { ComponentShapeUtil } from './ComponentShape';
import { setExpandHandler } from './component-expand';
import { ComponentFullscreenOverlay } from './ComponentFullscreen';
import { ComponentGallery } from './ComponentGallery';
import { SidePanel, loadPanelOpen, savePanelOpen, type PanelSlots } from './SidePanel';
import { createCanvasAssetStore, syncUri } from './canvas-sync';
import { wireCanvasStream } from './canvas-stream';
import { createCanvasTLSchema } from './tl-schema';
import { createCanvasUserStore } from './presence';
import { detectPaste } from './paste-detect';
import { placeDetected, wirePasteCapture } from './paste-place';
import { loadGuestScope, useGuestScope } from '../shared/guest-scope';
import { HuddleControl, HuddleFloat } from './huddle';
import { ComponentGuestView } from './ComponentGuestView';
import { GuestNamePrompt } from './GuestNamePrompt';
import { setDisplayName, useCurrentUser } from './identity';

// Registered once, at editor construction: our two custom shapes. `component`
// renders agent-authored React files; `chat` is a chat session living on the canvas.
const customShapeUtils: TLAnyShapeUtilConstructor[] = [
  ComponentShapeUtil,
  ChatShapeUtil,
  // Sticky notes are fixed-size by default; let users resize them (scales text with the note).
  NoteShapeUtil.configure({ resizeMode: 'scale' }),
];

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

// SharePanel/PeopleMenu (#212): tldraw's built-in collaborator UI — face pile, labeled
// cursors, click-to-follow (auto-unfollow on local pan/zoom) — rendered straight from
// the instance_presence records tldraw sync broadcasts. Off by default in tldraw;
// enabling the components is all it takes.
// PageMenu is DELIBERATELY not nulled. It was, once — but nulling it only removed the
// page SWITCHER, not the ability to make a page: `DefaultContextMenuContent` renders
// tldraw's `MoveToPageMenu` ("Move to page → New page") unless `options.maxPages <= 1`,
// and we pass no options. So a shape could be moved to a second page that the human then
// had no UI to navigate back to — present in the room, invisible in the browser.
// If pages are ever to be hidden again, set `maxPages: 1` (which drops the context-menu
// item too); nulling the menu alone is what stranded them.
const tldrawComponents: TLComponents = {
  ContextMenu: CanvasContextMenu,
  SharePanel: DefaultSharePanel,
  PeopleMenu: DefaultPeopleMenu,
};

// Members get the docked side panel: tldraw's chrome (menu, toolbar, style panel,
// zoom nav) is nulled in place and PORTALED into the panel's slot divs. Portals keep
// the components inside the Tldraw React tree, so every tldraw hook still works —
// only the DOM moves. When the panel is collapsed (slots null) the chrome unmounts:
// collapse doubles as a focus mode (keyboard + context menu keep working).
function panelComponents(slots: PanelSlots): TLComponents {
  // The fragment wrapper bridges the bundled-React-19 vs project-React-18 ReactPortal types.
  const into = (el: HTMLElement | null, node: ReactNode) => (el ? <>{createPortal(node, el)}</> : null);
  return {
    ...tldrawComponents,
    MenuPanel: () => into(slots.menu, <DefaultMenuPanel />),
    Toolbar: () => into(slots.toolbar, <DefaultToolbar />),
    StylePanel: () => into(slots.style, <DefaultStylePanel />),
    NavigationPanel: () => into(slots.nav, <DefaultNavigationPanel />),
  };
}

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

const CHAT_W = SHAPE_SIZE_DEFAULTS.chat.w;
const CHAT_H = SHAPE_SIZE_DEFAULTS.chat.h;

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
  // Component-scoped guest (PRD #221)? Resolve BEFORE mounting tldraw: that guest renders
  // one component fullscreen and nothing else. undefined = probe in flight (render nothing
  // for a beat); null/canvas-guest/member = the normal canvas below.
  const [scope, setScope] = useState<{ shapeId?: string; canvasId: string } | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void loadGuestScope().then((s) => alive && setScope(s));
    return () => {
      alive = false;
    };
  }, []);
  if (scope === undefined) return null;
  // The canvas comes from the LINK's scope, not the URL: the guest view opens the room
  // by canvas id (#294), and the link is the only thing that says which canvas that is.
  if (scope?.shapeId) return <ComponentGuestView shapeId={scope.shapeId} canvasId={scope.canvasId} />;
  return <CanvasApp />;
}

function CanvasApp() {
  const cleanup = useRef<(() => void) | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [ready, setReady] = useState(false);
  // Which component shape (if any) is expanded fullscreen over the canvas (⛶ button).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // The docked side panel (canvas controls + component palette + placed instances).
  const [panelOpen, setPanelOpen] = useState(loadPanelOpen);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [slots, setSlots] = useState<PanelSlots>({ menu: null, style: null, toolbar: null, nav: null });
  const onSlots = useCallback(
    (s: Partial<PanelSlots>) =>
      setSlots((prev) => {
        // No-op guard: SidePanel's ref callbacks re-fire every render (new function
        // identity), so an unchanged element must NOT produce a new state object —
        // that re-rendered Tldraw's components and looped ("Maximum update depth").
        for (const [k, v] of Object.entries(s)) if (prev[k as keyof PanelSlots] !== v) return { ...prev, ...s };
        return prev;
      }),
    [],
  );
  const guest = useGuestScope();
  const currentUser = useCurrentUser();

  // The canvas document (ADR-0019): a live connection to this canvas's TLSocketRoom in
  // its Durable Object. The SCHEMA comes from the shared factory — the same call the room
  // makes (worker/sync-room.ts) — which is what makes the `component`/`chat` shapes
  // validate identically on both sides (CLAUDE.md §7, #287).
  //
  // Presence (#212) rides the sync protocol itself since #293: `users` is the only wiring
  // it needs — sync derives this browser's `instance_presence` from the current user and
  // broadcasts it on the room's presence channel, which the room never persists.
  const canvasId = useMemo(activeCanvasId, []);
  const store = useSync({
    uri: useMemo(() => syncUri(window.location.origin, canvasId), [canvasId]),
    assets: useMemo(() => createCanvasAssetStore(canvasId), [canvasId]),
    schema: useMemo(() => createCanvasTLSchema(), []),
    users: useMemo(() => createCanvasUserStore(), []),
  });
  const menuSlotRef = useCallback((el: HTMLElement | null) => onSlots({ menu: el }), [onSlots]);
  const togglePanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    savePanelOpen(open);
    // The menu slot lives on the stage, not in the panel — it survives a collapse.
    if (!open) setSlots((prev) => ({ menu: prev.menu, style: null, toolbar: null, nav: null }));
  }, []);
  // Guests keep tldraw's default floating chrome; members' chrome portals into the panel.
  const components = useMemo<TLComponents>(() => (guest ? tldrawComponents : panelComponents(slots)), [guest, slots]);

  // Drop a fresh chat card. If a shape is selected (or a chat is focused), the new
  // card lands just to the right of it and is joined by a bound arrow — so chats
  // grow into a connected graph rather than scattered cards. With no anchor (first
  // chat / blank canvas) it lands in the middle of the current view, unconnected.
  //
  // `prompt` (from the canvas chat starter) is ARMED on the new shape rather than sent:
  // `send` no-ops until the session is subscribed, which only happens once the card
  // mounts and opens its stream — ChatView claims the armed prompt there.
  const newChat = useCallback((prompt?: string) => {
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
    if (prompt) armFirstPrompt(id, prompt);

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

  // What the starter's scope tag says: where the chat it creates is about to land. Same
  // anchor resolution as newChat, so the tag can't disagree with the placement.
  const starterScope = useCallback((): string | undefined => {
    const editor = editorRef.current;
    if (!editor) return undefined;
    const anchor = anchorShapeId(editor);
    const shape = anchor ? editor.getShape(anchor) : undefined;
    if (!shape) return 'on a clear spot';
    const title = shape.type === 'chat' ? String((shape.props as { title?: string }).title ?? '') : '';
    return `next to ${title || shape.type}`;
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
      // e2e seam (#293). tldraw 5.2.5 draws collaborator cursors onto a <canvas>
      // (`CollaboratorCursorOverlayUtil`, Path2D) — there is no DOM node to assert on, so
      // the presence spec reads collaborators through the editor instead. Dev-only, and
      // read-only: nothing in the app reads this back.
      if (import.meta.env.DEV) (window as unknown as { __canvasEditor?: Editor }).__canvasEditor = editor;
      // The document is `useSync`'s job now (ADR-0019), and presence is sync's too (#293).
      // What still rides the bridge's SSE stream is the agent screenshot round-trip —
      // see canvas-stream.ts.
      const unsync = wireCanvasStream(editor);
      setForkHandler((pid) => forkChat(pid as TLShapeId)); // chat cards' fork button routes here
      setExpandHandler((id) => setExpandedId(id)); // component cards' ⛶ button routes here

      // Smart paste: a spreadsheet/CSV table or a JSON document becomes a live
      // DataTable/JsonCard component instead of a wall of text; anything else
      // falls through to tldraw's stock text handling. The extra capture-phase
      // hook rescues raw JSON, which tldraw's clipboard flow silently drops.
      editor.registerExternalContentHandler('text', (content) => {
        const d = detectPaste(content);
        if (d) return placeDetected(editor, d, content.point);
        return defaultHandleExternalTextContent(editor, content);
      });
      // A pasted bare URL rides tldraw's 'url' channel (not 'text'): a GitHub repo
      // reference becomes a GithubRepoCard; anything else stays a stock bookmark. The
      // handler opts only feed failure toasts, which we don't mount here — stubbed.
      editor.registerExternalContentHandler('url', (content) => {
        const d = detectPaste({ text: content.url });
        if (d) return placeDetected(editor, d, content.point);
        return defaultHandleExternalUrlContent(editor, content, { toasts: { addToast: () => '' }, msg: (id: string) => id } as never);
      });
      const unJsonPaste = wirePasteCapture(editor);

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
            if (rec.typeName === 'shape' && (rec as { type?: string }).type === 'chat') {
              // An attached card fronts an existing chat via props.chatId (attach flow).
              const props = (rec as { props?: { chatId?: string } }).props;
              const chatId = props?.chatId || rec.id;
              closeSession(chatId);
              // Tell the embedding Shell (if any): a docked panel fronting this chat undocks.
              postDockMessage({ type: DOCK_CHAT_DELETED, chatId });
            }
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
        setExpandHandler(null);
        unJsonPaste();
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
        <Tldraw store={store} shapeUtils={customShapeUtils} components={components} onMount={onMount} />
        {/* The menu/actions strip lives on the canvas itself (top-left, independent of
            the panel): tldraw's dropdowns portal into its own overflow-clipped container,
            so a trigger outside it (the panel) opens an invisible, clipped menu. */}
        {!guest && <div className="side-panel-slot stage-menu" ref={menuSlotRef} />}
        {/* The chat starter: type a prompt, and the chat is created WITH that first turn
            (it replaces both the old FAB and the panel's "＋ New chat"). It lives on the
            STAGE, not the app, so it centers on the canvas rather than under the docked
            panel. Guests get it only when their share link grants guestChat (#220). */}
        {(guest ? guest.guestChat : true) && <ChatStarter onStart={newChat} scope={starterScope} disabled={!ready} />}
      </div>
      {/* The docked side panel (members only — placement is a write): all canvas
          controls, the component palette, and the placed-instance list. */}
      {!guest && panelOpen && (
        <SidePanel
          editor={ready ? editorRef.current : null}
          onSlots={onSlots}
          onClose={() => togglePanel(false)}
          onAddComponent={() => setGalleryOpen(true)}
        />
      )}
      {/* The component gallery modal (+ Component). */}
      {!guest && galleryOpen && (
        <ComponentGallery
          viewportCenter={() => {
            const b = editorRef.current?.getViewportPageBounds();
            return b ? { x: b.midX, y: b.midY } : { x: 500, y: 350 };
          }}
          onClose={() => setGalleryOpen(false)}
        />
      )}
      {!guest && !panelOpen && (
        <button type="button" className="palette-fab" onClick={() => togglePanel(true)} disabled={!ready} title="Open the canvas panel (controls, components, instances)">
          ❖ Panel
        </button>
      )}
      {expandedId && editorRef.current && (
        <ComponentFullscreenOverlay editor={editorRef.current} shapeId={expandedId} onClose={() => setExpandedId(null)} />
      )}
      {/* Huddle (ADR-0017): guests join via a floating button when their link grants it;
          members have the button in the side panel. */}
      {guest?.guestHuddle && <HuddleControl canvasId={guest.canvasId} className="huddle-fab" />}
      {/* Mid-call with the panel collapsed: the huddle stays visible (and leavable) as a
          floating card — the connection itself lives in the module manager either way. */}
      {!guest && !panelOpen && <HuddleFloat canvasId={activeCanvasId()} />}
      {/* #320: a guest names themselves on arrival, so presence can mark WHO is here and
          not just that someone is. Members' names come from their account. */}
      {guest && <GuestNamePrompt user={currentUser} onName={setDisplayName} />}
    </div>
  );
}
