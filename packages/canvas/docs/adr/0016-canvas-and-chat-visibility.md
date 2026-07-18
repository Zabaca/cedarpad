# 0016 — Canvas and chat visibility: creator-private, derived at read time

Status: accepted (design, 2026-07-17). Extends the workspace trust model of ADR-0008
(one shared trusted runtime) with the first intra-workspace visibility boundary.

The workspace is being used as a single shared demo space that outside people are
invited into. Members need a personal corner: a **private canvas** (and private
standalone chats) that other members cannot see, publishable to the workspace when
ready. This is a *visibility* feature, not a security boundary — everything still
runs in the one shared container (ADR-0008), and enforcement lives at the edge.

## Why

- Invitees currently see every canvas and every Inbox conversation in the
  workspace. That makes the workspace unusable for anything half-finished or
  personal the moment a second person joins.
- Multi-workspace exists but is heavyweight (a workspace is a deployment,
  ADR-0008). For "my drafts inside our shared space", a per-canvas flag is the
  right size.

## Decision

**Model.** Two stored flags plus one derived rule:

- `canvases.visibility` — `workspace` (default) | `private` — and
  `canvases.created_by` (the creating user). A private canvas is visible and
  openable ONLY by its creator; everyone else gets the same 404 as a nonexistent
  canvas, on every surface (list, pad routes, canvas APIs, MCP).
- `conversations.visibility` — `shared` (default) | `private` — and
  `conversations.created_by` (the human initiator; distinct from `user_id`,
  which is the bridge's system user, and from `assigned_to`, which is advisory
  and reassignable).
- **Effective visibility is derived at read time**, never copied:

  ```
  hidden from U ⟺ (conv.visibility  = 'private'  AND U ≠ conv.created_by)
               OR (canvas.visibility = 'private' AND U ≠ canvas.created_by)
  ```

  The canvas contribution comes from a join on `conversations.canvas_id`; there
  is no per-conversation cache of it.

**Canvas privacy dominates.** Re-privatizing a canvas hides ALL its attached
chats — including other members' own chats on it, even from those chats'
creators — until the canvas is re-published. Chosen over "your chat stays, the
canvas pane blocks" for rule simplicity; the transcript is not deleted, only
hidden, and re-publishing restores it.

**Flips.** Creator-only, both directions (`private ⇄ workspace`). New canvases
and chats default to visible (privacy is opt-in). Legacy canvases with no
recorded creator — and the registry-row-less `default` canvas — are permanently
workspace-visible.

**Owner is manage-not-read.** The workspace owner (there is no "admin" role —
owner/member only) can see that a private canvas exists (name + creator) and can
force-publish or delete it — the offboarding escape hatch — but cannot open it
while private. Privacy is a promise to members; the owner keeps stewardship of
the workspace, not a master key to its contents.

**Share links still work on a private canvas.** Minting one is a deliberate act
by the creator; `private` governs default workspace visibility, not explicit
sharing (ADR-0015 links remain the sole guest door).

**MCP parity.** Every MCP session is bound to a user; the same rules apply with
the token's user as U.

## Consequences

- Canvas flips are atomic: one column on one row; every attached chat follows
  instantly with no fan-out update and no drift window.
- The edge is the enforcement point (it already gates every route and owns the
  Turso reads); the container/bridge stays visibility-unaware, consistent with
  ADR-0008's "one trusted runtime per workspace".
- `conversations.created_by` must be stamped at birth from the edge-attested
  initiator (the same header that drives auto-assignment) — attribution can no
  longer ride on `assigned_to`.
- A member can silently lose Inbox access to their own chat when someone else's
  canvas goes private. Deliberate (see dominance above); revisit if it bites.

## Considered and rejected

- **Copying visibility onto conversation rows** — fan-out updates on every
  canvas flip; any missed row (crash, race, late attach) drifts silently.
  Deriving via the join cannot disagree with the canvas.
- **Per-member sharing / ACLs** ("share this canvas with just Khoa") — private
  is a binary creator-only flag. ACLs are a different, much larger feature;
  share links already cover "show one thing to one person".
- **Private by default** — flips today's collaborative default and would make
  the demo workspace look empty to invitees.
- **Owner can read private canvases** — weakens the promise the feature exists
  to make; the owner escape hatch (force-publish/delete) covers stewardship.
- **Blocking re-privatization while others' chats are attached** — a confusing
  refusal state in exchange for avoiding an edge the dominance rule handles.
- **"Chat survives, canvas pane blocks" on re-privatization** — softer for the
  chat's creator but splits effective visibility into per-surface rules; the
  dominance rule keeps one predicate for every surface.
