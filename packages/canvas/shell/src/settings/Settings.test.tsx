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

const realFetch = globalThis.fetch;
let calls: string[] = [];
let ownerView = true;

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
    if (url.startsWith('/api/workspaces/ws_abc/invitations/') && method === 'DELETE') return new Response(null, { status: 204 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  calls = [];
  ownerView = true;
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
});
