// Edge-side MCP tool probe (per-chat MCP selection): the chat UI needs a server's tool
// list to render checkboxes, and only the edge may hold the bearer token — so the edge does
// the initialize → tools/list dance and returns names + descriptions. Streamable-HTTP only
// (the registry is HTTP-only); handles both plain-JSON and SSE-framed responses.

type JsonRpcResponse = { result?: unknown; error?: { code?: number; message?: string } };

/** Parse a streamable-HTTP response body: plain JSON, or the last `data:` line of an SSE frame. */
function parseRpcBody(text: string): JsonRpcResponse | null {
  const t = text.trim();
  if (t.startsWith('{')) {
    try {
      return JSON.parse(t) as JsonRpcResponse;
    } catch {
      return null;
    }
  }
  const dataLines = t.split('\n').filter((l) => l.startsWith('data:'));
  const last = dataLines[dataLines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last.slice(5).trim()) as JsonRpcResponse;
  } catch {
    return null;
  }
}

export type McpToolInfo = { name: string; description?: string };

/** List a remote MCP server's tools with a bearer token. Throws on unreachable/unauthorized —
 *  callers surface the honest error to the UI. */
export async function probeMcpTools(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<McpToolInfo[]> {
  const headers = (extra?: Record<string, string>) => ({
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${token}`,
    ...extra,
  });
  const init = await fetchImpl(url, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cedarpad', version: '1.0' } },
    }),
  });
  if (!init.ok) throw new Error(`initialize: ${init.status}`);
  // Stateful servers issue a session id to ride on subsequent calls; stateless ones don't.
  const session = init.headers.get('mcp-session-id');

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: headers(session ? { 'mcp-session-id': session } : undefined),
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  if (!res.ok) throw new Error(`tools/list: ${res.status}`);
  const rpc = parseRpcBody(await res.text());
  if (!rpc || rpc.error) throw new Error(`tools/list: ${rpc?.error?.message ?? 'unparseable response'}`);
  const tools = (rpc.result as { tools?: Array<{ name?: unknown; description?: unknown }> })?.tools;
  if (!Array.isArray(tools)) throw new Error('tools/list: no tools array');
  return tools
    .filter((t) => typeof t.name === 'string')
    .map((t) => ({ name: t.name as string, ...(typeof t.description === 'string' ? { description: t.description } : {}) }));
}
