import { z } from 'zod';

import { ComponentName, DataFileName, DataFileSource } from './bridge-wire.ts';
import { parsePrUrl } from './pr-url.ts';
import { SkillFilePath, SkillName, UploadSkillInput } from './skills-wire.ts';
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
 * Operations 6 to 15 — the **Record** verbs (ADR-0022). Component source stops being a
 * directory the container tars into R2 and becomes rows the edge owns; this is how the
 * container gets it there. Note what these are NOT: there is no `record.put`, no table, no
 * filter — they are component-shaped, exactly like the chat verbs above are chat-shaped, so
 * the surface stays behavioural and cannot decay into a SQL tunnel.
 *
 * The name is validated HERE as well as at the store, so a traversing name is a 400 at the
 * boundary rather than something the edge has to be trusted to notice.
 *
 * **`canvasId` is required even for a shared-tier operation, and that is the security
 * design.** The workspace shared library has no canvas of its own, so nulling the field
 * would leave the edge's ownership check — "is this canvas in this workspace?" — with
 * nothing to look up, and no check at all is what a check with nothing to check becomes.
 * Instead the caller always names the canvas it is acting FROM, the edge verifies that
 * canvas belongs to the named workspace exactly as it does for an own-tier write, and the
 * shared tier's null canvas key is minted at the EDGE. A workspace's shared library is
 * therefore reachable only by naming a canvas the registry places inside it — the container
 * never sends the null and never picks the tier's key.
 *
 * Be precise about what that buys, though: it makes the shared tier exactly as protected as
 * the own tier, and no more. Both are **consistency** checks — the bearer above is a constant
 * with no workspace identity in it, so neither can stop a caller that names a real, coherent
 * (workspace, canvas) pair it does not own. That is #374, and it is a property of the token,
 * not of these verbs.
 *
 * These verbs break the "best-effort" rule that governs every operation above them, and
 * deliberately: a Component write that cannot be persisted must FAIL the tool call so the
 * agent can retry. Today's disk write succeeds, reports success, and can evaporate on the
 * next bad boot — a write that fails loudly beats one that lies.
 */
/** Which of the workspace's two writable libraries an operation addresses. The platform
 *  tier is absent by construction: it is image code, never a Record, and never written. */
export const ComponentTier = z.enum(['own', 'shared']).default('own');
export type ComponentTier = z.infer<typeof ComponentTier>;

/**
 * The tier a listing REPORTS, which is one wider than the tier an operation can address:
 * `base` is the image-only platform library (ADR-0022 decision 8) — never written, never a
 * Record, but always visible. Callers use these labels for duplicate-avoidance, so a listing
 * without them is not a substitute for one with them (PRD #354 story 11).
 */
export const ComponentTierLabel = z.enum(['own', 'shared', 'base']);
export type ComponentTierLabel = z.infer<typeof ComponentTierLabel>;

/** One line of the component library: what it is called, what its leading comment says it
 *  does, and which tier the naming canvas RESOLVES it in. */
export const ComponentCatalogEntry = z.object({
  name: z.string().min(1),
  description: z.string(),
  tier: ComponentTierLabel,
});
export type ComponentCatalogEntry = z.infer<typeof ComponentCatalogEntry>;

export const ComponentWriteInput = z.object({
  workspaceId: z.string().min(1),
  /** The canvas the write is performed FROM — the entitlement proof, always a real canvas. */
  canvasId: z.string().min(1),
  tier: ComponentTier,
  /** Attribution (`updated_by`), not authorization — the edge derives permission itself.
   *  Nullable because "we do not know who" is a real state (a container with no configured
   *  identity), and recording a placeholder that no user query will ever match would be a
   *  history that LOOKS attributed and is not — worse than one that admits the gap. */
  userId: z.string().min(1).nullable(),
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
  tier: ComponentTier,
  name: ComponentName,
});
export type ComponentReadInput = z.infer<typeof ComponentReadInput>;

/**
 * The listing verb. It is deliberately NOT `component.read` with a wildcard: the question is
 * "what can this canvas place?", which spans all three tiers — the two writable ones the edge
 * holds as Records and the image-only PLATFORM tier it knows from the build-time manifest.
 * Only the edge can answer all three at once, and only the edge can answer any of them with
 * the container's filesystem gone.
 *
 * No `tier` field, unlike the read/write pair: a listing that let a caller pick one tier
 * would be a filter, and it would also throw away the PRECEDENCE that makes the answer
 * meaningful (own beats shared beats base — the tier a name resolves in is what the label
 * reports).
 */
export const ComponentListInput = z.object({
  workspaceId: z.string().min(1),
  /** The canvas asking — its own tier, plus the workspace library it can reach through it. */
  canvasId: z.string().min(1),
});
export type ComponentListInput = z.infer<typeof ComponentListInput>;

/** Every Component the canvas can see, name-ordered, each labelled with the tier it resolves
 *  in. An empty list is an ANSWER (a workspace with nothing but an empty platform tier). */
