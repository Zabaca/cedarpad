# A dev-agent run is a chat turn

Status: accepted (design). Amended by [ADR-0012](./0012-every-turn-ends-with-end-turn.md)
(`ask_human` → `end_turn`; the quiet-run contract is superseded — a quiet run now ends
`done`, mechanically gated). Amends [ADR-0010](./0010-dev-agent-is-a-role-not-a-container.md)
(its batch-exec half) and extends [ADR-0009](./0009-one-chat-system-live-bridge-view.md) —
"one chat system" now includes the *scheduled* run itself, not just the grill that follows it.
Vocabulary: root [CONTEXT.md](../../CONTEXT.md) ("Runners" + "Promote protocol" sections).

ADR-0010 made the dev-agent a role of the warm container but kept its batch as a **separate
execution path**: the edge `exec`'d a standalone script (`dev-agent-run.ts`) that ran its own
SDK query, then a code harness parsed candidates from the final text, applied the quality gate,
and called `askHuman`. Consequence: the run was **invisible until it ended** — no Inbox row, no
stream, no interrupt — and quiet or failed runs were indistinguishable from "nothing happened."
This ADR deletes that path: **a dev-agent run is a bridge chat turn, kicked headlessly.** It
appears in the Inbox the moment its session starts, streams live when opened, and can be
interrupted like any chat.

## Why

- **The whole point of the session index (#142) is live visibility** — but the index only
  covered bridge chat turns, and even those only after the first turn settled. The batch never
  touched the bridge at all, so "Run now" produced a 202 and then silence for minutes.
- **ADR-0009's own thesis finishes the argument**: a chat interface is a live view of the
  session's bridge; a run you can only see after the fact is the photograph the ADR forbids.
- **ADR-0010 made this cheap**: batch and bridge now share a container, so "run the explore
  through the bridge" is a route, not an infra lift.

## Decision

- **A session enters the Inbox when it starts.** The bridge surfaces the SDK init message's
  `session_id` as an event and upserts the Conversation row there (`waiting-on: none`) — for
  **every** session, not just dev-agent runs. One entry rule; "Needs me" is unaffected. A turn
  that errors mid-flight still leaves its row — a visible failed run is a feature (the missing
  Jobs status surface, for free).
- **The run is a token-armed turn on the warm bridge.** The edge Jobs/cron kick mints the
  git token and proxies `POST /api/dev-agent/run`; the bridge composes the explore prompt,
  picks a chatId, and dispatches the standard chat-turn machinery — deliberately not behind the
  425 subscribe-before-send guard (a headless kick has no subscriber by design; the Inbox
  attaches mid-stream later). The **token header is the complete definition of a dev-agent
  turn**: it drives the `'dev-agent'` Conversation tag, the prepared-worktree cwd (so the
  explore reads a fresh clone of `origin/main`, not the aging image snapshot), the `open_pr`
  tool, and the widened skill allowlist (`impeccable` + `improve-codebase-architecture`).
- **The harness dissolves; the agent runs its own workflow.** The prompt instructs: run the
  Explore phase, drop candidates matching `docs/adr/declined/`, call `ask_human` with the
  survivors — or end the turn without calling it (the quiet-run contract, now prompt-law).
  `parseCandidates`, the ```json contract, `filterCandidates`-as-code, and
  `runDevAgentWorkflow` retire. If quiet-run discipline degrades in practice, the fallback is
  a **tool-side filter inside `ask_human`** (reject candidate asks matching declined markers),
  not a resurrected harness.
- **One turn per chat, enforced at the wire.** `/send` returns **409 `turn_in_flight`** while
  the chat's turn runs (sibling to the 425); the client re-queues on 409 and marks `busy` on
  frames from a turn it didn't start. Stop-then-send stays the explicit way to talk over a run.
- **One dev-agent run at a time, with join semantics.** The single-flight moves from the edge
  (whose window collapsed to a proxy round-trip once the bridge answers 202 immediately) into
  the run route: a kick during a run returns the *running* run's `chatId` — "Run now" while
  running means "take me to the running one." `DEV_AGENT_ENABLED` still gates only the cron.
- **`exec` disappears as an execution mode.** `dev-agent-run.ts`, `DevAgentRunner`,
  `runDevAgent`, `devAgentBatchEnv`, `DEV_AGENT_WORKFLOW_CMD`, and the edge run seams retire.
  A future non-chat workload comes back as new design, not a kept-just-in-case path.

## Consequences

- **Issue #145 closes by dissolution**: the run is a chat turn, so `onTurnComplete` backs up
  its transcript to R2 like every turn — no special batch backup needed.
- **The quality gate is prompt-enforced, not code-enforced** — a sloppy model could promote
  junk or break the quiet-run contract. Accepted: the run is now watchable and interruptible
  (code was the only adult in the room precisely when nobody was watching), and the tool-side
  filter is the designed fallback.
- **The run's turn competes inside the bridge process** with interactive chats (same event
  loop, same SDK concurrency), not just the same container. Accepted at today's scale.
- **A first-sentence title**: the Conversation row titles from the first message, so the run
  prompt opens with its human-readable label ("Architecture explore: …") rather than growing a
  summary-override parameter nobody else needs yet.

## Considered and rejected

- **Row-at-start for dev-agent runs only** — two entry rules ("dev-agent sessions appear at
  start, product sessions after their first turn") that no domain expert would ask for.
- **A "running" row + snapshot transcript, batch path kept** — the minimal fix, but it builds
  exactly the photograph-of-a-different-environment ADR-0009 rejects, and invites replying to
  a session a concurrent standalone query still holds.
- **Keeping the harness bridge-side** (a special turn type that post-processes the final text
  through parse → gate → `askHuman`) — re-introduces the special-cased chat ADR-0009 spent
  itself dissolving, and reads oddly in the stream (the agent presents candidates, then a
  different actor files the item).
- **Interrupt-then-send / queue-until-settled for mid-run replies** — one stray Enter killing a
  ten-minute explore (or a "quick steer" landing eight minutes late) loses to an explicit 409 +
  re-queue with Stop as the human-in-the-loop override.
- **An edge-side run lock (KV/DO/TTL)** — the edge no longer knows when a run ends; only the
  bridge does. A TTL is a guess wearing a lock's clothes.
