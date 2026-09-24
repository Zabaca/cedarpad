// The one custom tldraw shape behind file-based components. A `component` shape
// references a real module the agent authored under src/canvas-components/ (by
// name + props + rev), and this ShapeUtil dynamic-imports that vite-compiled
// module and renders it. Editing the file + bumping rev re-imports it live.

import * as React from 'react';
import { type Editor, type TLBaseShape } from 'tldraw';

import { type AgentComponent, LOAD_ATTEMPTS, loadComponent } from './component-loader';
import { activeCanvasId } from './active-canvas';
import { requestExpand } from './component-expand';
import { setDisplayName, useCurrentUser } from './identity';
import { type EventGuards, InteractiveBoxShapeUtil } from './InteractiveBoxShapeUtil';
import { isInteractiveControl } from './predicates';
import { componentShapeProps } from './shape-props';
import { fetchMart, type MartData } from './mart-data';
import { fetchNotebook } from './notebook-data';
import type { DataSource } from '../shared/mart-contract';
import type { NotebookParams, NotebookRow } from '../shared/notebook-source';
import { readPage } from './tldraw-bridge';
import { resolveReplyTarget } from './reply-target';
import { getActiveChat, postMessageToChat } from './agent-link';
// ComponentStatus is the read bridge's concern too, so it lives in the model
// (shapes.ts); pureFromTldrawShape lifts `meta.status` onto the model field there.
import type { CanvasShape, ComponentStatus } from './shapes';

/**
 * The typed shape of a `component`'s tldraw `meta`. `status` is strictly OPTIONAL:
 * shapes/docs persisted before this field reads back `undefined` and stay valid, so
 * no data transform is needed. It is additive on tldraw's freeform `meta` record
 * (this app hydrates the editor from the simplified model, not a tldraw snapshot, so
 * there is no tldraw props-migration sequence to run). This optionality IS the
 * migration: the package's back-compat idiom for an added field.
 */
export interface ComponentShapeMeta {
  status?: ComponentStatus;
}

export type ComponentShapeTl = Omit<
  TLBaseShape<'component', { w: number; h: number; module: string; data: Record<string, unknown>; rev: number; dataSource: DataSource | null }>,
  'meta'
> & { meta: ComponentShapeMeta };

/** True when the shape's current status is already what we're about to write: the
 * idempotency guard so a redundant `updateShape` (status mirrors per-host React
 * state) doesn't churn the record. Compares the whole discriminant, so a retry that
 * keeps `phase: 'loading'` but bumps `attempt` still writes. */
export function sameStatus(current: ComponentStatus | undefined, next: ComponentStatus): boolean {
  if (!current || current.phase !== next.phase) return false;
  return JSON.stringify(current) === JSON.stringify(next);
}

// Register `component` as a first-class tldraw shape type via the official
// augmentation hook, so it joins the TLShape union and ShapeUtil / resizeBox /
// TLResizeInfo all type-check against it without casts.
declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    component: { w: number; h: number; module: string; data: Record<string, unknown>; rev: number; dataSource: DataSource | null };
  }
}

// The throw site is in the error's stack, not its message. Pull the first of OUR
// source frames (vite serves them as `…/Thing.tsx?r=..:LINE:COL`), e.g.
// `captureRig.tsx:73`, so the card names where it actually broke, not just the
// generic hook message. Skip this file (the boundary) and react internals.
function topAppFrame(stack?: string | null): string {
  if (!stack) return '';
  for (const line of stack.split('\n')) {
    const m = line.match(/\/([\w.-]+\.tsx)(?:\?[^:]*)?:(\d+):\d+/);
    if (m && m[1] !== 'ComponentShape.tsx') return `${m[1]}:${m[2]}`;
  }
  return '';
}

// "Cannot read properties of null (reading 'useX')" is the dispatcher-null shape:
// some component threw earlier in this render pass and left React's hook dispatcher
// null, so every component after it throws this too. Can't tell culprit from
// collateral per-card (both look identical) — only render ORDER does, so point at
// the console where the FIRST such line is the root cause.
const isHookNullError = (msg: string) => /Cannot read propert.*of null \(reading 'use[A-Z]/.test(msg);

/** Friendly red card shown when a component fails to load or render. Names the
 * module and the exact source frame the throw came from. */
function ErrorCard({ module, message, where }: { module: string; message: string; where: string }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        padding: 12,
        overflow: 'auto',
        background: 'var(--surface)',
        border: '1px solid var(--danger)',
        borderRadius: 10,
        color: 'var(--muted)',
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'pre-wrap',
      }}
    >
      <strong style={{ color: 'var(--danger)' }}>Component error · {module}</strong>
      {where && (
        <>
          {'\n'}
          <span style={{ color: 'var(--warning)' }}>at {where}</span>
        </>
      )}
      {'\n'}
      {message}
      {isHookNullError(message) && (
        <>
          {'\n\n'}
          <span style={{ color: 'var(--muted)', opacity: 0.8 }}>
            Hook-dispatcher null. If several cards show this, the cause is the FIRST `[component error]` line in the
            console (render order); the rest are collateral.
          </span>
        </>
      )}
    </div>
  );
}

