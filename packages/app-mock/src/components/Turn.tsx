import { Sparkles } from "lucide-react";
import type { TurnNode } from "../fixtures";
import { Block } from "./Block";

/**
 * Turn Node — one Claude turn.
 * Visually distinguished from Content Nodes by a header band + cedar accent.
 * Block Node children render below.
 */
export function Turn({ turn }: { turn: TurnNode }) {
  return (
    <div className="relative">
      {/* Outline gutter dot — Turn Nodes use a filled cedar dot, distinct from
          the hollow dot used by Content Nodes. */}
      <span className="absolute -left-5 top-3 h-2 w-2 rounded-full bg-cedar-500" />

      <div className="rounded-lg border border-cedar-600/30 bg-bark-800/60">
        <div className="flex items-center gap-2 border-b border-cedar-600/20 px-3 py-2">
          <Sparkles size={13} className="text-cedar-400" />
          <span className="text-xs font-medium text-cedar-300">
            {turn.agent}
          </span>
          <span className="text-[10px] text-bark-400">· Turn Node</span>
          <span className="ml-auto text-[10px] text-bark-400">
            {turn.blocks.length} blocks
          </span>
        </div>

        <div className="space-y-2 p-3">
          {turn.blocks.map((b) => (
            <Block key={b.id} block={b} />
          ))}
        </div>
      </div>
    </div>
  );
}
