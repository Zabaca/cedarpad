import { describe, expect, test } from 'bun:test';

import { probeMcpTools } from './mcp-probe.ts';

// The edge-side initialize → tools/list dance. Streamable HTTP comes in two framings
// (plain JSON and SSE `data:` lines) and two statefulness flavors (with/without
// mcp-session-id) — the probe must handle all of them and always carry the bearer.

const TOOLS = { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'search', description: 'find things' }, { name: 'deploy' }] } };
const INIT = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } };

function stub(opts?: { session?: string; sse?: boolean; listStatus?: number }) {
  const calls: Array<{ method: string; auth: string | null; session: string | null }> = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? 'null') as { method: string };
    const h = new Headers(init?.headers);
    calls.push({ method: body.method, auth: h.get('authorization'), session: h.get('mcp-session-id') });
    if (body.method === 'initialize') {
      return new Response(JSON.stringify(INIT), { headers: opts?.session ? { 'mcp-session-id': opts.session } : {} });
    }
    if (opts?.listStatus) return new Response('unauthorized', { status: opts.listStatus });
    const text = opts?.sse ? `event: message\ndata: ${JSON.stringify(TOOLS)}\n\n` : JSON.stringify(TOOLS);
    return new Response(text);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('probeMcpTools', () => {
  test('plain-JSON stateless server: initialize then tools/list, bearer on both', async () => {
    const { fetchImpl, calls } = stub();
    const tools = await probeMcpTools('https://mcp.example/api', 'tok_x', fetchImpl);
    expect(tools).toEqual([{ name: 'search', description: 'find things' }, { name: 'deploy' }]);
    expect(calls.map((c) => c.method)).toEqual(['initialize', 'tools/list']);
    expect(calls.every((c) => c.auth === 'Bearer tok_x')).toBe(true);
    expect(calls[1]?.session).toBeNull();
  });

  test('SSE-framed stateful server: the issued session id rides tools/list', async () => {
    const { fetchImpl, calls } = stub({ session: 'sess_1', sse: true });
    const tools = await probeMcpTools('https://mcp.example/api', 'tok_x', fetchImpl);
    expect(tools.map((t) => t.name)).toEqual(['search', 'deploy']);
    expect(calls[1]?.session).toBe('sess_1');
  });

  test('an unauthorized tools/list throws (callers surface the honest error)', async () => {
    const { fetchImpl } = stub({ listStatus: 401 });
    await expect(probeMcpTools('https://mcp.example/api', 'bad', fetchImpl)).rejects.toThrow('tools/list: 401');
  });
});
