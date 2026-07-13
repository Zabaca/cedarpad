import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realWorkspaces from '../web-poc/lib/db/queries/workspaces.ts';
import * as realMcpTokens from '../web-poc/lib/db/queries/mcp-tokens.ts';
import type { GateUser } from './auth-gate.ts';

// The owner-consent API (ADR-0013 train 2, #176): PUT/DELETE
// /api/workspaces/:workspaceId/mcp/:mcpName/token. OWNER-only (#181): connecting a token
// is workspace admin, like inviting — a member gets 403, an invisible workspace 404, and
// `default` needs its real seeded row like any other id (no bypass; fails closed).

let workspaceRecord: { id: string; ownerUserId?: string } | null = null;
let setCalls: Array<{ workspaceId: string; mcpName: string; token: string }> = [];
let clearCalls: Array<{ workspaceId: string; mcpName: string }> = [];

// Delegate + restore (see worker/index.test.ts): bun's mock.module rebinds the module for
// every LATER test file in this process, so canned impls must hand back to the real ones
// after this file — and the real fns must be captured BY VALUE before mock.module installs
// (the live namespace would resolve to the wrapper itself → proper-tail-call infinite loop).
const realGetWorkspace = realWorkspaces.getWorkspace;
const realSetToken = realMcpTokens.setToken;
const realClearToken = realMcpTokens.clearToken;
let getWorkspaceImpl: typeof realGetWorkspace = () => Promise.resolve(workspaceRecord as never);
let setTokenImpl: typeof realSetToken = (_db, workspaceId, mcpName, token) => {
  setCalls.push({ workspaceId, mcpName, token });
  return Promise.resolve();
};
let clearTokenImpl: typeof realClearToken = (_db, workspaceId, mcpName) => {
  clearCalls.push({ workspaceId, mcpName });
  return Promise.resolve();
};

mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => ({}) }));
mock.module('../web-poc/lib/db/queries/workspaces.ts', () => ({
  ...realWorkspaces,
  getWorkspace: (...args: Parameters<typeof realGetWorkspace>) => getWorkspaceImpl(...args),
}));
mock.module('../web-poc/lib/db/queries/mcp-tokens.ts', () => ({
  ...realMcpTokens,
  setToken: (...args: Parameters<typeof realSetToken>) => setTokenImpl(...args),
  clearToken: (...args: Parameters<typeof realClearToken>) => clearTokenImpl(...args),
}));
afterAll(() => {
  getWorkspaceImpl = realGetWorkspace;
  setTokenImpl = realSetToken;
  clearTokenImpl = realClearToken;
});

const { handleMcpTokenApi } = await import('./mcp-tokens-api.ts');

const user: GateUser = { id: 'u_1' } as GateUser;

const put = (workspaceId: string, mcpName: string, body: unknown) =>
  handleMcpTokenApi(
    new Request('https://poc.cedarpad.com/x', { method: 'PUT', body: JSON.stringify(body) }),
    {} as never,
    user,
    workspaceId,
    mcpName,
  );
const del = (workspaceId: string, mcpName: string) =>
  handleMcpTokenApi(new Request('https://poc.cedarpad.com/x', { method: 'DELETE' }), {} as never, user, workspaceId, mcpName);

beforeEach(() => {
  workspaceRecord = null;
  setCalls = [];
  clearCalls = [];
});

describe('handleMcpTokenApi: connect (PUT) — OWNER consent, edge custody', () => {
  test('the owner connects a token (default included — via its seeded row, no bypass)', async () => {
    workspaceRecord = { id: 'default', ownerUserId: 'u_1' };
    const res = await put('default', 'ledgerbot', { token: 'tok_abc' });
    expect(res.status).toBe(204);
    expect(setCalls).toEqual([{ workspaceId: 'default', mcpName: 'ledgerbot', token: 'tok_abc' }]);
  });

  test('a MEMBER is 403 — token consent is workspace admin, not use (#181)', async () => {
    workspaceRecord = { id: 'ws_1', ownerUserId: 'someone_else' };
    const res = await put('ws_1', 'ledgerbot', { token: 'tok_abc' });
    expect(res.status).toBe(403);
    expect(setCalls).toEqual([]);
  });

  test('an invisible/unknown workspace (default without its seed included) is 404 — no write attempted', async () => {
    workspaceRecord = null;
    expect((await put('ws_someone_elses', 'ledgerbot', { token: 'tok_abc' })).status).toBe(404);
    expect((await put('default', 'ledgerbot', { token: 'tok_abc' })).status).toBe(404);
    expect(setCalls).toEqual([]);
  });

  test('an empty/missing token is a 400 — no write attempted', async () => {
    workspaceRecord = { id: 'default', ownerUserId: 'u_1' };
    const res = await put('default', 'ledgerbot', { token: '' });
    expect(res.status).toBe(400);
    expect(setCalls).toEqual([]);
  });
});

describe('handleMcpTokenApi: disconnect (DELETE)', () => {
  test('the owner clears the token', async () => {
    workspaceRecord = { id: 'default', ownerUserId: 'u_1' };
    const res = await del('default', 'ledgerbot');
    expect(res.status).toBe(204);
    expect(clearCalls).toEqual([{ workspaceId: 'default', mcpName: 'ledgerbot' }]);
  });

  test('a member is 403, an invisible workspace 404 — no clear attempted', async () => {
    workspaceRecord = { id: 'ws_1', ownerUserId: 'someone_else' };
    expect((await del('ws_1', 'ledgerbot')).status).toBe(403);
    workspaceRecord = null;
    expect((await del('ws_someone_elses', 'ledgerbot')).status).toBe(404);
    expect(clearCalls).toEqual([]);
  });
});
