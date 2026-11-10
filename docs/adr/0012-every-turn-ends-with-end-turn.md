# Every turn ends with end_turn

Status: **superseded (2026-10-09)** — `end_turn` and its Stop-hook gate were removed with the Inbox, which was the only consumer of a turn's declared ending. Kept as history. Was: accepted (design). Amends [ADR-0011](./0011-a-dev-agent-run-is-a-chat-turn.md)
(supersedes its quiet-run contract and renames `ask_human`). Vocabulary: root
[CONTEXT.md](../../CONTEXT.md) ("Promote protocol").

A live dev-agent run ended its reply turn by asking the human a question **in prose** and then
stopping — no `ask_human`, so the Conversation never flipped to `waiting_on: human`, never hit
"Needs me", and looked identical to a finished run. The same ambiguity exists for every product
chat: a settled turn wrote nothing to its row, so "asked me something", "finished the work",
and "died quietly" were indistinguishable in the Inbox. This ADR makes the turn's ending part
of the turn's contract, mechanically enforced: **every turn must declare how it ends, via one
mandatory terminal tool — `end_turn` — and a Stop hook refuses an undeclared stop.**

## Why

- **The Inbox is only as truthful as turn endings are explicit.** The two-axis model
  (`status` × `waiting_on` + `unread`) already distinguishes "needs me" / "new activity" /
  "quiet" — but nothing obligated a turn to write any of it. The miss was structural, not a
  model failure: prose questions satisfied the prompt-law's letter ("ask the human") while
  bypassing the machinery.
- **ADR-0011 predicted this**: "if quiet-run discipline degrades in practice, the fallback is
  tool-side." This is that fallback, generalized from the dedup invariant to the end-turn
  invariant — enforcement moves from prompt to code exactly where prompt-law proved leaky.
- **The cost falls only on non-compliance.** A compliant turn pays one cheap in-turn tool call;
  only an undeclared stop pays the blocked-stop → feedback → retry loop.

## Decision

- **One terminal tool, two outcomes.** `end_turn` replaces `ask_human`:
  `{outcome: 'needs_human', summary, question}` promotes the Conversation (open /
  `waiting_on: human` / unread, preview = the question, notify fires) — the reply resumes the
  session, as before. `{outcome: 'done', summary}` records completion (`waiting_on: none`,
  unread, preview = the summary). There is deliberately **no agent-side close**: archiving
  stays a human verb in the Inbox UI.
- **A Stop hook gates every turn, all flavors.** The SDK `Stop` hook blocks an undeclared stop
  with instructions to call `end_turn`, at most **2 blocks per turn**, then lets the stop
  through and logs `turn ended ungated` — a guardrail, not a cage. User interrupts (abort) and
  error turns are exempt.
- **The mechanical settle is the fallback state.** Every settled turn marks the row
  `unread` + touches `last_activity` regardless of the gate, so an ungated ending still
  surfaces as activity in "All" — visibly unclassified rather than silently indistinguishable.
- **Both outcomes render in the thread**: chip + the question/summary as an agent bubble
  (legacy `ask_human` events in old transcripts keep rendering their question).
- **Prompt-law carries the rest**: "never end a turn with a question only in prose; say
  everything important in your message first — `summary` is for the Inbox list."

## Consequences

- Every conversation row now tells the truth at a glance: "Needs me" = agent explicitly blocked
  on the human; unread in "All" = something happened since you looked; preview = the latest
  question or result, not the stale first message.
- Every turn grows one tool call, and a confused agent can burn up to two extra model
  round-trips arguing with the gate. Accepted: the tax is bounded and falls on the failure mode.
- Old transcripts keep their `ask_human` chips (replay renders them); resumed old conversations
  speak `end_turn` from their next turn on.
- The `done` unread dot appears even for turns the human watched live. Accepted: a false dot
  costs one click; plumbing "was a client subscribed at settle" costs real complexity.

## Considered and rejected

- **Gate dev-agent turns only** — product chats have the same ambiguity (the Inbox can't tell
  "answered you" from "asked you something"), and two gating rules for one turn machinery is
  the kind of flavor-split ADR-0011 just spent itself dissolving.
- **Keep `ask_human` + add a sibling `mark_done`** — two terminal tools force the agent to
  choose between tools instead of setting a parameter; the gate becomes set-membership; the
  protocol is days old with no external users, so the consolidation was a mechanical rename.
- **Prompt-law alone (try harder)** — already failed live on run #1; the miss is structural
  (prose satisfies the words while bypassing the machinery).
- **Auto-classify at settle (does the last message end with "?")** — a heuristic judging the
  agent's output when we can simply require the agent to declare intent; false positives would
  promote conversations nobody is waiting on.
- **Unbounded blocking (a cage, not a guardrail)** — a confused agent looping against the gate
  burns tokens against `maxTurns` with no exit; N=2 + logged fallback keeps the failure visible
  and cheap.
