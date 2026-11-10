// VariantBoard — the alignment ritual as a component (docs/POSITIONING.md):
// render N options side by side as LIVE embedded components, let the team vote,
// and mark the decision. Each variant names a module from the same three-tier
// library every placed component resolves against (own dir → shared → platform),
// so "compare the landing pages" is data, not copies.
//
// data shape (all agent- or human-writable):
//   title?: string                — the decision question
//   variants: Array<{ id, label, module?, data?, note?, zoom? }>
//     module — component to embed live (omit for a text-only option)
//     data   — props for the embedded component
//     zoom   — preview scale (default 1; use ~0.4 for full-page variants)
//   vote_<userId>: { variantId, name }   — one top-level key per voter, so
//     concurrent ballots shallow-merge without clobbering (ProposalVote pattern)
//   decided?: { id, by }          — the locked-in choice

import { Component, useEffect, useState, type ComponentType, type ReactNode } from 'react';

import { activeCanvasId } from '../active-canvas';
import { loadComponent } from '../component-loader';

type Variant = {
  id: string;
  label: string;
  module?: string;
  data?: Record<string, unknown>;
  note?: string;
  zoom?: number;
};
type Vote = { variantId: string; name?: string };
type User = { id: string; name?: string };

const voteKey = (userId: string) => `vote_${userId}`;

/** Live-embed one library component, resolved exactly like a placed instance. */
function EmbeddedVariant({ module, data }: { module: string; data: Record<string, unknown> }) {
  const [state, setState] = useState<{ Comp?: ComponentType<Record<string, unknown>>; error?: string }>({});
  useEffect(() => {
    let alive = true;
    loadComponent(module, 0, activeCanvasId())
      .then((Comp) => alive && setState({ Comp }))
      .catch((e) => alive && setState({ error: (e as Error).message }));
    return () => {
      alive = false;
    };
  }, [module]);
  if (state.error) return <div style={{ color: '#b91c1c', fontSize: 12, padding: 12 }}>“{module}” failed to load: {state.error}</div>;
  if (!state.Comp) return <div style={{ color: '#94a3b8', fontSize: 12, padding: 12 }}>Loading {module}…</div>;
  const Comp = state.Comp;
  // Embedded previews are read-only: a no-op setData so interactive components
  // don't throw, but a variant preview never writes the board's own data.
  return <Comp {...data} setData={() => {}} />;
}

class PreviewBoundary extends Component<{ children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  override render() {
    if (this.state.error) return <div style={{ color: '#b91c1c', fontSize: 12, padding: 12 }}>Variant crashed: {this.state.error}</div>;
    return this.props.children;
  }
}

