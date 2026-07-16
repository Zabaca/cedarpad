import { useState, CSSProperties } from "react";

type Answer = {
  id: string;
  text: string;
  author: string;
  createdAt: number;
};

type Question = {
  id: string;
  text: string;
  author: string;
  createdAt: number;
  answers: Answer[];
};

type QABoardData = {
  questions?: Question[];
};

type Props = QABoardData & {
  setData?: (patch: Partial<QABoardData>) => void;
};

function makeId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function timeAgo(ts: number) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_COLORS = ["#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];
function avatarColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: avatarColor(name),
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: size * 0.42,
        fontWeight: 700,
        flexShrink: 0,
      }}
    >
      {initials(name)}
    </div>
  );
}

const inputStyle: CSSProperties = {
  font: "inherit",
  fontSize: 12.5,
  padding: "7px 9px",
  border: "1px solid #dcdce2",
  borderRadius: 7,
  outline: "none",
  background: "#fff",
  color: "#1c1c22",
};

const focusRing = "0 0 0 3px rgba(37, 99, 235, 0.15)";

export default function QABoard({ questions, setData }: Props) {
  const qs = questions ?? [];
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState<string | null>(null);

  const author = name.trim() || "Anonymous";

  const update = (next: Question[]) => setData?.({ questions: next });

  const addQuestion = () => {
    const text = draft.trim();
    if (!text) return;
    const q: Question = {
      id: makeId(),
      text,
      author,
      createdAt: Date.now(),
      answers: [],
    };
    update([q, ...qs]);
    setDraft("");
  };

  const addAnswer = (questionId: string) => {
    const text = (answerDrafts[questionId] ?? "").trim();
    if (!text) return;
    const a: Answer = { id: makeId(), text, author, createdAt: Date.now() };
    update(
      qs.map((q) =>
        q.id === questionId ? { ...q, answers: [...q.answers, a] } : q
      )
    );
    setAnswerDrafts((d) => ({ ...d, [questionId]: "" }));
  };

  const sorted = [...qs].sort((a, b) => b.createdAt - a.createdAt);

  const focusStyle = (key: string): CSSProperties =>
    focused === key
      ? { borderColor: "#93b4f5", boxShadow: focusRing }
      : {};

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
      <div
        style={{
          padding: "11px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          background: "linear-gradient(180deg, #ffffff, #fafbfc)",
          borderBottom: "1px solid #ebebf0",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: -0.2 }}>Q&amp;A</span>
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
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onFocus={() => setFocused("name")}
          onBlur={() => setFocused(null)}
          placeholder="Your name"
          style={{
            ...inputStyle,
            ...focusStyle("name"),
            width: 96,
            fontSize: 11.5,
            padding: "4px 8px",
            borderRadius: 999,
            textAlign: "center",
          }}
        />
      </div>

      <div
        style={{
          padding: 12,
          display: "flex",
          gap: 8,
          background: "#fff",
          borderBottom: "1px solid #ebebf0",
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused("ask")}
          onBlur={() => setFocused(null)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addQuestion();
          }}
          placeholder="Ask a question…"
          rows={2}
          style={{ ...inputStyle, ...focusStyle("ask"), flex: 1, resize: "none", lineHeight: 1.4 }}
        />
        <button
          onClick={addQuestion}
          disabled={!draft.trim()}
          style={{
            border: "none",
            borderRadius: 7,
            background: draft.trim() ? "#2563eb" : "#e4e7ee",
            color: draft.trim() ? "#fff" : "#a6a9b5",
            fontSize: 12.5,
            fontWeight: 600,
            padding: "0 16px",
            cursor: draft.trim() ? "pointer" : "default",
            transition: "background 0.15s ease",
          }}
        >
          Ask
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {sorted.length === 0 && (
          <div style={{ color: "#9a9aa6", textAlign: "center", padding: "30px 8px", fontSize: 12.5 }}>
            No questions yet — be the first to ask.
          </div>
        )}

        {sorted.map((q) => {
          const isOpen = openId === q.id;
          const hasAnswers = q.answers.length > 0;
          return (
            <div
              key={q.id}
              style={{
                background: "#fff",
                border: `1px solid ${isOpen ? "#c7d7fb" : "#eaeaef"}`,
                borderRadius: 10,
                padding: "11px 12px",
                boxShadow: isOpen ? "0 2px 8px rgba(37,99,235,0.08)" : "0 1px 2px rgba(20,20,30,0.02)",
                transition: "border-color 0.15s ease, box-shadow 0.15s ease",
              }}
            >
              <div style={{ display: "flex", gap: 8 }}>
                <Avatar name={q.author} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.45, fontSize: 13 }}>
                    {q.text}
                  </div>
                  <div style={{ marginTop: 5, fontSize: 11, color: "#9a9aa6", display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontWeight: 600, color: "#6b6b78" }}>{q.author}</span>
                    <span>·</span>
                    <span>{timeAgo(q.createdAt)}</span>
                    <button
                      onClick={() => setOpenId(isOpen ? null : q.id)}
                      style={{
                        marginLeft: "auto",
                        color: hasAnswers ? "#2563eb" : "#9a9aa6",
                        cursor: "pointer",
                        background: hasAnswers ? "#eef2ff" : "#f4f4f7",
                        border: "none",
                        borderRadius: 999,
                        padding: "3px 9px",
                        font: "inherit",
                        fontSize: 11,
                        fontWeight: 600,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      {q.answers.length} answer{q.answers.length === 1 ? "" : "s"}
                      <span style={{ fontSize: 9 }}>{isOpen ? "▲" : "▼"}</span>
                    </button>
                  </div>
                </div>
              </div>

              {isOpen && (
                <div style={{ marginTop: 10, marginLeft: 28, paddingLeft: 12, borderLeft: "2px solid #eef0f4" }}>
                  {q.answers.map((a) => (
                    <div key={a.id} style={{ display: "flex", gap: 7, marginBottom: 8 }}>
                      <Avatar name={a.author} size={17} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.4, fontSize: 12.5 }}>
                          {a.text}
                        </div>
                        <div style={{ fontSize: 10.5, color: "#a0a0ac", marginTop: 2 }}>
                          <span style={{ fontWeight: 600, color: "#7a7a88" }}>{a.author}</span> · {timeAgo(a.createdAt)}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <input
                      value={answerDrafts[q.id] ?? ""}
                      onChange={(e) =>
                        setAnswerDrafts((d) => ({ ...d, [q.id]: e.target.value }))
                      }
                      onFocus={() => setFocused(`ans-${q.id}`)}
                      onBlur={() => setFocused(null)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") addAnswer(q.id);
                      }}
                      placeholder="Write an answer…"
                      style={{ ...inputStyle, ...focusStyle(`ans-${q.id}`), flex: 1, padding: "6px 9px" }}
                    />
                    <button
                      onClick={() => addAnswer(q.id)}
                      disabled={!(answerDrafts[q.id] ?? "").trim()}
                      style={{
                        border: "1px solid #dcdce2",
                        borderRadius: 7,
                        background: "#fff",
                        color: (answerDrafts[q.id] ?? "").trim() ? "#1c1c22" : "#b8b8c2",
                        fontSize: 12,
                        fontWeight: 600,
                        padding: "0 12px",
                        cursor: "pointer",
                      }}
                    >
                      Reply
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
