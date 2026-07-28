import { z } from 'zod';

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
 * Both operations are best-effort at the call site (`bridge.ts`: "an index failure never
 * fails the turn"), so an unreachable edge degrades exactly as a failed platform-data-layer
 * write does today: logged, turn continues.
 */

/** The edge route. Self-gating (bearer, below) rather than session-gated: the caller is a
 * container process, which has no Better Auth cookie. */
export const PLATFORM_RPC_PATH = '/api/platform-rpc';

/** The HMAC message. Key separation: the bearer is derived from BETTER_AUTH_SECRET rather
 * than being it, so this credential can never be replayed as anything else. */
const TOKEN_LABEL = 'platform-rpc/v1';

const b64url = (bytes: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

/**
 * The bearer both sides derive from the shared trust root — `HMAC-SHA256(BETTER_AUTH_SECRET,
 * 'platform-rpc/v1')`. Same pattern and same secret as the guest cookie
 * (`worker/guest-session.ts`): "same trust root as member sessions, no second secret to
 * rotate" — so this slice adds no new secret to sops, and therefore no deploy gate.
 */
const hmacKey = (secret: string, usages: KeyUsage[]) =>
  crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);

export async function platformRpcToken(secret: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, ['sign']), new TextEncoder().encode(TOKEN_LABEL));
  return b64url(sig);
}

/** Verify a presented bearer. Goes through `crypto.subtle.verify` rather than comparing
 * strings, so a wrong token cannot be walked out one character at a time by timing. */
export async function verifyPlatformRpcToken(secret: string, presented: string): Promise<boolean> {
  const padded = presented.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(presented.length / 4) * 4, '=');
  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', await hmacKey(secret, ['verify']), sig, new TextEncoder().encode(TOKEN_LABEL));
}

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

/** The whole request, discriminated by operation name — the complete surface. */
export const PlatformRpcRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('conversation.start'), input: ConversationStartInput }),
  z.object({ op: z.literal('notify'), input: NotifyInput }),
]);
export type PlatformRpcRequest = z.infer<typeof PlatformRpcRequest>;
