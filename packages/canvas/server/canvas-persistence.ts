// The data-loss policy over BlobStore. BlobStore is dumb IO; the smart rule lives
// here: once a load has failed we are "degraded" (the store may hold good data we
// couldn't read), so we refuse to overwrite it with an empty canvas. A
// non-empty save is always fine, and a clean/absent load clears degradation so
// a legitimate "user cleared the canvas" empty save still goes through.

import type { CanvasState } from '../src/shapes.ts';
import type { BlobStore } from './blob-store.ts';

const isEmpty = (state: CanvasState): boolean => state.shapes.length === 0;

// Destructive-shrink guard (the tldraw-crash nuke that wiped 364 shapes → 1). A save that
// collapses a substantial canvas to near-empty in one step is almost always a crash, not an
// intent, so we refuse it: the on-disk good state survives and the live store is reseeded from
// it (the bridge). FLOOR keeps a genuinely small/new canvas unguarded; RATIO is the
// kept-fraction below which a save is treated as catastrophic.
const SHRINK_FLOOR = 10;
const COLLAPSE_RATIO = 0.1; // block a save keeping < 10% of shapes (a > 90% one-shot loss)

export class CanvasPersistence {
  private degraded = false;
  // The shape count of the last state we accepted as good (a successful save, or the boot
  // load). The shrink guard measures every save against THIS, not the immediately-prior save,
  // so a multi-step crash can't walk the count down past the guard.
  private lastSavedShapeCount = 0;

  /** Set when the most recent save was refused as a catastrophic shrink, for /api/status and
   *  the bridge's reseed-from-disk recovery. Cleared on any accepted save. */
  blockedShrink: { from: number; to: number } | null = null;

  /** True once a load has failed — we then refuse empty-over-known-good writes. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  constructor(
    private readonly store: BlobStore,
    private readonly ws: string,
    private readonly canvas: string,
  ) {}

  /** Load the saved canvas. A throw marks us degraded (then rethrows); an absent
   * canvas (null) is a clean, non-degraded empty. Seeds the shrink-guard baseline. */
  async load(): Promise<CanvasState | null> {
    try {
      const state = await this.store.loadCanvasState(this.ws, this.canvas);
      this.degraded = false;
      this.lastSavedShapeCount = state?.shapes.length ?? 0;
      return state;
    } catch (err) {
      this.degraded = true;
      throw err;
    }
  }

  /** Persist the canvas, unless doing so would (a) blank known-good R2 data we failed to read,
   * or (b) catastrophically shrink a substantial canvas (a crash, not an edit). Returns whether
   * the write happened; on a blocked shrink, `blockedShrink` carries the from/to counts. */
  async save(state: CanvasState): Promise<boolean> {
    if (this.degraded && isEmpty(state)) return false;
    if (this.lastSavedShapeCount >= SHRINK_FLOOR && state.shapes.length <= this.lastSavedShapeCount * COLLAPSE_RATIO) {
      this.blockedShrink = { from: this.lastSavedShapeCount, to: state.shapes.length };
      return false;
    }
    await this.store.saveCanvasState(this.ws, this.canvas, state);
    this.lastSavedShapeCount = state.shapes.length;
    this.blockedShrink = null;
    return true;
  }
}
