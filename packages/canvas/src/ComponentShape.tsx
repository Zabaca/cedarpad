// The one custom tldraw shape behind file-based components. A `component` shape
// references a real module the agent authored under src/canvas-components/ (by
// name + props + rev), and this ShapeUtil dynamic-imports that vite-compiled
// module and renders it. Editing the file + bumping rev re-imports it live.

import * as React from 'react';
import { type Editor, T, type TLBaseShape } from 'tldraw';

import { type AgentComponent, LOAD_ATTEMPTS, loadComponent } from './component-loader';
import { activeCanvasId } from './active-canvas';
import { type EventGuards, InteractiveBoxShapeUtil } from './InteractiveBoxShapeUtil';
import { isInteractiveControl } from './predicates';
// ComponentStatus is the read bridge's concern too, so it lives in the model
// (shapes.ts); pureFromTldrawShape lifts `meta.status` onto the model field there.
import type { ComponentStatus } from './shapes';

/**
 * The typed shape of a `component`'s tldraw `meta`. `status` is strictly OPTIONAL:
 * shapes/docs persisted before this field reads back `undefined` and stay valid, so
 * no data transform is needed. It is additive on tldraw's freeform `meta` record
 * (this app hydrates the editor from the simplified model, not a tldraw snapshot, so
 * there is no tldraw props-migration sequence to run). This optionality IS the
 * migration: the package's back-compat idiom for an added field (cf. `pageId`).
 */
export interface ComponentShapeMeta {
  status?: ComponentStatus;
}

export type ComponentShapeTl = Omit<
  TLBaseShape<'component', { w: number; h: number; module: string; data: Record<string, unknown>; rev: number }>,
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
    component: { w: number; h: number; module: string; data: Record<string, unknown>; rev: number };
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
export function ComponentHost({
  shapeId,
  editor,
  module,
  data,
  rev,
  load = (module, rev) => loadComponent(module, rev, activeCanvasId()),
}: {
  shapeId: string;
  editor: Editor;
  module: string;
  data: Record<string, unknown>;
  rev: number;
  /** The module loader. Defaults to the real vite dynamic-import loader; injected in tests. */
  load?: (module: string, rev: number) => Promise<AgentComponent>;
}) {
  const [Comp, setComp] = React.useState<AgentComponent | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Attempts at loading THIS module@rev. Reset to the first attempt on every fresh
  // load below; retries (a later slice) bump it so a `loading` status carries which try.
  const attemptRef = React.useRef(0);

  // Merge a patch into this shape's `data`. Reads the shape fresh each call so
  // rapid successive updates compose instead of clobbering a stale snapshot.
  const setData = React.useCallback(
    (patch: Record<string, unknown>) => {
      const cur = editor.getShape(shapeId as never) as { type?: string; props?: { data?: Record<string, unknown> } } | undefined;
      if (!cur || cur.type !== 'component') return;
      editor.updateShape({ id: shapeId as never, type: 'component', props: { data: { ...(cur.props?.data ?? {}), ...patch } } });
    },
    [editor, shapeId],
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

  if (error) return <ErrorCard module={module} message={error} where="" />;
  if (!Comp) return <div style={{ padding: 12, color: 'var(--muted)', font: '12px ui-sans-serif' }}>loading {module}…</div>;
  return (
    <ComponentErrorBoundary
      key={`${module}@${rev}`}
      module={module}
      onRenderError={(message, where) => writeStatus({ phase: 'render_error', message, where })}
    >
      <div style={{ width: '100%', height: '100%', overflow: 'auto' }}>
        <Comp {...data} setData={setData} />
      </div>
    </ComponentErrorBoundary>
  );
}

export class ComponentShapeUtil extends InteractiveBoxShapeUtil<
  'component',
  { module: string; data: Record<string, unknown>; rev: number }
> {
  static override type = 'component' as const;
  static override props = { w: T.number, h: T.number, module: T.string, data: T.jsonValue as T.Validator<Record<string, unknown>>, rev: T.number };

  override getDefaultProps(): ComponentShapeTl['props'] {
    return { w: 360, h: 260, module: 'Missing', data: {}, rev: 0 };
  }

  // Pointer: swallow on actual controls (and, in the base, on scrollbar gutters) so
  // clicking a button/input or dragging the scrollbar interacts, while clicking the
  // card background still selects/drags the shape. Wheel: always own it so scrolling
  // a tall component scrolls its content instead of zooming the canvas.
  // ponytail: wheel:()=>true means hovering a non-scrollable component eats canvas
  // zoom; move the cursor off the card to zoom. Scope to scrollable regions if that bites.
  override readonly guards: EventGuards = { pointer: isInteractiveControl, wheel: () => true };
  override containerStyle = { background: 'var(--surface)', boxShadow: 'var(--shadow-float), 0 0 0 1px var(--line)' };

  protected override renderContent(shape: ComponentShapeTl) {
    return <ComponentHost shapeId={shape.id} editor={this.editor} module={shape.props.module} data={shape.props.data} rev={shape.props.rev} />;
  }
}
