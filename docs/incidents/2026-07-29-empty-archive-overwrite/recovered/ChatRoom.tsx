import { useState, useRef, useEffect, useLayoutEffect, CSSProperties } from "react";

type ChatUser = { id: string; name?: string; email?: string; color?: string; kind?: "user" | "guest" };

type Reply = {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  color: string;
  createdAt: number;
};

type Message = {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  color: string;
  createdAt: number;
  replies: Reply[];
};

type ChatData = {
  title?: string;
  messages?: Message[];
};

type Props = ChatData & {
  currentUser?: ChatUser | null;
  setData?: (patch: Partial<ChatData>) => void;
  setDisplayName?: (name: string) => void;
};

function makeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function timeAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 1) return `${s}s ago`;
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const FALLBACK_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];
function colorFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[h % FALLBACK_COLORS.length];
}

function Avatar({ name, color, size = 26 }: { name: string; color: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.4,
        fontWeight: 700,
        flexShrink: 0,
        userSelect: "none",
      }}
    >
      {initials(name)}
    </div>
  );
}

const inputBase: CSSProperties = {
  font: "inherit",
  fontSize: 13,
  padding: "8px 11px",
  border: "1px solid #dcdce2",
  borderRadius: 9,
  outline: "none",
  background: "#fff",
  color: "#1c1c22",
};

