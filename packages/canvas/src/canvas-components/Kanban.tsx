// A ticket / kanban board that lives on the canvas. Interactive AND persistent:
// every edit calls setData({ columns }), which merges into this shape's `data`
// (synced to the bridge + saved across reloads — see ComponentShape's setData).
//
// Props (the `data` you place it with), all optional:
//   { title?: string, columns?: Array<{ id, title, cards: Array<{ id, title, desc? }> }> }
// Omit columns to get a default To Do / In Progress / Done board.
//
// Interactions (buttons + inputs, so tldraw doesn't steal the pointer — see the
// isInteractiveControl guard): add a card per column, edit a card's title inline,
// move a card to the previous/next column (◀ ▶), delete a card (×).
//
// Commands: every board edit is a named reducer in `commands`, which the UI calls AND the
// agent calls through call_component — one set of rules, run against the live data.
import { type CSSProperties, useState } from 'react';
import { z } from 'zod';

type Card = { id: string; title: string; desc?: string };
type Column = { id: string; title: string; cards: Card[] };

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const DEFAULT_COLUMNS: Column[] = [
  { id: 'todo', title: 'To Do', cards: [] },
  { id: 'doing', title: 'In Progress', cards: [] },
  { id: 'done', title: 'Done', cards: [] },
];

type BoardData = Record<string, unknown>;

const columnsOf = (data: BoardData): Column[] =>
  Array.isArray(data.columns) && data.columns.length ? (data.columns as Column[]) : DEFAULT_COLUMNS;

const findCard = (cols: Column[], cardId: string): Card => {
  const card = cols.flatMap((c) => c.cards).find((k) => k.id === cardId);
  if (!card) throw new Error(`no card "${cardId}"`);
  return card;
};

const withoutCard = (cols: Column[], cardId: string): Column[] => cols.map((c) => ({ ...c, cards: c.cards.filter((k) => k.id !== cardId) }));

export const commands = {
  addCard: {
    args: z.object({ column: z.string().describe('Column id'), title: z.string().min(1), desc: z.string().optional() }),
    run: (data: BoardData, a: { column: string; title: string; desc?: string }): BoardData => {
      const cols = columnsOf(data);
      if (!cols.some((c) => c.id === a.column)) throw new Error(`no column "${a.column}" (have ${cols.map((c) => c.id).join(', ')})`);
      const card: Card = { id: uid(), title: a.title, ...(a.desc !== undefined ? { desc: a.desc } : {}) };
      return { ...data, columns: cols.map((c) => (c.id === a.column ? { ...c, cards: [...c.cards, card] } : c)) };
    },
  },
  moveCard: {
    args: z.object({ card: z.string().describe('Card id'), to: z.string().describe('Target column id') }),
    run: (data: BoardData, a: { card: string; to: string }): BoardData => {
      const cols = columnsOf(data);
      const card = findCard(cols, a.card);
      if (!cols.some((c) => c.id === a.to)) throw new Error(`no column "${a.to}" (have ${cols.map((c) => c.id).join(', ')})`);
      return { ...data, columns: withoutCard(cols, a.card).map((c) => (c.id === a.to ? { ...c, cards: [...c.cards, card] } : c)) };
    },
  },
  editCard: {
    args: z.object({ card: z.string().describe('Card id'), title: z.string().optional(), desc: z.string().optional() }),
    run: (data: BoardData, a: { card: string; title?: string; desc?: string }): BoardData => {
      const cols = columnsOf(data);
      findCard(cols, a.card);
      const title = a.title?.trim();
      return {
        ...data,
        columns: cols.map((c) => ({
          ...c,
          cards: c.cards.map((k) => (k.id === a.card ? { ...k, ...(title ? { title } : {}), ...(a.desc !== undefined ? { desc: a.desc } : {}) } : k)),
        })),
      };
    },
  },
  removeCard: {
    args: z.object({ card: z.string().describe('Card id') }),
    run: (data: BoardData, a: { card: string }): BoardData => {
      const cols = columnsOf(data);
      findCard(cols, a.card);
      return { ...data, columns: withoutCard(cols, a.card) };
    },
  },
  renameBoard: {
    args: z.object({ title: z.string().min(1) }),
    run: (data: BoardData, a: { title: string }): BoardData => ({ ...data, title: a.title }),
  },
};

const COLUMN_ACCENT: Record<string, string> = { todo: '#64748b', doing: '#2563eb', done: '#16a34a' };