/** Catches render-time throws so one bad component never takes down the canvas. */
class ComponentErrorBoundary extends React.Component<
  { module: string; onRenderError?: (message: string, where: string) => void; children: React.ReactNode },
  { error: Error | null; where: string }
> {
  state = { error: null as Error | null, where: '' };
  static getDerivedStateFromError(error: Error) {
    return { error, where: topAppFrame(error.stack) };
  }
  // Logged in render order: the FIRST line is the cascade's root cause. The source
  // frame + React component stack localize it (this is what the message alone hid).
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const where = topAppFrame(error.stack);
    console.error(`[component error] ${this.props.module}${where ? ` @ ${where}` : ''}: ${error.message}`, info.componentStack);
    // Mirror the render failure onto the shape's status. The host owns the shape
    // write (it holds editor + shapeId); the boundary only reports. Prefer the
    // component-stack frame (it names the failing component) and fall back to the
    // throw-stack frame when the env emits no source-located component stack.
    this.props.onRenderError?.(error.message, topAppFrame(info.componentStack) || where);
  }
  render() {
    if (this.state.error)
      return <ErrorCard module={this.props.module} message={this.state.error.message} where={this.state.where} />;
    return this.props.children;
  }
}

/** Loads `module@rev` and renders it with `data` as props; shows loading / errors.
 * Also injects `setData`, letting an interactive component persist its own state
 * by merging a patch into its shape's `data` (which then syncs + survives reload). */
/** A placed component's live-mart fetch state (#239). Absent `dataSource` never enters
 * this at all — the idle/no-op path IS the backward-compat guarantee. */
type MartState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; mart: MartData } | { phase: 'error'; message: string };

/** The Notebook's equivalent (ADR-0024). No sidecar: a notebook read is live, so there is
 * no "as of" to carry — the freshness question a mart has simply does not arise. */
type NotebookState = { phase: 'idle' } | { phase: 'loading' } | { phase: 'ready'; rows: NotebookRow[] } | { phase: 'error'; message: string };

/** The freshness badge (#239 requirement 4): a mart is a snapshot as of its last
 * materialize run, and a number with no "as of" is how someone makes a decision on stale
 * data — so this renders unconditionally whenever a component names a mart, independent
 * of whether the component itself does anything with the resolved rows. */
function MartFreshnessBadge({ state }: { state: MartState }) {
  if (state.phase === 'idle') return null;
  const text =
    state.phase === 'loading'
      ? 'loading mart…'
      : state.phase === 'error'
        ? `mart error: ${state.message}`
        : `as of ${new Date(state.mart.sidecar.generatedAt).toLocaleString()} · ${state.mart.sidecar.rowCount.toLocaleString()} row${state.mart.sidecar.rowCount === 1 ? '' : 's'}`;
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 4,
        left: 8,
        right: 8,
        font: '10px ui-monospace, SFMono-Regular, Menlo, monospace',
        color: state.phase === 'error' ? 'var(--danger)' : 'var(--muted)',
        opacity: 0.85,
        pointerEvents: 'none',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>
  );
}

