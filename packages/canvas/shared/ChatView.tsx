// The presentational chat UI: one conversation (keyed by `chatId`) rendered over the
// tldraw-free chat-store (SSE stream, transcript, send). Shared so both surfaces render
// the SAME chat: the canvas app wraps it in `ChatShapeUtil` (its tldraw shape), and the
// edge Shell's Inbox renders it directly. This module MUST stay tldraw-free — the tldraw
// coupling lives entirely in `src/ChatShape.tsx`.

import * as React from 'react';

import { requestFork, setActiveChat } from '../src/agent-link';
import { EFFORTS, ensureSession, getSnapshot, interrupt, type McpSelection, MODELS, openStream, type PendingImage, send, setEffort, setMcpSelection, setModel, subscribe, takeFirstPrompt, toolNameOf } from './chat-store';
import { useGuestScope } from './guest-scope';
import { MarkdownMessage } from './MarkdownMessage';

// Per-chat MCP selection (opt-out; default = every connected server/tool on). Server names
// come from the member-readable edge list; tool names load lazily per server. Any member may
// toggle — the selection is server-owned ChatMeta, converged across tabs like model/effort.
function McpPopover({ chatId, mcp }: { chatId: string; mcp: McpSelection | null }) {
  const [open, setOpen] = React.useState(false);
  const [servers, setServers] = React.useState<Array<{ name: string; connected: boolean }> | 'error' | null>(null);
  const [tools, setTools] = React.useState<Record<string, Array<{ name: string }> | 'loading' | 'error'>>({});
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const wsRef = React.useRef<string | null>(null);
  const sel: McpSelection = mcp ?? { disabledServers: [], disabledTools: {} };
  const offCount = sel.disabledServers.length + Object.values(sel.disabledTools).reduce((n, t) => n + t.length, 0);

  const toggleOpen = () => {
    setOpen((v) => !v);
    if (servers !== null) return;
    void (async () => {
      try {
        const cv = await fetch('/api/canvases', { credentials: 'same-origin' });
        if (!cv.ok) throw new Error(String(cv.status));
        const { workspaceId } = (await cv.json()) as { workspaceId: string };
        wsRef.current = workspaceId;
        const res = await fetch(`/api/workspaces/${workspaceId}/mcp`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(String(res.status));
        setServers(((await res.json()) as { servers: Array<{ name: string; connected: boolean }> }).servers);
      } catch {
        setServers('error');
      }
    })();
  };

  const expand = (name: string) => {
    setExpanded((e) => ({ ...e, [name]: !e[name] }));
    if (tools[name] || !wsRef.current) return;
    setTools((t) => ({ ...t, [name]: 'loading' }));
    void fetch(`/api/workspaces/${wsRef.current}/mcp/${encodeURIComponent(name)}/tools`, { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { tools: Array<{ name: string }> };
        setTools((t) => ({ ...t, [name]: body.tools }));
      })
      .catch(() => setTools((t) => ({ ...t, [name]: 'error' })));
  };

  const toggleServer = (name: string, enable: boolean) => {
    const off = new Set(sel.disabledServers);
    if (enable) off.delete(name);
    else off.add(name);
    setMcpSelection(chatId, { ...sel, disabledServers: [...off] });
  };

  const toggleTool = (server: string, tool: string, enable: boolean) => {
    const off = new Set(sel.disabledTools[server] ?? []);
    if (enable) off.delete(tool);
    else off.add(tool);
    const disabledTools = { ...sel.disabledTools };
    if (off.size === 0) delete disabledTools[server];
    else disabledTools[server] = [...off];
    setMcpSelection(chatId, { ...sel, disabledTools });
  };

  return (
    <span className="chat-mcp-wrap" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={`chat-mcp-btn${offCount > 0 ? ' chat-mcp-btn-limited' : ''}`}
        onClick={toggleOpen}
        title={offCount > 0 ? `MCP tools for this chat (${offCount} turned off)` : 'MCP tools for this chat (all on)'}
      >
        mcp
      </button>
      {open && (
        <div className="chat-mcp-pop">
          {servers === null && <div className="chat-mcp-note">loading…</div>}
          {servers === 'error' && <div className="chat-mcp-note">unavailable</div>}
          {Array.isArray(servers) && servers.length === 0 && <div className="chat-mcp-note">no external MCP servers in the registry</div>}
          {Array.isArray(servers) &&
            servers.map((s) => {
              const enabled = !sel.disabledServers.includes(s.name);
              const t = tools[s.name];
              return (
                <div key={s.name} className="chat-mcp-server">
                  <label className="chat-mcp-row" title={s.connected ? undefined : 'Not connected for this workspace'}>
                    <input type="checkbox" checked={enabled} disabled={!s.connected} onChange={(e) => toggleServer(s.name, e.target.checked)} />
                    <span>{s.name}</span>
                    {!s.connected && <span className="chat-mcp-note">not connected</span>}
                    {s.connected && (
                      <button type="button" className="chat-mcp-expand" onClick={() => expand(s.name)} title="Choose individual tools">
                        {expanded[s.name] ? '▾' : '▸'}
                      </button>
                    )}
                  </label>
                  {expanded[s.name] && enabled && (
                    <div className="chat-mcp-tools">
                      {t === 'loading' && <div className="chat-mcp-note">loading tools…</div>}
                      {t === 'error' && <div className="chat-mcp-note">could not list tools</div>}
                      {Array.isArray(t) &&
                        t.map((tool) => (
                          <label key={tool.name} className="chat-mcp-row">
                            <input
                              type="checkbox"
                              checked={!(sel.disabledTools[s.name] ?? []).includes(tool.name)}
                              onChange={(e) => toggleTool(s.name, tool.name, e.target.checked)}
                            />
                            <span>{tool.name}</span>
                          </label>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      )}
    </span>
  );
}

// `onDock` (optional) renders the dock affordance — only the embedded pad passes it
// (ChatShape); the Inbox thread and the Shell's own docked panel render without one.
// `onFocus` (optional) renders the "⌖ On canvas" affordance — only the Inbox thread passes
// it, and only when this conversation has a linked canvas AND the canvas pane is showing.
// The pad's own card never does: focusing the card you are already reading is a no-op.
export function ChatView({ chatId, title, onDock, onFocus }: { chatId: string; title: string; onDock?: () => void; onFocus?: () => void }) {
  ensureSession(chatId); // idempotent sync load so the first render has the transcript
  const snap = React.useSyncExternalStore(
    React.useCallback((cb) => subscribe(chatId, cb), [chatId]),
    React.useCallback(() => getSnapshot(chatId), [chatId]),
  );
  const [input, setInput] = React.useState('');
  const [pending, setPending] = React.useState<PendingImage[]>([]);
  // #220: a guest without the link's guestChat grant sees every conversation VIEW-ONLY —
  // the composer is hidden entirely (the gate 401s sends anyway; don't offer them).
  const guest = useGuestScope();
  const readOnly = !!guest && !guest.guestChat;
  const scroller = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  // Always-current ref so the window listener closure never goes stale.
  const doSubmitRef = React.useRef<() => void>(() => {});

  React.useEffect(() => {
    openStream(chatId); // tied to the shape, not this mount — no cleanup (survives culling)
  }, [chatId]);
  React.useEffect(() => {
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
  }, [snap.items.length, snap.status, snap.busy]);
  // A chat started from the canvas starter carries its opening prompt armed on the shape
  // id: fire it as the first turn the moment this card's stream is live. `takeFirstPrompt`
  // is claim-once, so a remount (or a second card on the same chat) never re-sends it.
  React.useEffect(() => {
    if (!snap.subscribed || readOnly) return;
    const first = takeFirstPrompt(chatId);
    if (first) void send(chatId, first, []);
  }, [chatId, snap.subscribed, readOnly]);

  const addImageFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const m = /^data:(image\/[a-z+]+);base64,(.+)$/s.exec(dataUrl);
      if (!m || !m[1] || !m[2]) return;
      setPending((p) => [...p, { media_type: m[1]!, data: m[2]!, dataUrl }]);
    };
    reader.readAsDataURL(file);
  };
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clip = e.clipboardData?.items;
    if (!clip) return;
    let found = false;
    for (const it of clip) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) {
          addImageFile(file);
          found = true;
        }
      }
    }
    if (found) e.preventDefault();
  };

  const doSubmit = () => {
    const message = input.trim();
    if ((!message && pending.length === 0) || !snap.subscribed) return;
    const imgs = pending;
    setInput('');
    setPending([]);
    void send(chatId, message, imgs);
    setTimeout(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.style.height = 'auto';
      ta.style.overflowY = 'hidden';
      ta.focus();
    }, 0);
  };

  doSubmitRef.current = doSubmit;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  };

  // Window-level capture listener fires before any tldraw native keydown handler.
  // Uses form.requestSubmit() — identical code path to clicking Send.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target !== textareaRef.current) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const form = textareaRef.current?.closest('form');
        form?.requestSubmit();
      } else if (e.key === 'Escape' && getSnapshot(chatId).busy) {
        // Esc interrupts the running turn (like Claude Code). Only swallow the key
        // when there's actually a turn to stop; otherwise let tldraw handle Escape.
        e.preventDefault();
        e.stopImmediatePropagation();
        void interrupt(chatId);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [chatId]);

  return (
    <div className="chat-card" onPointerDownCapture={() => setActiveChat(chatId)}>
      <div className="chat-card-head">
        <span aria-hidden className={`t-dot${snap.busy ? ' busy' : ''}`}>
          ⏺
        </span>
        <span className="chat-card-title">{title}</span>
        {snap.busy && <span className="chat-card-status">{snap.subscribed ? snap.status || 'working' : 'reconnecting…'}</span>}
        {snap.busy && (
          <button
            type="button"
            className="chat-stop"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => interrupt(chatId)}
            title="Stop the agent (Esc)"
          >
            Stop
          </button>
        )}
        {onFocus && (
          <button
            type="button"
            className="chat-focus"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onFocus}
            title="Center the canvas on this chat's card"
          >
            ⌖ On canvas
          </button>
        )}
        {snap.contextPct !== null && (
          <span className="chat-ctx" title="Context window used on the last turn">
            {snap.contextPct}%
          </span>
        )}
        {onDock && (
          <button
            type="button"
            className="chat-dock"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onDock}
            title="Dock this chat into the side panel (the card stays)"
          >
            ⇱
          </button>
        )}
        <button
          type="button"
          className="chat-fork"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => requestFork(chatId)}
          title="Fork this chat into a new session"
        >
          ⑂
        </button>
        <select
          className="chat-model"
          value={snap.model}
          onChange={(e) => setModel(chatId, e.target.value)}
          title="Model for this chat (applies to the next message)"
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select
          className="chat-model"
          value={snap.effort}
          onChange={(e) => setEffort(chatId, e.target.value)}
          title="Reasoning effort (applies to the next message). 'default' lets the model decide."
        >
          {EFFORTS.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        {!guest && <McpPopover chatId={chatId} mcp={snap.mcp} />}
      </div>
      <div className="chat-card-body">
        {Object.keys(snap.tasks).length > 0 && (
          <div className="job-tray" title="Background jobs running in this chat">
            {Object.values(snap.tasks).map((t) => (
              <div key={t.id} className={`job-row ${t.status}`}>
                <span aria-hidden className="job-dot">
                  ◆
                </span>
                <span className="job-type">{t.taskType ?? 'job'}</span>
                <span className="job-title">{t.title || t.detail || t.id}</span>
                {t.summary && <span className="job-summary">{t.summary}</span>}
                <span className="sr-only"> ({t.status})</span>
              </div>
            ))}
          </div>
        )}
        {Object.keys(snap.todos).length > 0 && (
          <ol className="todo-tray" title="The agent's plan (TaskCreate / TaskUpdate)">
            {Object.values(snap.todos).map((t, i) => (
              <li key={t.id} className={`todo-row ${t.status}`}>
                {/* `⎿ ` on the first row only, then aligned padding — Claude Code's list
                    grammar, where the elbow introduces the block rather than each item. */}
                <span aria-hidden className="todo-elbow">
                  {i === 0 ? '⎿ ' : '  '}
                </span>
                <span aria-hidden className="todo-box">
                  {t.status === 'completed' ? '✔' : t.status === 'in_progress' ? '◼' : '◻'}
                </span>
                <span className="todo-subject">{t.subject || t.id}</span>
                <span className="sr-only">
                  {' '}
                  ({t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in progress' : 'pending'})
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="chat-log" ref={scroller}>
          {snap.items.length === 0 && (
            <div className="chat-empty">
              Ask the agent to draw or build. Try:
              <br />
              <em>"Draw a 3-step login flowchart with arrows."</em>
              <br />
              <em>"Build a KPI dashboard for these numbers."</em>
            </div>
          )}
          {snap.items.map((it) => {
            const nested = it.parentId ? ' nested' : '';
            if (it.kind === 'tool') {
              // A Task chip gains a subagent label + live status once task_* events arrive.
              const isSub = !!it.subagentType;
              const label = isSub ? `⤷ ${it.subagentType}${it.status && it.status !== 'running' ? ` · ${it.status}` : ''}` : it.label;
              const running = it.status === 'running';
              // Claude Code's ⏺ / ⎿ pair: the call on one line, its result indented under
              // it. The glyph carries state (running amber, done green) and is aria-hidden
              // — the status rides the label text, never colour alone.
              const result = it.summary && (
                <div className="tool-result">
                  <span aria-hidden className="tool-glyph spacer">
                    ⏺
                  </span>
                  <span aria-hidden className="tool-elbow">
                    ⎿
                  </span>
                  <span className="tool-summary">{it.summary}</span>
                </div>
              );
              // Two emphases, not one: the tool name recedes, the thing it acted on carries
              // the line. A subagent chip has no argument — its label IS the subagent.
              const head = (
                <>
                  <span aria-hidden className="tool-glyph">
                    ⏺
                  </span>
                  {!isSub && it.arg ? (
                    // `Read(app/settings/page.tsx)` — Claude Code's call form. The parens are
                    // the separator, so the argument reads as what the tool was applied TO
                    // rather than as a second, equal noun.
                    <span className="tool-label">
                      <span className="tool-name">{toolNameOf(it.label, it.arg)}</span>
                      <span aria-hidden className="tool-paren">
                        (
                      </span>
                      <span className="tool-arg">{it.arg}</span>
                      <span aria-hidden className="tool-paren">
                        )
                      </span>
                    </span>
                  ) : (
                    <span className="tool-label">{label}</span>
                  )}
                </>
              );
              // The full call text rides a real <details>, so it is keyboard-operable and
              // announced. The card's pointer guard admits it already (`inChatBody`), which
              // is why no role="button" is needed here — unlike a component-shape card.
              return (
                <div key={it.id} className={`tool-chip${nested}${isSub ? ' subagent' : ''}${running ? ' running' : ''}`}>
                  {it.detail ? (
                    <details className="tool-detail">
                      <summary className="tool-call">
                        {head}
                        <span aria-hidden className="tool-more">
                          ▸
                        </span>
                      </summary>
                      <pre className="tool-detail-body">{it.detail}</pre>
                    </details>
                  ) : (
                    <div className="tool-call">{head}</div>
                  )}
                  {result}
                </div>
              );
            }
            // The user turn is Claude Code's full-width ❯ row; the agent's is plain text,
            // still through MarkdownMessage so tables/code/links keep rendering.
            return (
              <div key={it.id} className={`bubble ${it.role}${nested}`}>
                {it.images && it.images.length > 0 && (
                  <div className="bubble-images">
                    {it.images.map((src, i) => (
                      <img key={i} src={src} alt="pasted screenshot" />
                    ))}
                  </div>
                )}
                {it.role === 'user' && (
                  <span aria-hidden className="bubble-marker">
                    ❯
                  </span>
                )}
                {it.role === 'agent' ? <MarkdownMessage text={it.text} /> : <span className="bubble-text">{it.text}</span>}
              </div>
            );
          })}
          {snap.busy && <WorkingLine label={snap.subscribed ? snap.status || 'working' : 'reconnecting…'} />}
        </div>
        {pending.length > 0 && (
          <div className="chat-attachments">
            {pending.map((p, i) => (
              <div key={i} className="attachment">
                <img src={p.dataUrl} alt="attachment" />
                <button type="button" onClick={() => setPending((cur) => cur.filter((_, j) => j !== i))} title="Remove">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {readOnly ? null : (
        <form className="chat-input" onSubmit={submit}>
          <span aria-hidden className="chat-input-marker">
            ❯
          </span>
          <textarea
            ref={textareaRef}
            value={input}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              // auto-grow: reset to auto then let scrollHeight drive it
              e.target.style.height = 'auto';
              const capped = e.target.scrollHeight > 100;
              e.target.style.height = `${Math.min(e.target.scrollHeight, 100)}px`;
              e.target.style.overflowY = capped ? 'auto' : 'hidden';
            }}
            onPaste={onPaste}
            placeholder={!snap.subscribed ? 'connecting…' : pending.length ? 'Add a note, or just send…' : 'Message the agent…  (paste a screenshot)'}
            disabled={!snap.subscribed}
          />
          <button type="submit" disabled={!snap.subscribed || (!input.trim() && pending.length === 0)}>
            Send
          </button>
        </form>
        )}
        {readOnly ? null : (
          <div className="chat-mode">
            <span className="chat-mode-model">
              <span aria-hidden>⏵⏵ </span>
              {snap.model} · {snap.effort}
            </span>
            <span className="chat-mode-hint">
              {snap.busy ? 'esc to interrupt' : 'enter to send · shift+enter for a newline'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Claude Code's working line: a pulsing sparkle, the server's own status verb, and the
// elapsed hint. The verb comes from `snap.status` — this invents nothing, it only animates
// the glyph and counts seconds. A polite live region, so a screen reader hears the turn
// start without the glyph churn.
const WORKING_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

function WorkingLine({ label }: { label: string }) {
  const [glyph, setGlyph] = React.useState(0);
  const [secs, setSecs] = React.useState(0);

  React.useEffect(() => {
    const g = setInterval(() => setGlyph((n) => (n + 1) % WORKING_GLYPHS.length), 110);
    const s = setInterval(() => setSecs((n) => n + 1), 1000);
    return () => {
      clearInterval(g);
      clearInterval(s);
    };
  }, []);

  return (
    <div className="activity" role="status" aria-live="polite">
      <span aria-hidden className="activity-glyph">
        {WORKING_GLYPHS[glyph]}
      </span>
      <span className="activity-verb">{label}…</span>
      <span className="activity-hint">({secs}s · esc to interrupt)</span>
    </div>
  );
}