export const ComponentListOutput = z.object({ components: z.array(ComponentCatalogEntry) });
export type ComponentListOutput = z.infer<typeof ComponentListOutput>;

/**
 * Operations 9 and 10 — promote (own → shared) and adopt (shared → own). They name only the
 * canvas and the Component:
 * the tier is implicit in the verb, and the direction is what makes each one meaningful.
 * They are verbs rather than "write here, delete there" precisely because a promote must be
 * ONE change of tier — a lost half left placed instances resolving to a same-named platform
 * component and rendering the wrong card, with no error anywhere.
 */
export const ComponentTierMoveInput = z.object({
  workspaceId: z.string().min(1),
  canvasId: z.string().min(1),
  /** Attribution, as on a write — a promote is a write, and it records who made it. */
  userId: z.string().min(1).nullable(),
  name: ComponentName,
});
export type ComponentTierMoveInput = z.infer<typeof ComponentTierMoveInput>;

/** `null` = no Record for that name in that tier. Absent is an ANSWER, not a failure —
 *  the caller must be able to fall through to the next tier without treating it as an error. */
export const ComponentReadOutput = z.object({ source: z.string().nullable() });
export type ComponentReadOutput = z.infer<typeof ComponentReadOutput>;

/**
 * Operation 8 — "what has happened to this Component" (ADR-0022 decision 4). Before Records
 * nothing in this product recorded who changed a Component or when, which is why the
 * 2026-07-29 loss could only be reconstructed from chat transcripts. This is the verb that
 * makes that question answerable without production credentials.
 *
 * Same shape as a read, because it IS a read — of the history rather than the current source.
 */
export const ComponentHistoryInput = ComponentReadInput;
export type ComponentHistoryInput = z.infer<typeof ComponentHistoryInput>;

/**
 * Newest first, and deliberately WITHOUT the source. "Who changed this and when" must not
 * cost every revision of the text; a restore (#362) names a version, so the source it needs
 * never has to make this trip. `createdAt` is coerced because JSON has no instant — the wire
 * carries an ISO string and both ends work with a Date.
 */
export const ComponentHistoryOutput = z.object({
  versions: z.array(
    z.object({
      version: z.number().int().positive(),
      createdAt: z.coerce.date(),
      createdBy: z.string().nullable(),
    }),
  ),
});
export type ComponentHistoryOutput = z.infer<typeof ComponentHistoryOutput>;

/** One entry of a Component's history. The store layer, the edge and the container all use
 *  THIS type rather than each declaring their own — one contract, no mirrors to drift. */
export type ComponentVersion = ComponentHistoryOutput['versions'][number];

/**
 * Operation 15 — "put this Component back the way it was at version N" (#362). The operation
 * that turns history into RECOVERY: the 2026-07-29 loss needed production credentials, a
 * database fork at a timestamp, and someone who knew the trick; this is the same act as an
 * ordinary write.
 *
 * (Numbered by WIRE ORDER — its position in the union below — not by topic, which is why a
 * Component verb lands after the data ones. Appending keeps an added verb from renumbering
 * every existing one, and two verbs sharing a number is not a conflict git would catch.)
 *
 * NOTE WHAT IS ABSENT: there is no `source`. The caller names a VERSION, and the read-then-put
 * happens entirely at the edge, which buys three things at once — the source stays on the side
 * that owns the rows; a restore cannot be forged by a container composing text of its own
 * invention; and a large Component is not shipped across the hop twice to end up where it
 * already was.
 *
 * It DOES carry `tier`, inherited from the write it is derived from, and honours it. The
 * shared library became a Record in #359, so its versions exist and `component.history` will
 * happily list them; a restore that silently only ever touched the own tier would leave the
 * shared tier with a history and no way to act on it — the exact gap this slice closes. As on
 * every other tiered verb, the container names the canvas it acts FROM and the EDGE mints the
 * shared tier's null key (`tierCanvas`); the container never sends the null.
 *
 * A restore is a FORWARD WRITE, never a rewind: it appends a further version rather than
 * truncating the ones after the chosen point, so the restore is itself undoable. A "recover"
 * that erased history would be a second way to lose work — the exact shape ADR-0022 removes.
 */
export const ComponentRestoreInput = ComponentWriteInput.omit({ source: true }).extend({
  /** The version to bring back, as `component.history` numbers them. */
  version: z.number().int().positive(),
});
export type ComponentRestoreInput = z.infer<typeof ComponentRestoreInput>;

/** The revision the restore CREATED — never the one it restored from, which the caller
 *  already named. A Component with no such version is a 404, not a rev of zero. */
export const ComponentRestoreOutput = z.object({ rev: z.number().int().positive() });
export type ComponentRestoreOutput = z.infer<typeof ComponentRestoreOutput>;

