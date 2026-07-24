import { useCallback, useEffect, useState } from 'react';

import { disablePush, enablePush, pushState, type PushState } from '../push.ts';

// The Settings stage (#192): workspace administration in the one chrome. V1 holds the
// Members section — roster (workspace-visible) + invitations (owner-only). The server
// decides "owner": the invitations GET is 200 for the owner only (403 member), and a
// non-200 hides every admin affordance — same probe the workspace popover used.
//
// The Repository-connection section (#193) joins this stage next.

type MemberView = { userId: string; name: string; email: string; role: 'owner' | 'member' };
type InvitationView = { token: string; email: string; url: string; expiresAt: number };
type GrantedRepo = { fullName: string; defaultBranch: string; protected: boolean };
// ADR-0016: a PAT-backed repo row with its live badges. `unreachable` = the stored token
// no longer opens the repo (expired/revoked) — the row needs "Update token…", not removal.
type PatRepo = { fullName: string; defaultBranch: string | null; protected: boolean; canPush: boolean; unreachable?: boolean };
type PublicRepo = { fullName: string };
type GithubStatus = {
  connected: boolean;
  source?: 'workspace' | 'env';
  accounts?: string[];
  selectedRepos: string[];
  grantedRepos?: GrantedRepo[];
  patRepos?: PatRepo[];
  publicRepos?: PublicRepo[];
  canConnect?: boolean;
};
type WaitlistEntry = { email: string; createdAt: string };
// ADR-0016 manage-not-read: `locked` rows (other members' private canvases) reach the
// workspace owner as name + creator only; the owner may force-publish or delete, never open.
type CanvasRowView = {
  id: string;
  name: string;
  visibility: 'workspace' | 'private';
  mine: boolean;
  locked?: boolean;
  createdBy?: string | null;
};

