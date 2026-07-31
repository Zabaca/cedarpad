// Register happy-dom's window/document BEFORE importing the component tree.
import '../../../src/happydom-harness.ts';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SettingsStage } from './Settings';

const MEMBERS = {
  members: [
    { userId: 'u_owner', name: 'James', email: 'james@zabaca.com', role: 'owner' },
    { userId: 'u_khoa', name: 'Khoa', email: 'khoa@example.com', role: 'member' },
  ],
};
const INVITATIONS = { invitations: [{ token: 'tok_1', email: 'newbie@example.com', url: '/invite/tok_1', expiresAt: 1752000000000 }] };

const GITHUB_CONNECTED = {
  connected: true,
  source: 'workspace',
  selectedRepos: ['Zabaca/cedarpad'],
  grantedRepos: [
    { fullName: 'Zabaca/cedarpad', defaultBranch: 'main', protected: false },
    { fullName: 'Zabaca/ledgerbot', defaultBranch: 'master', protected: true },
  ],
  canConnect: true,
};
const PAT_REPOS = [
  { fullName: 'hudsonts/app', defaultBranch: 'main', protected: false, canPush: false },
  { fullName: 'client/dead', defaultBranch: null, protected: false, canPush: false, unreachable: true },
];
const GITHUB_DISCONNECTED = { connected: false, selectedRepos: [], canConnect: true };

const realFetch = globalThis.fetch;
let calls: string[] = [];
let ownerView = true;
let githubStatus: unknown = GITHUB_CONNECTED;
let adminWaitlist: Array<{ email: string; createdAt: string }> | null = null; // null = not admin (403)
let buildStamps: unknown = { buildRev: 'a8e62db', version: '0.2.0' };

function stubEdge() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (url === '/api/workspaces/ws_abc/members' && method === 'GET') return Response.json(MEMBERS);
    if (url === '/api/workspaces/ws_abc/invitations' && method === 'GET') {
      return ownerView ? Response.json(INVITATIONS) : Response.json({ error: 'owner only' }, { status: 403 });
    }
    if (url.startsWith('/api/workspaces/ws_abc/members/') && method === 'DELETE') return new Response(null, { status: 204 });
    if (url.startsWith('/api/workspaces/ws_abc/members/') && method === 'PATCH') {
      return Response.json({
        members: [
          { userId: 'u_khoa', name: 'Khoa', email: 'khoa@example.com', role: 'owner' },
          { userId: 'u_owner', name: 'James', email: 'james@zabaca.com', role: 'member' },
        ],
      });
    }
    if (url.startsWith('/api/workspaces/ws_abc/invitations/') && method === 'DELETE') return new Response(null, { status: 204 });
    if (url === '/api/workspaces/ws_abc/github' && method === 'GET') return Response.json(githubStatus as never);
    if (url === '/api/admin/waitlist' && method === 'GET') {
      return adminWaitlist ? Response.json({ entries: adminWaitlist }) : Response.json({ error: 'admin only' }, { status: 403 });
    }
    if (url === '/api/auth/admin/create-user' && method === 'POST') return Response.json({ user: { id: 'u_new' } });
    if (url === '/api/auth/admin/set-user-password' && method === 'POST') return Response.json({ status: true });
    if (url === '/api/workspaces/ws_abc/github/repos' && method === 'PUT') {
      return Response.json({ selectedRepos: JSON.parse((init?.body as string) ?? '{}').selected });
    }
    if (url === '/api/workspaces/ws_abc/github/refresh' && method === 'POST') {
      return Response.json({ refreshed: ['Zabaca/cedarpad'], failed: [] });
    }
    if (url === '/api/workspaces/ws_abc/github/external') {
      if (method === 'DELETE') return new Response(null, { status: 204 });
      const b = JSON.parse((init?.body as string) ?? '{}') as { fullName?: string };
      return Response.json({ fullName: b.fullName, defaultBranch: 'main', protected: false, canPush: true });
    }
    if (url === '/api/buildrev' && method === 'GET') {
      return buildStamps ? Response.json(buildStamps) : new Response('unavailable', { status: 503 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  calls = [];
  ownerView = true;
  githubStatus = GITHUB_CONNECTED;
  adminWaitlist = null;
  buildStamps = { buildRev: 'a8e62db', version: '0.2.0' };
  stubEdge();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  globalThis.fetch = realFetch;
});

const flush = async () => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};

