// Register happy-dom (window/document/Element) BEFORE importing the base — it pulls
// in tldraw's runtime, which touches the DOM at module-eval. This side-effect import
// MUST stay first. See happydom-harness.ts.
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import * as React from 'react';

import { type EventGuards, InteractiveBoxShapeUtil } from './InteractiveBoxShapeUtil';

// A minimal concrete subclass for exercising the base seam. Each test customizes the
// guards / cornerRadius / content it needs; the static type/props/getDefaultProps are
// only here to satisfy ShapeUtil — nothing registers these with a live editor.
class TestBox extends InteractiveBoxShapeUtil<'test', Record<string, never>> {
  static override type = 'test' as const;
  static override props = {};
  override readonly guards: EventGuards = {};
  override getDefaultProps() {
    return { w: 100, h: 80 };
  }
  protected override renderContent() {
    return <button data-testid="content">x</button>;
  }
}

/** Construct a util (the editor is unused by the rendering path) over a fake shape. */
function mount(util: TestBox, w = 100, h = 80) {
  const shape = { id: 'shape:test', type: 'test', x: 0, y: 0, props: { w, h } };
  const container = util.component(shape as never) as React.ReactElement<{
    children: React.ReactElement<Record<string, unknown>>;
    onPointerDown?: () => void;
  }>;
  const guardDiv = container.props.children;
  return { container, guardProps: guardDiv.props as Record<string, (e: unknown) => void> };
}

/** A real Element (happy-dom) the predicates can run `.closest()` against. */
function makeEl(tag: string): Element {
  return document.createElement(tag);
}

/** A synthetic-event stub that records whether stopPropagation was called. Carries a
 *  `nativeEvent` (real synthetic events always do) so the base's scrollbar check runs. */
function fakeEvent(target: Element | null, nativeOverrides: Record<string, unknown> = {}) {
  let stopped = 0;
  const nativeEvent = { target, offsetX: 0, offsetY: 0, ...nativeOverrides };
  return { event: { target, nativeEvent, stopPropagation: () => void stopped++ }, stoppedCount: () => stopped };
}

/** A happy-dom element with overridable scroll/client metrics for scrollbar tests. */
function scrollableEl(metrics: { scrollHeight?: number; clientHeight?: number; scrollWidth?: number; clientWidth?: number }): Element {
  const el = document.createElement('div');
  for (const [k, v] of Object.entries(metrics)) Object.defineProperty(el, k, { value: v, configurable: true });
  return el;
}

describe('InteractiveBoxShapeUtil — pointer guard', () => {
  class PointerBox extends TestBox {
    override readonly guards: EventGuards = { pointer: (t) => !!t?.closest('button') };
  }

  test('fires stopPropagation when the predicate returns true', () => {
    const { guardProps } = mount(new PointerBox({} as never));
    const { event, stoppedCount } = fakeEvent(makeEl('button'));
    guardProps.onPointerDownCapture!(event);
    expect(stoppedCount()).toBe(1);
    // The same handler is wired to pointerup (the base reuses one fire fn).
    const up = fakeEvent(makeEl('button'));
    guardProps.onPointerUpCapture!(up.event);
    expect(up.stoppedCount()).toBe(1);
  });

  test('does NOT fire stopPropagation when the predicate returns false', () => {
    const { guardProps } = mount(new PointerBox({} as never));
    const { event, stoppedCount } = fakeEvent(makeEl('div'));
    guardProps.onPointerDownCapture!(event);
    expect(stoppedCount()).toBe(0);
    // null target (no element under the pointer) is also a clean no-op.
    const none = fakeEvent(null);
    guardProps.onPointerDownCapture!(none.event);
    expect(none.stoppedCount()).toBe(0);
  });

  test('a pointerdown on a scrollbar gutter is swallowed even when the predicate is false', () => {
    const { guardProps } = mount(new PointerBox({} as never)); // predicate matches button only
    // Vertical scrollbar present (scrollHeight > clientHeight) and the click X is past
    // the content edge (offsetX >= clientWidth) → on the gutter → must be swallowed.
    const bar = scrollableEl({ scrollHeight: 200, clientHeight: 80, clientWidth: 100, scrollWidth: 100 });
    const { event, stoppedCount } = fakeEvent(bar, { offsetX: 108, offsetY: 40 });
    guardProps.onPointerDownCapture!(event);
    expect(stoppedCount()).toBe(1);

    // A click on the content area (offsetX < clientWidth) of the same element is NOT a
    // scrollbar drag, so with a false predicate it falls through to tldraw (drags shape).
    const inside = fakeEvent(bar, { offsetX: 40, offsetY: 40 });
    guardProps.onPointerDownCapture!(inside.event);
    expect(inside.stoppedCount()).toBe(0);
  });
});

