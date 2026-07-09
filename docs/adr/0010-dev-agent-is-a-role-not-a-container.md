# The dev-agent is a role, not a container

Status: accepted (design). Amends [ADR-0007](./0007-workspace-platform-topology.md) (the
dev-agent's place in the topology) and revises [ADR-0009](./0009-one-chat-system-live-bridge-view.md)
Tier 2 ("the dev-agent sandbox must run the interactive bridge"). The batch-exec half of this
ADR is itself revised by [ADR-0011](./0011-a-dev-agent-run-is-a-chat-turn.md) — the run is a
bridge chat turn now, not an `exec`. Vocabulary: root [CONTEXT.md](../../CONTEXT.md)
("Runners" section).

The dev-agent was built (ADR-0007, PRD #51) as a **separate sandbox instance** of the product
image with its own short (2m) sleep schedule. This ADR deletes that instance: **"dev-agent-ness"
is a property of the Conversation** (`workspaceId === 'dev-agent'`, a logical tag), **not of a
container**. Dev-agent Conversations resume on the **warm default workspace container** — the
path canvas chats already use reliably — and the one container-level capability (the `open_pr`
tool + its git worktree) moves from a per-container gate to a **per-conversation** gate driven
by an **edge-minted, per-send request-header token**.

## Why

The separate container was the source of every reliability problem the first live end-to-end
test surfaced, while the *feature* itself (trigger → Explore → `ask_human` → Inbox item) worked:

- **Perpetually cold.** Its own 2m sleep and ~zero traffic meant every interactive open paid a
  full cold boot of the whole product stack — the exact latency ADR-0009 accepted only as an
  occasional cost became the *every-time* cost.
- **The port-4510 wedge.** Running the batch `exec` and the interactive stack on the one
  instance wedged the vite port, cleared only by idle-sleep.
- **Batch pile-up.** Multiple "Run now" clicks stacked concurrent batch execs.
- **A persistent 425** ("chat connection not ready") on the dev-agent bridge.
- **Incidental complexity.** The cwd-drift class of bugs (#133) and the interactive-boot
  token mint existed *only because* the second container existed.

Meanwhile the warm product container already runs everything a dev-agent turn needs (the same
image, the same bridge). The isolation the separate instance bought ("never pins or reaps the
product container's sleep timer") protects an off-hours autonomous workload we do not run yet —
the dev-agent today is triggered on demand and immediately grilled interactively.

## Decision

- **The container is a runtime; the dev-agent is a Conversation tag.** `'dev-agent'` remains a
  distinct `workspaceId` (disjoint by construction from every product workspace id) that marks
  the Conversation, drives routing predicates, and files Inbox items — but it maps to no
  container. `coordsForWorkspace('dev-agent')` resolves to the default workspace's coords.
- **The batch run execs on the warm default container**, with its env built from that
  container's coords (`CANVAS_WORKSPACE='default'`). The trigger is **single-flighted**: cron +
  manual clicks collapse onto one in-flight run.
- **`open_pr` is armed per turn by an edge-minted token header.** On a dev-agent
  Conversation's `POST /send` (and only then), the edge chat proxy mints a ~1h repo-scoped
  GitHub App installation token and attaches it as `x-dev-agent-git-token` on the proxied
  request. The bridge reads it, threads it into that one turn, and never persists it. The App
  private key never leaves the edge (ADR-0008's boundary, unchanged). No token ⇒ no tool —
  product turns are untouched.
- **The dev-agent turn runs in a prepared worktree, never the live tree.** The baked image is
  not a git repo (`.git` is dockerignored), and `CANVAS_CWD` is the live vite-watched app tree —
  so committing it was always wrong. Each dev-agent chat gets a real `Zabaca/cedarpad` checkout
  (hub clone under `${CANVAS_CWD}/.dev-agent`, worktree off `origin/main`, branch keyed by the
  dev-agent tag + chatId, reused across turns with edits intact). The SDK turn runs with
  `cwd = worktree.path`; since SDK resume is cwd-scoped (#133), the session JSONL is *moved*
  into the worktree's project dir before the turn. `open_pr` commits that tree; the PR stays
  the durable artifact (ADR-0007).

## Consequences

- **The cold-boot, wedge, pile-up, and 425 all disappear structurally** — there is no cold
  instance to boot, no second stack to wedge, and the trigger is single-flighted.
- **A heavy batch Explore shares the user's container** and may briefly lag an open canvas.
  Accepted: the batch is on-demand today.
- **Known gap:** the batch does not back up its explore-session transcript to R2 at run end.
  While the container stays warm the interactive resume reads the JSONL in place (a win); a
  sleep between batch and first reply loses it. Follow-up: back up the explore session when
  the batch settles.
- **Escape hatch:** if autonomous, frequent, off-hours runs ever matter, re-isolate only the
  *batch exec* (a wake-run-sleep instance), not the interactive path. The cron scaffolding and
  the `DEV_AGENT_ENABLED` kill-switch (still `"false"`) remain in place for that.
- ADR-0009's Tier-2 consequence is revised: no dev-agent sandbox runs its own interactive
  bridge; the warm workspace container's bridge serves dev-agent Conversations like any other.

## Considered and rejected

- **Keep the separate container and fix its symptoms one by one** (pre-warm it, serialize the
  execs, debug the 425) — rejected: every fix papers over the same root cause (a second,
  cold, single-purpose instance) and the isolation it buys protects a workload we don't run.
- **Token in container env at boot** (the shipped #96 shape: mint on the dev-agent boot,
  inject via `setEnvVars`/`.env`) — rejected: it makes the *container* the unit of
  dev-agent-ness (the exact coupling this ADR removes), leaves a long-lived credential in
  container env, and mints even when no PR will ever be opened. Per-send header minting scopes
  the credential to the turn that might use it.
- **`git init` in `CANVAS_CWD`** to make `open_pr`'s commit work — rejected: pollutes the live
  vite-watched app tree on a shared container; edits and branches would fight the running app.
- **A derived `workspace-dev-agent` container** (treat `'dev-agent'` like a registry
  workspace) — rejected: it re-creates the perpetually-cold second instance under a different
  key, and that container would hold no bridge session.
