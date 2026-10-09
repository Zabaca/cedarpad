import { useCallback, useEffect, useState } from 'react';


// The Settings stage (#192): workspace administration in the one chrome. V1 holds the
// Members section — roster (workspace-visible) + invitations (owner-only). The server
// decides "owner": the invitations GET is 200 for the owner only (403 member), and a
// non-200 hides every admin affordance — same probe the workspace popover used.

type MemberView = { userId: string; name: string; email: string; role: 'owner' | 'member' };
type InvitationView = { token: string; email: string; url: string; expiresAt: number };
type WaitlistEntry = { email: string; createdAt: string };
// ADR-0025: the two stamps baked into the serving container image — the released semver and
// the git SHA it was cut from. Both public, both from /api/buildrev.
type BuildStamps = { buildRev: string; version: string };
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
  const [waitlist, setWaitlist] = useState<WaitlistEntry[] | null>(null); // null = not admin
  const [lockedCanvases, setLockedCanvases] = useState<CanvasRowView[]>([]);
  const [build, setBuild] = useState<BuildStamps | null>(null);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;

  const reload = useCallback(async () => {
    const [m, i, w, c] = await Promise.all([
      fetch(`${base}/members`, { credentials: 'same-origin' }).catch(() => null),
      fetch(`${base}/invitations`, { credentials: 'same-origin' }).catch(() => null),
      // The admin probe (ADR-0014): 200 only for role=admin; anything else hides the section.
      fetch('/api/admin/waitlist', { credentials: 'same-origin' }).catch(() => null),
      // ADR-0016: locked rows appear only in the owner's list — empty for members.
      fetch(`/api/canvases?workspace=${encodeURIComponent(workspaceId)}`, { credentials: 'same-origin' }).catch(() => null),
    ]);
    if (m?.ok) setMembers(((await m.json()) as { members: MemberView[] }).members);
    setInvitations(i?.ok ? ((await i.json()) as { invitations: InvitationView[] }).invitations : null);
    setWaitlist(w?.ok ? ((await w.json()) as { entries: WaitlistEntry[] }).entries : null);
    if (c?.ok) setLockedCanvases(((await c.json()) as { canvases: CanvasRowView[] }).canvases.filter((cv) => cv.locked));
  }, [base]);

  useEffect(() => {
    if (workspaceId) void reload();
  }, [workspaceId, reload]);

  // The running release (ADR-0025). Deliberately NOT part of `reload()`'s workspace payload
  // and deliberately fetched rather than bundled: /api/buildrev reports the stamps baked into
  // the container that is SERVING, so this states what is actually live rather than what this
  // JS bundle was built from. Unreachable → stays null → the section does not render, which
  // is the honest answer to "which version am I on?".
  useEffect(() => {
    void fetch('/api/buildrev', { credentials: 'same-origin' })
      .then((r) => (r.ok ? (r.json() as Promise<BuildStamps>) : null))
      .then((d) => setBuild(d?.version && d?.buildRev ? d : null))
      .catch(() => setBuild(null));
  }, []);

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

  // The manual invite (ADR-0014), now passwordless: this creates the account and the
  // workspace membership, and the user signs in by asking the login page for a magic
  // link — creating the row is what makes their address eligible for one. The password
  // below is vestigial: admin/create-user still requires the field, but there is no
  // password credential to sign in with, so it is generated and never shown.
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
    window.alert(`User created. Tell ${email} to sign in at cedarpad and request a sign-in link — it will be emailed to them.`);
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

        {build && (
          <section className="settings-section settings-version">
            <div className="settings-section-head">
              <h3>Version</h3>
            </div>
            <p className="settings-row-sub">
              Running <strong>v{build.version}</strong> <span className="settings-buildrev">({build.buildRev})</span> —{' '}
              <a href="https://cedarpad.com/changelog" target="_blank" rel="noreferrer">
                what&rsquo;s new
              </a>
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
