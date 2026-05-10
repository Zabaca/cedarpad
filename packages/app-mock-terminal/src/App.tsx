import { useEffect, useMemo, useState } from "react";
import { tree, workspaces, type OutlineNode } from "./fixtures";

/* The selected node id used to demo the inline action menu. */
const SELECTED_ID = "b2"; // tool_use Read block in thread/main

const KEY_HINTS = [
  { key: "j/k", desc: "nav" },
  { key: "h/l", desc: "fold" },
  { key: "o", desc: "new sibling" },
  { key: "O", desc: "new above" },
  { key: "Tab", desc: "nest" },
  { key: "S-Tab", desc: "outdent" },
  { key: "z", desc: "zoom" },
  { key: "b", desc: "Branch" },
  { key: "r", desc: "Retry" },
  { key: "n", desc: "New thread" },
  { key: "/", desc: "search" },
  { key: "⌘P", desc: "switch ws" },
  { key: "i", desc: "insert" },
  { key: ":", desc: "cmd" },
  { key: "?", desc: "help" },
];

export function App() {
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Cmd+P / Ctrl+P / Esc — minimal so the palette is interactive.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "Escape") {
        setPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app">
      <TabBar />
      <main className="main">
        <Breadcrumb segments={["cedarpad", "Engineering log", "cedarpad design notes"]} />
        <Outline nodes={tree} />
      </main>
      <StatusLine />
      {paletteOpen && <Palette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

/* ───────────────────────── Top bar ───────────────────────── */

function TabBar() {
  return (
    <header className="tabbar">
      <div className="tabbar__brand">
        cedarpad <span className="dim">// variant C · terminal</span>
      </div>
      <div className="tab is-active">
        <span className="marker">▶</span>
        <span>cedarpad design notes</span>
        <span className="badge">[2 threads]</span>
      </div>
      <div className="tab">
        <span className="marker">●</span>
        <span>Open questions</span>
      </div>
      <div className="tab">
        <span className="marker">●</span>
        <span>Reading list</span>
      </div>
      <div className="tabbar__spacer" />
      <div className="tabbar__meta">
        <span>
          <span className="key">⌘P</span> switch workspace
        </span>
        <span>
          <span className="key">⌘K</span> command
        </span>
      </div>
    </header>
  );
}

/* ───────────────────────── Breadcrumb ───────────────────────── */

function Breadcrumb({ segments }: { segments: string[] }) {
  return (
    <nav className="breadcrumb">
      <span className="dim">~/cedarpad</span>
      <span className="sep">::</span>
      {segments.map((s, i) => {
        const isLeaf = i === segments.length - 1;
        return (
          <span key={i} style={{ display: "inline-flex", gap: 6 }}>
            <span className={`seg${isLeaf ? " is-leaf" : ""}`}>{s}</span>
            {!isLeaf && <span className="sep">/</span>}
          </span>
        );
      })}
      <span style={{ marginLeft: "auto" }} className="dim">
        zoom: <span className="cyan">cedarpad design notes</span>
      </span>
    </nav>
  );
}

/* ───────────────────────── Outline ───────────────────────── */

function Outline({ nodes }: { nodes: OutlineNode[] }) {
  return (
    <div role="tree" aria-label="cedarpad outline">
      {nodes.map((n) => (
        <NodeView key={n.id} node={n} depth={0} />
      ))}
    </div>
  );
}

function indentRail(depth: number): string {
  // Visual indent of "│  " columns for each depth, terminal-tree style.
  if (depth === 0) return "";
  return "│ ".repeat(depth - 1) + "│ ";
}

function NodeView({ node, depth }: { node: OutlineNode; depth: number }) {
  const isSelected = node.id === SELECTED_ID;
  const className = useMemo(() => {
    const classes = ["row", `kind-${node.kind}`];
    if (node.completed) classes.push("completed");
    if (isSelected) classes.push("is-selected");
    return classes.join(" ");
  }, [node.kind, node.completed, isSelected]);

  return (
    <>
      <div className={className} data-id={node.id}>
        <span className="row__indent">{indentRail(depth)}</span>
        <span className="row__marker">{rowMarker(node)}</span>
        <span className="row__body">
          <span className="row__text">
            {renderText(node)}
            {node.streaming && <span className="caret">█</span>}
          </span>
          {node.meta && <span className="row__meta">{node.meta}</span>}
        </span>
      </div>

      {/* Block-result rows render the captured output below the row */}
      {node.kind === "block-result" && node.resultBlock && (
        <div className="row kind-block-result">
          <span className="row__indent">{indentRail(depth)}</span>
          <span className="row__marker"> </span>
          <span className="row__body">
            <pre>
              <span className={node.resultStatus === "err" ? "err" : "ok"}>
                {node.resultStatus === "err" ? "⨯ " : "✓ "}
              </span>
              {node.resultBlock}
            </pre>
          </span>
        </div>
      )}

      {/* Inline action menu hangs under the selected row */}
      {isSelected && <ActionMenu />}

      {/* Side-by-side sibling threads */}
      {node.split && (
        <div className="threads-split">
          <ThreadColumn
            title={node.split.left.title}
            badge={node.split.left.badge}
            badgeAlt={false}
            depth={depth + 1}
            children={node.split.left.children}
          />
          <ThreadColumn
            title={node.split.right.title}
            badge={node.split.right.badge}
            badgeAlt
            depth={depth + 1}
            children={node.split.right.children}
          />
        </div>
      )}

      {/* Regular children */}
      {node.children?.map((c) => (
        <NodeView key={c.id} node={c} depth={depth + 1} />
      ))}
    </>
  );
}

function rowMarker(node: OutlineNode): string {
  if (node.completed) return "✓";
  return node.marker;
}

function renderText(node: OutlineNode): React.ReactNode {
  // tool_use rows: "$ Read packages/foo/bar.ts" — split the prefix verb so we can
  // render the command in white while the verb itself stays yellow.
  if (node.kind === "block-tool") {
    const [verb, ...rest] = node.text.split(" ");
    return (
      <>
        <span>{verb} </span>
        <span className="tool-cmd">{rest.join(" ")}</span>
      </>
    );
  }
  return node.text;
}

/* ───────────────────────── Side-by-side threads ───────────────────────── */

function ThreadColumn(props: {
  title: string;
  badge: string;
  badgeAlt: boolean;
  depth: number;
  children: OutlineNode[];
}) {
  return (
    <div className="threads-split__col">
      <h4>
        {props.title}
        <span className={`badge${props.badgeAlt ? " alt" : ""}`}>[{props.badge}]</span>
      </h4>
      {props.children.map((n) => (
        <NodeView key={n.id} node={n} depth={props.depth} />
      ))}
    </div>
  );
}

/* ───────────────────────── Action menu ───────────────────────── */

function ActionMenu() {
  return (
    <div className="actions" role="menu" aria-label="Block actions">
      <span className="label">block actions</span>
      <span className="arrow">→</span>
      <span className="item">
        <span className="key">b</span>
        <span className="name">
          <strong>B</strong>ranch
        </span>
      </span>
      <span className="item">
        <span className="key">r</span>
        <span className="name">
          <strong>R</strong>etry from here
        </span>
      </span>
      <span className="item">
        <span className="key">n</span>
        <span className="name">
          <strong>N</strong>ew thread sibling
        </span>
      </span>
      <span className="item">
        <span className="key">y</span>
        <span className="name">
          <strong>Y</strong>ank
        </span>
      </span>
      <span className="item">
        <span className="key">d</span>
        <span className="name">
          <strong>D</strong>elete
        </span>
      </span>
    </div>
  );
}

/* ───────────────────────── Status line ───────────────────────── */

function StatusLine() {
  return (
    <footer className="statusline">
      <div className="statusline__mode">NORMAL</div>
      <div className="statusline__path">
        ws: <span className="repo">~/Projects/zabaca/cedarpad</span>
      </div>
      <div className="statusline__thread">
        thread: <span className="name">main</span> <span className="dim">(2 siblings)</span>
      </div>
      <div className="statusline__hints">
        {KEY_HINTS.map((h) => (
          <span key={h.key}>
            <span className="key">{h.key}</span> <span className="desc">{h.desc}</span>
          </span>
        ))}
      </div>
      <div className="statusline__right">
        <span className="live">●</span> claude idle &nbsp;·&nbsp; tokens 12.4k/200k &nbsp;·&nbsp; 1:1
      </div>
    </footer>
  );
}

/* ───────────────────────── Workspace switcher ───────────────────────── */

function Palette({ onClose }: { onClose: () => void }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
        e.preventDefault();
        setActive((i) => Math.min(workspaces.length - 1, i + 1));
      } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="Workspace switcher" onClick={(e) => e.stopPropagation()}>
        <div className="palette__header">
          <span className="palette__prompt">›</span>
          <span className="palette__query">
            ced<span className="caret">█</span>
          </span>
          <span className="palette__hint">
            <span className="k">⏎</span> open · <span className="k">esc</span> close
          </span>
        </div>
        <ul className="palette__list">
          {workspaces.map((w, i) => (
            <li key={w.name} className={`palette__row${i === active ? " is-active" : ""}`}>
              <span className="idx">{i + 1}</span>
              <span>
                <span className="name">{renderMatched(w.name, w.matchIndices)}</span>
                <span style={{ marginLeft: 10 }} className="path">
                  {w.path}
                </span>
              </span>
              <span className="meta">
                {w.threadCount} threads · {w.lastUsed}
              </span>
            </li>
          ))}
        </ul>
        <div className="palette__footer">
          <span>
            <span className="key">↑↓</span> / <span className="key">⌃p</span>/<span className="key">⌃n</span> nav
          </span>
          <span>
            <span className="key">⏎</span> open
          </span>
          <span>
            <span className="key">⌘⏎</span> open in new window
          </span>
          <span>
            <span className="key">⌫</span> remove from recents
          </span>
        </div>
      </div>
    </div>
  );
}

function renderMatched(name: string, indices: number[]) {
  const set = new Set(indices);
  return name.split("").map((ch, i) =>
    set.has(i) ? (
      <span key={i} className="match">
        {ch}
      </span>
    ) : (
      <span key={i}>{ch}</span>
    ),
  );
}
