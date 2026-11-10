import { useState } from 'react';

type Choice = 'approve' | 'reject' | 'abstain';
type Participant = { id: string; label: string; color: string };
type Proposal = { id: string; title: string; desc?: string; by?: string };

// Votes are stored per-participant under their OWN top-level data key (`votes_<id>`),
// e.g. data.votes_chat1 = { proposalId: 'approve' }. Because setData shallow-merges
// top-level keys, two sessions voting at the same time only ever touch their own key
// and can never clobber each other's ballots. The component reads every votes_<id> back.

const DEFAULT_PARTICIPANTS: Participant[] = [
  { id: 'chat1', label: 'Chat 1', color: '#3b82f6' },
  { id: 'chat2', label: 'Chat 2', color: '#10b981' },
];

const CHOICE_STYLE: Record<Choice, { color: string; label: string }> = {
  approve: { color: '#10b981', label: 'Approve' },
  reject:  { color: '#ef4444', label: 'Reject' },
  abstain: { color: '#9ca3af', label: 'Abstain' },
};

const voteKey = (id: string) => `votes_${id}`;

export default function ProposalVote(props: {
  title?: string;
  participants?: Participant[];
  proposals?: Proposal[];
  setData?: (patch: Record<string, unknown>) => void;
  [k: string]: unknown;
}) {
  const { title = 'Proposals', participants, proposals = [], setData } = props;
  const parts = participants?.length ? participants : DEFAULT_PARTICIPANTS;

  const [voterId, setVoterId] = useState(parts[0]?.id ?? 'chat1');
  const [draft, setDraft] = useState('');
  const [draftDesc, setDraftDesc] = useState('');

  const votesOf = (id: string): Record<string, Choice> =>
    (props[voteKey(id)] as Record<string, Choice> | undefined) ?? {};

  const castVote = (proposalId: string, choice: Choice) => {
    const mine = votesOf(voterId);
    const next = mine[proposalId] === choice
      ? (() => { const { [proposalId]: _drop, ...rest } = mine; return rest; })() // toggle off
      : { ...mine, [proposalId]: choice };
    setData?.({ [voteKey(voterId)]: next }); // only touches THIS voter's key — collision-safe
  };

  const addProposal = () => {
    const t = draft.trim();
    if (!t) return;
    const next: Proposal = {
      id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title: t,
      desc: draftDesc.trim() || undefined,
      by: voterId,
    };
    setData?.({ proposals: [...proposals, next] });
    setDraft('');
    setDraftDesc('');
  };

  const getParticipant = (id: string) => parts.find(p => p.id === id);

  const tally = (proposalId: string) => {
    let approve = 0, reject = 0, abstain = 0, voted = 0;
    for (const p of parts) {
      const c = votesOf(p.id)[proposalId];
      if (!c) continue;
      voted++;
      if (c === 'approve') approve++;
      else if (c === 'reject') reject++;
      else abstain++;
    }
    let status: { label: string; color: string };
    if (voted < parts.length) status = { label: `Pending ${voted}/${parts.length}`, color: '#6b7280' };
    else if (approve > reject) status = { label: 'Passed', color: '#10b981' };
    else if (reject > approve) status = { label: 'Rejected', color: '#ef4444' };
    else status = { label: 'Tied', color: '#f59e0b' };
    return { approve, reject, abstain, status };
  };

  const selectStyle: React.CSSProperties = {
    background: '#1a1e2e', border: '1px solid #2a2e3d', color: '#c9cdd6',
    borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer', outline: 'none',
  };

  return (
    <div style={{
      height: '100%', display: 'flex', flexDirection: 'column',
      background: '#0f1117', color: '#c9cdd6',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: 13, overflow: 'hidden', borderRadius: 12, border: '1px solid #1e2230',
    }}>

      {/* Header */}
      <div style={{
        padding: '10px 14px', borderBottom: '1px solid #1e2230', display: 'flex',
        alignItems: 'center', gap: 10, flexShrink: 0, background: '#0b0d14',
      }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: '#e2e4e9' }}>{title}</span>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', alignItems: 'center' }}>
          <span style={{ color: '#6b7280', fontSize: 11 }}>voting as</span>
          <select value={voterId} onChange={e => setVoterId(e.target.value)} style={selectStyle}>
            {parts.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </div>
      </div>

      {/* Proposal list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {proposals.length === 0 && (
          <div style={{ color: '#3a4055', fontSize: 12, textAlign: 'center', marginTop: 24, fontStyle: 'italic' }}>
            No proposals yet. Add one below.
          </div>
        )}
        {proposals.map(prop => {
          const t = tally(prop.id);
          const myVote = votesOf(voterId)[prop.id];
          const proposer = prop.by ? getParticipant(prop.by) : undefined;
          return (
            <div key={prop.id} style={{
              background: '#13161f', border: '1px solid #1e2230',
              borderLeft: `3px solid ${t.status.color}`, borderRadius: 8, padding: '10px 12px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: '#e2e4e9' }}>{prop.title}</span>
                <span style={{
                  marginLeft: 'auto', color: t.status.color, fontSize: 11, fontWeight: 700,
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                  background: `${t.status.color}1a`, border: `1px solid ${t.status.color}40`,
                  borderRadius: 4, padding: '1px 7px',
                }}>
                  {t.status.label}
                </span>
              </div>
              {prop.desc && (
                <div style={{ color: '#9aa0ad', fontSize: 12, lineHeight: 1.5, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
                  {prop.desc}
                </div>
              )}
              {proposer && (
                <div style={{ fontSize: 10, color: proposer.color, marginBottom: 8 }}>
                  proposed by {proposer.label}
                </div>
              )}

              {/* Vote buttons (cast as the selected voter) */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {(Object.keys(CHOICE_STYLE) as Choice[]).map(choice => {
                  const cs = CHOICE_STYLE[choice];
                  const active = myVote === choice;
                  return (
                    <button
                      key={choice}
                      type="button"
                      onClick={() => castVote(prop.id, choice)}
                      style={{
                        flex: 1,
                        background: active ? `${cs.color}26` : 'transparent',
                        border: `1px solid ${active ? cs.color : '#2a2e3d'}`,
                        color: active ? cs.color : '#6b7280',
                        borderRadius: 6, padding: '5px 0', fontSize: 12,
                        fontWeight: active ? 700 : 500, cursor: 'pointer',
                      }}
                    >
                      {cs.label}
                    </button>
                  );
                })}
              </div>

              {/* Per-participant vote chips */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {parts.map(p => {
                  const c = votesOf(p.id)[prop.id];
                  const cs = c ? CHOICE_STYLE[c] : null;
                  return (
                    <span key={p.id} style={{
                      fontSize: 10, borderRadius: 4, padding: '1px 7px',
                      background: '#1a1e2e', border: `1px solid ${cs ? cs.color + '55' : '#2a2e3d'}`,
                      color: cs ? cs.color : '#3a4055',
                    }}>
                      <span style={{ color: p.color, fontWeight: 700 }}>{p.label}</span>
                      {': '}{cs ? cs.label.toLowerCase() : '—'}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Add proposal */}
      <div style={{
        borderTop: '1px solid #1e2230', padding: '9px 12px', display: 'flex',
        flexDirection: 'column', gap: 6, flexShrink: 0, background: '#0b0d14',
      }}>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addProposal(); }}
          placeholder="Proposal title…"
          style={{
            background: '#1a1e2e', border: '1px solid #2a2e3d', color: '#c9cdd6',
            borderRadius: 6, padding: '6px 9px', font: 'inherit', outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={draftDesc}
            onChange={e => setDraftDesc(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addProposal(); }}
            placeholder="Optional detail…"
            style={{
              flex: 1, background: '#1a1e2e', border: '1px solid #2a2e3d', color: '#c9cdd6',
              borderRadius: 6, padding: '6px 9px', font: 'inherit', outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={addProposal}
            style={{
              background: '#2563eb', border: 'none', color: '#fff', borderRadius: 6,
              padding: '0 14px', cursor: 'pointer', fontWeight: 600, fontSize: 13,
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