export default function ChatRoom({ title = "Chat", messages, currentUser, setData, setDisplayName }: Props) {
  const msgs = messages ?? [];
  const [draft, setDraft] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [nameDraft, setNameDraft] = useState("");
  const [focused, setFocused] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevCount = useRef(msgs.length);

  // Auto-scroll to newest only when near the bottom, so reading history isn't disrupted.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (msgs.length > prevCount.current && nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevCount.current = msgs.length;
  }, [msgs.length]);

  // Re-render occasionally so relative timestamps stay fresh.
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const resolved = !!currentUser && !!currentUser.id;
  const hasName = resolved && !!currentUser!.name && currentUser!.name!.trim().length > 0;
  const isGuest = currentUser?.kind === "guest";
  const identity = currentUser
    ? {
        id: currentUser.id || "anon",
        name: (currentUser.name && currentUser.name.trim()) || "",
        color: currentUser.color || colorFor(currentUser.id || "anon"),
      }
    : { id: "anon", name: "", color: colorFor("anon") };

  const needsName = !hasName;

  const focusStyle = (key: string): CSSProperties =>
    focused === key ? { borderColor: "#93b4f5", boxShadow: "0 0 0 3px rgba(37, 99, 235, 0.15)" } : {};

  const saveName = () => {
    const n = nameDraft.trim();
    if (!n) return;
    setDisplayName?.(n);
    setNameDraft("");
  };

  const post = () => {
    const text = draft.trim();
    if (!text || needsName) return;
    const m: Message = {
      id: makeId(),
      text,
      authorId: identity.id,
      authorName: identity.name,
      color: identity.color,
      createdAt: Date.now(),
      replies: [],
    };
    setData?.({ messages: [...msgs, m] });
    setDraft("");
  };

  const postReply = (messageId: string) => {
    const text = (replyDrafts[messageId] ?? "").trim();
    if (!text || needsName) return;
    const r: Reply = {
      id: makeId(),
      text,
      authorId: identity.id,
      authorName: identity.name,
      color: identity.color,
      createdAt: Date.now(),
    };
    setData?.({
      messages: msgs.map((m) => (m.id === messageId ? { ...m, replies: [...m.replies, r] } : m)),
    });
    setReplyDrafts((d) => ({ ...d, [messageId]: "" }));
  };

  const sorted = [...msgs].sort((a, b) => a.createdAt - b.createdAt);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "#f3f4f7",
        border: "1px solid #e3e4ea",
        borderRadius: 12,
        font: '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: "#1c1c22",
        overflow: "hidden",
        boxShadow: "0 1px 2px rgba(20,20,30,0.04)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "11px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "linear-gradient(180deg, #ffffff, #fafbfc)",
          borderBottom: "1px solid #ebebf0",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
          <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: -0.2 }}>{title}</span>
          {sorted.length > 0 && (
            <span
              style={{
                color: "#7a7a88",
                fontWeight: 600,
                fontSize: 11,
                background: "#eef0f4",
                borderRadius: 999,
                padding: "1px 7px",
              }}
            >
              {sorted.length}
            </span>
          )}
        </div>
        {hasName && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Avatar name={identity.name} color={identity.color} size={20} />
            <span style={{ fontSize: 11.5, fontWeight: 600, color: "#6b6b78" }}>{identity.name}</span>
          </div>
        )}
      </div>

      {/* Message list */}
      <div
        ref={listRef}
        style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}
      >
        {sorted.length === 0 && (
          <div style={{ color: "#9a9aa6", textAlign: "center", padding: "34px 8px", fontSize: 12.5 }}>
            No messages yet — say hello 👋
          </div>
        )}

        {sorted.map((m) => {
          const isOpen = openId === m.id;
          const mine = m.authorId === identity.id;
          const replyCount = m.replies.length;
          return (
            <div
              key={m.id}
              style={{
                background: "#fff",
                border: `1px solid ${isOpen ? "#c7d7fb" : "#eaeaef"}`,
                borderRadius: 11,
                padding: "10px 12px",
                boxShadow: isOpen ? "0 2px 8px rgba(37,99,235,0.08)" : "0 1px 2px rgba(20,20,30,0.02)",
                transition: "border-color 0.15s ease, box-shadow 0.15s ease",
              }}
            >
              <div style={{ display: "flex", gap: 9 }}>
                <Avatar name={m.authorName || "?"} color={m.color} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginBottom: 2 }}>
                    <span style={{ fontWeight: 700, fontSize: 12.5, color: "#33333d" }}>
                      {m.authorName || "Anonymous"}
                      {mine && <span style={{ color: "#9a9aa6", fontWeight: 500 }}> (you)</span>}
                    </span>
                    <span style={{ fontSize: 11, color: "#a0a0ac" }}>{timeAgo(m.createdAt)}</span>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.5, fontSize: 13 }}>
                    {m.text}
                  </div>
                  <button
                    onClick={() => setOpenId(isOpen ? null : m.id)}
                    style={{
                      marginTop: 6,
                      color: replyCount ? "#2563eb" : "#9a9aa6",
                      cursor: "pointer",
                      background: replyCount ? "#eef2ff" : "transparent",
                      border: "none",
                      borderRadius: 999,
                      padding: replyCount ? "3px 9px" : "3px 0",
                      font: "inherit",
                      fontSize: 11,
                      fontWeight: 600,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {replyCount > 0
                      ? `${replyCount} repl${replyCount === 1 ? "y" : "ies"}`
                      : "Reply"}
                    <span style={{ fontSize: 9 }}>{isOpen ? "▲" : "▼"}</span>
                  </button>
                </div>
              </div>

              {isOpen && (
                <div style={{ marginTop: 9, marginLeft: 35, paddingLeft: 12, borderLeft: "2px solid #eef0f4" }}>
                  {m.replies.map((r) => (
                    <div key={r.id} style={{ display: "flex", gap: 8, marginBottom: 9 }}>
                      <Avatar name={r.authorName || "?"} color={r.color} size={20} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                          <span style={{ fontWeight: 700, fontSize: 12, color: "#4a4a56" }}>
                            {r.authorName || "Anonymous"}
                          </span>
                          <span style={{ fontSize: 10.5, color: "#a0a0ac" }}>{timeAgo(r.createdAt)}</span>
                        </div>
                        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.45, fontSize: 12.5 }}>
                          {r.text}
                        </div>
                      </div>
                    </div>
                  ))}
                  {!needsName && (
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <input
                        value={replyDrafts[m.id] ?? ""}
                        onChange={(e) => setReplyDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                        onFocus={() => setFocused(`r-${m.id}`)}
                        onBlur={() => setFocused(null)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            postReply(m.id);
                          }
                        }}
                        placeholder="Reply…"
                        style={{ ...inputBase, ...focusStyle(`r-${m.id}`), flex: 1, padding: "6px 9px", fontSize: 12.5 }}
                      />
                      <button
                        onClick={() => postReply(m.id)}
                        disabled={!(replyDrafts[m.id] ?? "").trim()}
                        style={{
                          border: "1px solid #dcdce2",
                          borderRadius: 8,
                          background: "#fff",
                          color: (replyDrafts[m.id] ?? "").trim() ? "#1c1c22" : "#b8b8c2",
                          fontSize: 12,
                          fontWeight: 600,
                          padding: "0 12px",
                          cursor: (replyDrafts[m.id] ?? "").trim() ? "pointer" : "default",
                        }}
                      >
                        Send
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Composer / name gate */}
      <div style={{ padding: 12, background: "#fff", borderTop: "1px solid #ebebf0", flexShrink: 0 }}>
        {needsName ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <span style={{ fontSize: 11.5, color: "#7a7a88", fontWeight: 600 }}>
              {isGuest || !resolved ? "Pick a name to join the chat" : "Set a display name to chat"}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onFocus={() => setFocused("name")}
                onBlur={() => setFocused(null)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                }}
                placeholder="Your name"
                style={{ ...inputBase, ...focusStyle("name"), flex: 1 }}
              />
              <button
                onClick={saveName}
                disabled={!nameDraft.trim()}
                style={{
                  border: "none",
                  borderRadius: 9,
                  background: nameDraft.trim() ? "#2563eb" : "#e4e7ee",
                  color: nameDraft.trim() ? "#fff" : "#a6a9b5",
                  fontSize: 13,
                  fontWeight: 600,
                  padding: "0 16px",
                  cursor: nameDraft.trim() ? "pointer" : "default",
                }}
              >
                Join
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={() => setFocused("draft")}
              onBlur={() => setFocused(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  post();
                }
              }}
              placeholder="Message…  (Enter to send, Shift+Enter for newline)"
              rows={1}
              style={{
                ...inputBase,
                ...focusStyle("draft"),
                flex: 1,
                resize: "none",
                lineHeight: 1.45,
                maxHeight: 120,
                overflowY: "auto",
              }}
            />
            <button
              onClick={post}
              disabled={!draft.trim()}
              style={{
                border: "none",
                borderRadius: 9,
                background: draft.trim() ? "#2563eb" : "#e4e7ee",
                color: draft.trim() ? "#fff" : "#a6a9b5",
                fontSize: 13,
                fontWeight: 600,
                padding: "0 18px",
                height: 38,
                cursor: draft.trim() ? "pointer" : "default",
                transition: "background 0.15s ease",
              }}
            >
              Send
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
