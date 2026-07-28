# Canvas sync moves to tldraw sync, hosted in a Durable Object

Status: accepted (design). Extends [ADR-0007](./0007-workspace-platform-topology.md) (the Render
Pad) and follows the direction of [ADR-0018](./0018-platform-data-layer-on-d1.md) — state moves out
of the container and to the edge. Vocabulary: root [CONTEXT.md](../../CONTEXT.md).

The hand-rolled canvas sync (SSE full-state broadcast + `planReconcile` + a single
`canvas-state.json` blob) is replaced by **tldraw sync** (`@tldraw/sync` +
`@tldraw/sync-core`): one `TLSocketRoom` per canvas, hosted in a **Cloudflare Durable Object**,
room state in DO SQLite.

## Why

Canvas sync is naive and already hurting at ~300 shapes:

- **Full-state rebroadcast.** Every single-shape edit serializes the *entire* canvas and sends it
  to every client (`server/canvas-sessions.ts`). Cost is O(shapes × clients) per edit.
- **Whole-document client diff.** Each SSE frame triggers a full snapshot + diff (`src/sync.ts`).
- **Single-blob persistence.** The whole canvas rewrites to R2 roughly every second while editing
  (`server/canvas-persistence.ts`, `server/blob-store.ts`).
- **Per-shape last-writer-wins.** Concurrent edits to one shape clobber; text cannot merge
  (`src/store.ts` — an id-keyed `Map` plus an integer version).
- **The version counter is in-memory** and resets on restart, so clients re-sync from scratch.

tldraw sync is **not a CRDT** — it is server-authoritative with a git-like push/pull/rebase, which
tldraw chose deliberately because general-purpose CRDTs model canvas data poorly. Deltas, presence,
conflict merge, and reconnect/resume come from the protocol rather than from us.

## Decision

- **One `TLSocketRoom` per canvas, in a Durable Object.** Room uniqueness is load-bearing: exactly
  one room per canvas globally. The DO *is* that guarantee. Never host the same canvas twice.
- **The room moves to the edge; the container stops owning canvas state.** This continues
  ADR-0018's direction. The bridge keeps chat, the agent, and the build/dev surface.
- **The agent write path is an authenticated HTTP mutation endpoint on the DO**, with a zod
  contract at the boundary (guideline 7). Agents send intent (`{module, data, x, y, w, h}`); a
  typed builder inside the DO constructs valid `TLRecord`s. Agents never hand-craft records.
- **`CanvasStore` is the seam.** `src/store.ts` is a four-method interface
  (`getState`/`upsert`/`remove`/`clear`) and every agent tool in `src/canvas-ops.ts` depends only
  on it. Re-backing that interface onto the DO room leaves the whole tool layer untouched. This is
  the single most important structural fact about this migration.
- **Use `room.updateStore()`, accepting its 5.2.5 deprecation**, rather than `storage.transaction`.
  See "The write API" below.
- **Arrows stay in the tldraw document.** They are already both the visual and the relationship.
  Semantic and cross-canvas relationships stay as D1 rows — a room is per-canvas, so a cross-canvas
  link has nowhere to live as an arrow record, and "what references this mart?" must be a query,
  not a scan of every canvas document.
- **Referential integrity is ours.** Sync-core contains zero binding logic. If a shape with a bound
  arrow is deleted, the write path cleans up the binding itself.
- **Cut over all canvases at once.** No production users, no feature flag, no phased rollout. Old
  blobs are retained, so rollback is re-import, not restore.

## The write API: `updateStore` over `storage.transaction`

`room.updateStore()` is deprecated in 5.2.5 in favour of `storage.transaction`. We use the
deprecated call anyway, and this is deliberate.

`StoreUpdateContext.put()` calls `recordType.validate(record, recordBefore)` and throws on an
unknown `typeName`. The storage layer has no `validate` call at all — `txn.set` is a raw write.
Our zod contract validates the *agent's intent*; only tldraw can validate the *resulting record*.
Those are different assertions. Writing raw into storage means a malformed record persists and then
breaks every client that loads the room — a corruption bug, not a rejected request. We take the
deprecation warning over that failure mode, and revisit when tldraw ships a validating transaction.

## The schema must become React-free

Today `component` and `chat` are registered as **types-only** augmentations of
`TLGlobalShapePropsMap` (`src/ComponentShape.tsx:50`, `src/ChatShape.tsx:19`) — there are **no
runtime props validators anywhere**. The client never needed them; a DO does, because it validates
records server-side and cannot import React or touch a DOM.

