// The component gallery: a modal card grid over the canvas, opened by the side
// panel's "+ Component" button. Cards come from GET /api/components `details`
// (name + first-comment description + tier); clicking a card places an instance at
// the viewport center (same POST the palette used) and closes the modal.

import * as React from 'react';

import { withCanvasHeader } from './active-canvas';
import { placementAt, filterModules } from './ComponentPalette';

// A gallery card IS one component-catalog entry — the same shape /api/components returns.
// Bind to the shared contract so the tier enum can't drift here (CLAUDE.md §7).
import type { ComponentCatalogEntry as GalleryCard } from '../shared/platform-rpc';
export type { GalleryCard };

const TIER_LABEL: Record<GalleryCard['tier'], string> = { own: 'this canvas', shared: 'shared', base: 'built-in' };

/** Filter cards by substring over name + description. */
export function filterCards(cards: GalleryCard[], query: string): GalleryCard[] {
  const q = query.trim().toLowerCase();
  return q ? cards.filter((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q)) : cards;
}

export function ComponentGallery({
  viewportCenter,
  currentPage,
  onClose,
}: {
  viewportCenter: () => { x: number; y: number };
  /** The page to place onto — undefined on the canvas's first page, which is how the
   *  model spells it (src/current-page.ts). The placement happens on the SERVER, so
   *  without this the card lands on page one whatever page the human is looking at. */
  currentPage: () => string | undefined;
  onClose: () => void;
}) {
  const [cards, setCards] = React.useState<GalleryCard[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [placing, setPlacing] = React.useState<string | null>(null);
  const placedRef = React.useRef(0);

  React.useEffect(() => {
    fetch('/api/components', { headers: withCanvasHeader() })
      .then(async (r) => {
        if (!r.ok) throw new Error(`list failed (${r.status})`);
        const body = (await r.json()) as { components: string[]; details?: GalleryCard[] };
        setCards(body.details ?? filterModules(body.components, '').map((name) => ({ name, description: '', tier: 'base' as const })));
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const place = async (name: string) => {
    setPlacing(name);
    setError(null);
    try {
      const page = currentPage();
      const r = await fetch('/api/components/place', {
        method: 'POST',
        headers: withCanvasHeader({ 'content-type': 'application/json' }),
        body: JSON.stringify({ module: name, ...placementAt(viewportCenter(), placedRef.current), ...(page ? { page } : {}) }),
      });
      if (!r.ok) throw new Error(`place failed (${r.status})`);
      placedRef.current += 1;
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setPlacing(null);
    }
  };

  const shown = cards ? filterCards(cards, query) : [];

  return (
    <div className="gallery-scrim" onClick={onClose}>
      <div className="gallery" role="dialog" aria-label="Add a component" onClick={(e) => e.stopPropagation()}>
        <div className="gallery-head">
          <b>Add a component</b>
          <span className="gallery-count">{cards ? shown.length : '…'}</span>
          <button type="button" className="gallery-close" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <input
          className="gallery-filter"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search components…"
        />
        {error && <div className="gallery-error">{error}</div>}
        <div className="gallery-grid">
          {cards !== null && shown.length === 0 && <div className="gallery-empty">No matches.</div>}
          {shown.map((c) => (
            <button
              type="button"
              key={c.name}
              className="gallery-card"
              disabled={placing !== null}
              onClick={() => void place(c.name)}
              title={`Place ${c.name} on the canvas`}
            >
              <span className="gallery-card-name">{placing === c.name ? 'Adding…' : c.name}</span>
              <span className={`gallery-card-tier tier-${c.tier}`}>{TIER_LABEL[c.tier]}</span>
              <span className="gallery-card-desc">{c.description || 'No description yet.'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
