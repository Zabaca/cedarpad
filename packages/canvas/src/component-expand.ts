// The expand-to-fullscreen bus: a component card's ⛶ button signals here; App (which
// owns the editor + overlay state) registers the handler. Module-level singleton, same
// pattern as agent-link's fork handler — kept in its own module so ComponentShape and
// the overlay don't import each other (no cycle).

let expandHandler: ((shapeId: string) => void) | null = null;

export function setExpandHandler(fn: ((shapeId: string) => void) | null): void {
  expandHandler = fn;
}

export function requestExpand(shapeId: string): void {
  expandHandler?.(shapeId);
}
