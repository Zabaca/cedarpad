// Docked chat panel (canvas stage): pure localStorage-serialization helpers for the
// per-canvas dock memory. Which chat is docked is per-device UI memory, not domain state
// (CONTEXT.md "Docked chat") — same split as inbox-panes.ts: Shell.tsx owns the DOM and
// the localStorage calls; this stays DOM-free so it unit-tests without jsdom.

import { clampWidth, MAX_PANE_WIDTH, MIN_PANE_WIDTH } from './inbox/inbox-panes';

/** localStorage key the canvas stage persists its dock memory under. */
export const DOCK_MEMORY_KEY = 'canvas.dock.memory';

/** A chat docked into the canvas stage's panel (a mirror of its card, one slot per canvas). */
export type DockedChat = { chatId: string; title: string };

/** canvasId → its docked chat. One slot per canvas; absent = nothing docked. */
export type DockMemory = Record<string, DockedChat>;

/** Parse a persisted dock-memory blob, dropping anything malformed (a bad entry never
 *  takes the whole memory down — the other canvases keep their docks). */
export function parseDockMemory(raw: string | null): DockMemory {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: DockMemory = {};
    for (const [canvasId, v] of Object.entries(parsed as Record<string, unknown>)) {
      const d = v as { chatId?: unknown; title?: unknown } | null;
      if (d && typeof d.chatId === 'string' && d.chatId && typeof d.title === 'string') {
        out[canvasId] = { chatId: d.chatId, title: d.title };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Serialize dock memory for localStorage. */
export const serializeDockMemory = (mem: DockMemory): string => JSON.stringify(mem);

/** localStorage key for the panel's width (px) — one width, not per-canvas. */
export const DOCK_WIDTH_KEY = 'canvas.dock.width';

/** The panel width (px) before any user resize (a chat card's default width). */
export const DEFAULT_DOCK_WIDTH = 420;

/** Parse a persisted panel width, clamped to the shared pane bounds; garbage → default. */
export function parseDockWidth(raw: string | null): number {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? clampWidth(n, MIN_PANE_WIDTH, MAX_PANE_WIDTH) : DEFAULT_DOCK_WIDTH;
}
