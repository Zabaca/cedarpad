// The shared base for the canvas's interactive box shapes (`component`, `chat`).
// Both are a fixed-size, resizable, rounded HTMLContainer whose content is live
// DOM that must receive real pointer/keyboard/wheel events — yet the box itself
// still has to drag/select like any tldraw shape. This base owns that whole seam
// (geometry, resize, rounded indicator, the pointer-events:all container, and the
// capture-phase guards that let a control swallow an event while the background
// still reaches tldraw); subclasses supply only what differs: the extra props,
// the rendered content, which guards apply, the corner radius, and chrome.

import * as React from 'react';
import { HTMLContainer, Rectangle2d, ShapeUtil, resizeBox, type TLBaseShape, type TLResizeInfo } from 'tldraw';

/** Answers "did this event originate somewhere the content (not tldraw) should own?" */
export type GuardPredicate = (target: Element | null) => boolean;

/** True when a pointerdown landed on the target element's native scrollbar gutter
 *  (between its content edge and border) — that drag must scroll the content, never
 *  move the shape. offsetX/Y are relative to the target's padding box; the scrollbar
 *  sits past clientWidth/clientHeight. Generic: works for any scrollable child. */
function onScrollbar(e: PointerEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.clientWidth !== 'number') return false;
  const vBar = el.scrollHeight > el.clientHeight && e.offsetX >= el.clientWidth;
  const hBar = el.scrollWidth > el.clientWidth && e.offsetY >= el.clientHeight;
  return vBar || hBar;
}

/**
 * Which capture-phase guards a box wants. A supplied predicate wires the matching
 * capture handler(s); an absent one means that event class passes straight through
 * to tldraw. `pointer` covers both pointerdown and pointerup.
 */
export interface EventGuards {
  pointer?: GuardPredicate;
  wheel?: GuardPredicate;
  key?: GuardPredicate;
}

/** Every interactive box carries at least width + height; subclasses add `TExtra`. */
export type InteractiveBoxShape<TType extends string, TExtra extends object> = TLBaseShape<
  TType,
  { w: number; h: number } & TExtra
>;

// Capture-phase handlers attached to the single guard div. Only the ones whose
// predicate was supplied are present, so an unused event class has no listener.
type GuardHandlerProps = {
  onPointerDownCapture?: React.PointerEventHandler;
  onPointerUpCapture?: React.PointerEventHandler;
  onWheelCapture?: React.WheelEventHandler;
  onKeyDownCapture?: React.KeyboardEventHandler;
};

/**
 * Generic ShapeUtil base for interactive boxes. `TType` is the tldraw shape type
 * string; `TExtraProps` is the shape's props beyond `{ w, h }`. Concrete shapes
 * still declare their own `static type` / `static props` / `getDefaultProps` (and
 * their `declare module '@tldraw/tlschema'` augmentation) — this base only owns
 * the shared rendering + interaction behavior.
 */
// tldraw constrains `ShapeUtil`'s generic to the `TLShape` union, which a concrete
// shape joins ONLY through its `declare module '@tldraw/tlschema'` augmentation. A
// shape generic over an arbitrary `TType` can't be in that union, so the base
// parameterizes `ShapeUtil` with `any` and instead types every method against the
// real `InteractiveBoxShape<TType, TExtraProps>` — subclasses still get fully typed
// `props` on `renderContent` / `getDefaultProps` / hooks.
export abstract class InteractiveBoxShapeUtil<
  TType extends string,
  TExtraProps extends object = object,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
> extends ShapeUtil<any> {
  /** The capture-phase guards this box uses (which classes of event its content owns). */
  abstract readonly guards: EventGuards;

  /** The live content rendered inside the box (the part each shape is actually about). */
  protected abstract renderContent(shape: InteractiveBoxShape<TType, TExtraProps>): React.ReactNode;

  /** Corner radius for both the rendered card and its selection indicator. */
  cornerRadius = 8;

  /** Extra container chrome (background, shadow) merged over the base container style. */
  containerStyle: React.CSSProperties = {};

  /** Optional hook fired on a (non-capture) pointerdown anywhere on the box. */
  onContainerPointerDown?: (shape: InteractiveBoxShape<TType, TExtraProps>) => void;

  override canResize = () => true;
  override canEdit = () => false;

  override getGeometry(shape: InteractiveBoxShape<TType, TExtraProps>) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  // info is TLResizeInfo<any> because TLResizeInfo, like ShapeUtil, is constrained to
  // the concrete TLShape union our generic box can't join (see the class note).
  override onResize(shape: InteractiveBoxShape<TType, TExtraProps>, info: TLResizeInfo<any>) {
    // resizeBox is typed against tldraw's concrete box-shape union; our generic box
    // is structurally a box ({ w, h }) but not nominally in that union, so cast.
    return resizeBox(shape as never, info as never);
  }

  override getIndicatorPath(shape: InteractiveBoxShape<TType, TExtraProps>) {
    const path = new Path2D();
    path.roundRect(0, 0, shape.props.w, shape.props.h, this.cornerRadius);
    return path;
  }

  // Build only the capture handlers whose predicate was supplied. Each swallows the
  // event (keeping tldraw out) exactly when its predicate is true for the target —
  // so a click/keystroke/scroll on a control reaches the content while the same
  // gesture on the card background still selects/drags the shape.
  private buildGuardProps(): GuardHandlerProps {
    const props: GuardHandlerProps = {};
    const { pointer, wheel, key } = this.guards;
    if (pointer) {
      const fire: React.PointerEventHandler = (e) => {
        if (onScrollbar(e.nativeEvent) || pointer(e.target as Element | null)) e.stopPropagation();
      };
      props.onPointerDownCapture = fire;
      props.onPointerUpCapture = fire;
    }
    if (wheel) {
      props.onWheelCapture = (e) => {
        if (wheel(e.target as Element | null)) {
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
        }
      };
    }
    if (key) {
      props.onKeyDownCapture = (e) => {
        // Stop the native event so tldraw's document-level key handlers don't fire,
        // but leave the React synthetic event propagating so child onKeyDown handlers
        // (e.g. textarea submit on Enter) still receive it.
        if (key(e.target as Element | null)) e.nativeEvent.stopPropagation();
      };
    }
    return props;
  }

  override component(shape: InteractiveBoxShape<TType, TExtraProps>) {
    const { w, h } = shape.props;
    const onPointerDown = this.onContainerPointerDown ? () => this.onContainerPointerDown?.(shape) : undefined;
    return (
      <HTMLContainer
        // borderRadius mirrors cornerRadius so the rendered card corner matches the
        // selection indicator (getIndicatorPath); overflow:hidden clips content to it.
        style={{ width: w, height: h, overflow: 'hidden', borderRadius: this.cornerRadius, pointerEvents: 'all', ...this.containerStyle }}
        onPointerDown={onPointerDown}
      >
        <div style={{ width: '100%', height: '100%' }} {...this.buildGuardProps()}>
          {this.renderContent(shape)}
        </div>
      </HTMLContainer>
    );
  }
}
