// Preview mode: the pad renders ONE component module and nothing else.
//
// It exists because the Components stage lives at the EDGE (Records from D1, base from the
// bundled manifest) while components are compiled by VITE IN THE CONTAINER — so the stage
// cannot render anything by itself, and a grid of live thumbnails would wake the container
// on every visit and compile every module to draw pictures nobody asked for. This is the
// on-demand half: one iframe, one module, only when someone asks to look.
//
// The module is named on the pad's own URL rather than by a new route, so it inherits the
// pad's existing gate and proxying unchanged.

import { COMPONENT_NAME_RE } from '../shared/bridge-wire';

/**
 * The module a `?preview=` search string asks for, or null when this is an ordinary pad.
 *
 * VALIDATED HERE, not just at the write side: the value is interpolated into a module URL
 * by the loader, so an unchecked name is a path traversal out of the components directory.
 * Same rule the store enforces on write (`COMPONENT_NAME_RE`) — one rule, both directions.
 */
export function previewModule(search: string): string | null {
  const value = new URLSearchParams(search).get('preview');
  return value && COMPONENT_NAME_RE.test(value) ? value : null;
}
