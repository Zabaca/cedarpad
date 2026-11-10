// A Workflowy-style outliner that lives on the canvas. Interactive AND SHARED: every edit
// calls setData({ nodes }), which merges into this shape's `data` (synced to everyone on
// the canvas + saved across reloads — see ComponentShape's setData).
//
// The outline is rendered straight off the `nodes` prop — there is no local mirror of the
// tree. That is what makes it shared: a collaborator's edit arrives as a new `nodes` prop
// and renders immediately. `useState` here is only for state that is genuinely per-viewer
// (which bullet you have zoomed into, whether you're hiding completed items) — your zoom
// is yours, the outline is everyone's.
//
// Props (the `data` you place it with), all optional:
//   { title?: string, nodes?: Record<id, { id, text, children: id[], collapsed?, completed?, note? }> }
// Omit `nodes` to get the welcome outline. The map is keyed by id and rooted at "root",
// so an agent can write a whole outline in one place_component call.
//
// Keys: Enter splits the bullet · Shift+Enter opens a description · Tab / Shift+Tab
// indent and outdent · Backspace at position 0 merges into the row above · ⌘/Ctrl+Enter
// marks done · ↑ / ↓ move between rows. Click a bullet ● to zoom into it; the breadcrumb
// walks back out.
//
// Every control is a <textarea> or carries role="button", so tldraw doesn't steal the
// pointer (see the isInteractiveControl guard in src/predicates.ts). The tree algebra
// itself is in src/outline-tree.ts, unit-tested there.
import { type CSSProperties, type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';

import {
  ROOT,
  type OutlineNode,
  type OutlineNodes,
  type Edit,
  flattenVisible,
  indent,
  mergeInto,
  outdent,
  parentOf,
  pathTo,
  splitAt,
} from '../outline-tree';

type Data = { nodes?: OutlineNodes; title?: string };
type Props = Data & { setData?: (patch: Partial<Data>) => void };

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : `n_${Math.floor(Math.random() * 1e9)}`;

// The welcome outline, shown until someone writes `nodes`. Ids are FIXED, like Kanban's
// DEFAULT_COLUMNS: a random-id seed would give every viewer of an untouched outline a
// different tree, so the first edit — which persists that viewer's ids — would look to
// everyone else like the outline being replaced. Never mutated: every edit below clones
// first (as do the outline-tree functions), so this constant is safe to share.
const SEED: OutlineNodes = {
  [ROOT]: { id: ROOT, text: '', children: ['w1', 'w5'] },
  w1: { id: 'w1', text: 'Welcome to your outline', children: ['w2', 'w3', 'w4'] },
  w2: { id: 'w2', text: 'Press Enter to make a new bullet', children: [] },
  w3: { id: 'w3', text: 'Tab to indent · Shift+Tab to outdent', children: [] },
  w4: { id: 'w4', text: 'Click a bullet ● to zoom in', children: [] },
  w5: { id: 'w5', text: 'Groceries', children: ['w6', 'w7'] },
  w6: { id: 'w6', text: 'Coffee', children: [] },
  w7: { id: 'w7', text: 'Oat milk', children: [] },
};

// Self-contained light surface. Like Kanban, this card paints its own paper rather than
// reading the cedar tokens — an outline is a document, and it reads as one on the board.
const C = {
  bg: '#ffffff',
  text: '#42484d',
  faint: '#9ea1a5',
  bullet: '#4d4d4d',
  halo: '#d4e0e8',
  line: '#edeef0',
  accent: '#2b7fd4',
  crumb: '#8a8f94',
};

function Row(props: {
  node: OutlineNode;
  depth: number;
  onText: (id: string, v: string) => void;
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>, id: string) => void;
  onToggle: (id: string) => void;
  onZoom: (id: string) => void;
  registerRef: (id: string, el: HTMLTextAreaElement | null) => void;
  onNoteText: (id: string, v: string) => void;
  onNoteKey: (e: KeyboardEvent<HTMLTextAreaElement>, id: string) => void;
  registerNoteRef: (id: string, el: HTMLTextAreaElement | null) => void;
}) {
  const { node, depth, onText, onKey, onToggle, onZoom, registerRef, onNoteText, onNoteKey, registerNoteRef } = props;
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const [hover, setHover] = useState(false);
  const hasKids = node.children.length > 0;

  // Both textareas grow with their content: rows={1} plus a measured scrollHeight, so a
  // long bullet wraps instead of scrolling inside a one-line box.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [node.text]);

  useLayoutEffect(() => {
    const el = noteRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [node.note]);

  return (
    <>
      <div
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ display: 'flex', alignItems: 'flex-start', gap: 2, marginLeft: depth * 22, padding: '1px 0' }}
      >
        {/* collapse triangle — only interactive, and only visible, when there is a subtree */}
        <div
          role={hasKids ? 'button' : undefined}
          onClick={() => hasKids && onToggle(node.id)}
          style={{
            width: 16,
            height: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: hasKids ? 'pointer' : 'default',
            color: C.faint,
            fontSize: 9,
            opacity: hasKids && (hover || node.collapsed) ? 1 : 0,
            transition: 'transform .12s ease',
            transform: node.collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            userSelect: 'none',
          }}
        >
          ▶
        </div>
        {/* bullet dot — the zoom target. Haloed when it hides a collapsed subtree. */}
        <div
          role="button"
          title="Zoom in"
          onClick={() => onZoom(node.id)}
          style={{ width: 18, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: C.bullet,
              boxShadow: node.collapsed && hasKids ? `0 0 0 5px ${C.halo}` : 'none',
            }}
          />
        </div>
        <textarea
          ref={(el) => {
            ref.current = el;
            registerRef(node.id, el);
          }}
          value={node.text}
          rows={1}
          // onInput, not onChange (same convention as ChatStarter): for a textarea they
          // fire on the same native event, but React's onChange is synthesized through a
          // value tracker that happy-dom defeats — so onChange is untestable here, and
          // this is the edit path whose sharing the tests exist to pin.
          onInput={(e) => onText(node.id, (e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => onKey(e, node.id)}
          placeholder=" "
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            resize: 'none',
            background: 'transparent',
            font: 'inherit',
            fontSize: 14.5,
            lineHeight: '22px',
            color: node.completed ? C.faint : C.text,
            textDecoration: node.completed ? 'line-through' : 'none',
            padding: '1px 0',
            margin: 0,
            overflow: 'hidden',
            minWidth: 0,
          }}
        />
      </div>
      {node.note !== undefined && (
        <div style={{ display: 'flex', marginLeft: depth * 22 + 24, paddingBottom: 2 }}>
          <textarea
            ref={(el) => {
              noteRef.current = el;
              registerNoteRef(node.id, el);
            }}
            value={node.note}
            rows={1}
            onInput={(e) => onNoteText(node.id, (e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => onNoteKey(e, node.id)}
            placeholder="Add a description…"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              resize: 'none',
              background: 'transparent',
              font: 'inherit',
              fontSize: 12.5,
              lineHeight: '18px',
              color: C.crumb,
              fontStyle: 'italic',
              padding: 0,
              margin: 0,
              overflow: 'hidden',
              minWidth: 0,
            }}
          />
        </div>
      )}
    </>
  );
}

