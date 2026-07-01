import { useState, useRef, useEffect } from 'react';

type Tag = 'topic' | 'fact' | 'note';
type Participant = { id: string; label: string; color: string };
type Message = { id: string; from: string; tag?: Tag; content: string; ts?: string; closed?: boolean };

const TAG_STYLE: Record<Tag, { bg: string; border: string; color: string }> = {
  topic:  { bg: '#8b5cf620', border: '#8b5cf650', color: '#a78bfa' },
  fact:   { bg: '#f59e0b20', border: '#f59e0b50', color: '#fbbf24' },
  note:   { bg: '#6b728020', border: '#6b728050', color: '#9ca3af' },
};

const DEFAULT_PARTICIPANTS: Participant[] = [
  { id: 'chat1', label: 'Chat 1', color: '#3b82f6' },
  { id: 'chat2', label: 'Chat 2', color: '#10b981' },
];

export default function DiscussionThread({
  title = 'Discussion',
  participants,
  messages = [],
  setData,
}: {
  title?: string;
  participants?: Participant[];
  messages?: Message[];
  setData?: (patch: Record<string, unknown>) => void;
}) {
  const parts = participants?.length ? participants : DEFAULT_PARTICIPANTS;
  const [draft, setDraft] = useState('');
  const [fromId, setFromId] = useState(parts[0]?.id ?? 'chat1');
  const [tag, setTag] = useState<Tag>('topic');
  const [showClosed, setShowClosed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const addMessage = () => {
    const content = draft.trim();
    if (!content) return;
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const next: Message = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
      from: fromId,
      tag,
      content,
      ts,
    };
    setData?.({ messages: [...messages, next] });
    setDraft('');
  };

  const getParticipant = (id: string) => parts.find(p => p.id === id);

  const toggleClosed = (id: string) => {
    setData?.({ messages: messages.map(m => m.id === id ? { ...m, closed: !m.closed } : m) });
  };

  const closedCount = messages.filter(m => m.tag === 'topic' && m.closed).length;
  const visible = messages.filter(m => showClosed || !m.closed);

  const selectStyle: React.CSSProperties = {
    background: '#1a1e2e',
    border: '1px solid #2a2e3d',
    color: '#c9cdd6',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
    cursor: 'pointer',
    outline: 'none',
  };

  return (
    <div style={{
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      background: '#0f1117',
      color: '#c9cdd6',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 13,
      overflow: 'hidden',
      borderRadius: 12,
      border: '1px solid #1e2230',
    }}>

      {/* Header */}
      <div style={{
        padding: '10px 14px',
        borderBottom: '1px solid #1e2230',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexShrink: 0,
        background: '#0b0d14',
      }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#e2e4e9' }}>{title}</span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          {closedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowClosed(s => !s)}
              style={{
                background: 'none',
                border: '1px solid #2a2e3d',
                color: '#6b7280',
                borderRadius: 6,
                padding: '2px 8px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {showClosed ? 'hide closed' : `${closedCount} closed`}
            </button>
          )}
          {parts.map(p => (
            <span key={p.id} style={{
              background: `${p.color}22`,
              border: `1px solid ${p.color}55`,
              color: p.color,
              borderRadius: 99,
              padding: '2px 9px',
              fontSize: 11,
              fontWeight: 600,
            }}>
              {p.label}
            </span>
          ))}
        </div>
      </div>

      {/* Message list */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}>
        {messages.length === 0 && (
          <div style={{ color: '#3a4055', fontSize: 12, textAlign: 'center', marginTop: 24, fontStyle: 'italic' }}>
            No entries yet. Add a topic, fact, or note below.
          </div>
        )}
        {visible.map(msg => {
          const p = getParticipant(msg.from);
          const color = msg.closed ? '#3a4055' : (p?.color ?? '#6b7280');
          const tagStyle = msg.tag ? TAG_STYLE[msg.tag] : null;
          return (
            <div key={msg.id} style={{
              background: '#13161f',
              border: '1px solid #1e2230',
              borderLeft: `3px solid ${color}`,
              borderRadius: 8,
              padding: '8px 11px',
              opacity: msg.closed ? 0.5 : 1,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                <span style={{ color, fontWeight: 700, fontSize: 12 }}>{p?.label ?? msg.from}</span>
                {tagStyle && msg.tag && (
                  <span style={{
                    background: msg.closed ? '#1e223020' : tagStyle.bg,
                    border: `1px solid ${msg.closed ? '#2a2e3d' : tagStyle.border}`,
                    color: msg.closed ? '#3a4055' : tagStyle.color,
                    borderRadius: 4,
                    padding: '1px 6px',
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}>
                    {msg.closed ? 'closed' : msg.tag}
                  </span>
                )}
                {msg.ts && (
                  <span style={{ color: '#3a4055', fontSize: 10 }}>
                    {msg.ts}
                  </span>
                )}
                {msg.tag === 'topic' && (
                  <button
                    type="button"
                    onClick={() => toggleClosed(msg.id)}
                    style={{
                      marginLeft: 'auto',
                      background: 'none',
                      border: '1px solid #2a2e3d',
                      color: msg.closed ? '#10b981' : '#6b7280',
                      borderRadius: 4,
                      padding: '1px 7px',
                      fontSize: 10,
                      cursor: 'pointer',
                    }}
                  >
                    {msg.closed ? 'reopen' : 'close'}
                  </button>
                )}
              </div>
              <div style={{ lineHeight: 1.55, color: msg.closed ? '#3a4055' : '#c9cdd6', whiteSpace: 'pre-wrap', wordBreak: 'break-word', textDecoration: msg.closed ? 'line-through' : 'none' }}>
                {msg.content}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div style={{
        borderTop: '1px solid #1e2230',
        padding: '9px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        flexShrink: 0,
        background: '#0b0d14',
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <select value={fromId} onChange={e => setFromId(e.target.value)} style={selectStyle}>
            {parts.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <select value={tag} onChange={e => setTag(e.target.value as Tag)} style={selectStyle}>
            <option value="topic">Topic</option>
            <option value="fact">Fact</option>
            <option value="note">Note</option>
          </select>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addMessage(); }}
            placeholder="Add entry… (⌘Enter to send)"
            rows={2}
            style={{
              flex: 1,
              background: '#1a1e2e',
              border: '1px solid #2a2e3d',
              color: '#c9cdd6',
              borderRadius: 6,
              padding: '6px 9px',
              font: 'inherit',
              resize: 'none',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={addMessage}
            style={{
              background: '#2563eb',
              border: 'none',
              color: '#fff',
              borderRadius: 6,
              padding: '0 14px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: 13,
              alignSelf: 'stretch',
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
