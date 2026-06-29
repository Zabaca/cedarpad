# 0003: Event-driven persistence: two triggers, no `fs.watch`, one sink + health

Status: accepted (supersedes the `fs.watch`-based sync of ADR 0001 and ADR 0002's residual
recursive **sessions** watcher; the `onChange` canvas-state save and the `components.tar` /
`custom.tar` content from ADR 0002 stand, only their *trigger* and *observability* change)

## Context

ADR 0002 fixed the components overlay by flattening it to a single dir so its watcher could
drop `recursive: true`. But the **sessions** sync (`~/.claude/projects`, the SDK's conversation
JSONL) was left on `fs.watch({ recursive: true })`, which throws `EINVAL` on Linux. The watcher
catches it and degrades to "sync disabled." So on the deployed container the session JSONL is
*restored* on boot but **never saved back**: every idle-sleep or recycle restores a stale tar,
wiping the transcript and breaking `resume` ("No conversation found"). This is the literal cause
of the human's "messages missing even after reload" on the deployed instance.

Two deeper problems sat under it:

- **The triggers were heterogeneous and partly broken.** Canvas via `store.onChange` (works),
  components/custom via non-recursive `fs.watch` (works), sessions via recursive `fs.watch`
  (broken). `fs.watch` is the component that has actually failed us, and it can also die on
  `ENOSPC` (inotify limits) for the working cases.
- **Only canvas-state had health.** Its `saveHealth` (`pending`, `savedVersion`, `lastError`) is
  surfaced at `/api/status` and is what made the original silent canvas-save bug findable. The
  other three artifacts failed to `console.error` only, invisible. That is the silent-failure
  class, still live for three of four artifacts.

## Decision

**Two triggers, and `fs.watch` removed entirely.** The canvas store is the only thing the human
mutates directly, so it commits on its own mutation event. Everything else changes only as the
effect of an agent turn, so it commits when the turn ends.

| Trigger | Commits | Reliable because |
|---|---|---|
| `store.onChange` | canvas state | in-process, already works everywhere (unchanged) |
| turn-completion (`{kind:'done'}`) | sessions + components + custom, as one batch | in-process event, no filesystem watching, platform-independent |

- File artifacts (components, custom) get a **max-mtime dirty-check** so a draw-only turn does not
  re-tar and re-upload unchanged libraries. Sessions skip the check (a turn always wrote JSONL).
- **One sink + health.** Every durable artifact registers as a `Persistable` (name, serialize,
  save, optional guard) flowing through one shared debounce → attempt → record-health → log
  wrapper, and **all four report at `/api/status`**. Canvas keeps its degraded/empty-write guard;
  the file artifacts keep their tar serialize. Only the wrapper and the health map are shared, not
  the serialize or the guard.

## Considered options

- **Per-subdir non-recursive watches for sessions** (watch each project dir, add watches as new
  dirs appear). Rejected: dynamic watch bookkeeping for zero benefit over a completion hook.
- **`setInterval` poll-and-save.** Rejected: a blind timer unrelated to actual turns; wastes
  writes when idle, lags when busy.
- **A watcher library (chokidar).** Rejected: a dependency to replace one `fs.watch` call.
- **Move only sessions to turn-completion, keep the working component/custom watches.** Rejected
  for uniformity: one trigger model with no `fs.watch` anywhere removes the `EINVAL`/`ENOSPC`
  failure class from the codebase entirely.

## Consequences

- `fs.watch`, `EINVAL`, and inotify limits are gone. Persistence is uniformly event-driven: no
  polling, no watching.
- **Dangling-component-reference window.** Canvas-state persists per-mutation (~1s) but a component
  file persists at turn-end, so a hard-kill *mid-turn* can leave a `component` shape whose `.tsx`
  was not yet saved (renders an error on restart). Accepted: the common loss events (idle-sleep,
  deploy-recycle) are between turns, where every turn-completion save has already fired; a mid-turn
  hard crash is rare and self-heals on `resume` re-running the turn. Recycle is a hard-kill with no
  flush anyway, so a shutdown-flush would not narrow this.
- Background work that outlives a turn (a spawned Bash writing a file after `done`) is caught by the
  next turn's save.
- **`resume` is now correct on the deployed container** (sessions actually persist), which is the
  precondition for ADR 0004's JSONL-as-truth chat transcript.
