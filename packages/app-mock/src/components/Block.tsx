import { FileText, Search, Wrench, CheckCircle2 } from "lucide-react";
import type { BlockNode } from "../fixtures";
import { BlockActions } from "./BlockActions";

/**
 * One Block Node — child of a Turn Node.
 * Three visual variants: text, tool_use, tool_result.
 * Each is wrapped in a `group` so BlockActions reveals on hover.
 */
export function Block({ block }: { block: BlockNode }) {
  if (block.type === "text") {
    return (
      <div className="group relative rounded-md border border-bark-600 bg-bark-700/40 px-3 py-2 text-sm leading-relaxed text-bark-100">
        <BlockActions />
        <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-bark-400">
          <FileText size={11} />
          <span>text block</span>
        </div>
        {block.text}
      </div>
    );
  }

  if (block.type === "tool_use") {
    const Icon = block.tool === "Grep" ? Search : Wrench;
    return (
      <div className="group relative rounded-md border border-cedar-600/40 bg-cedar-600/10 px-3 py-2 font-mono text-xs text-cedar-300">
        <BlockActions />
        <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-cedar-400">
          <Icon size={11} />
          <span>tool_use · {block.tool}</span>
        </div>
        <div className="space-y-0.5">
          {Object.entries(block.input).map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="text-bark-400">{k}:</span>
              <span className="text-bark-100">{v}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // tool_result
  return (
    <div className="group relative rounded-md border border-moss-500/40 bg-moss-500/5 px-3 py-2 font-mono text-xs text-bark-100">
      <BlockActions />
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-moss-400">
        <CheckCircle2 size={11} />
        <span>tool_result</span>
      </div>
      <pre className="whitespace-pre-wrap text-bark-200">{block.result}</pre>
    </div>
  );
}
