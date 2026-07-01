// Pure, in-memory canvas store. No I/O, no framework — just an id-keyed shape map
// plus a monotonic version. The bridge server wraps this over HTTP; tests hit it
// directly. Mutations are upsert-by-id and delete-by-id, so concurrent writers
// (the human via the browser, the agent via tools) reconcile by last-writer-wins
// per shape rather than clobbering the whole document.

import { isDeepStrictEqual } from 'node:util';

import type { CanvasPage, CanvasShape, CanvasState } from './shapes';

export interface CanvasStore {
  getState(): CanvasState;
  /** Upsert one or more shapes by id. Returns the new version. */
  upsert(shapes: CanvasShape[]): number;
  /** Remove shapes by id (missing ids are ignored). Returns the new version. */
  remove(ids: string[]): number;
  /** Upsert one or more pages by id. Returns the new version. */
  upsertPages(pages: CanvasPage[]): number;
  /** Remove pages by id (missing ids are ignored). Returns the new version. */
  removePages(ids: string[]): number;
  /** Drop every shape. Pages are left intact. Returns the new version. */
  clear(): number;
}

export function createStore(
  seed: CanvasShape[] = [],
  onChange?: (state: CanvasState) => void,
  seedPages: CanvasPage[] = [],
): CanvasStore {
  const shapes = new Map<string, CanvasShape>();
  for (const s of seed) shapes.set(s.id, s);
  const pages = new Map<string, CanvasPage>();
  for (const p of seedPages) pages.set(p.id, p);
  let version = 0;

  const state = (): CanvasState => ({
    version,
    // Stable ordering by id keeps reads deterministic for tests + diffing.
    shapes: [...shapes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    // Pages ordered by their fractional index (the order shown in the page menu).
    pages: [...pages.values()].sort((a, b) => a.index.localeCompare(b.index)),
  });

  // Fire onChange only when the version actually advanced.
  const bumped = (before: number): number => {
    if (onChange && version !== before) onChange(state());
    return version;
  };

  return {
    getState: state,
    upsert(next) {
      const before = version;
      if (next.length === 0) return version;
      let changed = false;
      for (const s of next) {
        // Dedup by post-image: an identical re-upsert is a no-op, so the
        // version-bumps-only-on-real-change invariant holds even if a caller
        // skips a normalize-before-upsert pre-filter.
        if (!isDeepStrictEqual(shapes.get(s.id), s)) {
          shapes.set(s.id, s);
          changed = true;
        }
      }
      if (changed) version += 1;
      return bumped(before);
    },
    remove(ids) {
      const before = version;
      let changed = false;
      for (const id of ids) changed = shapes.delete(id) || changed;
      if (changed) version += 1;
      return bumped(before);
    },
    upsertPages(next) {
      const before = version;
      if (next.length === 0) return version;
      let changed = false;
      for (const p of next) {
        // Deep-equal dedup (not a hand-written field cascade) so a new
        // CanvasPage field can't silently slip past change detection.
        if (!isDeepStrictEqual(pages.get(p.id), p)) {
          pages.set(p.id, p);
          changed = true;
        }
      }
      if (changed) version += 1;
      return bumped(before);
    },
    removePages(ids) {
      const before = version;
      let changed = false;
      for (const id of ids) changed = pages.delete(id) || changed;
      if (changed) version += 1;
      return bumped(before);
    },
    clear() {
      const before = version;
      if (shapes.size === 0) return version;
      shapes.clear();
      version += 1;
      return bumped(before);
    },
  };
}
