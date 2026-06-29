# 0004: Chat transcript is derived from the SDK session JSONL; per-chat state is a server-owned `ChatMeta`

Status: accepted (not yet built; depends on ADR 0003's turn-completion sessions persistence)

## Context

The chat UI transcript (the rendered messages, tool-call chips, todo/jobs panels) lived only in
each browser's `localStorage`, filled by a **fire-and-forget** SSE broadcast (`broadcastChat`) with
no server-side log and no `id:` / `Last-Event-ID`. Consequences: a disconnect during a turn lost
every event in the gap (nowhere to replay from), and a reload on a fresh tab or device showed
nothing. The per-chat config (`model`, `effort`, `forkNext`) and the resume `sessionId` also lived
only in `localStorage` and rode in each `/send` body, so the server was stateless about a chat.

Meanwhile the Claude Agent SDK **already** writes the full conversation to
`~/.claude/projects/<sessionId>.jsonl` (it needs it for `resume`), and ADR 0003 now persists that
JSONL across recycles. So the authoritative transcript already exists and is already durable; the
UI just was not using it. A second copy of the transcript (our own blob or a SQLite table keyed by
`chatId`) would have to be kept in sync with a JSONL we cannot stop the SDK writing, the exact
redundancy we want to avoid.

## Decision

- **The settled transcript is derived from the SDK session JSONL**, not stored in any store of
  ours. `classify.ts` (already source-agnostic for settled `assistant`/`user`/`result` messages)
  projects JSONL lines → `ChatEvent`s on (re)connect, with a replay-mode flag that emits the
  assistant text block (which the live path drops because it streamed as deltas). The live SSE
  covers only the in-flight turn.
- **The `chatId → sessionId` link cannot be derived** (the JSONL carries no `chatId`; the SDK does
  not know our canvas concepts), so it is persisted in a **server-owned per-chat record**,
  `ChatMeta = { sessionId, model, effort, forkNext }`. `ChatMeta` is the single home for durable
  per-chat state and **replaces `localStorage`**. Config changes POST to the bridge → update
  `ChatMeta` → persist (via ADR 0003's sink) → broadcast a new `config` SSE frame. At turn-start the
  server reads model/effort/fork/sessionId from `ChatMeta` (the `/send` body carries only
  `message` + `images`), resumes from `ChatMeta.sessionId`, and **clears `forkNext`** after
  consuming it.
- **Canvas state is untouched.** The chat *card* (`chat` shape) stays human-owned in canvas state;
  `ChatMeta` is a separate server-owned artifact. Keeping the pointer off the shape avoids a
  read-modify-write race between the human dragging the card and the server stamping `sessionId`,
  and keeps the chat shape human-only per the glossary.
- **No persistent replay ring.** On (re)connect the server serves the JSONL-derived transcript; at
  `done` the client reconciles against the JSONL (the just-settled turn snaps to full form). The
  only residual is a seconds-long cosmetic tail-glitch after a rare mid-turn reconnect. A thin
  reconnect indicator (driven by `EventSource` `onerror`/`onopen`) covers the "did not know it
  disconnected" complaint.

## Considered options

- **Persist our own `ChatEvent` log to R2** (tee the broadcast at `broadcastChat`). Our stable
  schema, byte-identical replay, but a second source of truth that can drift from the SDK JSONL.
  Rejected for the JSONL (one source, already persisted, more DRY).
- **A DB as the unified store (D1 / Turso / Litestream / DO-SQLite).** Rejected/deferred. The
  container disk is ephemeral, so SQLite is **not** self-persisting (it still needs DO-storage or
  R2 sync underneath); it cannot hold the agent's source files (the compiler reads them from disk);
  and storing chat in it re-introduces the second-copy redundancy alongside the unavoidable SDK
  JSONL. A DB unifies at most canvas, never files or the resume JSONL. **Off-ramp** if multi-canvas
  scale or queryable history arrives: **DO-SQLite** (native to the Sandbox's owning Durable Object,
  durable, co-located), owning canvas + chat-display only.
- **"Catch me up" resume prompt** (ask the agent to re-summarize after a drop). Rejected: lossy
  reconstruction, burns tokens, the agent may misremember its own tool outputs.
- **`sessionId` as a field on the chat shape.** Rejected: the server stamping it at turn-completion
  races the human dragging the card (lost update), and it violates the human-only chat shape.

## Consequences

- The transcript is server-authoritative and shared across tabs/devices; a fresh device rehydrates
  identically. `localStorage` chat state is removed (not demoted to a cache).
- The rehydration read path **couples to the SDK's on-disk JSONL line format** (undocumented, can
  shift between SDK versions). `classify` already couples to SDK *types*; this extends it to the
  file shape. If the format churns, switch to the SDK's own session-read API.
- **Fork lineage**: a forked chat spans multiple session files; the common (no-fork) case is one
  file. Reconstruct the 1-file case; forks show from the latest segment until it matters.
- An in-flight turn is not in the JSONL until it settles, so a mid-stream reconnect shows the
  in-flight answer only from the reconnect point until `done`.
