import { useEffect, useState } from "react";
import {
  ChevronRight,
  Folder,
  HelpCircle,
  Search,
  ZoomIn,
} from "lucide-react";
import { OUTLINE, WORKSPACES, KEY_HINTS } from "./fixtures";
import { Outline } from "./components/Outline";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { HelpOverlay } from "./components/HelpOverlay";
import { KeyCombo, Kbd } from "./components/Kbd";

export function App() {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Cmd+P opens switcher; ? opens help. Only keyboard handling we need
  // for the mock to feel real.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setSwitcherOpen(true);
      }
      if (e.key === "?" && !switcherOpen && !helpOpen) {
        e.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [switcherOpen, helpOpen]);

  const activeWs = WORKSPACES[0];

  return (
    <div className="flex h-full flex-col">
      {/* Top bar — workspace name + breadcrumbs + search/help affordances */}
      <header className="flex items-center gap-3 border-b border-bark-700 bg-bark-800/60 px-4 py-2">
        <button
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-bark-100 hover:bg-bark-700"
          onClick={() => setSwitcherOpen(true)}
          title="Switch workspace (Cmd+P)"
        >
          <Folder size={13} className="text-cedar-400" />
          <span className="font-medium">{activeWs.name}</span>
          <span className="text-bark-400">{activeWs.path}</span>
          <ChevronRight size={11} className="text-bark-400" />
          <KeyCombo keys={["Cmd", "P"]} />
        </button>

        <div className="ml-2 flex items-center gap-1 text-[11px] text-bark-400">
          <span>cedarpad — design notes</span>
          <ChevronRight size={10} />
          <span className="text-bark-200">questions for Claude…</span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-bark-300 hover:bg-bark-700 hover:text-bark-100"
            title="Zoom into selected Node (future)"
          >
            <ZoomIn size={13} />
            <span>Zoom</span>
          </button>
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-bark-300 hover:bg-bark-700 hover:text-bark-100"
            title="Search (future)"
          >
            <Search size={13} />
            <KeyCombo keys={["Cmd", "K"]} />
          </button>
          <button
            className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-bark-300 hover:bg-bark-700 hover:text-bark-100"
            onClick={() => setHelpOpen(true)}
            title="Keyboard help (?)"
          >
            <HelpCircle size={13} />
            <Kbd>?</Kbd>
          </button>
        </div>
      </header>

      {/* Main outline canvas */}
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-3xl px-8 py-8">
          <h1 className="mb-1 text-2xl font-semibold text-bark-100">
            cedarpad
          </h1>
          <p className="mb-6 text-xs text-bark-400">
            visual mock · the X+Y model: Workflowy outline (X) + Claude turns
            as descendant nodes (Y) · hover any block for branch actions
          </p>
          <Outline nodes={OUTLINE} />
        </div>
      </main>

      {/* Footer — keyboard hints inline */}
      <footer className="border-t border-bark-700 bg-bark-800/60 px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-bark-400">
          {KEY_HINTS.slice(0, 8).map((h, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              <KeyCombo keys={h.keys} />
              <span>{h.label}</span>
            </span>
          ))}
          <span className="ml-auto inline-flex items-center gap-1.5">
            <Kbd>?</Kbd>
            <span>all bindings</span>
          </span>
        </div>
      </footer>

      {switcherOpen && (
        <WorkspaceSwitcher
          workspaces={WORKSPACES}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
