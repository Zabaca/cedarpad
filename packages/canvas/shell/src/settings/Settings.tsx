import { useCallback, useEffect, useState } from 'react';

// The Settings stage (#192): workspace administration in the one chrome. V1 holds the
// Members section — roster (workspace-visible) + invitations (owner-only). The server
// decides "owner": the invitations GET is 200 for the owner only (403 member), and a
// non-200 hides every admin affordance — same probe the workspace popover used.
//
// The Repository-connection section (#193) joins this stage next.

type MemberView = { userId: string; name: string; email: string; role: 'owner' | 'member' };
type InvitationView = { token: string; email: string; url: string; expiresAt: number };
type GrantedRepo = { fullName: string; defaultBranch: string; protected: boolean };
type GithubStatus = {
  connected: boolean;
  source?: 'workspace' | 'env';
  selectedRepos: string[];
  grantedRepos?: GrantedRepo[];
  canConnect?: boolean;
};

export function SettingsStage({ workspaceId }: { workspaceId: string }) {
  const [members, setMembers] = useState<MemberView[]>([]);
  const [invitations, setInvitations] = useState<InvitationView[] | null>(null); // null = not owner
  const [github, setGithub] = useState<GithubStatus | null>(null);
  const base = `/api/workspaces/${encodeURIComponent(workspaceId)}`;

  const reload = useCallback(async () => {
    const [m, i, g] = await Promise.all([
      fetch(`${base}/members`, { credentials: 'same-origin' }).catch(() => null),
      fetch(`${base}/invitations`, { credentials: 'same-origin' }).catch(() => null),
      fetch(`${base}/github`, { credentials: 'same-origin' }).catch(() => null),
    ]);
    if (m?.ok) setMembers(((await m.json()) as { members: MemberView[] }).members);
    setInvitations(i?.ok ? ((await i.json()) as { invitations: InvitationView[] }).invitations : null);
    if (g?.ok) setGithub((await g.json()) as GithubStatus);
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

  const toggleRepo = async (fullName: string) => {
    if (!github) return;
    const selected = github.selectedRepos.includes(fullName)
      ? github.selectedRepos.filter((r) => r !== fullName)
      : [...github.selectedRepos, fullName];
    const r = await fetch(`${base}/github/repos`, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selected }),
    }).catch(() => null);
    if (!r?.ok) {
      window.alert('Could not update the repo selection.');
      return;
    }
    setGithub({ ...github, selectedRepos: selected });
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect GitHub from this workspace? The dev-agent loses repo access until reconnected.')) return;
    await fetch(`${base}/github`, { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
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

        <section className="settings-section">
          <div className="settings-section-head">
            <h3>Repositories</h3>
            {github?.connected && github.source === 'workspace' && isOwnerView && (
              <button type="button" className="settings-disconnect" onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
          </div>

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
                <div className="settings-row-sub">
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
        </section>
      </div>
    </div>
  );
}
