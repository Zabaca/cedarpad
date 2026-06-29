// A chat session as a first-class canvas shape. Each `chat` shape renders one
// conversation (its chatId is the shape id) by subscribing to the cull-safe
// chat-store. Drag the header to move the card; the body (log + input) is
// interactive. Deleting the shape ends the session (App watches for removal).

import * as React from 'react';
import { T, type TLBaseShape } from 'tldraw';

import { requestFork, setActiveChat } from './agent-link';
import { EFFORTS, ensureSession, getSnapshot, interrupt, MODELS, openStream, type PendingImage, send, setEffort, setModel, subscribe } from './chat-store';
import { type EventGuards, InteractiveBoxShapeUtil } from './InteractiveBoxShapeUtil';
import { MarkdownMessage } from './MarkdownMessage';
import { inChatBody, inChatLog, isInteractiveControl } from './predicates';

export type ChatShapeTl = TLBaseShape<'chat', { w: number; h: number; title: string }>;

// Register `chat` as a first-class tldraw shape type (joins the TLShape union).
declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    chat: { w: number; h: number; title: string };
  }
}

function ChatView({ chatId, title }: { chatId: string; title: string }) {
  ensureSession(chatId); // idempotent sync load so the first render has the transcript
  const snap = React.useSyncExternalStore(
    React.useCallback((cb) => subscribe(chatId, cb), [chatId]),
    React.useCallback(() => getSnapshot(chatId), [chatId]),
  );
  const [input, setInput] = React.useState('');
  const [pending, setPending] = React.useState<PendingImage[]>([]);
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
        <span className={snap.busy ? 'tab-dot' : 'dot'} />
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
        {snap.contextPct !== null && (
          <span className="chat-ctx" title="Context window used on the last turn">
            {snap.contextPct}%
          </span>
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
      </div>
      <div className="chat-card-body">
        {Object.keys(snap.tasks).length > 0 && (
          <div className="job-tray" title="Background jobs running in this chat">
            {Object.values(snap.tasks).map((t) => (
              <div key={t.id} className={`job-row ${t.status}`}>
                <span className="job-dot" />
                <span className="job-type">{t.taskType ?? 'job'}</span>
                <span className="job-title">{t.title || t.detail || t.id}</span>
                {t.summary && <span className="job-summary">{t.summary}</span>}
              </div>
            ))}
          </div>
        )}
        {Object.keys(snap.todos).length > 0 && (
          <div className="todo-tray" title="The agent's plan (TaskCreate / TaskUpdate)">
            {Object.values(snap.todos).map((t) => (
              <div key={t.id} className={`todo-row ${t.status}`}>
                <span className="todo-box">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span>
                <span className="todo-subject">{t.subject || t.id}</span>
              </div>
            ))}
          </div>
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
              return (
                <div key={it.id} className={`tool-chip${nested}${isSub ? ' subagent' : ''}${running ? ' running' : ''}`}>
                  {label}
                  {it.summary && <span className="tool-summary"> · {it.summary}</span>}
                </div>
              );
            }
            return (
              <div key={it.id} className={`bubble ${it.role}${nested}`}>
                {it.images && it.images.length > 0 && (
                  <div className="bubble-images">
                    {it.images.map((src, i) => (
                      <img key={i} src={src} alt="pasted screenshot" />
                    ))}
                  </div>
                )}
                {it.role === 'agent' ? <MarkdownMessage text={it.text} /> : it.text}
              </div>
            );
          })}
          {snap.busy && (
            <div className="activity">
              {snap.subscribed ? snap.status || 'working' : 'reconnecting…'}
              <span className="ell" />
            </div>
          )}
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
        <form className="chat-input" onSubmit={submit}>
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
      </div>
    </div>
  );
}

export class ChatShapeUtil extends InteractiveBoxShapeUtil<'chat', { title: string }> {
  static override type = 'chat' as const;
  static override props = { w: T.number, h: T.number, title: T.string };

  override getDefaultProps(): ChatShapeTl['props'] {
    return { w: 380, h: 460, title: 'Chat' };
  }

  override cornerRadius = 12;

  // Pointer/keyboard inside the body must reach the chat UI, not tldraw (the header
  // is left un-guarded so it drags the whole card); wheel is only swallowed inside
  // the log so it scrolls the transcript instead of zooming the canvas.
  // Body reaches the chat UI; the header drags the card — EXCEPT interactive
  // controls in the header (the model select) must reach the control, not drag.
  override readonly guards: EventGuards = {
    pointer: (t) => inChatBody(t) || isInteractiveControl(t),
    wheel: inChatLog,
    key: inChatBody,
  };

  override onContainerPointerDown = (shape: ChatShapeTl) => setActiveChat(shape.id);

  protected override renderContent(shape: ChatShapeTl) {
    return <ChatView chatId={shape.id} title={shape.props.title} />;
  }
}
