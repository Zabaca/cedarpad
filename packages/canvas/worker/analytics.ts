// Usage events, sent from the edge to PostHog.
//
// The browser half (shell/src/analytics.ts) sees pageviews and the shell's own clicks, but
// the canvas runs in the pad iframe and ad blockers drop a share of browser events. The
// things that say whether cedarpad is USED — a chat sent, a canvas or workspace made, a
// component written, an MCP tool called, a share link opened — all cross this Worker, so
// they are counted here, where nothing can block them.
//
// THE NO-CONTENT RULE. An event names who and where, never what: a workspace id, a canvas
// id, a module or tool name, a source enum. Chat text, component source, data files and
// tokens never reach a property. `UsageProperties` is the whole vocabulary, and
// `captureBody` drops any key outside it at runtime as well, so a caller that widens the
// type with a cast still cannot leak.
//
// Fire-and-forget: `track` hands the send to `ctx.waitUntil` and returns. A PostHog outage,
// a bad key or a slow network never delays or fails the request it rode on.

/** Server-side capture endpoint. Direct, not the m.zabaca.com proxy: nothing blocks a Worker. */
export const POSTHOG_CAPTURE_URL = 'https://us.i.posthog.com/i/v0/e/';

export type UsageEventName =
  | 'chat_message_sent'
  | 'canvas_created'
  | 'workspace_created'
  | 'component_written'
  | 'mcp_tool_called'
  | 'guest_link_opened';

export interface UsageProperties {
  workspace_id?: string;
  canvas_id?: string;
  /** A component module or data file name — the name, never its contents. */
  module?: string;
  /** An MCP tool name. */
  tool?: string;
  /** Where a write came from. */
  source?: 'app' | 'mcp';
}

export interface UsageEvent {
  event: UsageEventName;
  /** The user id (matches the browser's `identify`), or `share:<linkId>` for a guest. */
  distinctId: string;
  properties?: UsageProperties;
  /** Guests get no PostHog person profile — they are a link, not somebody. */
  anonymous?: boolean;
}

const ALLOWED: ReadonlySet<string> = new Set(['workspace_id', 'canvas_id', 'module', 'tool', 'source']);

/** The JSON body for one capture. Pure; exported for tests. */
export function captureBody(apiKey: string, e: UsageEvent, now: Date): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.properties ?? {})) {
    if (ALLOWED.has(k) && typeof v === 'string' && v !== '') properties[k] = v;
  }
  properties.$lib = 'cedarpad-edge';
  if (e.anonymous) properties.$process_person_profile = false;
  return { api_key: apiKey, event: e.event, distinct_id: e.distinctId, properties, timestamp: now.toISOString() };
}

interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

/** Send one usage event in the background. A no-op without `POSTHOG_KEY` (preview, local dev). */
export function track(
  env: { POSTHOG_KEY?: string },
  ctx: WaitUntil,
  e: UsageEvent,
  send: typeof fetch = fetch,
): void {
  const key = env.POSTHOG_KEY;
  if (!key) return;
  try {
    const sent = send(POSTHOG_CAPTURE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(captureBody(key, e, new Date())),
    }).then(
      () => undefined,
      (err: unknown) => console.warn(`[analytics] ${e.event} not sent: ${err instanceof Error ? err.message : String(err)}`),
    );
    ctx.waitUntil(sent);
  } catch (err) {
    console.warn(`[analytics] ${e.event} not sent: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The usage event a member request through the container proxy amounts to, if any. Pure. */
export function proxiedRequestEvent(
  method: string,
  pathname: string,
  canvasId: string | null,
): { event: UsageEventName; properties: UsageProperties } | null {
  const canvas = canvasId ? { canvas_id: canvasId } : {};
  if (method === 'POST' && /^\/api\/chat\/[^/]+\/send$/.test(pathname)) {
    return { event: 'chat_message_sent', properties: canvas };
  }
  const data = /^\/api\/components\/data\/([^/]+)$/.exec(pathname);
  if (data && method === 'PUT') {
    return { event: 'component_written', properties: { ...canvas, module: decodeURIComponent(data[1] as string), source: 'app' } };
  }
  const component = /^\/api\/components\/([^/]+)$/.exec(pathname);
  if (component && (method === 'PUT' || method === 'PATCH') && !['promote', 'adopt', 'place'].includes(component[1] as string)) {
    return { event: 'component_written', properties: { ...canvas, module: decodeURIComponent(component[1] as string), source: 'app' } };
  }
  return null;
}

/** MCP tools that write a component or data file. */
export const MCP_WRITE_TOOLS: ReadonlySet<string> = new Set(['write_component', 'edit_component', 'write_data']);
