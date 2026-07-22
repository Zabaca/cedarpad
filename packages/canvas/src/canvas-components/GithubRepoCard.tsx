// GitHub Repo reference card (ADR-0016 addendum): pasting a GitHub URL onto the canvas
// places one of these. It is a VIEW of the workspace's Repo asset, never the owner of it —
// cloned-ness is looked up live from the workspace repo set (the edge status endpoint), so
// removing the repo in Settings flips every card for it back to "not cloned". Only the
// clone-request stamp (`requestedBy`) lives in synced card data.
//
// One button, permission decides the outcome: the owner's Clone really clones (owner-only
// edge endpoint, validates the repo is public); a member's Clone gets the 403 and the card
// turns that into a visible "requested by X" on the shared canvas.
import * as React from 'react';

type CurrentUser = { id: string; name?: string; email?: string } | null;

type RepoStatus = 'checking' | 'cloned' | 'uncloned' | 'unknown';

/** The workspace repo set, flattened to full names. Exported for tests. */
export function repoSetFromStatus(body: {
  selectedRepos?: string[];
  patRepos?: Array<{ fullName: string }>;
  publicRepos?: Array<{ fullName: string }>;
}): string[] {
  return [
    ...(body.selectedRepos ?? []),
    ...(body.patRepos ?? []).map((r) => r.fullName),
    ...(body.publicRepos ?? []).map((r) => r.fullName),
  ];
}

export default function GithubRepoCard({
  repo = '',
  url = '',
  requestedBy,
  setData,
  currentUser,
  fetchImpl,
}: {
  repo?: string;
  url?: string;
  requestedBy?: string;
  setData?: (patch: Record<string, unknown>) => void;
  currentUser?: CurrentUser;
  /** Test seam; defaults to the browser fetch. */
  fetchImpl?: typeof fetch;
}) {
  const doFetch = React.useMemo(() => fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a)), [fetchImpl]);
  const [wsId, setWsId] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<RepoStatus>('checking');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const checkoutPath = `.repos/${repo.replace('/', '__')}/`;

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cv = await doFetch('/api/canvases');
        if (!cv.ok) throw new Error(String(cv.status));
        const { workspaceId } = (await cv.json()) as { workspaceId: string };
        const st = await doFetch(`/api/workspaces/${workspaceId}/github`);
        if (!st.ok) throw new Error(String(st.status));
        const body = (await st.json()) as Parameters<typeof repoSetFromStatus>[0];
        if (!alive) return;
        setWsId(workspaceId);
        setStatus(repoSetFromStatus(body).includes(repo) ? 'cloned' : 'uncloned');
      } catch {
        if (alive) setStatus('unknown'); // e.g. a guest view — still a useful reference marker
      }
    })();
    return () => {
      alive = false;
    };
  }, [doFetch, repo]);

  const clone = async () => {
    if (!wsId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await doFetch(`/api/workspaces/${wsId}/github/public`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName: repo }),
      });
      if (res.ok || res.status === 409) {
        setStatus('cloned'); // 409 = already in the workspace — same truth
        if (requestedBy) setData?.({ requestedBy: undefined });
      } else if (res.status === 403) {
        // Not the owner: the click IS the permission request, visible to everyone.
        setData?.({ requestedBy: currentUser?.name ?? currentUser?.email ?? 'a member' });
      } else {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `clone failed (${res.status})`);
      }
    } catch {
      setError('clone failed (network)');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    if (!wsId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await doFetch(`/api/workspaces/${wsId}/github/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fullName: repo }),
      });
      if (!res.ok) setError(`refresh failed (${res.status})`);
    } catch {
      setError('refresh failed (network)');
    } finally {
      setBusy(false);
    }
  };

  const chip = (label: string, bg: string, fg: string) => (
    <span style={{ background: bg, color: fg, borderRadius: 999, padding: '2px 8px', font: '11px/1.4 system-ui, sans-serif' }}>{label}</span>
  );

  const btn: React.CSSProperties = {
    font: '12px/1 system-ui, sans-serif',
    padding: '5px 10px',
    borderRadius: 6,
    border: '1px solid #d1d5db',
    background: '#fff',
    cursor: 'pointer',
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#fff',
        borderRadius: 8,
        padding: 12,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontFamily: 'system-ui, sans-serif',
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span aria-hidden style={{ fontSize: 16 }}>🐙</span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          style={{ font: '600 14px/1.3 system-ui, sans-serif', color: '#111827', textDecoration: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={url}
        >
          {repo || 'github repo'}
        </a>
        <span style={{ marginLeft: 'auto' }}>
          {status === 'checking' && chip('checking…', '#f3f4f6', '#6b7280')}
          {status === 'cloned' && chip('cloned', '#dcfce7', '#166534')}
          {status === 'uncloned' && chip('not cloned', '#f3f4f6', '#6b7280')}
          {status === 'unknown' && chip('github', '#f3f4f6', '#6b7280')}
        </span>
      </div>

      {status === 'cloned' && (
        <div style={{ font: '12px/1.5 ui-monospace, monospace', color: '#374151', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 8px', userSelect: 'text' }}>
          {checkoutPath}
        </div>
      )}
      {status === 'cloned' && (
        <div style={{ font: '11px/1.4 system-ui, sans-serif', color: '#6b7280' }}>
          Linked chats can read this checkout like local files.
        </div>
      )}

      {requestedBy && status !== 'cloned' && (
        <div style={{ font: '12px/1.4 system-ui, sans-serif', color: '#92400e', background: '#fef3c7', borderRadius: 6, padding: '6px 8px' }}>
          Clone requested by {requestedBy} — the workspace owner can approve by cloning.
        </div>
      )}
      {error && <div style={{ font: '12px/1.4 system-ui, sans-serif', color: '#b91c1c' }}>{error}</div>}

      <div style={{ marginTop: 'auto', display: 'flex', gap: 8 }}>
        {status === 'uncloned' && (
          <button type="button" style={btn} onClick={() => void clone()} disabled={busy}>
            {busy ? 'Cloning…' : 'Clone into workspace'}
          </button>
        )}
        {status === 'cloned' && (
          <button type="button" style={btn} onClick={() => void refresh()} disabled={busy}>
            {busy ? 'Refreshing…' : 'Refresh checkout'}
          </button>
        )}
      </div>
    </div>
  );
}
