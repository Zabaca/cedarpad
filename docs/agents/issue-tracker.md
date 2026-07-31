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

**A parent spec ticket looks grabbable.** A spec filed as a ticket sits in
Backlog with no blockers, indistinguishable from work. Say so in its title or
first line, or a Worker will try to implement an entire spec in one session.

## The dependency-graph protocol — mandatory for any multi-ticket batch

A batch is not done until every edge is set **and verified**.

1. **Map the graph before creating anything.** List the tickets and, for each,
   which siblings must finish first. If nothing depends on anything, say so
   explicitly.
2. **Create prerequisites first**, so every id exists before anything references
   it.
3. **Pass `"dependsOn":[…]` on the dependent's own create call.** Never create
   now intending to wire edges later — later is where edges get lost.
4. **Check `dependsOnResults` on every create response.** Each ref returns
   `{"ok":true}` or an error. Repair a failure immediately with
   `raw POST "tickets/<full-id>/dependencies" '{"blockingTicketId":"<full-id>"}'`.
5. **Re-read the whole graph before reporting done** —
   `raw GET "tickets/<full-id>/dependencies"` per dependent — and confirm
   `blockedBy` matches step 1.

If you build the batch from a shell script, **write the identifier to stdout and
everything else to stderr.** A logging line captured into the variable holding an
identifier produces refs that fail as `dependency_not_found`, and the creates
that follow keep succeeding — so you end up with tickets, no edges, and a green
transcript.
