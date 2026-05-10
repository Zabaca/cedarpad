import { GitBranch, RefreshCw, Plus } from "lucide-react";
import { KeyCombo } from "./Kbd";

/**
 * Hover-revealed action menu for a Block Node.
 * Shows the three branch verbs from packages/app/CONTEXT.md.
 * These don't do anything — visual mock only.
 */
export function BlockActions() {
  return (
    <div className="absolute right-2 top-2 hidden group-hover:flex flex-col gap-1 rounded-md border border-bark-500 bg-bark-800/95 p-1 shadow-lg backdrop-blur z-10">
      <ActionRow
        icon={<GitBranch size={13} className="text-cedar-400" />}
        label="Branch"
        sub="fork w/ history through here"
        keys={["Cmd", "B"]}
      />
      <ActionRow
        icon={<RefreshCw size={13} className="text-moss-400" />}
        label="Retry from here"
        sub="fork w/ history before here"
        keys={["Cmd", "R"]}
      />
      <ActionRow
        icon={<Plus size={13} className="text-bark-200" />}
        label="New thread sibling"
        sub="fresh Thread, same Root"
        keys={["Cmd", "N"]}
      />
    </div>
  );
}

function ActionRow({
  icon,
  label,
  sub,
  keys,
}: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  keys: string[];
}) {
  return (
    <button className="flex items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bark-700">
      <span className="shrink-0">{icon}</span>
      <span className="flex-1">
        <div className="text-xs text-bark-100">{label}</div>
        <div className="text-[10px] text-bark-400">{sub}</div>
      </span>
      <span className="shrink-0">
        <KeyCombo keys={keys} />
      </span>
    </button>
  );
}