/**
 * Operations 11 and 12 — the **Workspace-skill** Record verbs (ADR-0022, #361). Same shape and
 * same reasons as the two above, with one difference that drives everything: a skill is a
 * DIRECTORY, so the key is two-level and the payload is a set of files. `upload_skill`'s
 * files-only wire contract is unchanged (PRD #354 story 23) — only where the files land moves.
 *
 * `skill.list` returns the workspace's WHOLE tree rather than one skill, and that is a domain
 * fact rather than a query: the agent SDK discovers skills by SCANNING `.claude/skills/`, so
 * "what is this workspace's skill tree?" is the only question materialization can ask. There is
 * still no filter, no table and no statement here.
 *
 * The path rules are enforced HERE (`SkillFilePath`, shared with the upload contract) as well
 * as at the store, because this string becomes a filesystem location in the container.
 */
export const SkillWriteInput = z.object({
  workspaceId: z.string().min(1),
  /** Attribution (`updated_by`), not authorization — the edge derives permission itself. */
  userId: z.string().min(1),
  skill: SkillName,
  files: UploadSkillInput.shape.files,
});
export type SkillWriteInput = z.infer<typeof SkillWriteInput>;

/** How many files the upload persisted — what `upload_skill` already reports to its caller. */
export const SkillWriteOutput = z.object({ files: z.number().int().nonnegative() });
export type SkillWriteOutput = z.infer<typeof SkillWriteOutput>;

export const SkillListInput = z.object({ workspaceId: z.string().min(1) });
export type SkillListInput = z.infer<typeof SkillListInput>;

/** The tree to render under `.claude/skills/`. An empty list is an ANSWER (a workspace with
 *  no skills), never a failure — the turn then sees platform skills only, as it always did. */
export const SkillListOutput = z.object({
  files: z.array(z.object({ skill: SkillName, path: SkillFilePath, content: z.string() })),
});
export type SkillListOutput = z.infer<typeof SkillListOutput>;

/**
 * Operations 13 and 14 — the **data-file** Record verbs (ADR-0022). A data file is the same
 * kind of thing as a Component (same table, `kind: 'data'`) but not the same verb: its name
 * carries an extension from a CLOSED set, and its content has a size cap, so widening
 * `component.write` with a nullable kind would have hidden two different validation rules
 * behind one shape. Named separately, the surface still reads as behaviour.
 *
 * Both the extension set and the cap are enforced HERE, in the contract, so an oversized or
 * executable-looking payload is a 400 at the boundary rather than something the edge has to
 * be trusted to notice. Like the Component verbs, these are NOT best-effort: a data write
 * that cannot be persisted must fail the tool call.
 */
export const DataWriteInput = z.object({
  workspaceId: z.string().min(1),
  canvasId: z.string().min(1),
  /** Attribution, nullable for the same reason `ComponentWriteInput.userId` is. */
  userId: z.string().min(1).nullable(),
  name: DataFileName,
  source: DataFileSource,
});
export type DataWriteInput = z.infer<typeof DataWriteInput>;

export const DataWriteOutput = z.object({ rev: z.number().int().positive() });
export type DataWriteOutput = z.infer<typeof DataWriteOutput>;

export const DataReadInput = z.object({
  workspaceId: z.string().min(1),
  canvasId: z.string().min(1),
  name: DataFileName,
});
export type DataReadInput = z.infer<typeof DataReadInput>;

/** `null` = no Record for that name in that tier — an ANSWER, not a failure. */
export const DataReadOutput = z.object({ source: z.string().nullable() });
export type DataReadOutput = z.infer<typeof DataReadOutput>;

/** The whole request, discriminated by operation name — the complete surface. */
export const PlatformRpcRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('conversation.start'), input: ConversationStartInput }),
  z.object({ op: z.literal('conversation.settle'), input: ConversationSettleInput }),
  z.object({ op: z.literal('conversation.prOpened'), input: ConversationPrOpenedInput }),
  z.object({ op: z.literal('turn.end'), input: TurnEndInput }),
  z.object({ op: z.literal('notify'), input: NotifyInput }),
  z.object({ op: z.literal('component.write'), input: ComponentWriteInput }),
  z.object({ op: z.literal('component.read'), input: ComponentReadInput }),
  z.object({ op: z.literal('component.history'), input: ComponentHistoryInput }),
  z.object({ op: z.literal('component.list'), input: ComponentListInput }),
  z.object({ op: z.literal('component.promote'), input: ComponentTierMoveInput }),
  z.object({ op: z.literal('component.adopt'), input: ComponentTierMoveInput }),
  z.object({ op: z.literal('skill.write'), input: SkillWriteInput }),
  z.object({ op: z.literal('skill.list'), input: SkillListInput }),
  z.object({ op: z.literal('data.write'), input: DataWriteInput }),
  z.object({ op: z.literal('data.read'), input: DataReadInput }),
  z.object({ op: z.literal('component.restore'), input: ComponentRestoreInput }),
]);
export type PlatformRpcRequest = z.infer<typeof PlatformRpcRequest>;
