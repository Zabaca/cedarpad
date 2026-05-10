import { useEffect, useMemo, useState } from 'react';
import {
  Search,
  GitBranch,
  CornerDownRight,
  Plus,
  ChevronRight,
  ChevronDown,
  MessageSquarePlus,
  RotateCcw,
  Folder,
  Command,
  Keyboard,
  Sun,
  Moon,
  Sparkles,
  Wrench,
  FileCode2,
  ArrowRightLeft,
  X,
  Circle,
  CheckCircle2,
  Map,
} from 'lucide-react';
import {
  outline,
  workspaces,
  branchGraph,
  type OutlineNode,
  type ThreadRoot,
  type Thread,
  type Block,
  type GraphNode,
} from './fixtures';

// ---------- Theme ----------

function useDark() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return [dark, setDark] as const;
}

// ---------- App shell ----------

export function App() {
  const [dark, setDark] = useDark();
  const [activeWorkspace, setActiveWorkspace] = useState(workspaces[0]);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // Which Thread Root is focused / which sibling thread is currently full-color.
  const [activeThreadId, setActiveThreadId] = useState<string>('t-1a');

  // Cmd+P opens the workspace switcher; ? opens help.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        setShowSwitcher((v) => !v);
      } else if (e.key === '?' && !e.metaKey && !e.ctrlKey) {
        setShowHelp((v) => !v);
      } else if (e.key === 'Escape') {
        setShowSwitcher(false);
        setShowHelp(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="h-full w-full flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100">
      <TopBar
        workspace={activeWorkspace.name}
        onOpenSwitcher={() => setShowSwitcher(true)}
        dark={dark}
        onToggleDark={() => setDark(!dark)}
      />
      <div className="flex-1 flex min-h-0">
        <Sidebar activeThreadId={activeThreadId} onSelectThread={setActiveThreadId} />
        <Main activeThreadId={activeThreadId} onSelectThread={setActiveThreadId} />
      </div>
      <Footer onOpenHelp={() => setShowHelp(true)} />
      {showSwitcher && (
        <WorkspaceSwitcher
          activeId={activeWorkspace.id}
          onPick={(ws) => {
            setActiveWorkspace(ws);
            setShowSwitcher(false);
          }}
          onClose={() => setShowSwitcher(false)}
        />
      )}
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}

// ---------- Top bar ----------

function TopBar({
  workspace,
  onOpenSwitcher,
  dark,
  onToggleDark,
}: {
  workspace: string;
  onOpenSwitcher: () => void;
  dark: boolean;
  onToggleDark: () => void;
}) {
  return (
    <header className="h-12 px-4 flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
      <div className="flex items-center gap-3">
        <div className="w-6 h-6 rounded-md bg-accent-600 grid place-items-center text-white font-bold text-xs">
          cp
        </div>
        <span className="font-semibold text-sm">cedarpad</span>
        <span className="text-2xs uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300 font-semibold">
          variant B · branches
        </span>
        <button
          onClick={onOpenSwitcher}
          className="ml-2 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 px-2 py-1 rounded transition"
        >
          <Folder className="w-3.5 h-3.5" />
          <span className="font-medium">{workspace}</span>
          <kbd className="text-2xs text-slate-400 border border-slate-200 dark:border-slate-700 rounded px-1 py-0.5 font-mono">
            ⌘P
          </kbd>
        </button>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 rounded px-2 py-1">
          <Search className="w-3.5 h-3.5" />
          <span>Search…</span>
          <kbd className="text-2xs border border-slate-200 dark:border-slate-700 rounded px-1 font-mono">⌘K</kbd>
        </div>
        <button
          onClick={onToggleDark}
          className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition"
          title="toggle theme"
        >
          {dark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>
      </div>
    </header>
  );
}

// ---------- Sidebar ----------

function Sidebar({
  activeThreadId,
  onSelectThread,
}: {
  activeThreadId: string;
  onSelectThread: (id: string) => void;
}) {
  return (
    <aside className="w-72 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col">
      <div className="px-4 py-3 text-xs uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500 flex items-center justify-between">
        <span>Outline</span>
        <button className="hover:text-slate-600 dark:hover:text-slate-300" title="new node">
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto thin-scroll px-2">
        <OutlineList nodes={outline} depth={0} />
      </div>
      <BranchMiniMap activeThreadId={activeThreadId} onSelectThread={onSelectThread} />
    </aside>
  );
}

function OutlineList({ nodes, depth }: { nodes: OutlineNode[]; depth: number }) {
  return (
    <ul className="space-y-px">
      {nodes.map((n) => (
        <OutlineNodeRow key={n.id} node={n} depth={depth} />
      ))}
    </ul>
  );
}

function OutlineNodeRow({ node, depth }: { node: OutlineNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const isThreadRoot = node.kind === 'thread-root';
  const hasKids =
    (node.kind === 'content' && node.children.length > 0) ||
    (node.kind === 'thread-root' && node.threads.length > 0);

  return (
    <li>
      <div
        className={[
          'group flex items-start gap-1 py-1 px-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-default',
          isThreadRoot ? 'border-l-2 border-accent-500 pl-2 bg-accent-50/50 dark:bg-accent-900/10' : '',
        ].join(' ')}
        style={{ paddingLeft: depth * 14 + 6 }}
      >
        {hasKids ? (
          <button onClick={() => setOpen(!open)} className="mt-1 text-slate-400 hover:text-slate-700">
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        ) : (
          <span className="w-3 h-3 mt-1" />
        )}

        {node.kind === 'content' ? (
          <span className="mt-1.5 w-1 h-1 rounded-full bg-slate-400 shrink-0" />
        ) : (
          <GitBranch className="w-3.5 h-3.5 mt-0.5 text-accent-600 shrink-0" />
        )}

        <span
          className={[
            'text-sm leading-snug flex-1',
            node.kind === 'content' && (node as any).completed
              ? 'line-through text-slate-400 dark:text-slate-500'
              : '',
            isThreadRoot ? 'font-medium text-accent-700 dark:text-accent-300' : '',
          ].join(' ')}
        >
          {node.text}
          {isThreadRoot && (
            <span className="ml-2 text-2xs uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-100 dark:bg-accent-900/50 text-accent-700 dark:text-accent-300">
              {(node as ThreadRoot).threads.length} threads
            </span>
          )}
        </span>

        {node.kind === 'content' && !(node as any).completed && (
          <button
            className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-accent-600 transition"
            title="Start Thread on this Node"
          >
            <Sparkles className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && node.kind === 'content' && node.children.length > 0 && (
        <OutlineList nodes={node.children} depth={depth + 1} />
      )}
      {open && node.kind === 'thread-root' && (
        <ul style={{ paddingLeft: (depth + 1) * 14 + 6 }} className="space-y-px text-xs text-slate-500 dark:text-slate-400">
          {(node as ThreadRoot).threads.map((t) => (
            <li key={t.id} className="flex items-center gap-1.5 py-0.5">
              <CornerDownRight className="w-3 h-3" />
              <span>{t.label}</span>
              <ThreadStatusDot status={t.status} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ThreadStatusDot({ status }: { status: Thread['status'] }) {
  if (status === 'streaming')
    return <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />;
  if (status === 'cancelled') return <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-400" />;
  return <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />;
}

// ---------- Branch graph mini-map (sidebar bottom) ----------

function BranchMiniMap({
  activeThreadId,
  onSelectThread,
}: {
  activeThreadId: string;
  onSelectThread: (id: string) => void;
}) {
  return (
    <div className="border-t border-slate-200 dark:border-slate-800 p-3 bg-slate-50 dark:bg-slate-900/60">
      <div className="flex items-center justify-between mb-2">
        <span className="text-2xs uppercase tracking-wider font-semibold text-slate-400 dark:text-slate-500 flex items-center gap-1.5">
          <Map className="w-3 h-3" /> Branch graph
        </span>
        <span className="text-2xs text-slate-400">3 forks alive</span>
      </div>
      <GraphTree node={branchGraph} activeThreadId={activeThreadId} onSelectThread={onSelectThread} />
      <div className="mt-2 text-2xs text-slate-400 dark:text-slate-500 leading-snug">
        Tiny map of all forks under the focused Thread Root.
      </div>
    </div>
  );
}

function GraphTree({
  node,
  activeThreadId,
  onSelectThread,
  depth = 0,
}: {
  node: GraphNode;
  activeThreadId: string;
  onSelectThread: (id: string) => void;
  depth?: number;
}) {
  const isActive = node.kind === 'thread' && node.id === activeThreadId;
  return (
    <div>
      <div
        className={[
          'flex items-center gap-1.5 py-0.5 text-xs',
          node.kind === 'root' ? 'text-accent-700 dark:text-accent-300 font-semibold' : '',
          node.kind === 'thread'
            ? isActive
              ? 'text-accent-700 dark:text-accent-200 font-medium'
              : 'text-slate-500 dark:text-slate-400'
            : '',
          node.kind === 'turn' ? 'text-slate-400 dark:text-slate-500' : '',
        ].join(' ')}
        style={{ paddingLeft: depth * 10 }}
      >
        {node.kind === 'root' && <GitBranch className="w-3 h-3" />}
        {node.kind === 'thread' && (
          <button
            onClick={() => onSelectThread(node.id)}
            className={[
              'flex items-center gap-1 hover:underline',
              isActive ? '' : '',
            ].join(' ')}
          >
            <span
              className={[
                'inline-block w-1.5 h-1.5 rounded-full',
                isActive ? 'bg-accent-500' : 'bg-slate-300 dark:bg-slate-600',
              ].join(' ')}
            />
            <span className="truncate max-w-[180px]">{node.label}</span>
          </button>
        )}
        {node.kind === 'root' && <span className="truncate">{node.label}</span>}
        {node.kind === 'turn' && (
          <>
            <span className="inline-block w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700" />
            <span>{node.label}</span>
          </>
        )}
      </div>
      {node.children.map((c) => (
        <GraphTree
          key={c.id}
          node={c}
          depth={depth + 1}
          activeThreadId={activeThreadId}
          onSelectThread={onSelectThread}
        />
      ))}
    </div>
  );
}

// ---------- Main panel ----------

function Main({
  activeThreadId,
  onSelectThread,
}: {
  activeThreadId: string;
  onSelectThread: (id: string) => void;
}) {
  // The Thread Root we feature side-by-side. (In a real app this is the focused subtree.)
  const root = useMemo(() => findThreadRoot(outline), []);

  return (
    <main className="flex-1 min-w-0 flex flex-col">
      <Breadcrumbs root={root} />
      <div className="flex-1 min-h-0 overflow-hidden">
        <ParallelThreads root={root} activeThreadId={activeThreadId} onSelectThread={onSelectThread} />
      </div>
    </main>
  );
}

function Breadcrumbs({ root }: { root: ThreadRoot }) {
  return (
    <div className="px-6 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between">
      <div className="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400 min-w-0">
        <span>cedarpad</span>
        <ChevronRight className="w-3 h-3" />
        <span>Open questions</span>
        <ChevronRight className="w-3 h-3" />
        <GitBranch className="w-3.5 h-3.5 text-accent-600" />
        <span className="text-slate-800 dark:text-slate-200 font-medium truncate">{root.text}</span>
        <span className="text-2xs uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300 ml-2 shrink-0">
          Thread Root · {root.threads.length} threads
        </span>
      </div>
      <button className="flex items-center gap-1.5 text-xs text-accent-700 dark:text-accent-300 hover:bg-accent-50 dark:hover:bg-accent-900/30 px-2 py-1 rounded font-medium transition">
        <ArrowRightLeft className="w-3.5 h-3.5" />
        Compare branches
      </button>
    </div>
  );
}

function ParallelThreads({
  root,
  activeThreadId,
  onSelectThread,
}: {
  root: ThreadRoot;
  activeThreadId: string;
  onSelectThread: (id: string) => void;
}) {
  return (
    <div className="h-full overflow-x-auto thin-scroll bg-slate-50 dark:bg-slate-950">
      <div className="h-full flex gap-4 p-4 min-w-max">
        {root.threads.map((t) => (
          <ThreadColumn
            key={t.id}
            thread={t}
            active={t.id === activeThreadId}
            onActivate={() => onSelectThread(t.id)}
          />
        ))}
        <NewThreadColumn rootId={root.id} />
      </div>
    </div>
  );
}

function NewThreadColumn({ rootId }: { rootId: string }) {
  return (
    <div className="w-[420px] shrink-0 rounded-lg border-2 border-dashed border-slate-200 dark:border-slate-800 bg-transparent flex items-center justify-center text-slate-400 hover:border-accent-300 hover:text-accent-600 dark:hover:border-accent-700 transition cursor-pointer">
      <div className="flex flex-col items-center gap-1.5 text-sm">
        <MessageSquarePlus className="w-5 h-5" />
        <span className="font-medium">New thread sibling</span>
        <span className="text-2xs text-slate-400">Fresh Thread under this Root</span>
      </div>
    </div>
  );
}

// ---------- Single Thread column ----------

function ThreadColumn({
  thread,
  active,
  onActivate,
}: {
  thread: Thread;
  active: boolean;
  onActivate: () => void;
}) {
  return (
    <section
      onClick={onActivate}
      className={[
        'w-[420px] shrink-0 rounded-lg border bg-white dark:bg-slate-900 flex flex-col overflow-hidden transition',
        active
          ? 'border-accent-300 dark:border-accent-700 shadow-md ring-1 ring-accent-200 dark:ring-accent-800/50'
          : 'border-slate-200 dark:border-slate-800 opacity-60 hover:opacity-90 hover:border-slate-300 dark:hover:border-slate-700 cursor-pointer',
      ].join(' ')}
    >
      <header
        className={[
          'px-3 py-2 border-b flex items-center justify-between shrink-0',
          active
            ? 'border-accent-200 dark:border-accent-800/60 bg-accent-50/60 dark:bg-accent-900/20'
            : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900',
        ].join(' ')}
      >
        <div className="flex items-center gap-2 min-w-0">
          <GitBranch
            className={[
              'w-3.5 h-3.5 shrink-0',
              active ? 'text-accent-600' : 'text-slate-400',
            ].join(' ')}
          />
          <span
            className={[
              'text-sm font-medium truncate',
              active ? 'text-slate-800 dark:text-slate-100' : 'text-slate-500 dark:text-slate-400',
            ].join(' ')}
          >
            {thread.label}
          </span>
          <ThreadStatusBadge status={thread.status} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            title="close branch"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto thin-scroll px-3 py-3 space-y-3">
        {thread.turns.map((turn) => (
          <TurnView key={turn.id} prompt={turn.prompt} blocks={turn.blocks} muted={!active} />
        ))}
        {thread.status === 'streaming' && (
          <div className="text-2xs text-amber-600 dark:text-amber-400 flex items-center gap-1 pl-6">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            Claude is streaming…
          </div>
        )}
      </div>

      <footer className="border-t border-slate-200 dark:border-slate-800 px-3 py-2 bg-slate-50 dark:bg-slate-900 shrink-0">
        <div className="flex items-center gap-2 text-sm text-slate-400 dark:text-slate-500">
          <span className="w-1 h-1 rounded-full bg-slate-300" />
          <span>Continue this Thread…</span>
          <kbd className="ml-auto text-2xs border border-slate-200 dark:border-slate-700 rounded px-1 py-0.5 font-mono">
            ⌘↵
          </kbd>
        </div>
      </footer>
    </section>
  );
}

function ThreadStatusBadge({ status }: { status: Thread['status'] }) {
  if (status === 'streaming')
    return (
      <span className="text-2xs px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-medium">
        streaming
      </span>
    );
  if (status === 'cancelled')
    return (
      <span className="text-2xs px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-900/40 text-rose-700 dark:text-rose-300 font-medium">
        cancelled
      </span>
    );
  return (
    <span className="text-2xs px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-medium">
      done
    </span>
  );
}

// ---------- Turn + Blocks ----------

function TurnView({ prompt, blocks, muted }: { prompt: string; blocks: Block[]; muted: boolean }) {
  return (
    <div className={muted ? 'opacity-80' : ''}>
      {/* Human prompt — Content Node sibling under Thread Root */}
      <div className="mb-2 flex items-start gap-2">
        <div className="w-5 h-5 rounded-full bg-slate-200 dark:bg-slate-700 grid place-items-center text-2xs font-semibold text-slate-600 dark:text-slate-300 shrink-0">
          you
        </div>
        <div className="flex-1 text-sm bg-slate-100 dark:bg-slate-800 rounded-lg px-3 py-2 leading-relaxed">
          {prompt}
        </div>
      </div>

      {/* Turn Node — collapsible container */}
      <div className="ml-6 border-l-2 border-slate-200 dark:border-slate-800 pl-3 space-y-1.5">
        <div className="text-2xs uppercase tracking-wider text-slate-400 dark:text-slate-500 font-semibold flex items-center gap-1">
          <Sparkles className="w-3 h-3" />
          Turn Node · {blocks.length} blocks
        </div>
        {blocks.map((b) => (
          <BlockView key={b.id} block={b} />
        ))}
      </div>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  return (
    <div className="group relative rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-accent-300 dark:hover:border-accent-700 transition">
      <div className="flex items-stretch">
        <BlockKindStripe kind={block.kind} />
        <div className="flex-1 px-3 py-2 min-w-0">
          <BlockHeader block={block} />
          <BlockBody block={block} />
        </div>
        <BlockActions />
      </div>
    </div>
  );
}

function BlockKindStripe({ kind }: { kind: Block['kind'] }) {
  const cls =
    kind === 'text'
      ? 'bg-accent-400'
      : kind === 'tool_use'
        ? 'bg-amber-400'
        : 'bg-emerald-400';
  return <div className={`w-1 shrink-0 ${cls}`} />;
}

function BlockHeader({ block }: { block: Block }) {
  if (block.kind === 'text') {
    return (
      <div className="text-2xs uppercase tracking-wider text-slate-400 dark:text-slate-500 font-semibold flex items-center gap-1 mb-1">
        <span>text</span>
      </div>
    );
  }
  if (block.kind === 'tool_use') {
    return (
      <div className="text-2xs uppercase tracking-wider text-amber-600 dark:text-amber-400 font-semibold flex items-center gap-1 mb-1">
        <Wrench className="w-3 h-3" />
        <span>tool_use · {block.tool}</span>
      </div>
    );
  }
  return (
    <div className="text-2xs uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1 mb-1">
      <FileCode2 className="w-3 h-3" />
      <span>tool_result · {block.tool}</span>
    </div>
  );
}

function BlockBody({ block }: { block: Block }) {
  if (block.kind === 'text') {
    return (
      <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200 whitespace-pre-wrap">
        {block.text}
      </p>
    );
  }
  if (block.kind === 'tool_use') {
    return (
      <code className="block text-xs font-mono text-slate-600 dark:text-slate-300 bg-amber-50 dark:bg-amber-900/20 px-2 py-1 rounded overflow-x-auto thin-scroll">
        {block.input}
      </code>
    );
  }
  return (
    <pre className="text-xs font-mono text-slate-600 dark:text-slate-300 bg-emerald-50 dark:bg-emerald-900/20 px-2 py-1 rounded overflow-x-auto thin-scroll whitespace-pre">
      {block.output}
    </pre>
  );
}

function BlockActions() {
  // Variant B distinctive: Branch is a *visible* button on every Block.
  // The other two verbs live in a small menu.
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-start gap-1 px-2 py-2 shrink-0 relative">
      <button
        className="flex items-center gap-1 text-2xs font-semibold text-accent-700 dark:text-accent-300 bg-accent-50 dark:bg-accent-900/30 hover:bg-accent-100 dark:hover:bg-accent-900/60 border border-accent-200 dark:border-accent-800 rounded px-1.5 py-1 transition"
        title="Branch — fork with full history including this Block"
      >
        <GitBranch className="w-3 h-3" />
        Branch
      </button>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 px-1 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition"
        title="more"
      >
        <Plus className="w-3 h-3 rotate-45" />
      </button>
      {open && (
        <div className="absolute right-2 top-9 z-10 w-56 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg py-1 text-xs">
          <MenuItem icon={<RotateCcw className="w-3.5 h-3.5" />} label="Retry from here" hint="fork w/o this Block" />
          <MenuItem
            icon={<MessageSquarePlus className="w-3.5 h-3.5" />}
            label="New thread sibling"
            hint="fresh Thread, no history"
          />
          <div className="border-t border-slate-200 dark:border-slate-700 my-1" />
          <MenuItem icon={<Circle className="w-3.5 h-3.5" />} label="Promote to Content Node" hint="" />
          <MenuItem icon={<CheckCircle2 className="w-3.5 h-3.5" />} label="Mark important" hint="" />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, hint }: { icon: React.ReactNode; label: string; hint: string }) {
  return (
    <button className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 text-left">
      <span className="text-slate-500">{icon}</span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-2xs text-slate-400">{hint}</span>}
    </button>
  );
}

// ---------- Footer ----------

function Footer({ onOpenHelp }: { onOpenHelp: () => void }) {
  return (
    <footer className="h-8 px-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between text-2xs text-slate-500 dark:text-slate-400 shrink-0">
      <div className="flex items-center gap-3">
        <KeyHint k="Tab" label="nest" />
        <KeyHint k="⇧Tab" label="outdent" />
        <KeyHint k="⌘↵" label="send prompt" />
        <KeyHint k="⌘B" label="Branch from Block" />
        <KeyHint k="⌘⇧R" label="Retry from here" />
        <KeyHint k="⌘P" label="switch workspace" />
      </div>
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
          read-only
        </span>
        <button onClick={onOpenHelp} className="flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200">
          <Keyboard className="w-3 h-3" /> help
          <kbd className="text-2xs border border-slate-200 dark:border-slate-700 rounded px-1 font-mono">?</kbd>
        </button>
      </div>
    </footer>
  );
}

function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="font-mono text-2xs border border-slate-200 dark:border-slate-700 rounded px-1 py-0.5 bg-slate-50 dark:bg-slate-800">
        {k}
      </kbd>
      <span>{label}</span>
    </span>
  );
}

// ---------- Workspace switcher (Cmd+P) ----------

function WorkspaceSwitcher({
  activeId,
  onPick,
  onClose,
}: {
  activeId: string;
  onPick: (ws: typeof workspaces[number]) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const filtered = workspaces.filter(
    (w) => w.name.toLowerCase().includes(q.toLowerCase()) || w.path.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-start justify-center pt-32" onClick={onClose}>
      <div
        className="w-[520px] bg-white dark:bg-slate-900 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-200 dark:border-slate-800">
          <Folder className="w-4 h-4 text-slate-400" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Open workspace…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-slate-400"
          />
          <kbd className="text-2xs border border-slate-200 dark:border-slate-700 rounded px-1 font-mono">esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto thin-scroll py-1">
          {filtered.map((w) => (
            <li key={w.id}>
              <button
                onClick={() => onPick(w)}
                className={[
                  'w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800',
                  w.id === activeId ? 'bg-accent-50 dark:bg-accent-900/20' : '',
                ].join(' ')}
              >
                <div className="w-7 h-7 rounded bg-slate-100 dark:bg-slate-800 grid place-items-center text-xs font-semibold text-slate-500">
                  {w.name.slice(0, 2)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{w.name}</div>
                  <div className="text-2xs text-slate-400 truncate font-mono">{w.path}</div>
                </div>
                <span className="text-2xs text-slate-400">{w.lastOpened}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-slate-400">No workspaces match "{q}"</li>
          )}
        </ul>
        <div className="border-t border-slate-200 dark:border-slate-800 px-3 py-1.5 text-2xs text-slate-400 flex items-center gap-3">
          <span className="flex items-center gap-1">
            <Command className="w-3 h-3" /> P to toggle
          </span>
          <span>↑↓ navigate</span>
          <span>↵ open</span>
        </div>
      </div>
    </div>
  );
}

// ---------- Help overlay ----------

function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm grid place-items-center" onClick={onClose}>
      <div
        className="w-[640px] bg-white dark:bg-slate-900 rounded-lg shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <span className="font-semibold text-sm flex items-center gap-2">
            <Keyboard className="w-4 h-4" /> Keyboard reference
          </span>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 px-5 py-4 text-sm">
          <HelpRow k="Tab / ⇧Tab" label="Nest / outdent Node" />
          <HelpRow k="↑ / ↓" label="Move between Nodes" />
          <HelpRow k="↵" label="New sibling Node" />
          <HelpRow k="⌘↵" label="Send prompt to Claude" />
          <HelpRow k="⌘B" label="Branch from Block (inclusive)" />
          <HelpRow k="⌘⇧R" label="Retry from here (exclusive)" />
          <HelpRow k="⌘N" label="New thread sibling under Root" />
          <HelpRow k="⌘.​" label="Cancel in-flight turn" />
          <HelpRow k="⌘P" label="Workspace switcher" />
          <HelpRow k="⌘K" label="Search Nodes" />
          <HelpRow k="⌘Z / ⇧⌘Z" label="Undo / redo" />
          <HelpRow k="?" label="Toggle this help" />
        </div>
        <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-2xs text-slate-500">
          variant B · branches-as-columns · all keys are demo affordances, no live handlers
        </div>
      </div>
    </div>
  );
}

function HelpRow({ k, label }: { k: string; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-700 dark:text-slate-200">{label}</span>
      <kbd className="font-mono text-2xs border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 bg-slate-50 dark:bg-slate-800">
        {k}
      </kbd>
    </div>
  );
}

// ---------- helpers ----------

function findThreadRoot(nodes: OutlineNode[]): ThreadRoot {
  for (const n of nodes) {
    if (n.kind === 'thread-root') return n;
    if (n.kind === 'content') {
      const r = findThreadRoot(n.children);
      if (r) return r;
    }
  }
  throw new Error('no thread root in fixtures');
}
