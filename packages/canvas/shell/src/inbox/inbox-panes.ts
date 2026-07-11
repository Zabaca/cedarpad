// Column management for the Inbox's three panes (list | thread | canvas): pure width-clamping
// and localStorage-serialization helpers. Kept free of any DOM/pointer-event code so they
// unit-test without jsdom — Inbox.tsx owns the actual pointer drag + localStorage calls.

/** localStorage keys the Inbox persists its pane layout under. */
export const PANE_WIDTHS_KEY = 'inbox.pane.widths';
export const CANVAS_HIDDEN_KEY = 'inbox.canvas.hidden';

/** Minimum/maximum width (px) a resized pane may reach, so no pane collapses to zero or
 *  swallows the whole stage. */
export const MIN_PANE_WIDTH = 220;
export const MAX_PANE_WIDTH = 900;

export type PaneWidths = { list: number; thread: number };

/** The list/thread widths (px) before any user resize. */
export const DEFAULT_PANE_WIDTHS: PaneWidths = { list: 340, thread: 520 };

/** Clamp a dragged width to `[min, max]`. */
export function clampWidth(width: number, min: number, max: number): number {
  return Math.min(Math.max(width, min), max);
}

/** Parse a persisted pane-widths blob, falling back to the defaults for anything malformed
 *  (missing localStorage entry, invalid JSON, or a shape that isn't `{list, thread}` numbers). */
export function parsePaneWidths(raw: string | null): PaneWidths {
  if (!raw) return DEFAULT_PANE_WIDTHS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as PaneWidths).list === 'number' &&
      typeof (parsed as PaneWidths).thread === 'number'
    ) {
      return parsed as PaneWidths;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_PANE_WIDTHS;
}

/** Serialize pane widths for localStorage. */
export function serializePaneWidths(widths: PaneWidths): string {
  return JSON.stringify(widths);
}

/** Parse the persisted canvas-pane visibility: `'true'` is hidden, anything else (including
 *  absent) is shown — the canvas pane's default state. */
export function parseCanvasHidden(raw: string | null): boolean {
  return raw === 'true';
}
