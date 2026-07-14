import { useCallback, useEffect, useState } from 'react';

// The Settings stage (#192): workspace administration in the one chrome. V1 holds the
// Members section — roster (workspace-visible) + invitations (owner-only). The server
// decides "owner": the invitations GET is 200 for the owner only (403 member), and a
// non-200 hides every admin affordance — same probe the workspace popover used.
//
// The Repository-connection section (#193) joins this stage next.

type MemberView = { userId: string; name: string; email: string; role: 'owner' | 'member' };
type InvitationView = { token: string; email: string; url: string; expiresAt: number };

export function SettingsStage({ workspaceId }: { workspaceId: string }) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [invitations, setInvitations] = useState<InvitationView[] | null>(null); // null = not owner
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;

  const reload = useCallback(async () => {
    const [m, i] = await Promise.all([
      fetch(`${base}/members`, { credentials: 'same-origin' }).catch(() => null),
      fetch(`${base}/invitations`, { credentials: 'same-origin' }).catch(() => null),
    ]);
    if (m?.ok) setMembers(((await m.json()) as { members: MemberView[] }).members);
    setInvitations(i?.ok ? ((await i.json()) as { invitations: InvitationView[] }).invitations : null);
  }, [base]);

  useEffect(() => {
    if (workspaceId) void reload();
  }, [workspaceId, reload]);

  const isOwnerView = invitations !== null;

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
                {isOwnerView && m.role !== 'owner' && (
                  <button
                    type="button"
                    className="settings-remove"
                    title="Remove from workspace"
                    onClick={() => void removeMember(m)}
                  >
                    Remove
                  </button>
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
      </div>
    </div>
  );
}
