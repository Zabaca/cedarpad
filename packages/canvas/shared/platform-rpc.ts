import { z } from 'zod';

import { ComponentName } from './bridge-wire.ts';
import { parsePrUrl } from './pr-url.ts';
import { serviceToken, verifyServiceToken } from './service-token.ts';

/**
 * The platform RPC (ADR-0018) — the container's ONLY path back into the **platform data
 * layer**, and the single contract both ends parse against (CLAUDE.md §7).
 *
 * It is a **behavioural** surface, not a data-access layer: every reachable operation is a
 * named chat-lifecycle verb. The rejected alternative — `drizzle-orm/sqlite-proxy` against a
 * worker SQL endpoint — is *unrepresentable* here: there is no query, no statement, no table
 * name, and no filter anywhere in this file, so no caller can express one and no future edit
 * can add one without changing this contract in review.
 *
 * Every operation is best-effort at the call site (`bridge.ts`: "an index failure never
 * fails the turn"), so an unreachable edge degrades exactly as a failed platform-data-layer
 * write does today: logged, turn continues.
 *
 * #266 (the container drops its database) completed the surface: the verbs below are
 * every write a container turn originates. ADR-0018 named two of them — the two that had no
 * local-client fallback left after #261/#264 — but `conversation.settle` and `turn.end` are
 * the same kind of thing (chat-lifecycle, best-effort, no row returned to the caller), and
 * they were the last two call sites still holding a client. The surface is closed here: a
 * turn begins, may settle, and ends.
 */

/** The edge route. Self-gating (bearer, below) rather than session-gated: the caller is a
 * container process, which has no Better Auth cookie. */
export const PLATFORM_RPC_PATH = '/api/platform-rpc';

/** The HMAC message. Key separation: the bearer is derived from BETTER_AUTH_SECRET rather
 * than being it, so this credential can never be replayed as anything else. */
const TOKEN_LABEL = 'platform-rpc/v1';


/**
 * The bearer both sides derive from the shared trust root — `HMAC-SHA256(BETTER_AUTH_SECRET,
 * 'platform-rpc/v1')`. Same pattern and same secret as the guest cookie
 * (`worker/guest-session.ts`): "same trust root as member sessions, no second secret to
 * rotate" — so this slice adds no new secret to sops, and therefore no deploy gate.
 */
/**
 * The trust root LOCAL DEV falls back to when there is no `web-poc/.dev.vars` (a fresh
 * checkout or worktree). Both ends read it — the bridge for `PLATFORM_RPC_ORIGIN` pointing at
 * localhost, the generated dev wrangler config as a `vars` default that a real `.dev.vars`
 * overrides — so the hop works out of the box and cannot half-configure into a silent 401.
 *
 * Safe to keep in the repo because it is only ever reachable across localhost, and the bridge
 * refuses it for any non-localhost edge (server/bridge.ts). It is not a production credential
 * and must never become one.
 */
export const LOCAL_DEV_PLATFORM_SECRET = 'local-dev-platform-secret-not-for-production-use';

export const platformRpcToken = (secret: string): Promise<string> => serviceToken(secret, TOKEN_LABEL);

/** Verify a presented bearer. Constant-time by construction — see `shared/service-token.ts`. */
export const verifyPlatformRpcToken = (secret: string, presented: string): Promise<boolean> =>
  verifyServiceToken(secret, TOKEN_LABEL, presented);

/**
 * Operation 1 — "find or create the Conversation for this session". The fields are exactly
 * the identity and provenance of a chat turn; nothing here selects rows.
 */
export const ConversationStartInput = z.object({
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: z.enum(['chat', 'dev-agent']).optional(),
  /** The bridge chatId that owns the Conversation (its identity key). */
  ownerRef: z.string().min(1).optional(),
  canvasId: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  summary: z.string().optional(),
  /** The turn's human initiator (edge-stamped `x-inbox-assign`), claim-if-unassigned. */
  assignTo: z.string().min(1).optional(),
});
export type ConversationStartInput = z.infer<typeof ConversationStartInput>;

/** Just the id: the container needs a handle, never the row (the edge owns the row). */
export const ConversationStartOutput = z.object({ conversationId: z.string().min(1) });
export type ConversationStartOutput = z.infer<typeof ConversationStartOutput>;

/**
 * Operation 2 — "notify whoever is watching this Conversation". The caller names the
 * Conversation and the question; WHO gets woken and WHICH devices they hold are resolved
 * entirely at the edge, so the container never learns the subscriber list.
 */
export const NotifyInput = z.object({
  conversationId: z.string().min(1),
  question: z.string(),
});
export type NotifyInput = z.infer<typeof NotifyInput>;

/**
 * Operation 3 — "this turn settled". The finally-block backstop (`bridge.ts`): make sure the
 * chat's Conversation exists and mark it active, so a turn whose `end_turn` gate was bypassed
 * (ungated stop, error turn) still surfaces in the Inbox's "All". Same identity fields as
 * `conversation.start`, minus `assignTo` — a settle is the agent finishing, never a human act,
 * so it can never claim a row for anyone.
 */
