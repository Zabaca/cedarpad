import { Box } from "@mantine/core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

interface ResizableSplitProps {
  /** localStorage key the chosen width is persisted under. */
  storageKey: string;
  /** Left pane width as a % of the row, used on first load and on reset. */
  defaultPct: number;
  minPct?: number;
  maxPct?: number;
  /** CSS height for the row (the panes stretch to fill it). */
  height: string;
  left: ReactNode;
  right: ReactNode;
  /** When false, only the left pane renders full-width (no divider, no right pane). */
  showRight?: boolean;
}

const KEY_STEP = 2; // % moved per arrow keypress

/**
 * Two panes split by a draggable vertical divider. The left pane's width (as a
 * percentage) is persisted to `storageKey`, clamped to [minPct, maxPct].
 * Drag the handle to resize, double-click it to reset to `defaultPct`, or focus
 * it and use ←/→. When `showRight` is false the left pane fills the row.
 */
export function ResizableSplit({
  storageKey,
  defaultPct,
  minPct = 25,
  maxPct = 70,
  height,
  left,
  right,
  showRight = true,
}: ResizableSplitProps) {
  const clamp = useCallback(
    (p: number) => Math.min(maxPct, Math.max(minPct, p)),
    [minPct, maxPct],
  );

  const rowRef = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(n) && n > 0) return Math.min(maxPct, Math.max(minPct, n));
    } catch {
      /* localStorage unavailable */
    }
    return defaultPct;
  });
  const [dragging, setDragging] = useState(false);

  const onMove = useCallback(
    (e: PointerEvent) => {
      const el = rowRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      setPct(clamp(((e.clientX - r.left) / r.width) * 100));
    },
    [clamp],
  );

  // While dragging: track the pointer globally, suppress selection, hold the cursor.
  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    const prevSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      document.body.style.userSelect = prevSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging, onMove]);

  // Persist the settled width (skip mid-drag churn).
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(storageKey, String(Math.round(pct)));
    } catch {
      /* ignore */
    }
  }, [dragging, pct, storageKey]);

  if (!showRight) {
    return <Box style={{ height }}>{left}</Box>;
  }

  return (
    <Box ref={rowRef} style={{ display: "flex", alignItems: "stretch", height }}>
      <Box style={{ width: `${pct}%`, minWidth: 0, height: "100%" }}>{left}</Box>

      {/* Draggable divider: thin visual line inside a wider, grabbable hit area. */}
      <Box
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panes (double-click to reset)"
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setPct(defaultPct)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setPct((p) => clamp(p - KEY_STEP));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setPct((p) => clamp(p + KEY_STEP));
          }
        }}
        style={{
          flex: "0 0 auto",
          width: 11,
          margin: "0 1px",
          cursor: "col-resize",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          touchAction: "none",
        }}
      >
        <Box
          style={{
            width: 2,
            height: "100%",
            borderRadius: 2,
            background: dragging
              ? "var(--mantine-color-blue-5)"
              : "var(--mantine-color-default-border)",
            transition: dragging ? undefined : "background 120ms ease",
          }}
        />
      </Box>

      <Box style={{ flex: 1, minWidth: 0, height: "100%" }}>{right}</Box>
    </Box>
  );
}