export default function VariantBoard(props: {
  title?: string;
  variants?: Variant[];
  decided?: { id: string; by?: string } | null;
  setData?: (patch: Record<string, unknown>) => void;
  currentUser?: User;
  [k: string]: unknown;
}) {
  const { title = 'Which one?', variants = [], decided, setData, currentUser } = props;

  // Gather every vote_<id> key back into { userId → Vote }.
  const votes: Record<string, Vote> = {};
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('vote_') && v && typeof v === 'object' && 'variantId' in (v as object)) {
      votes[k.slice('vote_'.length)] = v as Vote;
    }
  }
  const tally = (variantId: string) => Object.values(votes).filter((v) => v.variantId === variantId);
  const myVote = currentUser ? votes[currentUser.id]?.variantId : undefined;

  const castVote = (variantId: string) => {
    if (!setData || !currentUser) return;
    setData({ [voteKey(currentUser.id)]: { variantId, name: currentUser.name } });
  };
  const decide = (variantId: string | null) => {
    setData?.({ decided: variantId ? { id: variantId, by: currentUser?.name } : null });
  };

  if (variants.length === 0) {
    return (
      <div style={{ padding: 20, fontFamily: 'ui-sans-serif, system-ui', color: '#64748b', fontSize: 13 }}>
        <b style={{ color: '#0f172a', display: 'block', marginBottom: 6 }}>{title}</b>
        No variants yet. Ask a chat to fill <code>data.variants</code> — each one can embed a live
        component from the library (e.g. LandingV1 vs LandingV2).
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontFamily: 'ui-sans-serif, system-ui', color: '#0f172a' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '12px 14px 10px', borderBottom: '1px solid #e2e8f0' }}>
        <b style={{ fontSize: 15 }}>{title}</b>
        {decided ? (
          <span style={{ fontSize: 12, color: '#15803d', fontWeight: 600 }}>
            ✓ decided: {variants.find((v) => v.id === decided.id)?.label ?? decided.id}
            {decided.by ? ` — by ${decided.by}` : ''}
            <button type="button" onClick={() => decide(null)} style={{ marginLeft: 8, fontSize: 11, border: 'none', background: 'none', color: '#64748b', cursor: 'pointer', textDecoration: 'underline' }}>
              undo
            </button>
          </span>
        ) : (
          <span style={{ fontSize: 12, color: '#64748b' }}>{Object.keys(votes).length} vote{Object.keys(votes).length === 1 ? '' : 's'}</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, padding: 12, flex: 1, minHeight: 0, overflowX: 'auto' }}>
        {variants.map((v) => {
          const isDecided = decided?.id === v.id;
          const dimmed = decided && !isDecided;
          const voters = tally(v.id);
          const zoom = v.zoom ?? 1;
          return (
            <div
              key={v.id}
              style={{
                flex: '1 0 240px',
                minWidth: 240,
                display: 'flex',
                flexDirection: 'column',
                border: isDecided ? '2px solid #15803d' : '1px solid #e2e8f0',
                borderRadius: 10,
                opacity: dimmed ? 0.45 : 1,
                overflow: 'hidden',
                background: '#fff',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid #f1f5f9' }}>
                <b style={{ fontSize: 13 }}>{v.label}</b>
                {v.module && <code style={{ fontSize: 10.5, color: '#94a3b8' }}>{v.module}</code>}
              </div>
              <div style={{ flex: 1, minHeight: 120, overflow: 'auto', background: '#fff' }}>
                {v.module ? (
                  <div style={{ width: `${100 / zoom}%`, transform: `scale(${zoom})`, transformOrigin: 'top left' }}>
                    <PreviewBoundary>
                      <EmbeddedVariant module={v.module} data={v.data ?? {}} />
                    </PreviewBoundary>
                  </div>
                ) : (
                  <div style={{ padding: 12, fontSize: 13, color: '#334155' }}>{v.note ?? 'Text-only option.'}</div>
                )}
              </div>
              {v.module && v.note && <div style={{ padding: '6px 10px', fontSize: 12, color: '#64748b', borderTop: '1px solid #f1f5f9' }}>{v.note}</div>}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderTop: '1px solid #f1f5f9' }}>
                <button
                  type="button"
                  disabled={!currentUser}
                  onClick={() => castVote(v.id)}
                  title={currentUser ? 'Vote for this variant' : 'Identity still resolving…'}
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '4px 10px',
                    borderRadius: 7,
                    cursor: currentUser ? 'pointer' : 'default',
                    border: myVote === v.id ? '1px solid #15803d' : '1px solid #cbd5e1',
                    background: myVote === v.id ? '#dcfce7' : '#fff',
                    color: myVote === v.id ? '#15803d' : '#334155',
                  }}
                >
                  {myVote === v.id ? '✓ voted' : 'vote'}
                </button>
                <span style={{ fontSize: 11.5, color: '#64748b', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {voters.length > 0 && `${voters.length} · ${voters.map((x) => x.name ?? 'someone').join(', ')}`}
                </span>
                {!decided && (
                  <button
                    type="button"
                    onClick={() => decide(v.id)}
                    style={{ fontSize: 11, border: 'none', background: 'none', color: '#94a3b8', cursor: 'pointer', textDecoration: 'underline' }}
                  >
                    decide
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