describe('SettingsStage — members (#192)', () => {
  test('renders the roster with roles, and the pending invitations for the owner', async () => {
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    expect(host.textContent).toContain('James');
    expect(host.textContent).toContain('james@zabaca.com');
    expect(host.textContent).toContain('owner');
    expect(host.textContent).toContain('Khoa');
    expect(host.textContent).toContain('newbie@example.com');
    // owner affordances: invite + remove + revoke
    expect(host.querySelector('.settings-invite')).not.toBeNull();
    expect(host.querySelectorAll('.settings-remove').length).toBe(1); // Khoa only, never the owner
    expect(host.querySelectorAll('.settings-revoke').length).toBe(1);
  });

  test('a non-owner member sees the roster read-only: no invite, no remove, no invitations', async () => {
    ownerView = false;
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    expect(host.textContent).toContain('Khoa');
    expect(host.textContent).not.toContain('newbie@example.com');
    expect(host.querySelector('.settings-invite')).toBeNull();
    expect(host.querySelectorAll('.settings-remove').length).toBe(0);
  });

  test('the repository section lists the grant with protection badges and the selection; toggling PUTs', async () => {
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    expect(host.textContent).toContain('Zabaca/cedarpad');
    expect(host.textContent).toContain('Zabaca/ledgerbot');
    // protection badge: ledgerbot's default branch is protected, cedarpad's is not
    expect(host.querySelectorAll('.settings-protected').length).toBe(1);
    expect(host.querySelectorAll('.settings-unprotected').length).toBe(1);
    const boxes = [...host.querySelectorAll('.settings-repo-toggle')] as HTMLInputElement[];
    expect(boxes.length).toBe(2);
    expect(boxes[0]?.checked).toBe(true); // cedarpad selected
    expect(boxes[1]?.checked).toBe(false);
    await act(async () => {
      boxes[1]?.click();
    });
    await flush();
    expect(calls.some((c) => c === 'PUT /api/workspaces/ws_abc/github/repos')).toBe(true);
  });

  test('an unconnected workspace offers Connect GitHub to the owner', async () => {
    githubStatus = GITHUB_DISCONNECTED;
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    const link = host.querySelector('.settings-connect') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/api/workspaces/ws_abc/github/connect');
  });

  test('the env-fallback (transitional) state still offers Connect GitHub — the way OUT of it', async () => {
    githubStatus = { connected: true, source: 'env', selectedRepos: ['Zabaca/cedarpad'], canConnect: true };
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    const link = host.querySelector('.settings-connect') as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/api/workspaces/ws_abc/github/connect');
  });

  test('a non-admin sees no Admin section at all (the 403 probe hides it)', async () => {
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    expect(host.textContent).not.toContain('Waitlist');
  });

  test('an admin sees the waitlist entries (ADR-0014: the waitlist tab)', async () => {
    adminWaitlist = [
      { email: 'second@x.com', createdAt: '2026-07-15 09:00:00' },
      { email: 'first@x.com', createdAt: '2026-07-14 19:00:00' },
    ];
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    expect(host.textContent).toContain('Waitlist');
    const rows = [...host.querySelectorAll('.settings-waitlist-row')].map((r) => r.textContent);
    expect(rows[0]).toContain('second@x.com');
    expect(rows[1]).toContain('first@x.com');
  });

  test('the admin creates a user (manual invite): posts email+name+password to the auth admin endpoint', async () => {
    adminWaitlist = [{ email: 'invitee@x.com', createdAt: '2026-07-14 19:00:00' }];
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    const prompts = ['invitee@x.com', 'Invitee'];
    const promptReal = window.prompt;
    const alertReal = window.alert;
    window.prompt = () => prompts.shift() ?? null;
    window.alert = () => {};
    await act(async () => {
      (host.querySelector('.settings-create-user') as HTMLButtonElement).click();
    });
    await flush();
    window.prompt = promptReal;
    window.alert = alertReal;
    expect(calls).toContain('POST /api/auth/admin/create-user');
  });

  test('an admin resets a member\'s password: posts userId+newPassword to the auth admin endpoint', async () => {
    adminWaitlist = [];
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    const confirmReal = window.confirm;
    const promptReal = window.prompt;
    window.confirm = () => true;
    window.prompt = () => null;
    await act(async () => {
      (host.querySelector('.settings-reset-password') as HTMLButtonElement).click();
    });
    await flush();
    window.confirm = confirmReal;
    window.prompt = promptReal;
    const call = calls.find((c) => c.startsWith('POST /api/auth/admin/set-user-password'));
    expect(call).toBeDefined();
  });

  test('a non-admin owner does not see the reset-password action', async () => {
    adminWaitlist = null;
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    expect(host.querySelector('.settings-reset-password')).toBeNull();
  });

  test('PAT repos render with their badges (read-only / expired) — ADR-0016', async () => {
    githubStatus = { ...GITHUB_CONNECTED, patRepos: PAT_REPOS };
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    expect(host.textContent).toContain('External repos (by token)');
    expect(host.textContent).toContain('hudsonts/app');
    expect(host.textContent).toContain('read-only — PRs unavailable');
    expect(host.textContent).toContain('token expired or revoked');
  });

  test('public repos render with the read-only badge and an owner Remove (ADR-0016 addendum)', async () => {
    githubStatus = { ...GITHUB_CONNECTED, publicRepos: [{ fullName: 'vercel/next.js' }] };
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    expect(host.textContent).toContain('Public repos');
    expect(host.textContent).toContain('vercel/next.js');
    expect(host.textContent).toContain('public — read-only');

    const confirmReal = window.confirm;
    window.confirm = () => true;
    const rows = [...host.querySelectorAll('.settings-row')];
    const row = rows.find((r) => r.textContent?.includes('vercel/next.js'));
    await act(async () => {
      (row?.querySelector('.settings-remove') as HTMLButtonElement).click();
    });
    await flush();
    window.confirm = confirmReal;
    expect(calls).toContain('DELETE /api/workspaces/ws_abc/github/external');
  });

  test('the owner adds a repo by token: POSTs fullName+token to the external endpoint', async () => {
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    const prompts = ['hudsonts/app', 'github_pat_x'];
    const promptReal = window.prompt;
    window.prompt = () => prompts.shift() ?? null;
    await act(async () => {
      (host.querySelector('.settings-add-external') as HTMLButtonElement).click();
    });
    await flush();
    window.prompt = promptReal;
    expect(calls).toContain('POST /api/workspaces/ws_abc/github/external');
  });

  test('a non-owner sees neither the add-by-token button nor row actions', async () => {
    ownerView = false;
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    expect(host.querySelector('.settings-add-external')).toBeNull();
  });

  test('removing a member DELETEs and reloads the roster', async () => {
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    const confirmReal = window.confirm;
    window.confirm = () => true;
    await act(async () => {
      (host.querySelector('.settings-remove') as HTMLButtonElement).click();
    });
    await flush();
    window.confirm = confirmReal;
    expect(calls).toContain('DELETE /api/workspaces/ws_abc/members/u_khoa');
    // roster re-fetched after the delete
    expect(calls.filter((c) => c === 'GET /api/workspaces/ws_abc/members').length).toBe(2);
  });

  test('making a member the owner PATCHes {role:"owner"} and applies the returned roster', async () => {
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();
    const confirmReal = window.confirm;
    window.confirm = () => true;
    await act(async () => {
      (host.querySelector('.settings-make-owner') as HTMLButtonElement).click();
    });
    await flush();
    window.confirm = confirmReal;
    expect(calls).toContain('PATCH /api/workspaces/ws_abc/members/u_khoa');
    expect(host.querySelectorAll('.settings-role-owner').length).toBe(1);
    expect(host.textContent).toContain('Khoa');
  });
});

// ADR-0025: the version is the release's public claim, so the app has to be able to state
// which one it is running. It reads /api/buildrev — the stamps baked into the SERVING
// container — rather than anything bundled, so it reports what is actually live.
describe('SettingsStage — the running version (ADR-0025)', () => {
  test('shows the released version, with the build SHA alongside it', async () => {
    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();

    expect(calls).toContain('GET /api/buildrev');
    const about = host.querySelector('.settings-version') as HTMLElement;
    expect(about?.textContent).toContain('0.2.0');
    expect(about?.textContent).toContain('a8e62db');
  });

  test('an unreachable build stamp renders nothing rather than a blank or wrong version', async () => {
    buildStamps = null; // → 503 from the stub

    await act(async () => root.render(<SettingsStage workspaceId="ws_abc" />));
    await flush();

    expect(host.querySelector('.settings-version')).toBeNull();
  });
});
