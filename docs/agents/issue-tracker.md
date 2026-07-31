# Issue Tracker

Issues for this repo are **Fredrin tickets** — the Fredrin desktop kanban this
project runs inside. They are NOT GitHub issues; do not use `gh issue` unless the
user explicitly says "GitHub issue".

## Operating it

The `fredrin` CLI is on `$PATH` in every Fredrin terminal. All output is JSON,
strictly noun-verb.

- **Create:** `fredrin tickets create '{"title":"…","description":"…"}'` — lands
  in **Backlog**.
- **List:** `fredrin tickets list` · **Read one:** `fredrin tickets get <id|identifier>`
- **Group:** `fredrin goals create '{"name":"…","description":"…"}'` then
  `fredrin goals assign <goalId> <ticket…>`. Always give a goal a description —
  it renders as the goal's plan on the board.
- **Anything the verbs don't cover:** `fredrin raw <METHOD> <path> [json]`.

Inside a ticket worktree there is also a per-ticket `./.fredrin/fredrin`
(`ticket get`, `ticket finish`, `ticket update-plan`, …). **Never print its
contents** — it carries a credential.

## A spec is a Goal. Tickets are work. — mandatory

**Never file a spec as a ticket.** The board is for work; a spec is the plan above
it. Fredrin has a container for exactly that: a Goal, whose `description` renders
as the Goal's plan. Fredrin's own vocabulary names the two stages —
`goals ask` describes itself as running during the "goalSeed→decompose interview".

So the pipeline maps onto them directly:

- **`/to-spec` → the Goal.** Write the durable decisions as an ADR in the repo,
  then create the Goal with the **spec as its description**. No tickets at this
  stage, and no "parent spec ticket".
- **`/to-tickets` → the slices**, created against the Goal that already exists and
  assigned as they go.

Those skills say "publish it to the issue tracker", which is GitHub-shaped — there,
an issue is the only container there is. Here it means: the Goal.

Two reasons this is not a style preference. A spec filed as a ticket sits in
Backlog with no blockers, **indistinguishable from work**, and a Worker will try to
implement the whole spec in one session — a title saying "do not implement" is a
patch over the wrong surface. And the spec has to survive *between* the two stages:
in the Goal it is on the board, so `/to-tickets` can run days later, from a
different session, and read the plan off it.

## Every multi-ticket batch belongs to a Goal — mandatory

**A batch is not done until it is grouped.** Any time you create more than one
ticket in a sitting — a spec decomposed into slices, a set of related fixes —
every one of them is assigned to a Goal. Ungrouped tickets scatter across the
board and nothing on screen says they belong to one piece of work.

1. The Goal exists first (see above), created **with a description**. A Goal
   without one is a bare label.
2. Create the tickets (see the dependency-graph protocol below).
3. `fredrin goals assign <goalId> <ticket…>` — identifiers are fine, and the whole
   batch can go in one call.
4. Re-read one ticket and confirm membership before reporting done.

Membership lives in the ticket's **`goals`** field, which is an **array** —
there is no `goal` field. Reading `.goal` returns null for a ticket that is
correctly assigned, which looks exactly like a failed assign.

## Workflow

- Tickets move Backlog → Running → Review → Completed via deterministic signals.
  Agents never move cards by hand.
- **"Ship" / "finish" means open a PR and move to Review — never merge.**
- PRs as a request surface: **off**. Don't treat inbound PRs as work items.

## Hard-won rules

Each of these has cost real work. They are not hypothetical.

**There is no close or archive verb.** The global CLI has none, and
`fredrin raw DELETE "tickets/<id>"` is a **hard delete** — the ticket is gone,
not archived, and `tickets get` returns `ticket_not_found` afterwards. Never use
it to "close" a ticket. To retire one, ask the human to archive it in the desktop
app. Deleting a ticket a Worker is running against does not stop the Worker; it
just makes that Worker's `ticket finish` fail.

**`PATCH` silently drops goal membership.** Patching a ticket's description or
title removes it from its goal, with no error and nothing in the response to
suggest it. After **any** `PATCH`, re-assign the goal and re-read the ticket to
confirm. Dependency edges do survive a patch; goal membership does not.

**Identifiers work for creating edges; full ids are required for editing them.**
`"dependsOn":["CRUX-ABC123"]` on a create resolves fine. But
`raw GET|POST|DELETE "tickets/<…>/dependencies"` needs the **full** id (the long
`cm…` string), and silently 404s on an identifier. Get full ids from
`fredrin tickets list`.

**Removing an edge needs a body, not a path segment:**
`raw DELETE "tickets/<full-id>/dependencies" '{"blockingTicketId":"<full-id>"}'`.

**List order is not creation order.** `tickets list` is ordered by board
position, not `createdAt` — a ticket created days earlier can appear above a
newer one. Never infer recency from list order; read `createdAt`. The listing is
also paginated (`nextCursor`), so a filtered scan can silently miss tickets.

**A parent spec ticket looks grabbable.** This is why a spec belongs in a Goal
(above) and not on the board: filed as a ticket it sits in Backlog with no
blockers, indistinguishable from work, and a Worker will try to implement the
whole spec in one session. If you inherit one that already exists, say so in its
title or first line — but do not create new ones.

## The dependency-graph protocol — mandatory for any multi-ticket batch

A batch is not done until every edge is set **and verified**.

1. **Map the graph before creating anything.** List the tickets and, for each,
   which siblings must finish first. If nothing depends on anything, say so
   explicitly.
2. **Create prerequisites first**, so every id exists before anything references
   it.
3. **Pass `"dependsOn":[…]` on the dependent's own create call.** Never create
   now intending to wire edges later — later is where edges get lost.
4. **Do not trust `dependsOnResults` — it is `null` on this API version.** It is
   documented as returning `{"ok":true}` per ref, and does not, so a create whose
   edges all landed and a create whose edges were all dropped look identical.
   Verify with the re-read in step 5 instead; that is what actually proves an edge.
   Repair a missing one with
   `raw POST "tickets/<full-id>/dependencies" '{"blockingTicketId":"<full-id>"}'`.
5. **Re-read the whole graph before reporting done** —
   `raw GET "tickets/<full-id>/dependencies"` per dependent — and confirm
   `blockedBy` matches step 1.

If you build the batch from a shell script, **write the identifier to stdout and
everything else to stderr.** A logging line captured into the variable holding an
identifier produces refs that fail as `dependency_not_found`, and the creates
that follow keep succeeding — so you end up with tickets, no edges, and a green
transcript.
