import { ChevronDown, MessageSquareText, GitBranch } from "lucide-react";
import type { ContentNode, Thread, ThreadChild } from "../fixtures";
import { Turn } from "./Turn";

/**
 * Render the entire outline tree.
 */
export function Outline({ nodes }: { nodes: ContentNode[] }) {
  return (
    <ul className="space-y-1.5">
      {nodes.map((n) => (
        <ContentNodeRow key={n.id} node={n} />
      ))}
    </ul>
  );
}

function ContentNodeRow({ node }: { node: ContentNode }) {
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isThreadRoot = !!node.threadRoot;
  const threads = node.threads ?? [];

  return (
    <li className="relative">
      <div className="group flex items-start gap-2">
        {/* Disclosure caret */}
        <button
          className="mt-1 shrink-0 text-bark-400 hover:text-bark-200"
          aria-label="collapse"
        >
          {hasChildren || isThreadRoot ? (
            <ChevronDown size={14} />
          ) : (
            <span className="block h-[14px] w-[14px]" />
          )}
        </button>

        {/* Bullet */}
        <span
          className={
            "mt-1.5 shrink-0 h-2 w-2 rounded-full " +
            (isThreadRoot
              ? "bg-cedar-500 ring-2 ring-cedar-500/30"
              : "border border-bark-300/70 bg-transparent")
          }
        />

        {/* Text */}
        <div className="flex-1 leading-relaxed text-bark-100">
          {isThreadRoot && (
            <span className="mr-2 inline-flex items-center gap-1 rounded bg-cedar-600/20 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-cedar-300">
              <MessageSquareText size={10} /> Thread Root
            </span>
          )}
          <span>{node.text}</span>
          {node.cursor && <span className="caret" />}
        </div>
      </div>

      {/* Outline children (Content Nodes only) */}
      {hasChildren && (
        <div className="ml-5 mt-1.5 border-l border-bark-700 pl-4">
          <Outline nodes={node.children!} />
        </div>
      )}

      {/* Threads — sibling subtrees under a Thread Root.
          Stacked vertically; each Thread is its own card with a label,
          to make branching legible. */}
      {isThreadRoot && threads.length > 0 && (
        <div className="ml-5 mt-2 space-y-3 border-l border-cedar-600/30 pl-4">
          {threads.map((t, idx) => (
            <ThreadCard key={t.id} thread={t} index={idx} />
          ))}
        </div>
      )}
    </li>
  );
}

function ThreadCard({ thread, index }: { thread: Thread; index: number }) {
  return (
    <section className="rounded-lg border border-bark-600 bg-bark-800/40">
      <header className="flex items-center gap-2 border-b border-bark-600 px-3 py-1.5">
        <GitBranch size={12} className="text-cedar-400" />
        <span className="text-[10px] font-medium uppercase tracking-wider text-cedar-300">
          Thread {index + 1}
        </span>
        <span className="text-xs text-bark-200">· {thread.label}</span>
      </header>
      <div className="space-y-2 p-3 pl-5">
        {thread.nodes.map((c) => (
          <ThreadChildRow key={getId(c)} child={c} />
        ))}
      </div>
    </section>
  );
}

function getId(c: ThreadChild) {
  return c.kind === "turn" ? c.id : c.id;
}

function ThreadChildRow({ child }: { child: ThreadChild }) {
  if (child.kind === "turn") {
    return <Turn turn={child} />;
  }
  // user prompt rendered as a Content Node child (per CONTEXT.md:
  // a Thread alternates human prompts (Content Nodes) and Turn Nodes).
  return (
    <div className="group relative flex items-start gap-2">
      <span className="absolute -left-5 top-2 h-2 w-2 rounded-full border border-bark-300/70" />
      <div className="flex-1 rounded-md border border-bark-600 bg-bark-700/30 px-3 py-2 text-sm text-bark-100">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-bark-400">
          you · Content Node prompt
        </div>
        {child.text}
      </div>
    </div>
  );
}