export default function Outliner({ nodes: nodesProp, title, setData }: Props) {
  // The shared tree. Prop-derived, NOT mirrored into state — see the file header. A
  // `nodes` without a ROOT is unrenderable (nothing to walk from), so it falls back the
  // same way a missing one does rather than showing an empty card.
  const nodes: OutlineNodes = nodesProp?.[ROOT] ? nodesProp : SEED;
  const [zoomId, setZoomId] = useState<string>(ROOT);
  const [showCompleted, setShowCompleted] = useState(true);
  const refs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const noteRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const pending = useRef<{ id: string; caret: number; field?: 'note' } | null>(null);

  // Focus and caret are applied AFTER the render that requested them: an edit that creates
  // or removes a row has to commit before the textarea it targets exists to focus.
  useLayoutEffect(() => {
    if (!pending.current) return;
    const { id, caret, field } = pending.current;
    const el = field === 'note' ? noteRefs.current[id] : refs.current[id];
    if (el) {
      el.focus();
      const c = Math.min(caret, el.value.length);
      el.setSelectionRange(c, c);
    }
    pending.current = null;
  });

  // The ONLY writer. Publishing to the shape is the whole update: the new tree comes back
  // as a prop on the next render, here and in every other tab on the canvas.
  const commit = (next: OutlineNodes) => {
    setData?.({ nodes: next });
  };
  const focus = (id: string, caret: number, field?: 'note') => {
    pending.current = { id, caret, field };
  };
  /** Move the caret into a textarea that already exists. Used where nothing is committed —
   *  with no local mirror of the tree, a no-op edit no longer forces a render, so those
   *  paths can't route through `pending` and must place the caret themselves. */
  const focusNow = (id: string, caret: number, field?: 'note') => {
    const el = field === 'note' ? noteRefs.current[id] : refs.current[id];
    if (!el) return;
    el.focus();
    const c = Math.min(caret, el.value.length);
    el.setSelectionRange(c, c);
  };
  /** Apply one of the pure tree edits, or do nothing if it refused. */
  const apply = (edit: Edit) => {
    if (!edit) return;
    commit(edit.nodes);
    focus(edit.focus.id, edit.focus.caret);
  };
  const clone = (): OutlineNodes => JSON.parse(JSON.stringify(nodes)) as OutlineNodes;

  // A zoom target can be deleted (merged away) while it is the view root — fall back to
  // the whole outline rather than rendering an empty card with a dead breadcrumb.
  const activeZoom = nodes[zoomId] ? zoomId : ROOT;
  const flat = flattenVisible(nodes, activeZoom, showCompleted);

  const onText = (id: string, v: string) => {
    const n = clone();
    const node = n[id];
    if (node) node.text = v;
    commit(n);
  };

  const onNoteText = (id: string, v: string) => {
    const n = clone();
    const node = n[id];
    if (node) node.note = v;
    commit(n);
  };

  const toggle = (id: string) => {
    const n = clone();
    const node = n[id];
    if (node) node.collapsed = !node.collapsed;
    commit(n);
  };

  const toggleComplete = (id: string) => {
    const n = clone();
    const node = n[id];
    if (node) node.completed = !node.completed;
    commit(n);
  };

  const openNote = (id: string) => {
    // Already open: the textarea is on screen, and re-committing an unchanged tree is not
    // guaranteed to produce a render for `pending` to ride on. Just go there.
    if (nodes[id]?.note !== undefined) {
      focusNow(id, 0, 'note');
      return;
    }
    const n = clone();
    const node = n[id];
    if (node) node.note = '';
    commit(n);
    focus(id, 0, 'note');
  };

  const closeNote = (id: string) => {
    const n = clone();
    const node = n[id];
    const textLen = node?.text.length ?? 0;
    if (node) delete node.note;
    commit(n);
    focus(id, textLen);
  };

  const addChild = (parentId: string) => {
    const n = clone();
    const parent = n[parentId];
    if (!parent) return;
    const nid = uid();
    n[nid] = { id: nid, text: '', children: [] };
    parent.children.push(nid);
    commit(n);
    focus(nid, 0);
  };

  const onNoteKey = (e: KeyboardEvent<HTMLTextAreaElement>, id: string) => {
    const el = e.currentTarget;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    if (e.key === 'Escape') {
      e.preventDefault();
      focusNow(id, nodes[id]?.text.length ?? 0);
    } else if (e.key === 'Backspace' && atStart && !el.value) {
      e.preventDefault();
      closeNote(id);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>, id: string) => {
    const el = e.currentTarget;
    const caret = el.selectionStart;
    const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    const index = flat.findIndex((r) => r.id === id);

    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      toggleComplete(id);
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      openNote(id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      apply(splitAt(nodes, id, caret, uid()));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      apply(e.shiftKey ? outdent(nodes, id, caret, activeZoom) : indent(nodes, id, caret));
    } else if (e.key === 'Backspace' && atStart && index > 0) {
      const prev = flat[index - 1];
      if (prev) {
        e.preventDefault();
        apply(mergeInto(nodes, prev.id, id));
      }
    } else if (e.key === 'ArrowUp' && atStart && index > 0) {
      const prev = flat[index - 1];
      if (prev) {
        e.preventDefault();
        focusNow(prev.id, refs.current[prev.id]?.value.length ?? 0);
      }
    } else if (e.key === 'ArrowDown' && atEnd && index < flat.length - 1) {
      const next = flat[index + 1];
      if (next) {
        e.preventDefault();
        focusNow(next.id, 0);
      }
    }
  };

  const registerRef = (id: string, el: HTMLTextAreaElement | null) => {
    refs.current[id] = el;
  };
  const registerNoteRef = (id: string, el: HTMLTextAreaElement | null) => {
    noteRefs.current[id] = el;
  };

  const crumbs = pathTo(nodes, activeZoom);
  const zoomedNode = nodes[activeZoom];
  const isZoomed = activeZoom !== ROOT;

  const crumbBtn: CSSProperties = {
    background: 'none',
    border: 'none',
    padding: 0,
    font: 'inherit',
    fontSize: 12,
    color: C.crumb,
    cursor: 'pointer',
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: C.bg,
        border: `1px solid ${C.line}`,
        borderRadius: 12,
        overflow: 'hidden',
        font: '400 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: C.text,
        boxShadow: '0 1px 3px rgba(20,20,30,0.06)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '9px 16px',
          borderBottom: `1px solid ${C.line}`,
          flexShrink: 0,
          minHeight: 20,
        }}
      >
        <button
          type="button"
          style={{ ...crumbBtn, color: isZoomed ? C.crumb : C.text, fontWeight: isZoomed ? 400 : 600 }}
          onClick={() => setZoomId(ROOT)}
        >
          {title || 'Home'}
        </button>
        {/* the trail, minus the zoomed node itself — that one is the title below */}
        {crumbs.slice(0, -1).map((cid) => (
          <span key={cid} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ color: C.faint, fontSize: 11 }}>/</span>
            <button type="button" style={crumbBtn} onClick={() => setZoomId(cid)}>
              {nodes[cid]?.text || 'Untitled'}
            </button>
          </span>
        ))}
        <button
          type="button"
          title="Toggle completed items"
          onClick={() => setShowCompleted((s) => !s)}
          style={{
            marginLeft: 'auto',
            background: showCompleted ? 'transparent' : '#eef2f5',
            border: `1px solid ${C.line}`,
            borderRadius: 6,
            padding: '3px 9px',
            fontSize: 11.5,
            fontWeight: 500,
            color: showCompleted ? C.crumb : C.accent,
            cursor: 'pointer',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {showCompleted ? 'Hide completed' : 'Show completed'}
        </button>
      </div>

      {isZoomed && zoomedNode && (
        <div style={{ padding: '14px 18px 4px 20px', flexShrink: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.text, lineHeight: 1.2 }}>{zoomedNode.text || 'Untitled'}</div>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 16px' }}>
        {flat.length === 0 && <div style={{ color: C.faint, fontSize: 13.5, padding: '6px 4px' }}>Nothing here yet.</div>}
        {flat.map((r) => {
          const node = nodes[r.id];
          return node ? (
            <Row
              key={r.id}
              node={node}
              depth={r.depth}
              onText={onText}
              onKey={onKey}
              onToggle={toggle}
              onZoom={setZoomId}
              registerRef={registerRef}
              onNoteText={onNoteText}
              onNoteKey={onNoteKey}
              registerNoteRef={registerNoteRef}
            />
          ) : null;
        })}
        <div
          role="button"
          onClick={() => addChild(activeZoom)}
          style={{ marginLeft: 36, marginTop: 4, padding: '3px 0', color: C.faint, fontSize: 13.5, cursor: 'text', userSelect: 'none' }}
        >
          + Add item
        </div>
      </div>
    </div>
  );
}