export default function Kanban({
  title = 'Board',
  columns,
  setData,
}: {
  title?: string;
  columns?: Column[];
  setData?: (patch: BoardData) => void;
}) {
  const cols = columnsOf({ columns });
  const commit = (next: BoardData) => setData?.({ columns: next.columns });
  const board: BoardData = { title, columns: cols };

  // Local-only UI state: per-column new-card drafts + the card currently being edited.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const addCard = (colId: string) => {
    const t = (drafts[colId] ?? '').trim();
    if (!t) return;
    commit(commands.addCard.run(board, { column: colId, title: t }));
    setDrafts((d) => ({ ...d, [colId]: '' }));
  };

  const deleteCard = (cardId: string) => commit(commands.removeCard.run(board, { card: cardId }));

  // Move a card to the adjacent column (dir -1 = left, +1 = right), keeping it within bounds.
  const moveCard = (colId: string, cardId: string, dir: -1 | 1) => {
    const to = cols[cols.findIndex((c) => c.id === colId) + dir];
    if (!to) return;
    commit(commands.moveCard.run(board, { card: cardId, to: to.id }));
  };

  const commitEdit = () => {
    if (!editing) return;
    commit(commands.editCard.run(board, { card: editing.id, title: editing.value }));
    setEditing(null);
  };

  const total = cols.reduce((n, c) => n + c.cards.length, 0);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', font: '13px ui-sans-serif, system-ui', color: '#0f172a', background: '#f8fafc' }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>{title}</span>
        <span style={{ color: '#94a3b8', fontSize: 12 }}>{total} card{total === 1 ? '' : 's'}</span>
      </div>

      <div style={{ flex: 1, display: 'flex', gap: 10, padding: 12, overflowX: 'auto', alignItems: 'flex-start' }}>
        {cols.map((col, ci) => (
          <div key={col.id} style={{ flex: '0 0 200px', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, maxHeight: '100%' }}>
            <div style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: 99, background: COLUMN_ACCENT[col.id] ?? '#94a3b8' }} />
              <span style={{ fontWeight: 600, fontSize: 12.5 }}>{col.title}</span>
              <span style={{ marginLeft: 'auto', color: '#cbd5e1', fontSize: 11, fontWeight: 600 }}>{col.cards.length}</span>
            </div>

            <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
              {col.cards.map((card) => (
                <div key={card.id} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 9px', boxShadow: '0 1px 2px rgba(15,23,42,0.04)' }}>
                  {editing?.id === card.id ? (
                    <input
                      autoFocus
                      value={editing.value}
                      onChange={(e) => setEditing({ id: card.id, value: e.target.value })}
                      onBlur={commitEdit}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #93c5fd', borderRadius: 6, padding: '4px 6px', font: 'inherit' }}
                    />
                  ) : (
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setEditing({ id: card.id, value: card.title })}
                      style={{ cursor: 'text', lineHeight: 1.35, wordBreak: 'break-word' }}
                      title="Click to edit"
                    >
                      {card.title}
                    </div>
                  )}
                  <div style={{ marginTop: 6, display: 'flex', gap: 4, alignItems: 'center' }}>
                    <button type="button" disabled={ci === 0} onClick={() => moveCard(col.id, card.id, -1)} style={arrowBtn(ci === 0)} title="Move left">◀</button>
                    <button type="button" disabled={ci === cols.length - 1} onClick={() => moveCard(col.id, card.id, 1)} style={arrowBtn(ci === cols.length - 1)} title="Move right">▶</button>
                    <button type="button" onClick={() => deleteCard(card.id)} style={{ ...arrowBtn(false), marginLeft: 'auto', color: '#dc2626' }} title="Delete">×</button>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ padding: 8, borderTop: '1px solid #f1f5f9', display: 'flex', gap: 6 }}>
              <input
                value={drafts[col.id] ?? ''}
                placeholder="+ Add a card"
                onChange={(e) => setDrafts((d) => ({ ...d, [col.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addCard(col.id);
                }}
                style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', border: '1px solid #e2e8f0', borderRadius: 6, padding: '5px 7px', font: 'inherit' }}
              />
              <button type="button" onClick={() => addCard(col.id)} style={{ border: '1px solid #cbd5e1', background: '#f1f5f9', borderRadius: 6, padding: '0 10px', cursor: 'pointer', fontWeight: 700, color: '#334155' }} title="Add card">
                +
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const arrowBtn = (disabled: boolean): CSSProperties => ({
  border: '1px solid #e2e8f0',
  background: disabled ? '#f8fafc' : '#fff',
  color: disabled ? '#cbd5e1' : '#475569',
  borderRadius: 6,
  width: 24,
  height: 22,
  cursor: disabled ? 'default' : 'pointer',
  font: '11px ui-sans-serif',
  lineHeight: 1,
});