describe('InteractiveBoxShapeUtil — guard wiring is conditional on the predicate', () => {
  test('no capture handlers are attached when guards is empty', () => {
    const { guardProps } = mount(new TestBox({} as never)); // guards = {}
    expect(guardProps.onPointerDownCapture).toBeUndefined();
    expect(guardProps.onPointerUpCapture).toBeUndefined();
    expect(guardProps.onWheelCapture).toBeUndefined();
    expect(guardProps.onKeyDownCapture).toBeUndefined();
  });

  test('only the supplied predicates attach their handlers', () => {
    class WheelKeyBox extends TestBox {
      override readonly guards: EventGuards = { wheel: () => true, key: () => true };
    }
    const { guardProps } = mount(new WheelKeyBox({} as never));
    expect(guardProps.onWheelCapture).toBeTypeOf('function');
    expect(guardProps.onKeyDownCapture).toBeTypeOf('function');
    // pointer was not supplied → its handlers stay off.
    expect(guardProps.onPointerDownCapture).toBeUndefined();
    expect(guardProps.onPointerUpCapture).toBeUndefined();
  });
});

describe('InteractiveBoxShapeUtil — the zoom gesture is the board\'s', () => {
  class WheelBox extends TestBox {
    override readonly guards: EventGuards = { wheel: () => true };
  }

  /** A wheel event stub: `ctrlKey` is what a pinch-zoom (and ctrl+wheel) sets. */
  function wheelEvent(target: Element | null, ctrlKey = false) {
    let stopped = 0;
    let stoppedImmediate = 0;
    const nativeEvent = { target, ctrlKey, stopImmediatePropagation: () => void stoppedImmediate++ };
    return {
      event: { target, ctrlKey, nativeEvent, stopPropagation: () => void stopped++ },
      swallowed: () => stopped > 0 || stoppedImmediate > 0,
    };
  }

  test('a plain wheel is still swallowed, so a component scrolls its own content', () => {
    const { guardProps } = mount(new WheelBox({} as never));
    const w = wheelEvent(makeEl('div'));
    guardProps.onWheelCapture!(w.event);
    expect(w.swallowed()).toBe(true);
  });

  test('ctrl+wheel passes through even over a card — hovering must not disable board zoom', () => {
    // The guard swallows wheel so a tall component scrolls instead of zooming the board.
    // A ZOOM gesture is not that: it belongs to the board wherever the pointer happens to
    // be, and swallowing it made a hovered card a dead zone for zooming.
    const { guardProps } = mount(new WheelBox({} as never));
    const w = wheelEvent(makeEl('div'), true);
    guardProps.onWheelCapture!(w.event);
    expect(w.swallowed()).toBe(false);
  });

  test('the pass-through does not depend on the predicate — it precedes it', () => {
    class NeverBox extends TestBox {
      override readonly guards: EventGuards = { wheel: () => false };
    }
    const { guardProps } = mount(new NeverBox({} as never));
    const w = wheelEvent(makeEl('div'), true);
    guardProps.onWheelCapture!(w.event);
    expect(w.swallowed()).toBe(false);
  });
});

describe('InteractiveBoxShapeUtil — onContainerPointerDown hook', () => {
  test('the container pointerdown invokes the hook with the shape; absent hook leaves it unset', () => {
    const seen: string[] = [];
    class HookBox extends TestBox {
      override onContainerPointerDown = (shape: { id: string }) => void seen.push(shape.id);
    }
    const { container } = mount(new HookBox({} as never));
    expect(container.props.onPointerDown).toBeTypeOf('function');
    container.props.onPointerDown!();
    expect(seen).toEqual(['shape:test']);

    // A subclass without the hook attaches no container pointerdown handler.
    const plain = mount(new TestBox({} as never));
    expect(plain.container.props.onPointerDown).toBeUndefined();
  });
});

describe('InteractiveBoxShapeUtil — indicator corner matches cornerRadius', () => {
  /** Run a callback with Path2D stubbed to record roundRect args (happy-dom has no Path2D). */
  function withPath2DSpy(run: () => void): number[][] {
    const calls: number[][] = [];
    const original = (globalThis as Record<string, unknown>).Path2D;
    (globalThis as Record<string, unknown>).Path2D = class {
      roundRect(...args: number[]) {
        calls.push(args);
      }
    };
    try {
      run();
    } finally {
      (globalThis as Record<string, unknown>).Path2D = original;
    }
    return calls;
  }

  test('uses the overridden cornerRadius (12) and the shape size', () => {
    class Corner12 extends TestBox {
      override cornerRadius = 12;
    }
    const util = new Corner12({} as never);
    const shape = { id: 'shape:test', type: 'test', x: 0, y: 0, props: { w: 200, h: 120 } };
    const calls = withPath2DSpy(() => util.getIndicatorPath(shape as never));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([0, 0, 200, 120, 12]);
  });

  test('uses the default cornerRadius (8) when not overridden', () => {
    const util = new TestBox({} as never);
    const shape = { id: 'shape:test', type: 'test', x: 0, y: 0, props: { w: 100, h: 80 } };
    const calls = withPath2DSpy(() => util.getIndicatorPath(shape as never));
    expect(calls[0]).toEqual([0, 0, 100, 80, 8]);
  });
});
