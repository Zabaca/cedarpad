import { beforeEach, describe, expect, mock, test } from 'bun:test';

import * as realWorkspaces from '../web-poc/lib/db/queries/workspaces.ts';
import type { GateUser } from './auth-gate.ts';

// The owner-consent API (ADR-0013 train 2, #176): PUT/DELETE
// /api/workspaces/:workspaceId/mcp/:mcpName/token. Ownership mirrors worker/index.ts's
// `ownedCanvas` pattern — the legacy `default` workspace needs no registry row; any other id
// must be owned by the caller (getWorkspace returning null ⇒ 404, no write attempted).

let workspaceRecord: { id: string } | null = null;
let setCalls: Array<{ workspaceId: string; mcpName: string; token: string }> = [];
let clearCalls: Array<{ workspaceId: string; mcpName: string }> = [];

mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => ({}) }));
mock.module('../web-poc/lib/db/queries/workspaces.ts', () => ({
  ...realWorkspaces,
  getWorkspace: () => Promise.resolve(workspaceRecord),
}));
mock.module('../web-poc/lib/db/queries/mcp-tokens.ts', () => ({
  setToken: (_db: unknown, workspaceId: string, mcpName: string, token: string) => {
    setCalls.push({ workspaceId, mcpName, token });
    return Promise.resolve();
  },
  clearToken: (_db: unknown, workspaceId: string, mcpName: string) => {
    clearCalls.push({ workspaceId, mcpName });
    return Promise.resolve();
  },
}));

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

describe('handleMcpTokenApi: connect (PUT) — owner consent, edge custody', () => {
  test('the legacy `default` workspace needs no registry row — a token connects', async () => {
    const res = await put('default', 'ledgerbot', { token: 'tok_abc' });
    expect(res.status).toBe(204);
    expect(setCalls).toEqual([{ workspaceId: 'default', mcpName: 'ledgerbot', token: 'tok_abc' }]);
  });

  test('an owned non-default workspace connects', async () => {
    workspaceRecord = { id: 'ws_1' };
    const res = await put('ws_1', 'ledgerbot', { token: 'tok_abc' });
    expect(res.status).toBe(204);
    expect(setCalls).toEqual([{ workspaceId: 'ws_1', mcpName: 'ledgerbot', token: 'tok_abc' }]);
  });

  test('a non-owned (or unknown) workspace is 404 — no write attempted', async () => {
    workspaceRecord = null;
    const res = await put('ws_someone_elses', 'ledgerbot', { token: 'tok_abc' });
    expect(res.status).toBe(404);
    expect(setCalls).toEqual([]);
  });

  test('an empty/missing token is a 400 — no write attempted', async () => {
    const res = await put('default', 'ledgerbot', { token: '' });
    expect(res.status).toBe(400);
    expect(setCalls).toEqual([]);
  });
});

describe('handleMcpTokenApi: disconnect (DELETE)', () => {
  test('clears the token for an owned workspace', async () => {
    const res = await del('default', 'ledgerbot');
    expect(res.status).toBe(204);
    expect(clearCalls).toEqual([{ workspaceId: 'default', mcpName: 'ledgerbot' }]);
  });

  test('a non-owned workspace is 404 — no clear attempted', async () => {
    workspaceRecord = null;
    const res = await del('ws_someone_elses', 'ledgerbot');
    expect(res.status).toBe(404);
    expect(clearCalls).toEqual([]);
  });
});
