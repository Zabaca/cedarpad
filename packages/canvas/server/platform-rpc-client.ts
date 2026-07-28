import {
  type ConversationStartInput,
  type NotifyInput,
  PLATFORM_RPC_PATH,
  PlatformRpcRequest,
  platformRpcToken,
} from '../shared/platform-rpc.ts';

// The container half of the platform RPC (ADR-0018). The container originates exactly two
// writes into the platform data layer; this is the only way it makes them, and the surface is
// two named verbs — there is no query, exec, or table name to reach for.

/** The two operations, as the bridge calls them. Both resolve even when the edge is down. */
export interface PlatformRpc {
  conversationStart(input: ConversationStartInput): Promise<void>;
  notify(input: NotifyInput): Promise<void>;
}

export interface PlatformRpcConfig {
  /** The edge origin (PLATFORM_RPC_ORIGIN, injected by worker/container-env.ts). Unset outside
   * a container, which is what makes "no edge in front of me" an explicit state. */
  origin: string | undefined;
  /** The shared trust root the bearer is derived from (BETTER_AUTH_SECRET). */
  secret: string | undefined;
  /** Test seam. Just the call signature — `typeof fetch` would also demand Bun's `preconnect`. */
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * The client, or **null when unconfigured** — mirroring `webPushSender`. A bridge with no edge
 * origin (local dev: vite + bridge, no Worker) keeps using its own platform-data-layer client;
 * ADR-0018 slice #263 puts the edge into local dev, and slice #266 removes that client for good.
 */
export function platformRpc(config: PlatformRpcConfig): PlatformRpc | null {
  const origin = config.origin?.replace(/\/$/, '');
  const secret = config.secret;
  if (!origin || !secret) return null;
  const doFetch = config.fetchImpl ?? fetch;

  // Best-effort by contract (bridge.ts: "an index failure never fails the turn"). A dead edge
  // degrades exactly as a failed platform-data-layer write does today: logged, turn continues.
  const call = async (body: PlatformRpcRequest): Promise<void> => {
    try {
      const res = await doFetch(`${origin}${PLATFORM_RPC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await platformRpcToken(secret)}` },
        // Parse at the boundary on the way OUT too (CLAUDE.md §7), so a drifted call site
        // fails here rather than as a confusing 400 from the edge.
        body: JSON.stringify(PlatformRpcRequest.parse(body)),
      });
      if (!res.ok) console.error(`[platform-rpc] ${body.op} failed: ${res.status}`);
    } catch (err) {
      console.error(`[platform-rpc] ${body.op} failed:`, err);
    }
  };

  return {
    conversationStart: (input) => call({ op: 'conversation.start', input }),
    notify: (input) => call({ op: 'notify', input }),
  };
}