export function SettingsStage({ workspaceId }: { workspaceId: string }) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [invitations, setInvitations] = useState<InvitationView[] | null>(null); // null = not owner
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[] | null>(null); // null = not admin
  const [lockedCanvases, setLockedCanvases] = useState<CanvasRowView[]>([]);
  // Web push (#87) — PER DEVICE, so this is deliberately not part of `reload()`'s
  // workspace payload: it describes the browser you're sitting at, not the workspace.
  const [push, setPush] = useState<PushState | null>(null);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;

  const reload = useCallback(async () => {
    const [m, i, g, w, c] = await Promise.all([
      fetch(`${base}/members`, { credentials: 'same-origin' }).catch(() => null),
      fetch(`${base}/invitations`, { credentials: 'same-origin' }).catch(() => null),
      fetch(`${base}/github`, { credentials: 'same-origin' }).catch(() => null),
      // The admin probe (ADR-0014): 200 only for role=admin; anything else hides the section.
      fetch('/api/admin/waitlist', { credentials: 'same-origin' }).catch(() => null),
      // ADR-0016: locked rows appear only in the owner's list — empty for members.
      fetch(`/api/canvases?workspace=${encodeURIComponent(workspaceId)}`, { credentials: 'same-origin' }).catch(() => null),
    ]);
    if (m?.ok) setMembers(((await m.json()) as { members: MemberView[] }).members);
    setInvitations(i?.ok ? ((await i.json()) as { invitations: InvitationView[] }).invitations : null);
    if (g?.ok) setGithub((await g.json()) as GithubStatus);
    setWaitlist(w?.ok ? ((await w.json()) as { entries: WaitlistEntry[] }).entries : null);
    if (c?.ok) setLockedCanvases(((await c.json()) as { canvases: CanvasRowView[] }).canvases.filter((cv) => cv.locked));
  }, [base]);

  useEffect(() => {
    if (workspaceId) void reload();
  }, [workspaceId, reload]);

  useEffect(() => {
    void pushState().then(setPush);
  }, []);

  const togglePush = async () => {
    setPush(await (push === 'on' ? disablePush() : enablePush()));
  };

  const isOwnerView = invitations !== null;
  // Global admin role (ADR-0014) — same probe as the Waitlist section, since
  // better-auth's admin plugin is gated on user.role === "admin", not workspace ownership.
  const isAdmin = waitlist !== null;

  const invite = async () => {
    const email = window.prompt('Invite to this workspace by email — the link works only for that address:');
    if (!email) return;
    const r = await fetch(`${base}/invitations`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not create the invitation.');
      return;
    }
    const d = (await r.json()) as { url: string };
    const link = `${window.location.origin}${d.url}`;
    await navigator.clipboard?.writeText(link).catch(() => {});
    window.prompt('Invite link (copied to clipboard) — send it over your own channel. Expires in 48h, single-use:', link);
    void reload();
  };

  const removeMember = async (m: MemberView) => {
    if (!window.confirm(`Remove ${m.name} (${m.email}) from this workspace?`)) return;
    await fetch(`${base}/members/${encodeURIComponent(m.userId)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    void reload();
  };

  const makeOwner = async (m: MemberView) => {
    if (!window.confirm(`Transfer ownership of this workspace to ${m.name}? You will become a member.`)) return;
    const r = await fetch(`${base}/members/${encodeURIComponent(m.userId)}`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not transfer ownership.');
      return;
    }
    setMembers(((await r.json()) as { members: MemberView[] }).members);
  };

  const toggleRepo = async (fullName: string) => {
    if (!github) return;
    const previous = github.selectedRepos;
    const selected = previous.includes(fullName) ? previous.filter((r) => r !== fullName) : [...previous, fullName];
    // Optimistic: the PUT takes a few seconds, and a checkbox that doesn't move until it
    // resolves reads as broken — a fast second click then reverts against the stale list.
    setGithub({ ...github, selectedRepos: selected });
    const r = await fetch(`${base}/github/repos`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selected }),
    }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not update the repo selection.');
      setGithub((g) => (g ? { ...g, selectedRepos: previous } : g));
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect GitHub from this workspace? The dev-agent loses repo access until reconnected.')) return;
    await fetch(`${base}/github`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    void reload();
  };

  // PAT repos (ADR-0016): repos outside the App installation's identity, added by token.
  // The token is validated live and stored sealed; a read-only token is accepted with a
  // "PRs unavailable" heads-up rather than rejected (least-privilege is a feature).
  const patCall = async (method: 'POST' | 'PATCH', fullName: string, token: string) => {
    const r = await fetch(`${base}/github/external`, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName, token }),
    }).catch(() => null);
    if (!r?.ok) {
      const err = r ? ((await r.json().catch(() => null)) as { error?: string } | null) : null;
      window.alert(err?.error ?? 'Could not save the repo token.');
      return;
    }
    const d = (await r.json()) as { canPush: boolean };
    if (!d.canPush) {
      window.alert('Saved — note the token is read-only: research and job discovery work, but PRs are unavailable until you update it with a write-capable token.');
    }
    void reload();
  };

  // Re-sync the read-only checkouts (ADR-0016) — member-allowed, it grants nothing.
  const refreshCheckouts = async () => {
    const r = await fetch(`${base}/github/refresh`, { method: 'POST', credentials: 'same-origin' }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not refresh the repo checkouts.');
      return;
    }
    const d = (await r.json()) as { refreshed: string[]; failed: string[] };
    window.alert(
      d.failed.length > 0
        ? `Refreshed: ${d.refreshed.join(', ') || 'none'}. Failed: ${d.failed.join(', ')}.`
        : `Refreshed ${d.refreshed.length} checkout${d.refreshed.length === 1 ? '' : 's'}.`,
    );
  };

  // Accept the forms people naturally paste — `git@github.com:owner/name.git`,
  // `https://github.com/owner/name` — and normalize to the API's `owner/name`.
  const normalizeRepoName = (input: string): string =>
    input
      .trim()
      .replace(/^git@github\.com:/, '')
      .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');

  const addExternalRepo = async () => {
    const entered = window.prompt('Add a repo by token — owner/name:');
    if (!entered) return;
    const fullName = normalizeRepoName(entered);
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      window.alert(`"${entered}" doesn't look like a repo — enter owner/name, e.g. fredrincom/fredrin.`);
      return;
    }
    const token = window.prompt(
      `Personal access token for ${fullName}. Use a fine-grained PAT scoped to ONLY that repo, with an expiry (read-write to allow PRs):`,
    );
    if (!token) return;
    await patCall('POST', fullName, token.trim());
  };

  const updateExternalToken = async (repo: PatRepo) => {
    const token = window.prompt(`New token for ${repo.fullName} (fine-grained, single-repo, with an expiry):`);
    if (!token) return;
    await patCall('PATCH', repo.fullName, token.trim());
  };

  const removeExternalRepo = async (repo: PatRepo | PublicRepo) => {
    if (!window.confirm(`Remove ${repo.fullName} from this workspace?`)) return;
    await fetch(`${base}/github/external`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fullName: repo.fullName }),
    }).catch(() => {});
    void reload();
  };

  // The manual invite (ADR-0014): admin creates the user with a temp password and
  // sends it over their own channel — no email infrastructure yet (Resend later).
  const createUser = async () => {
    const email = window.prompt('Create a user — email (from the waitlist, usually):');
    if (!email) return;
    const name = window.prompt('Display name:', email.split('@')[0] ?? '') ?? '';
    if (!name) return;
    const password = crypto.randomUUID();
    const r = await fetch('/api/auth/admin/create-user', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, name, password }),
    }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not create the user.');
      return;
    }
    // Auto-add the fresh account to THIS workspace: without membership the user can sign
    // in but sees nothing (and never shows in the roster) — the trap the invite-link flow
    // fell into. Owner-only endpoint, idempotent.
    const created = (await r.json().catch(() => null)) as { user?: { id?: string } } | null;
    if (created?.user?.id) {
      const added = await fetch(`${base}/members`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: created.user.id }),
      }).catch(() => null);
      if (!added?.ok) window.alert('User created, but adding them to the workspace failed — add them manually.');
    }
    window.prompt('User created. Temporary password (send it over your own channel):', password);
    void reload();
  };

  // Admin-only (global role, not just workspace owner — same gate as "Create user"):
  // better-auth's admin plugin already exposes this at /api/auth/admin/set-user-password.
  const resetPassword = async (m: MemberView) => {
    if (!window.confirm(`Reset ${m.name}'s (${m.email}) password? Their current password stops working immediately.`)) return;
    const password = crypto.randomUUID();
    const r = await fetch('/api/auth/admin/set-user-password', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: m.userId, newPassword: password }),
    }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not reset the password.');
      return;
    }
    window.prompt('Temporary password (send it over your own channel):', password);
  };

  const revokeInvitation = async (inv: InvitationView) => {
    await fetch(`${base}/invitations/${encodeURIComponent(inv.token)}`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    void reload();
  };

  if (!workspaceId) {
    return (
      <div className="shell-stage stage-settings">
        <div className="settings-body" />
      </div>
    );
  }

  return (
    <div className="shell-stage stage-settings">
      <div className="settings-body">
        <h2 className="settings-title">Workspace settings</h2>

        <section className="settings-section">
          <div className="settings-section-head">
            <h3>Members</h3>
            {isOwnerView && (
              <button type="button" className="settings-invite" onClick={() => void invite()}>
                Invite…
              </button>
            )}
          </div>
          <ul className="settings-list">
            {members.map((m) => (
              <li key={m.userId} className="settings-row">
                <span className="settings-row-name">{m.name}</span>
                <span className="settings-row-sub">{m.email}</span>
                <span className={`settings-role settings-role-${m.role}`}>{m.role}</span>
                {isAdmin && (
                  <button
                    type="button"
                    className="settings-reset-password"
                    title="Reset this member's password"
                    onClick={() => void resetPassword(m)}
                  >
                    Reset password…
                  </button>
                )}
                {isOwnerView && m.role !== 'owner' && (
                  <>
                    <button
                      type="button"
                      className="settings-make-owner"
                      title="Transfer ownership to this member"
                      onClick={() => void makeOwner(m)}
                    >
                      Make owner
                    </button>
                    <button
                      type="button"
                      className="settings-remove"
                      title="Remove from workspace"
                      onClick={() => void removeMember(m)}
                    >
                      Remove
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>

          {isOwnerView && invitations.length > 0 && (
            <>
              <div className="settings-subhead">Pending invitations</div>
              <ul className="settings-list">
                {invitations.map((inv) => (
                  <li key={inv.token} className="settings-row">
                    <span className="settings-row-name">{inv.email}</span>
                    <span className="settings-row-sub">
                      expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </span>
                    <button
                      type="button"
                      className="settings-revoke"
                      title="Revoke this invitation"
                      onClick={() => void revokeInvitation(inv)}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {isOwnerView && lockedCanvases.length > 0 && (
          <section className="settings-section">
            <div className="settings-section-head">
              <h3>Private canvases</h3>
            </div>
            <p className="settings-row-sub">
              Other members' private canvases. You can publish or delete them, but not open them while private
              (manage, not read).
            </p>
            <ul className="settings-list">
              {lockedCanvases.map((cv) => (
                <li key={cv.id} className="settings-row">
                  <span className="settings-row-name">🔒 {cv.name}</span>
                  <span className="settings-row-sub">
                    {members.find((m) => m.userId === cv.createdBy)?.name ?? cv.createdBy ?? 'unknown'}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        if (!window.confirm(`Make "${cv.name}" visible to the whole workspace?`)) return;
                        await fetch(`/api/canvases/${encodeURIComponent(cv.id)}`, {
                          method: 'PATCH',
                          credentials: 'same-origin',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ visibility: 'workspace' }),
                        }).catch(() => {});
                        void reload();
                      })()
                    }
                  >
                    Publish
                  </button>
                  <button
                    type="button"
                    className="settings-revoke"
                    onClick={() =>
                      void (async () => {
                        if (!window.confirm(`Delete "${cv.name}"? This cannot be undone.`)) return;
                        await fetch(`/api/canvases/${encodeURIComponent(cv.id)}`, {
                          method: 'DELETE',
                          credentials: 'same-origin',
                        }).catch(() => {});
                        void reload();
                      })()
                    }
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {push !== null && push !== 'unconfigured' && (
          <section className="settings-section">
            <div className="settings-section-head">
              <h3>Notifications</h3>
              {(push === 'on' || push === 'off') && (
                <button type="button" className="settings-push-toggle" onClick={() => void togglePush()}>
                  {push === 'on' ? 'Turn off on this device' : 'Turn on for this device'}
                </button>
              )}
            </div>
            <p className="settings-row-sub">
              {push === 'unsupported'
                ? 'This browser cannot receive push notifications.'
                : push === 'denied'
                  ? 'Notifications are blocked for this site — re-allow them in your browser settings, then reload.'
                  : push === 'on'
                    ? 'This device gets a notification when a session needs your input. Each device opts in separately.'
                    : 'Get a notification when a background session needs your input. Applies to this device only.'}
            </p>
          </section>
        )}

        <section className="settings-section">
          <div className="settings-section-head">
            <h3>Repositories</h3>
            <button
              type="button"
              className="settings-refresh-checkouts"
              title="Re-sync the read-only repo checkouts agents read from"
              onClick={() => void refreshCheckouts()}
            >
              Refresh checkouts
            </button>
            {isOwnerView && (
              <button type="button" className="settings-add-external" onClick={() => void addExternalRepo()}>
                Add repo by token…
              </button>
            )}
            {github?.connected && github.source === 'workspace' && isOwnerView && (
              <button type="button" className="settings-disconnect" onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
          </div>

          {/* One App installation covers one GitHub org/user — connecting again adds
              another account's repos alongside the existing ones. */}
          {github?.connected && github.source === 'workspace' && isOwnerView && github.canConnect && (
            <div className="settings-row-sub settings-banner">
              {(github.accounts?.length ?? 0) > 0 && <>Connected accounts: {github.accounts?.join(', ')}. </>}
              <a className="settings-connect" href={`${base}/github/connect`}>
                Connect another account…
              </a>
            </div>
          )}

          {!github && <div className="settings-row-sub">Loading…</div>}

          {github && !github.connected && (
            <div className="settings-empty">
              <p className="settings-row-sub">
                No GitHub connection. Connecting lets this workspace's agents open PRs against the repos you select.
              </p>
              {github.canConnect && (
                <a className="settings-connect" href={`${base}/github/connect`}>
                  Connect GitHub…
                </a>
              )}
            </div>
          )}

          {github?.connected && (
            <>
              {github.source === 'env' && (
                <div className="settings-row-sub settings-banner">
                  Connected via the deployment's environment (transitional) — connect through GitHub to manage the selection here.
                  {github.canConnect && (
                    <>
                      {' '}
                      <a className="settings-connect" href={`${base}/github/connect`}>
                        Connect GitHub…
                      </a>
                    </>
                  )}
                </div>
              )}
              <ul className="settings-list">
                {(github.grantedRepos ?? github.selectedRepos.map((r) => ({ fullName: r, defaultBranch: '', protected: false }))).map((repo) => {
                  const selected = github.selectedRepos.includes(repo.fullName);
                  const editable = isOwnerView && github.source === 'workspace' && !!github.grantedRepos;
                  return (
                    <li key={repo.fullName} className="settings-row">
                      {editable ? (
                        <input
                          type="checkbox"
                          className="settings-repo-toggle"
                          checked={selected}
                          onChange={() => void toggleRepo(repo.fullName)}
                        />
                      ) : (
                        <span className="settings-repo-dot">{selected ? '●' : '○'}</span>
                      )}
                      <span className="settings-row-name">{repo.fullName}</span>
                      {repo.defaultBranch && (
                        <span
                          className={repo.protected ? 'settings-protected' : 'settings-unprotected'}
                          title={
                            repo.protected
                              ? `${repo.defaultBranch} requires PRs — merges are the arming step`
                              : `${repo.defaultBranch} is NOT protected — agent tokens could push to it directly`
                          }
                        >
                          {repo.protected ? `${repo.defaultBranch} protected` : `${repo.defaultBranch} unprotected`}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="settings-row-sub">
                Selected repos are in scope for this workspace's agents: job discovery, dev-agent runs, and token minting.
              </p>
            </>
          )}

          {(github?.patRepos?.length ?? 0) > 0 && (
            <>
              <div className="settings-subhead">External repos (by token)</div>
              <ul className="settings-list">
                {github?.patRepos?.map((repo) => (
                  <li key={repo.fullName} className="settings-row">
                    <span className="settings-row-name">{repo.fullName}</span>
                    {repo.unreachable ? (
                      <span className="settings-unprotected" title="The stored token no longer reaches this repo — update it">
                        token expired or revoked
                      </span>
                    ) : (
                      <>
                        {repo.defaultBranch && (
                          <span
                            className={repo.protected ? 'settings-protected' : 'settings-unprotected'}
                            title={
                              repo.protected
                                ? `${repo.defaultBranch} requires PRs — merges are the arming step`
                                : `${repo.defaultBranch} is NOT protected — the token could push to it directly`
                            }
                          >
                            {repo.protected ? `${repo.defaultBranch} protected` : `${repo.defaultBranch} unprotected`}
                          </span>
                        )}
                        {!repo.canPush && (
                          <span className="settings-unprotected" title="Research and discovery work; PRs need a write-capable token">
                            read-only — PRs unavailable
                          </span>
                        )}
                      </>
                    )}
                    {isOwnerView && (
                      <>
                        <button type="button" className="settings-make-owner" onClick={() => void updateExternalToken(repo)}>
                          Update token…
                        </button>
                        <button type="button" className="settings-remove" onClick={() => void removeExternalRepo(repo)}>
                          Remove
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
              <p className="settings-row-sub">
                Repos connected with their own token (e.g. a client-issued GitHub account). Tokens are stored encrypted and
                used only at the moment of fetch or PR.
              </p>
            </>
          )}

          {(github?.publicRepos?.length ?? 0) > 0 && (
            <>
              <div className="settings-subhead">Public repos</div>
              <ul className="settings-list">
                {github?.publicRepos?.map((repo) => (
                  <li key={repo.fullName} className="settings-row">
                    <span className="settings-row-name">{repo.fullName}</span>
                    <span className="settings-unprotected" title="No credential stored; reads clone the public remote — PRs unavailable">
                      public — read-only
                    </span>
                    {isOwnerView && (
                      <button type="button" className="settings-remove" onClick={() => void removeExternalRepo(repo)}>
                        Remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <p className="settings-row-sub">
                Added by pasting a GitHub URL onto the canvas. Token-less: agents can read the checkout, but PRs are
                impossible. Removing one flips its canvas cards back to "not cloned".
              </p>
            </>
          )}
        </section>

        {waitlist !== null && (
          <section className="settings-section">
            <div className="settings-section-head">
              <h3>Waitlist</h3>
              <button type="button" className="settings-create-user" onClick={() => void createUser()}>
                Create user…
              </button>
            </div>
            {waitlist.length === 0 ? (
              <p className="settings-row-sub">No signups yet.</p>
            ) : (
              <ul className="settings-list">
                {waitlist.map((e) => (
                  <li key={e.email} className="settings-row settings-waitlist-row">
                    <span className="settings-row-name">{e.email}</span>
                    <span className="settings-row-sub">{e.createdAt} UTC</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="settings-row-sub">
              Signups from cedarpad.com. Invites are manual: create the user with the generated temporary password and
              send it over your own channel.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
