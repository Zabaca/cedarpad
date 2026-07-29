import {
  type ComponentHistoryInput,
  ComponentHistoryOutput,
  type ComponentReadInput,
  ComponentReadOutput,
  type ComponentVersion,
  type ComponentWriteInput,
  ComponentWriteOutput,
  type ConversationPrOpenedInput,
  type ConversationSettleInput,
  type ConversationStartInput,
  type NotifyInput,
  PLATFORM_RPC_PATH,
  PlatformRpcRequest,
  type SkillListInput,
  SkillListOutput,
  type SkillWriteInput,
  SkillWriteOutput,
  type TurnEndInput,
  TurnEndOutput,
  platformRpcToken,
} from '../shared/platform-rpc.ts';

// The container half of the platform RPC (ADR-0018). Since #266 the container holds NO
// platform-data-layer client at all, so this is the only way it writes — and the surface is
// a handful of named verbs; there is no query, exec, or table name to reach for.

/** The operations, as the bridge calls them. The chat-lifecycle ones all resolve even when
 *  the edge is down; the two Record verbs at the bottom deliberately do not. */
export interface PlatformRpc {
  conversationStart(input: ConversationStartInput): Promise<void>;
  conversationSettle(input: ConversationSettleInput): Promise<void>;
  /** "this run opened a PR" — the url the `open_pr` tool returned, so the Conversation
   *  carries its PR state and the Inbox can offer to merge it (CONTEXT.md "Open PR"). */
  conversationPrOpened(input: ConversationPrOpenedInput): Promise<void>;
  /** The one operation whose reply is read: the id is the handle `notify` then names. */
  turnEnd(input: TurnEndInput): Promise<TurnEndOutput | null>;
  notify(input: NotifyInput): Promise<void>;
  /** Persist a Component as a Record (ADR-0022). THROWS if the edge refuses or is
   *  unreachable — a Component write that cannot be persisted must fail the tool call so
   *  the agent can retry, rather than succeed to disk and evaporate on the next bad boot. */
  componentWrite(input: ComponentWriteInput): Promise<ComponentWriteOutput>;
  /** A Component's stored source, or null when the tier holds no Record. THROWS on a real
   *  store failure, so "absent" and "could not ask" stay distinguishable. */
  componentRead(input: ComponentReadInput): Promise<string | null>;
  /** A Component's version history, newest first — who changed it and when. THROWS like the
   *  other Record verbs: "no history" and "could not ask" must not look the same. */
  componentHistory(input: ComponentHistoryInput): Promise<ComponentVersion[]>;
  /** Persist a Workspace skill's files as Records (ADR-0022, #361). THROWS, for the same
   *  reason `componentWrite` does: an upload that cannot be persisted must fail its tool call. */
  skillWrite(input: SkillWriteInput): Promise<SkillWriteOutput>;
  /** The workspace's whole skill tree, for materialization before a turn. THROWS on a store
   *  failure — the caller decides whether to degrade, and it does (server/skills.ts). */
  skillList(input: SkillListInput): Promise<SkillListOutput['files']>;
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
  const call = async (body: PlatformRpcRequest): Promise<Response | null> => {
    try {
      const res = await doFetch(`${origin}${PLATFORM_RPC_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await platformRpcToken(secret)}` },
        // Parse at the boundary on the way OUT too (CLAUDE.md §7), so a drifted call site
        // fails here rather than as a confusing 400 from the edge.
        body: JSON.stringify(PlatformRpcRequest.parse(body)),
      });
      if (!res.ok) {
        console.error(`[platform-rpc] ${body.op} failed: ${res.status}`);
        return null;
      }
      return res;
    } catch (err) {
      console.error(`[platform-rpc] ${body.op} failed:`, err);
      return null;
    }
  };

  // The Record verbs' counterpart to `call` (ADR-0022): the same hop, but a failure PROPAGATES.
  // Component source is the thing the 2026-07-29 outage destroyed; "logged, turn continues" is
  // exactly the fail-open that turned a failed read into a destructive write.
  const callStrict = async (body: PlatformRpcRequest): Promise<unknown> => {
    const res = await doFetch(`${origin}${PLATFORM_RPC_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await platformRpcToken(secret)}` },
      body: JSON.stringify(PlatformRpcRequest.parse(body)),
    });
    if (!res.ok) throw new Error(`the workspace store refused this write (${body.op}: ${res.status})`);
    return await res.json();
  };

  return {
    conversationStart: async (input) => void (await call({ op: 'conversation.start', input })),
    conversationSettle: async (input) => void (await call({ op: 'conversation.settle', input })),
    conversationPrOpened: async (input) => void (await call({ op: 'conversation.prOpened', input })),
    turnEnd: async (input) => {
      const res = await call({ op: 'turn.end', input });
      if (!res) return null;
      // Parse on the way IN as well: a malformed reply is the same "the edge did not answer"
      // as an unreachable one, never a half-trusted id handed on to `notify`.
      const parsed = TurnEndOutput.safeParse(await res.json().catch(() => null));
      if (!parsed.success) console.error('[platform-rpc] turn.end returned an off-contract reply');
      return parsed.success ? parsed.data : null;
    },
    notify: (input) => call({ op: 'notify', input }).then(() => undefined),
    componentWrite: async (input) => ComponentWriteOutput.parse(await callStrict({ op: 'component.write', input })),
    componentRead: async (input) => ComponentReadOutput.parse(await callStrict({ op: 'component.read', input })).source,
    componentHistory: async (input) =>
      ComponentHistoryOutput.parse(await callStrict({ op: 'component.history', input })).versions,
    skillWrite: async (input) => SkillWriteOutput.parse(await callStrict({ op: 'skill.write', input })),
    skillList: async (input) => SkillListOutput.parse(await callStrict({ op: 'skill.list', input })).files,
  };
}
