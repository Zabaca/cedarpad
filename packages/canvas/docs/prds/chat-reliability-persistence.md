# PRD: Chat reliability + persistence (event-driven sync, JSONL-derived transcript)

Implements [ADR 0003](../decisions/0003-event-driven-persistence.md) (event-driven persistence) and
[ADR 0004](../decisions/0004-chat-transcript-from-jsonl.md) (chat transcript from the SDK session
JSONL). 0003 is the precondition for 0004: the transcript can only be derived from the session JSONL
if that JSONL actually persists across a recycle.

## Glossary

- **workspace** — the container/filesystem the agent runs in; the unit R2 keys are scoped by.
- **canvas** — one tldraw board (shapes + pages). Human-owned, persisted per mutation.
- **page** — a board within a canvas.
- **chat** — one chat card on the canvas (a `chat` shape). Human-owned in canvas state.
- **transcript** — the rendered message/tool-chip/todo history for a chat. Derived, not stored.
- **ChatMeta** — the server-owned per-chat record `{ sessionId, model, effort, forkNext }`. The
  single durable home for per-chat state; replaces browser `localStorage`.
- **session JSONL** — the SDK's `~/.claude/projects/<...>/<sessionId>.jsonl` conversation log. The
  authoritative transcript source.

## Problem Statement

Three failures, one root posture (the chat was browser-owned and the server stateless about it):

1. **A dropped stream looks identical to "still working."** The chat SSE was fire-and-forget with no
   server log and no reconnect signal, so a disconnect mid-turn silently lost every event in the gap.
2. **Transcript and tool-calls vanish after reload, and a fresh device shows nothing.** The rendered
   transcript and the per-chat config (`model`, `effort`, `forkNext`) plus the resume `sessionId`
   lived only in each browser's `localStorage`.
3. **On the deployed container the session JSONL is never saved back.** The sessions sync used
   `fs.watch({ recursive: true })`, which throws `EINVAL` on Linux; the watcher catches it and
   degrades to "sync disabled." The JSONL is restored on boot but never re-saved, so every idle-sleep
   or recycle restores a stale tar, wiping the transcript and breaking `resume` ("No conversation
   found").
4. **Persistence failures are silent for 3 of 4 artifacts.** Only canvas-state had health at
   `/api/status`; components, custom, and sessions failed to `console.error` only, invisibly.

## Solution

- **Event-driven persistence (ADR 0003).** Two triggers, `fs.watch` removed entirely:
  `store.onChange` commits canvas state (human-mutated, in-process); turn-completion commits sessions
  + components + custom as one batch (they only change as the effect of an agent turn). Every durable
  artifact registers as a `Persistable` flowing through one shared attempt → record-health → log
  wrapper, and all four report at `/api/status`.
- **Server-authoritative chat (ADR 0004).** The settled transcript is *derived* from the session
  JSONL by running its lines through `classify` in a replay mode (which emits the assistant text that
  the live path drops because it streamed as deltas). Per-chat durable state moves to a server-owned
  `ChatMeta` that replaces `localStorage`. A tab rehydrates by GETting the JSONL-derived transcript on
  connect; the live SSE covers only the in-flight turn; at `done` the client reconciles. This
  rehydrates identically on any tab/device and survives a recycle.

## Design / Visual Spec

Minimal. The reconnect indicator already exists: `ChatShape.tsx` renders `snap.subscribed ? status :
'reconnecting…'` (lines 120, 233), driven by the shared `EventSource` `onerror`/`onopen` flipping
`subscribed`. Verify it surfaces on a chat-stream drop; no new visual surface. Otherwise N/A — this is
a reliability/persistence build, not a UI build.

## User Stories

- As James, when I reload the browser, my chat transcript and tool-call chips are still there.
- As James, when I open a chat on a fresh device, I see the same history as on my main machine.
- As James, when I change a chat's model or effort, it survives a reload and matches across my open
  tabs.
- As James, when the container recycles (idle-sleep or deploy), I do not lose chat history and
  `resume` keeps continuing the same thread.
- As James, I can read `/api/status` and see every artifact's save health (canvas, components, custom,
  sessions), so a silent save failure is visible.
- As James, when the chat stream drops, the card shows a "reconnecting…" state instead of looking like
  it is still working.

## Implementation Decisions

### Persistence triggers (ADR 0003)

- Two triggers only: `store.onChange` (canvas) and turn-completion (`{kind:'done'}` → sessions +
  components + custom). No `fs.watch` anywhere; the `EINVAL`/`ENOSPC` failure class leaves the
  codebase.
- The turn-completion batch fires **after** the turn's event loop completes, once per turn. Sessions
  always re-save (a turn always wrote JSONL). Components/custom are gated on a **max-mtime dirty
  check** so a draw-only turn does not re-tar and re-upload unchanged libraries.
