import { useCallback, useEffect, useState } from 'react';

// The Components stage: every Component in the workspace, and every card rendering it.
//
// It exists because every other view of the library is scoped to ONE canvas — the pad's
// palette and gallery answer "what can this canvas place?" — so a Component generated on
// some other canvas is invisible until you go looking for it. Cleaning them up needs the
// cross-canvas view that nothing else provides.
//
// The tier label is not decoration. Components resolve own → shared → base, first match
// wins, so two Components can share a name and a card belongs to exactly one of them. The
// server attributes each card by resolving per canvas; this view carries `tier` and
// `canvasId` back on delete so the server knows WHICH `Roadmap` is meant.

type Tier = 'own' | 'shared' | 'base' | 'unresolved';

export interface Instance {
  canvasId: string;
  canvasName: string;
  shapeId: string;
  page?: string;
}

interface Entry {
  name: string;
  tier: Tier;
  canvasId: string | null;
  instances: Instance[];
}

const TIER_LABEL: Record<Tier, string> = {
  own: 'canvas',
  shared: 'shared',
  base: 'built-in',
  unresolved: 'no source',
};

/** Tier chips, built-in first: the platform library is the one tier you audit as a set,
 *  since it ships with the image and nothing in a workspace can edit it. */
const TIER_ORDER: Tier[] = ['base', 'shared', 'own', 'unresolved'];

/** How many Components sit in each tier. Drives both the chip labels and which chips exist
 *  at all — a chip is only offered for a tier that has rows, so no filter can empty the list
 *  and leave the page looking broken. */
export function tierCounts(entries: Array<{ tier: Tier }>): Record<Tier, number> {
  const counts: Record<Tier, number> = { own: 0, shared: 0, base: 0, unresolved: 0 };
  for (const e of entries) counts[e.tier] += 1;
  return counts;
}

/** Cards per canvas, for the confirmation. Deleting a Component removes cards the human
 *  cannot see from here, so the prompt has to say where they are and how many. */
export function instanceSummary(instances: Instance[]): Array<{ canvasName: string; count: number }> {
  const byCanvas = new Map<string, { canvasName: string; count: number }>();
  for (const i of instances) {
    const found = byCanvas.get(i.canvasId);
    if (found) found.count += 1;
    else byCanvas.set(i.canvasId, { canvasName: i.canvasName, count: 1 });
  }
  return [...byCanvas.values()];
}

function confirmText(entry: Entry): string {
  const summary = instanceSummary(entry.instances);
  const where = summary.length ? summary.map((s) => `${s.canvasName} (${s.count})`).join(', ') : 'no canvases';
  const cards = `${entry.instances.length} card${entry.instances.length === 1 ? '' : 's'} on ${where}`;
  // The asymmetry is worth stating: the source can be brought back, the cards cannot.
  const source =
    entry.tier === 'unresolved'
      ? 'There is no source to delete — these cards render nothing.'
      : 'The source is kept as a deleted revision and can be restored; the cards cannot.';
  return `Delete "${entry.name}"?\n\nThis removes ${cards}.\n${source}`;
}

