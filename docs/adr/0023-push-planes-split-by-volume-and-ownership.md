# Push planes split by volume and ownership, and multiplex within each split

Status: **partly superseded (2026-10-09)** — the workspace events hub and web push planes were removed with the Inbox; the canvas sync and chat streams remain. Kept as history. Was: **accepted** (grill session 2026-07-30, after the per-workspace events hub landed —
#383, PRs #385/#387). Vocabulary: root [CONTEXT.md](../../CONTEXT.md) — **Session**,
**Conversation**; canvas [CONTEXT.md](../../packages/canvas/CONTEXT.md).

Cedarpad pushes to the browser over more than one channel. That is deliberate and it is
bounded. **A new channel is justified only by a difference in message VOLUME or in who OWNS
the state.** Everything sharing a split shares one connection and is multiplexed by topic.
A new *feature* is never a reason for a new channel.

Concretely, two planes:

- **High-volume ephemeral streams get a direct path.** Turn output (tokens, tool calls) from
  the container; canvas document ops over tldraw sync.
- **Low-volume state-change notifications share one broker per durability tier.** The
  per-workspace events hub, at the edge.

## Why this needs saying

Three roles are easy to conflate: the **publisher** (whoever owns the write), the **broker**
(fan-out), and the **transport** (the pipe to the client). Standard practice — Phoenix
Channels, ActionCable, MQTT, Ably — is one connection per client multiplexed by topic, with
publishers kept separate from the broker. Nothing here disagrees with that. What differs is
that cedarpad has two constraints most systems do not, and they force *two* connections
rather than one:

**A compute tier that sleeps.** Most designs assume the publisher is reachable. The workspace
container is not — and the Inbox badge matters most exactly when it is asleep. Anything that
must survive the container sleeping cannot live on the container's plane.

**Streaming volume.** Turn output is per-token. Routing it through a pub/sub broker costs a
hop and broker CPU per token, for the same reason nobody pushes video through one. The tidier
architecture — one connection, everything through the hub — is practically worse.

## The rule, and how to apply it

> **The plane follows who owns the state, not what the state is about.**

The Inbox is the worked example, because it looks like a counterexample. It is *about* chats,
chats run in the container, and you can open a canvas from it — yet its badge belongs on the
edge plane. The reason is the layering the glossary already draws:

| Layer | Owned by | Lifetime | Plane |
| --- | --- | --- | --- |
| **Conversation** (Session + inbox state) | edge, D1 rows | durable | workspace events hub |
| **Session** (`sessionId` + transcript) | Claude Agent SDK | durable, R2 object | not pushed — fetched on resume |
| **turn** (one exchange) | container, while running | ephemeral | chat plane |

A Conversation outlives every turn in it. The row survives the container sleeping; the turn
does not survive its own completion. That is why `turn.end` is an **RPC call** and not an
event — the turn is telling the edge to update state the container does not own
([ADR-0018](./0018-platform-data-layer-on-d1.md): the container keeps no database client).

The Inbox pane proves the rule rather than breaking it: the list and badge come from
`/api/inbox` (edge, D1), while an opened conversation's `<ChatView>` speaks the chat plane,
proxied through the edge to the bridge. Same screen, two planes, two owners.

## Notifications are thin, and structurally so

The hub carries a topic and nothing else. It says "something in your inbox changed"; the
subscriber re-reads D1. It holds no count and no rows.

This is [ADR-0022](./0022-workspace-content-is-records-not-files.md)'s lesson applied to a
notifier: a second copy of the truth is a copy that can diverge, needs invalidation, and goes
stale in ways nobody notices. **A hub that holds nothing can only ever be late, never wrong.**

The wire contract is what keeps that true rather than aspirational —
`z.object({ topic: z.literal('inbox') }).strip()`, with a test asserting a count offered on
the notice is dropped. A count cannot be expressed on this wire even if someone later wants
it to be. Holding nothing is also what makes hibernation free: there is nothing to restore on
wake, because `ctx.getWebSockets()` **is** the subscriber list.

## Considered and rejected

**Route everything through the hub, for one client connection.** Architecturally tidier,
practically worse — see streaming volume above. Rejected.

**Put the badge on the chat plane.** The container's `chat-hub.ts` already multiplexes one SSE
stream per client, so adding inbox frames looks free. But the container sleeps, so the badge
would go dark on an idle workspace. Rejected on the sleep boundary.

**Put the badge on the sync plane.** `CanvasSyncRoom` is keyed per canvas; the Inbox spans
canvases, and the Shell that renders it holds no sync connection at all. It would also mean
forcing rows into TLRecords. Rejected on scope.

**Keep polling.** The watermark tick alone cuts ~93% of rows for a few lines and no new
infrastructure, so the hub had to justify itself on *latency* (sub-second vs up to 10s), not
cost. Kept as the safety net, not the mechanism.

## Consequences

**Push cost becomes proportional to write rate, which is unbounded.** Polling was bounded at
a fixed tick count however busy a workspace got. This is a worse *shape*, not merely a worse
number, and it is why the notice path is coalesced (leading-edge debounce, 500 ms) rather
than left to fan out per write. Any future consumer of this hub inherits that obligation.

**A recompute triggered by a notice is still `O(conversations + canvases)`.** Coalescing
bounds how often it runs, not what it costs. Pushing the count into SQL is the durable fix
and is not done.

**The lesson has been lost once already.** Live presence (#212) was a bespoke heartbeat with
a `POST /api/canvas/presence` endpoint and *throttled* `event: presence` SSE frames. #293
moved presence onto tldraw sync and deleted the bespoke transport — correctly — but the
throttle went with it, and the hub was built without one until a review caught it. **Transport-
specific safety machinery dies with its transport.** That is why the rule lives here and in
`CONTEXT.md` rather than only in a comment beside a socket.

**The hub is one topic today.** It is an inbox notifier that happens to be workspace-scoped.
Presence-adjacent state, "a Component changed, reload it", and cross-chat delivery are the
consumers it should absorb — *on this plane*, not as new `/api/*/events` endpoints. Three
planes is architecture; six streams per tab is a mess.
