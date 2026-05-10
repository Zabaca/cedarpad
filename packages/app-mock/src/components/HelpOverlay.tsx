import { useEffect } from "react";
import { KEY_HINTS } from "../fixtures";
import { KeyCombo, Kbd } from "./Kbd";

export function HelpOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-bark-900/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[92vw] rounded-lg border border-bark-500 bg-bark-800 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-bark-100">
            cedarpad — keyboard
          </h2>
          <Kbd>Esc</Kbd>
        </div>
        <ul className="grid grid-cols-2 gap-x-6 gap-y-2">
          {KEY_HINTS.map((h, i) => (
            <li
              key={i}
              className="flex items-center justify-between gap-3 text-xs text-bark-200"
            >
              <span>{h.label}</span>
              <KeyCombo keys={h.keys} />
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[11px] leading-relaxed text-bark-400">
          Bindings are illustrative — the real Slice 1 implementation may
          differ. This is a visual mock.
        </p>
      </div>
    </div>
  );
}