export function ComponentsStage({ workspaceId }: { workspaceId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // Which row is showing a live preview. ON DEMAND, one at a time, and never on load:
  // components are compiled by vite IN THE CONTAINER, so rendering one wakes it. Browsing
  // this list has to stay free — a grid of live thumbnails would wake and compile all of
  // them to draw pictures nobody asked for.
  const [preview, setPreview] = useState<string | null>(null);
  // Which tier the list is narrowed to. Purely a view filter — it never changes what a
  // delete resolves against, which still travels as name+tier+canvasId from the row itself.
  const [filter, setFilter] = useState<Tier | 'all'>('all');

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/workspace-components?workspace=${encodeURIComponent(workspaceId)}`, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`could not load components (${r.status})`);
      setEntries(((await r.json()) as { components: Entry[] }).components);
    } catch (e) {
      setError((e as Error).message);
      setEntries([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const keyOf = (e: Entry) => `${e.tier}:${e.canvasId ?? ''}:${e.name}`;

  const counts = tierCounts(entries ?? []);
  const shown = entries?.filter((e) => filter === 'all' || e.tier === filter);

  const remove = async (entry: Entry) => {
    if (!window.confirm(confirmText(entry))) return;
    setBusy(keyOf(entry));
    setError(null);
    try {
      const r = await fetch(`/api/workspace-components?workspace=${encodeURIComponent(workspaceId)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        // Name alone is ambiguous — see the header comment. All three or nothing.
        body: JSON.stringify({ name: entry.name, tier: entry.tier, canvasId: entry.canvasId }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `delete failed (${r.status})`);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="cmp-stage">
      <div className="cmp-head">
        <h1>Components</h1>
        <button type="button" className="cmp-refresh" onClick={() => void reload()} title="Reload">
          ↻
        </button>
      </div>
      <p className="cmp-intro">
        Every Component in this workspace and the cards that render it. A card resolves against its own canvas — a canvas
        holding its own copy of a name uses that one — so deleting here removes only the cards that actually use this source.
      </p>
      {entries && entries.length > 0 && (
        <div className="cmp-filters">
          <button type="button" className={`cmp-filter${filter === 'all' ? ' is-on' : ''}`} onClick={() => setFilter('all')}>
            All <span className="cmp-filter-n">{entries.length}</span>
          </button>
          {TIER_ORDER.filter((t) => counts[t] > 0).map((t) => (
            <button
              key={t}
              type="button"
              className={`cmp-filter tier-${t}${filter === t ? ' is-on' : ''}`}
              // Clicking the active chip clears it, so the filter never needs a separate reset.
              onClick={() => setFilter(filter === t ? 'all' : t)}
            >
              {TIER_LABEL[t]} <span className="cmp-filter-n">{counts[t]}</span>
            </button>
          ))}
        </div>
      )}
      {error && <div className="cmp-error">{error}</div>}
      {entries === null && <div className="cmp-empty">Loading…</div>}
      {entries?.length === 0 && !error && <div className="cmp-empty">No components yet.</div>}
      <div className="cmp-list">
        {shown?.map((e) => {
          const key = keyOf(e);
          return (
            <div key={key} className={`cmp-row tier-${e.tier}`}>
              <div className="cmp-row-main">
                <span className="cmp-name">{e.name}</span>
                <span className={`cmp-tier tier-${e.tier}`}>{TIER_LABEL[e.tier]}</span>
                <button
                  type="button"
                  className="cmp-count"
                  disabled={e.instances.length === 0}
                  onClick={() => setOpen(open === key ? null : key)}
                  title={e.instances.length ? 'Show where it is placed' : 'Not placed anywhere'}
                >
                  {e.instances.length} placed
                </button>
                {/* `unresolved` has no source to compile, so there is nothing to preview. */}
                {e.tier !== 'unresolved' && (
                  <button
                    type="button"
                    className="cmp-preview"
                    onClick={() => setPreview(preview === key ? null : key)}
                    title="Render this component (wakes the workspace container)"
                  >
                    {preview === key ? 'Hide' : 'Preview'}
                  </button>
                )}
                {/* Built-ins ship with the image, not as workspace rows — there is nothing
                    here that could delete one, so offering the button would only ever 400. */}
                {e.tier !== 'base' && (
                  <button type="button" className="cmp-delete" disabled={busy === key} onClick={() => void remove(e)}>
                    {busy === key ? 'Deleting…' : 'Delete'}
                  </button>
                )}
              </div>
              {preview === key && (
                <div className="cmp-preview-frame">
                  {/* The pad renders it (`?preview=`), because vite in the container is what
                      compiles a component — the edge cannot. An own-tier Component previews
                      on ITS canvas; shared and base resolve the same from any, so those use
                      the default one. That means the frame resolves the module exactly as a
                      card on that canvas would. */}
                  <iframe
                    title={`${e.name} preview`}
                    src={`/w/${encodeURIComponent(workspaceId)}/canvas/${encodeURIComponent(e.canvasId ?? 'default')}/pad?preview=${encodeURIComponent(e.name)}`}
                  />
                  <div className="cmp-preview-note">
                    Rendered with no placement data — a component that expects props shows empty or errors here.
                  </div>
                </div>
              )}
              {open === key && (
                <ul className="cmp-instances">
                  {e.instances.map((i) => (
                    <li key={i.shapeId}>
                      <a href={`/w/${encodeURIComponent(workspaceId)}/canvas/${encodeURIComponent(i.canvasId)}/pad`}>{i.canvasName}</a>
                      {i.page && <span className="cmp-page"> · {i.page}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