export const ConversationSettleInput = ConversationStartInput.omit({ assignTo: true });
export type ConversationSettleInput = z.infer<typeof ConversationSettleInput>;

/**
 * Operation 4 — "this turn declared its ending" (ADR-0012 `end_turn`). One verb for both
 * endings so the container never has to name the row transition: `done` → nothing pending,
 * `needs_human` → promoted with the question as the preview. The container gets back only the
 * Conversation's id, which is exactly what it needs to ask for the `notify` ping — it still
 * never holds the row.
 */
export const TurnEndInput = ConversationStartInput.omit({ assignTo: true, canvasId: true, repo: true }).extend({
  summary: z.string(),
  outcome: z.enum(['done', 'needs_human']),
  /** Present iff `outcome: 'needs_human'` — the question the human is being asked. */
  question: z.string().optional(),
});
export type TurnEndInput = z.infer<typeof TurnEndInput>;

/** Just the id, as with `conversation.start`: a handle, never the row. */
export const TurnEndOutput = z.object({ conversationId: z.string().min(1) });
export type TurnEndOutput = z.infer<typeof TurnEndOutput>;

/**
 * Operation 5 — "this run opened a PR" (CONTEXT.md "Open PR"). The `open_pr` tool's result
 * is the one durable artifact a dev-agent run produces, and until now it was only ever
 * spoken into the transcript. Reporting it here is what gives the Conversation its PR state
 * — and therefore what makes the Inbox's Merge action appear. Same identity fields as a
 * settle (the container names the chat, never the row); the url is validated HERE so no
 * unreadable link can reach the row and, from there, an authenticated GitHub call.
 */
export const ConversationPrOpenedInput = ConversationSettleInput.extend({
  prUrl: z.string().refine((u) => parsePrUrl(u) !== null, 'not a GitHub pull-request url'),
});
export type ConversationPrOpenedInput = z.infer<typeof ConversationPrOpenedInput>;

/**
 * Operations 6 and 7 — the **Record** verbs (ADR-0022). Component source stops being a
 * directory the container tars into R2 and becomes rows the edge owns; this is how the
 * container gets it there. Note what these are NOT: there is no `record.put`, no table, no
 * filter — they are component-shaped, exactly like the chat verbs above are chat-shaped, so
 * the surface stays behavioural and cannot decay into a SQL tunnel.
 *
 * The name is validated HERE as well as at the store, so a traversing name is a 400 at the
 * boundary rather than something the edge has to be trusted to notice. `canvasId` is
 * required: this slice carries the OWN tier only, and the shared tier gets its own verb
 * rather than a nullable field nobody can see the meaning of.
 *
 * These two break the "best-effort" rule that governs every operation above them, and
 * deliberately: a Component write that cannot be persisted must FAIL the tool call so the
 * agent can retry. Today's disk write succeeds, reports success, and can evaporate on the
 * next bad boot — a write that fails loudly beats one that lies.
 */
export const ComponentWriteInput = z.object({
  workspaceId: z.string().min(1),
  canvasId: z.string().min(1),
  /** Attribution (`updated_by`), not authorization — the edge derives permission itself. */
  userId: z.string().min(1),
  name: ComponentName,
  source: z.string().refine((s) => s.trim().length > 0, 'source must be non-empty'),
});
export type ComponentWriteInput = z.infer<typeof ComponentWriteInput>;

/** The stored revision — the container logs it; it never holds the row. */
export const ComponentWriteOutput = z.object({ rev: z.number().int().positive() });
export type ComponentWriteOutput = z.infer<typeof ComponentWriteOutput>;

export const ComponentReadInput = z.object({
  workspaceId: z.string().min(1),
  canvasId: z.string().min(1),
  name: ComponentName,
});
export type ComponentReadInput = z.infer<typeof ComponentReadInput>;

/** `null` = no Record for that name in that tier. Absent is an ANSWER, not a failure —
 *  the caller must be able to fall through to the next tier without treating it as an error. */
export const ComponentReadOutput = z.object({ source: z.string().nullable() });
export type ComponentReadOutput = z.infer<typeof ComponentReadOutput>;

/** The whole request, discriminated by operation name — the complete surface. */
export const PlatformRpcRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('conversation.start'), input: ConversationStartInput }),
  z.object({ op: z.literal('conversation.settle'), input: ConversationSettleInput }),
  z.object({ op: z.literal('conversation.prOpened'), input: ConversationPrOpenedInput }),
  z.object({ op: z.literal('turn.end'), input: TurnEndInput }),
  z.object({ op: z.literal('notify'), input: NotifyInput }),
  z.object({ op: z.literal('component.write'), input: ComponentWriteInput }),
  z.object({ op: z.literal('component.read'), input: ComponentReadInput }),
]);
export type PlatformRpcRequest = z.infer<typeof PlatformRpcRequest>;
