import { useEffect, useRef } from "react";
import { Folder, Search } from "lucide-react";
import type { Workspace } from "../fixtures";
import { Kbd } from "./Kbd";

/**
 * Cmd+P-style workspace switcher palette.
 * Visual only — clicking a workspace closes the palette but doesn't switch state.
 */
export function WorkspaceSwitcher({
  workspaces,
  onClose,
}: {
  workspaces: Workspace[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-bark-900/70 pt-[18vh] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={ref}
        className="w-[560px] max-w-[92vw] overflow-hidden rounded-lg border border-bark-500 bg-bark-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-bark-600 px-3 py-2.5">
          <Search size={14} className="text-bark-300" />
          <input
            autoFocus
            placeholder="Switch workspace…"
            className="flex-1 bg-transparent text-sm text-bark-100 outline-none placeholder:text-bark-400"
          />
          <Kbd>Esc</Kbd>
        </div>
        <ul className="max-h-[40vh] overflow-auto py-1">
          {workspaces.map((w, i) => (
            <li
              key={w.id}
              className={
                "flex cursor-pointer items-center gap-3 px-3 py-2 " +
                (i === 0 ? "bg-bark-700" : "hover:bg-bark-700/50")
              }
            >
              <Folder size={14} className="text-cedar-400 shrink-0" />
              <div className="flex-1">
                <div className="text-sm text-bark-100">{w.name}</div>
                <div className="text-[11px] text-bark-400">{w.path}</div>
              </div>
              <span className="text-[10px] text-bark-400">{w.lastOpened}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3 border-t border-bark-600 bg-bark-800/60 px-3 py-1.5 text-[10px] text-bark-400">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>Enter</Kbd> open
          </span>
          <span>
            <Kbd>Esc</Kbd> dismiss
          </span>
        </div>
      </div>
    </div>
  );
}