export function ComponentHost({
  shapeId,
  editor,
  module,
  data,
  rev,
  dataSource,
  load = (module, rev) => loadComponent(module, rev, activeCanvasId()),
  loadMart = fetchMart,
  loadNotebook = fetchNotebook,
  readShapes = () => readPage(editor),
  post = postMessageToChat,
  unguarded = false,
}: {
  shapeId: string;
  editor: Editor;
  module: string;
  data: Record<string, unknown>;
  rev: number;
  /** The mart this instance renders (#239 / ADR-0017). Absent = today's static-data
   * behavior, unchanged. */
  dataSource?: DataSource;
  /** The module loader. Defaults to the real vite dynamic-import loader; injected in tests. */
  load?: (module: string, rev: number) => Promise<AgentComponent>;
  /** The mart reader. Defaults to the real edge-route fetch; injected in tests. */
  loadMart?: (name: string) => Promise<MartData>;
  /** The Notebook reader (ADR-0024). Defaults to the real edge-route fetch; injected in tests. */
  loadNotebook?: (query: string, params?: NotebookParams) => Promise<NotebookRow[]>;
  /** Reads all page shapes to resolve this component's reply target; injected in tests. */
  readShapes?: () => CanvasShape[];
  /** Posts a component's reply into a chat session; injected in tests. */
  post?: (chatId: string, message: string) => Promise<void>;
  /**
   * True when this host renders the component OUTSIDE the shape's event guard — fullscreen
   * and component-guest, both of which mount `ComponentHost` with no tldraw around it.
   *
   * A component needs to know because the guard is not neutral. On a card,
   * `InteractiveBoxShapeUtil` swallows every wheel event before it reaches the content
   * (so tldraw does not zoom the board), and lets a pointerdown on anything that is not an
   * `isInteractiveControl` through to tldraw (so the card can still be dragged). A component
   * that wants to run its own camera therefore CANNOT on a card: its wheel listener never
   * fires, and its background drag is stolen mid-gesture, which also means it never sees the
   * matching pointerup. Anything gesture-driven should offer itself only when this is true.
   */
  unguarded?: boolean;
}) {
  const [Comp, setComp] = React.useState<AgentComponent | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [martState, setMartState] = React.useState<MartState>({ phase: 'idle' });
  const [notebookState, setNotebookState] = React.useState<NotebookState>({ phase: 'idle' });
  const currentUser = useCurrentUser();
  // Attempts at loading THIS module@rev. Reset to the first attempt on every fresh
  // load below; retries (a later slice) bump it so a `loading` status carries which try.
  const attemptRef = React.useRef(0);

  // Merge a patch into this shape's `data`. Reads the shape fresh each call so
  // rapid successive updates compose instead of clobbering a stale snapshot.
  // Keys whose value is `undefined` are dropped: `data` is validated as JSON, and an
  // undefined value makes that check throw — which blanks the whole tab, not just the card.
  const setData = React.useCallback(
    (patch: Record<string, unknown>) => {
      const cur = editor.getShape(shapeId as never) as { type?: string; props?: { data?: Record<string, unknown> } } | undefined;
      if (!cur || cur.type !== 'component') return;
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      editor.updateShape({ id: shapeId as never, type: 'component', props: { data: { ...(cur.props?.data ?? {}), ...defined } } });
    },
    [editor, shapeId],
  );

  // The component's reply capability: resolve WHICH chat this instance answers to (its
  // attached chat via the inbound arrow, else the focused chat) fresh at send time, then
  // post there. Injected so a component's button reaches the right chat instead of reaching
  // into a global. Null target => surface, never POST to a dead/wrong chat.
  const sendToAgent = React.useCallback(
    async (message: string) => {
      const target = resolveReplyTarget(readShapes(), shapeId, getActiveChat() || undefined);
      if (!target) throw new Error('No chat to reply to — focus or attach a chat card first.');
      await post(target, message);
    },
    [readShapes, post, shapeId],
  );

  // Mirror this host's lifecycle onto the shape's `meta.status` (same updateShape path
  // as setData, but on `meta` not `props`). Idempotent: skips a write when the stored
  // status already equals what we'd set, so it never churns the record.
  const writeStatus = React.useCallback(
    (status: ComponentStatus) => {
      const cur = editor.getShape(shapeId as never) as unknown as ComponentShapeTl | undefined;
      if (!cur || cur.type !== 'component') return;
      if (sameStatus(cur.meta?.status, status)) return;
      editor.updateShape({ id: shapeId as never, type: 'component', meta: { ...(cur.meta ?? {}), status } as never });
    },
    [editor, shapeId],
  );

  React.useEffect(() => {
    let alive = true;
    attemptRef.current = 1;
    setComp(null);
    setError(null);
    writeStatus({ phase: 'loading', attempt: attemptRef.current });
    load(module, rev)
      .then((C) => {
        if (!alive) return;
        setComp(() => C);
        writeStatus({ phase: 'ready' });
      })
      .catch((e: Error) => {
        if (!alive) return;
        // The load rejected only after the loader exhausted its retry budget. Keep the
        // per-host error state + ErrorCard untouched; mirror the failure onto status too.
        setError(e.message);
        writeStatus({ phase: 'load_error', message: e.message, attempts: LOAD_ATTEMPTS });
      });
    return () => {
      alive = false;
    };
    // writeStatus is stable (keyed on editor+shapeId); a fresh load is driven by module@rev.
  }, [module, rev]);

  // Resolve the named mart independently of the module load (#239): a component names a
  // mart, not a URL (ADR-0017) — this is the ONE read path (mart-data.ts -> the edge
  // route), never a second fetch/poll capability. Keyed on the mart NAME, not the whole
  // dataSource object reference, so an equal-by-value dataSource doesn't re-fetch.
  const martName = dataSource?.kind === 'mart' ? dataSource.name : undefined;
  React.useEffect(() => {
    if (!martName) {
      setMartState({ phase: 'idle' });
      return;
    }
    let alive = true;
    setMartState({ phase: 'loading' });
    loadMart(martName)
      .then((mart) => {
        if (alive) setMartState({ phase: 'ready', mart });
      })
      .catch((e: Error) => {
        if (alive) setMartState({ phase: 'error', message: e.message });
      });
    return () => {
      alive = false;
    };
  }, [martName]);

  // The Notebook's live read (ADR-0024), resolved the same way one member over: a named
  // query + its params, never a statement. Keyed on the SERIALIZED source so an
  // equal-by-value dataSource (params included) doesn't re-fetch on every render.
  const notebookKey = dataSource?.kind === 'notebook' ? JSON.stringify(dataSource) : undefined;
  React.useEffect(() => {
    if (!notebookKey) {
      setNotebookState({ phase: 'idle' });
      return;
    }
    const source = JSON.parse(notebookKey) as { query: string; params?: NotebookParams };
    let alive = true;
    setNotebookState({ phase: 'loading' });
    loadNotebook(source.query, source.params)
      .then((rows) => {
        if (alive) setNotebookState({ phase: 'ready', rows });
      })
      .catch((e: Error) => {
        if (alive) setNotebookState({ phase: 'error', message: e.message });
      });
    return () => {
      alive = false;
    };
  }, [notebookKey]);

  if (error) return <ErrorCard module={module} message={error} where="" />;
  if (!Comp) return <div style={{ padding: 12, color: 'var(--muted)', font: '12px ui-sans-serif' }}>loading {module}…</div>;
  // Mart rows resolve into the component's props (#239) ONLY when dataSource is set —
  // no dataSource means `data` reaches Comp byte-for-byte as before (backward compat).
  // A notebook source resolves into the SAME `rows` prop (ADR-0024), with `mart: null` —
  // a component renders rows without caring which namespace they came from.
  const resolvedData = martName
    ? martState.phase === 'ready'
      ? { ...data, rows: martState.mart.rows, mart: martState.mart.sidecar }
      : { ...data, rows: [], mart: null }
    : notebookKey
      ? { ...data, rows: notebookState.phase === 'ready' ? notebookState.rows : [], mart: null }
      : data;
  return (
    <>
      <ComponentErrorBoundary
        key={`${module}@${rev}`}
        module={module}
        onRenderError={(message, where) => writeStatus({ phase: 'render_error', message, where })}
      >
        <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
          {/* #211: identity rides alongside data/setData. `currentUser` is null until
              resolved; `setDisplayName` is the ask-once guest naming (no-op for users). */}
          <Comp {...resolvedData} setData={setData} sendToAgent={sendToAgent} currentUser={currentUser ?? undefined} setDisplayName={setDisplayName} unguarded={unguarded} />
        </div>
      </ComponentErrorBoundary>
      {martName && <MartFreshnessBadge state={martState} />}
    </>
  );
}