- Accepted residual: a hard-kill *mid-turn* can leave a `component` shape whose `.tsx` was not yet
  saved (the dangling-component-reference window). The common loss events (idle-sleep, recycle) are
  between turns, where the last turn-completion save already fired; a mid-turn crash self-heals on
  `resume` re-running the turn.

### Unified sink + health (ADR 0003)

- Every durable artifact is a `Persistable` (`name`, `serialize`, `save`, optional `guard`) flowing
  through one shared wrapper that records `pending` / `lastResult` (`ok` | `failed` | `skipped`) /
  `savedAt` / `lastError`. Only the wrapper and the health map are shared; each artifact keeps its own
  serialize (tar vs JSON) and guard (canvas keeps its degraded/empty-write guard).
- `healthSnapshot()` returns every registered artifact's health for `/api/status`.

### JSONL-as-truth transcript (ADR 0004)

- The settled transcript is projected from the session JSONL by `classify` in a **replay mode**: the
  same `delta` / `tool` / `todo` events as the live path, plus the assistant text block the live path
  drops (it streamed as deltas), and the user's own message text. Replay emits no
  `done` / `task` / `stream_event`.
- Runtime assumption verified at build time: the on-disk record is `{ type, message, ... }` whose
  `message` is the same shape `classify` reads, so it passes through `classify` directly with **no
  adapter**. The on-disk file holds only settled `assistant` / `user` records (plus CLI-metadata
  types `classify` already no-ops on); there are no `result` / `stream_event` / `system` lines.
  Subagent records (`isSidechain: true`) are filtered by the loader so they do not pollute the main
  transcript (no `parent_tool_use_id` is written on disk).

### ChatMeta (ADR 0004)

- `ChatMeta = { sessionId, model, effort, forkNext }` is a server-owned record, persisted via the
  ADR 0003 sink, and is the single home for durable per-chat state. It replaces `localStorage`.
- Config changes POST to the bridge → update `ChatMeta` → persist → broadcast a new `config` SSE
  frame so other tabs converge.
- At turn-start the server reads model / effort / fork / sessionId from `ChatMeta` (the `/send` body
  carries only `message` + `images`), resumes from `ChatMeta.sessionId`, and consumes `forkNext`
  (reads it then clears it to `false` — the one-shot semantic) server-side.
- The chat *card* (`chat` shape) stays human-owned in canvas state; `ChatMeta` is separate, so the
  server stamping `sessionId` never races the human dragging the card.

### Rehydration (ADR 0004)

- No persistent replay ring. On (re)connect the client GETs the JSONL-derived transcript for the
  chat (`{ config, events }`), clears its items, and replays the events; at `done` it reconciles
  against the just-settled JSONL. Pull-on-connect (per chat) rather than SSE push keeps the shared
  live stream for in-flight frames only.

## Testing Decisions

- Four pure cores are unit-tested with `bun:test` (RED→GREEN each slice): the JSONL→event projection
  + classify replay flag, the `ChatMeta` store, the `Persistable` sink + health, and the `maxMtimeMs`
  dirty-check. Disk-touching tests use `tmpdir()` + `${process.pid}` + `finally` cleanup; storage
  tests use the in-memory `memBackend`.
- Integration wiring (turn-completion hook, config route, transcript endpoint, client
  de-localStorage) gets local-dev acceptance, not new unit tests — each is a thin edit at a mapped
  seam.
- The container tar-to-R2 sessions save is a no-op locally; it gets deploy acceptance (after a deploy
  + a turn + recycle, transcript and `resume` survive). The read/projection/rehydration path is fully
  exercisable in local `bun run dev` because the JSONL sits on real disk at `~/.claude/projects`.

## Out of Scope

- Fork lineage across multiple session files (a forked chat spans files). Handle the common 1-file
  case; forks show from the latest segment until it matters.
- A DB backend (D1 / Turso / DO-SQLite) as the unified store — deferred per ADR 0004; the off-ramp is
  DO-SQLite if multi-canvas scale or queryable history arrives.
- The in-memory replay ring (rejected in ADR 0004 in favor of rehydrate-on-connect + reconcile).
- Write-enforcement keeping the agent out of the canvas core (an ADR 0002 follow-up).

## Further Notes

- The SDK's on-disk JSONL line format is undocumented (the ADR 0004 coupling). It was inspected at
  build time and confirmed `{ type, message, parentUuid, isSidechain, sessionId, ... }` with the
  `message` field matching the streaming shape; if a future SDK version churns the format, switch the
  read path to the SDK's own session-read API.
- The session-file path nesting (flat vs cwd-hash subdir) is covered by globbing `**/<sessionId>.jsonl`
  rather than assuming a layout.