So the shape props schema is extracted into React-free modules and both sides build an identical
`createTLSchema` from them. The spike hit exactly this and solved it the same way
(`spike/arm1-tldraw-sync/src/card-shape-schema.ts`). This is a prerequisite, not a detail.

## The R2 canvas-state reader is a real obstacle

`worker/mart-api.ts:99` `loadCanvasStateFromBucket` reads `canvas-state.json` straight off R2, and
`worker/index.ts:390` calls it on the guest mart path to resolve which marts a canvas references
(ADR-0017). Its comment states the premise plainly: *"Canvas state's source of truth is R2 (the
container is a cache that saves back to it) … it's what makes 'browsing never wakes the container'
hold for the guest path too."*

**tldraw sync invalidates that premise.** Once the room is authoritative, the R2 blob is stale, and
this reader would authorize guests against an out-of-date shape list — a security-relevant
staleness, not a cosmetic one. The DO answers the same question instead. Having the DO keep writing
a snapshot to R2 for cold readers was rejected: it recreates two representations of one fact, which
is the same objection that keeps arrows in the document.

## Spike evidence (2026-07-27, run wf_70bb7596-e1f)

The cross-arm **performance comparison failed** — arm 1 reimplemented the harness, absolute
thresholds were failed even by sync-free baselines, and the machine was never idle. Do not cite its
frame numbers.

What survived is still decisive: tldraw sync fan-out measured at **28.6 bytes per single-shape
edit, flat in document size** — the only fan-out measurement in the spike, and direct evidence it
does not reproduce this bug — plus **10/10 four-way convergence including a non-browser writer**.

**The spike did not prove the Durable Object.** Arm 1 hosted `TLSocketRoom` in a Bun process
(`spike/arm1-tldraw-sync/server/sync-server.ts`). The room is proven; DO hosting, hibernation, and
WebSocket-upgrade auth are not. Treat the DO as the unproven part of this change.

Branch `spike/arm1-tldraw-sync` is a useful reference — a working room, a custom shape with
React-free validators, and a non-browser writer. Branches `spike/arm2-reactflow-yjs` and
`spike/arm3-reactflow-codemix` edited root `package.json` workspaces and **must never be merged**.

## Consequences

- **`tldraw` must move 5.1.1 → 5.2.5**, and `@tldraw/tlschema` is pinned exact at 5.1.1 (for the
  `declare module` augmentation), so it moves in lockstep or the tree gets two copies and record
  types stop matching by identity.
- **Presence transport is replaced, rendering is not.** `src/presence.ts` already renders
  tldraw-native `instance_presence` records; only the bespoke heartbeat + SSE carriage goes away.
- **The guest path changes shape.** `src/ComponentGuestView.tsx` reads canvas state over the same
  SSE stream today; guests need a read-only room connection instead.
- **The canvas app has no production static build** — in the container it is still served by the
  vite dev server (`scripts/container-start.ts:100`). Not caused by this change, but a DO-hosted
  deploy meets it.
- **A new failure mode**: the DO is now on the canvas hot path. It was previously the container.

## Considered and rejected

- **`@codemix/graph`.** Not rejected on performance — it cost nothing per frame or on the wire. On
  **modelling**: a property gets exactly one schema, so `component.data` collapses to an opaque
  `z.any()` blob — unqueryable, unindexable — and because it is plain JSON rather than a `Y.Map`,
  two writers editing different keys of the same card clobber each other. That is a *coarser* merge
  than plain Yjs. Also alpha (0.3.0 / y-graph-storage 0.0.5), ids cannot be supplied, no per-vertex
  subscription, and `Edge.inV` throws on a dangling edge. This supersedes the earlier "alpha risk"
  framing — the objection is structural.
- **Incremental delta patching of the bespoke wire.** Smallest diff, and it does fix fan-out. Keeps
  last-writer-wins and leaves us maintaining a bespoke protocol forever.
- **Making the bridge a headless sync client** for agent writes. Rejected: it would *not* have
  bought binding integrity, because sync-core has no binding logic — that lives at Editor level and
  would need a server-side DOM. All cost, no benefit over an HTTP endpoint.
- **Keeping arrows out of the document**, in D1 rows. Withdrawn as too broad: it creates two
  representations of one fact, a cross-store cascade with no atomicity, and a round trip to draw a
  link.