export class ComponentShapeUtil extends InteractiveBoxShapeUtil<
  'component',
  { module: string; data: Record<string, unknown>; rev: number; dataSource: DataSource | null }
> {
  static override type = 'component' as const;
  // Defined in ./shape-props (React-free) so the sync room's schema and this
  // ShapeUtil validate `component` identically. See ADR-0019.
  static override props = componentShapeProps;

  override getDefaultProps(): ComponentShapeTl['props'] {
    return { w: 360, h: 260, module: 'Missing', data: {}, rev: 0, dataSource: null };
  }

  // Pointer: swallow on actual controls (and, in the base, on scrollbar gutters) so
  // clicking a button/input or dragging the scrollbar interacts, while clicking the
  // card background still selects/drags the shape. Wheel: always own it so scrolling
  // a tall component scrolls its content instead of zooming the canvas.
  // wheel:()=>true still means a hovered non-scrollable component eats a PLAIN wheel, so
  // the board does not move under the cursor. The zoom gesture is no longer caught with it:
  // `InteractiveBoxShapeUtil` lets ctrl+wheel (and trackpad pinch) through ahead of this
  // predicate, so zooming no longer means finding a gap between cards first.
  override readonly guards: EventGuards = { pointer: isInteractiveControl, wheel: () => true };
  override containerStyle = { background: 'var(--surface)', boxShadow: 'var(--shadow-float), 0 0 0 1px var(--line)' };

  protected override renderContent(shape: ComponentShapeTl) {
    return (
      <>
        <ComponentHost
          shapeId={shape.id}
          editor={this.editor}
          module={shape.props.module}
          data={shape.props.data}
          rev={shape.props.rev}
          dataSource={shape.props.dataSource ?? undefined}
        />
        {/* Hover-revealed expand: App owns the fullscreen overlay (it has the editor);
            the button only signals over the agent-link-style singleton bus. */}
        <button type="button" className="component-expand" title="Expand to fullscreen" onClick={() => requestExpand(shape.id)}>
          ⛶
        </button>
      </>
    );
  }
}
