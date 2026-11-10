// The placed-component list, shared by the two surfaces that show it: the side panel's
// "On this board" section and the fullscreen rail. Order and labelling live HERE so the
// two can't drift — "Chart 2" is the same instance in both. What a row's primary click
// does, and whether a row offers a ⛶, are props; everything else is identical.
//
// Deliberately free of reactivity: the caller subscribes however it already does (the
// panel through tldraw's useValue, the fullscreen overlay through the store listener it
// already holds) and passes the read down. That's what lets the overlay keep driving
// itself from a plain-object editor stub in tests.

import * as React from 'react';

export type ComponentInstance = { id: string; module: string };
export type LabeledInstance = { id: string; label: string };

/** The narrowest editor surface this module reads — satisfied by tldraw's Editor and by
 *  the overlay's plain-object test stub alike. */
export interface InstanceSource {
  getCurrentPageShapes(): ReadonlyArray<{ id: string; type: string; props?: unknown }>;
}

/** Placed `component` shapes on the current page, in page order. */
export function readComponentInstances(editor: InstanceSource): ComponentInstance[] {
  return editor
    .getCurrentPageShapes()
    .filter((s) => s.type === 'component')
    .map((s) => ({ id: s.id as string, module: (s.props as { module?: string })?.module ?? '?' }));
}

/** Label the placed component instances: the module name, numbered ("Kanban 2")
 *  when the same module appears more than once, in page order. */
export function instanceLabels(instances: ReadonlyArray<ComponentInstance>): LabeledInstance[] {
  const totals = new Map<string, number>();
  for (const i of instances) totals.set(i.module, (totals.get(i.module) ?? 0) + 1);
  const seen = new Map<string, number>();
  return instances.map((i) => {
    const n = (seen.get(i.module) ?? 0) + 1;
    seen.set(i.module, n);
    return { id: i.id, label: (totals.get(i.module) ?? 1) > 1 ? `${i.module} ${n}` : i.module };
  });
}

export function ComponentInstanceList({
  items,
  activeId,
  onPrimary,
  primaryTitle = 'Zoom to this instance',
  onExpand,
}: {
  items: ReadonlyArray<LabeledInstance>;
  /** Highlighted row, if the surface tracks one (the rail does; the panel doesn't). */
  activeId?: string;
  /** A row's ordinary click. */
  onPrimary: (id: string) => void;
  primaryTitle?: string;
  /** Given, each row carries a ⛶ that calls this instead of the primary handler. */
  onExpand?: (id: string) => void;
}) {
  return (
    <div className="instance-list">
      {items.length === 0 && <div className="instance-list-empty">Nothing placed yet.</div>}
      {items.map((i) => (
        // A row can hold two controls, so it can't itself be the button it used to be —
        // a button inside a button is invalid, and the inner click would bubble out.
        <div key={i.id} className="instance-list-row" data-active={activeId === i.id ? 'true' : undefined}>
          <button type="button" className="instance-list-label" title={primaryTitle} onClick={() => onPrimary(i.id)}>
            {i.label}
          </button>
          {onExpand && (
            <button type="button" className="instance-list-expand" title="Open fullscreen" onClick={() => onExpand(i.id)}>
              ⛶
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
