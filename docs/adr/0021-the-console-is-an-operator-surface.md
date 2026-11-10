# The Console is an operator surface, not a Conversation

Status: **dropped (2026-10-09)** — the `pty-server` was removed in #454, when chat turns lost every shell and filesystem tool. Kept as history. Was: **proposed** (design, grill session 2026-07-29). Nothing built. Decision 6's runtime
was revised the same day after a measured spike — see Consequences. Vocabulary:
[canvas CONTEXT.md](../../packages/canvas/CONTEXT.md) (**Console**).

A **Console** is a Quake-style drop-down terminal (`Ctrl+\``) giving a Workspace **owner** a
real PTY into that workspace's container, running Claude Code with full capability. It is
deliberately **outside** the model that governs turns: no Inbox row, no `ChatMeta`, no
assignee, no `end_turn`. Two proven precedents feed it, an earlier Zabaca
sandbox POC for the transport, and the Fredrin agent environment for the
replay/resize discipline.

## Why

Every existing agent surface here is **turn-shaped**. [ADR-0009](./0009-one-chat-system-live-bridge-view.md)
makes a chat interface a live bridge view; [ADR-0012](./0012-every-turn-ends-with-end-turn.md)
refuses a turn that stops without declaring `end_turn`; a Conversation carries `assigned_to`
and `waiting_on`. That shape is right for collaborative work and wrong for operator work —
looking at the filesystem, checking what `.repos/` actually restored, running `git`, watching
a build. Today the only way to do any of that is to ask a chat turn to run it for you and
read the tool chip, which is a poor interface for something the runtime already has: a tty.

The mechanism is forced. The Sandbox SDK's built-in `Bun.Terminal` **drops SIGWINCH**, so
Claude's TUI never reflows on resize — a documented negative result from the ceo spike. Real
`node-pty` (a genuine `TIOCSWINSZ` ioctl) is the only option, which is why this ADR carries a
process-topology decision at all.

## Decision

1. **Not a Conversation.** The Console produces no Inbox row, no `ChatMeta`, no assignment,
   no `waiting_on`. ADR-0012's law is not weakened — it simply never applies, because a tty
   has no turns to end. Modelling it as a degenerate Conversation would have forced every
   filter, the promote protocol, and the assignment rules to special-case a row for which
   none of them mean anything.

2. **Owner-only — a hold on capability, not a containment claim.** State this plainly
   because the code says otherwise at first glance: a *member* **already** has an unsandboxed
   root shell. `server/agent.ts:693` disallows only `Write`/`Edit`/`NotebookEdit`, and
   canvas CONTEXT.md is explicit — *"Bash remains, so this steers the model rather than
   sandboxing it."* So owner-only buys **no** isolation a member could not already obtain by
   asking chat to run the command. It buys the *option* to tighten member capability later
   without having to un-ship a member-facing feature. Anyone tempted to "fix" the
   inconsistency by opening it to members should change member capability deliberately, not
   as a side effect. Guests are denied **by construction**: `worker/guest-gate.ts` is a
   default-deny path allowlist, so a new path is unreachable unless someone adds it.

3. **The gate must be written, not inherited.** `serveWorkspace` is reached only after a
   **membership** check — `worker/index.ts:840` calls `getWorkspace`, which is
   `ownerUserId = user OR isMember` (`workspaces.ts:81`), and pins the selection in a cookie.
   Owner-only therefore requires an explicit `ownerUserId === user.id` check on the Console
   path. This is the single easiest thing here to get wrong.

4. **bash, with `claude` auto-typed on a fresh spawn only.** Fredrin's pattern, for its
   stated reasons: the launch shows in scrollback and history, `Ctrl-C` returns to a prompt
   instead of killing the Console, and a reattach never re-runs it. Spawning `claude`
   directly (the ceo POC's choice) would mean the only route to a shell is asking claude's
   Bash tool for one — absurd when the feature *is* a terminal.

5. **Never a wake-lock.** Dismissing starts a short grace timer, then releases the socket, so
   the container's normal idle sleep proceeds. Pinning it would fight the explicit
   `keepAlive: false` hygiene in `sandbox-runtime.ts:24-33` and re-create the documented
   "won't sleep" pathology. Continuity across a sleep instead comes from a **pinned
   `--session-id`** plus `--resume`, riding the `~/.claude/projects` → R2 sync that
   `container-start.ts` already performs.

6. **A separate, supervised process — running `node`, not `bun`.** Not inside the bridge.
   `scripts/dev.ts:48-66` already articulates the pattern for the extension server —
   *"SUPERVISED, not part of the critical pair — if a bad handler fatally crashes it, restart
   just this process; the canvas (bridge + web) is untouched."* The bridge itself is spawned
   bare, with no `.exited` restart and (in-container) no `--watch`, so a native module
   segfaulting inside it is a **canvas outage** recoverable only via a 120s `waitForPort`
   timeout.

   The runtime is **forced, not preferred**. This ADR originally chose bun to keep the
   container to one runtime; a measured spike killed that. **node-pty does not work under
   bun at all** — see the spike result in Consequences. So the container runs bun (bridge,
   vite, extension server) *and* node (the PTY server), which is precisely what
   the earlier POC does, `node /app/pty-server.mjs` inside a bun-first image. That now
   reads as a forced move rather than an arbitrary one.

7. **One Console per workspace, with explicit takeover.** A second attach takes over and the
   previous client is *told* it was superseded — the ceo POC silently reassigns its single
   `s.ws`, leaving the first tab alive but permanently mute. One attach means one viewport
   drives `cols`/`rows`, so there is no geometry war.

8. **Fixed height, `translateY`-animated.** The panel's inner box sits at final size while a
   wrapper animates, so `ResizeObserver` never fires during the drop at all — the animation
   is GPU-composited and the resize question largely disappears rather than being managed.

9. **Excluded from the session-derived warehouse mart**, by the same pinned session id. Its
   transcripts *do* reach `sessions.tar` — that sync is exactly what makes `--resume` survive
   a sleep — but counting operator poking would degrade "cost per shipped PR" precisely as
   the Console gets more use. Total container spend is a different metric.

10. **The Console wakes the container, like the pad does.** It is global chrome and behaves
    like it, from any stage. This **deliberately rewrites** the invariant in
    `worker/index.ts:499` (*"browsing the shell never wakes (or bills) a container. Mounting
    the pad iframe is the only thing that does"*), which must be updated rather than left
    stale — a normative comment that is false is worse than no comment.

11. **The hotkey crosses the iframe by listener, not by protocol.** The Shell attaches its
    keydown listener to the same-origin pad iframe's `contentDocument`. A keydown inside the
    iframe never reaches the Shell's document (the same swallowing already documented for
    pointer events at `Shell.tsx:541`), and `Shell.tsx:20-25` deliberately keeps the boundary
    free of a message protocol — the dock gesture is *"the ONE postMessage"*. This keeps it
    at one. The panel renders in the Shell, since the pad remounts on every canvas switch.

## Consequences

- **MEASURED: node-pty is completely non-functional under bun.** Spiked 2026-07-29, before
  any implementation. Same script, same `node_modules`, only the runtime varied:

  | | node | bun |
  |---|---|---|
  | darwin-arm64 (bun 1.3.5, node 24.12) | pass 3/3 | fail 3/3 |
  | `cloudflare/sandbox:0.12.1` linux-amd64 (bun 1.3.12, node 22.22.3) | pass | fail |

  Failure signature is identical everywhere: the PTY spawns and an fd is allocated, but
  **zero bytes ever flow**, writes silently no-op, and `resize()` throws `ioctl(2) failed,
  EBADF`. Not a resize bug — the PTY is dead end to end, so the fd is evidently never wired
  up (bun's `net.Socket`/`tty.ReadStream` fd adoption, not the ioctl). Reproduced across two
  bun versions and two platforms, so it is neither version- nor platform-specific. Under
  node it passes everywhere: `stty size` goes 24 80 → 40 120 and a `trap ... WINCH` fires.
  **Do not retry bun without re-running this spike first.**
- **The image gains a C++ toolchain — confirmed, not assumed.** node-pty 1.1.0 ships
  prebuilds for `darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64` — **no linux at
  all** — and the base image has no `python3`, `make`, or `g++`. With those three installed,
  `npm install node-pty` builds cleanly via node-gyp and emits `build/Release/pty.node`
  (linux needs no `spawn-helper`; that is a macOS artifact). Cacheable layer, but it adds to
  pull size, which cold boots pay.
- **Install with `npm`, not `bun`.** `bun add node-pty` produces a broken install even where
  a prebuild exists: no `build/Release`, and the prebuild's `spawn-helper` lands **without
  its execute bit**, which surfaces as a misleading `posix_spawnp failed` at spawn time.
  Node fails identically against that tree, so this is bun's *install* rather than its
  *runtime* — a separate defect from the one above, and one that would otherwise burn an
  afternoon looking like a bun/node-pty incompatibility.
- **Replay hygiene is load-bearing, not optional.** Because (5) closes the socket, reopens
  are routine, and each one replays scrollback. Fredrin's **fit-before-replay** and
  **`inputReady` gate** are required — without the latter, replayed device queries (OSC 11,
  `\x1b[6n`) are re-answered by xterm and echo as garbage at the prompt on every reopen. The
  earlier POC writes its buffer raw and has neither.
- **Fredrin's resize machinery is deliberately NOT ported, and should stay unported.**
  Converge-on-ack, the `ptyCols` echo, and the pre-registration queue exist because its
  transport is lossy pub/sub plus a polled DB row; ours is a direct ordered WebSocket, so if
  the socket is open the resize arrived. Likewise its 150ms scrollback-protecting debounce
  answers `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`, which we do not set. Recording this so
  nobody ports them later as "the proven approach" — they solve problems this design does
  not have.
- **Two things from the POCs must not be inherited**: the hardcoded `cols: 80, rows: 24`
  spawn geometry (pass the client's, or Claude draws its first frames at the wrong width),
  and the silent single-`s.ws` reassignment on reattach (see decision 7).
- **A dismissed-but-not-released Console resembles a known open bug** — *"a stale idle tab's
  vite HMR websocket re-wakes the container after teardown."* The grace timer in (5) is what
  keeps the Console from being a second instance of it; whether a WebSocket through the
  preview proxy pins the container the way an SSE forward does is **unverified** and worth
  settling in the same spike.

## Out of scope, noted here because it surfaced during this design

`server/agent.ts:693` branches `disallowedTools` on turn *kind* only, and canvas CONTEXT.md
records that *"guest turns are plain chat turns"* — so a `guestChat` share link appears to
grant Bash + `bypassPermissions` in the container, where `writeEnvFile` places R2 credentials
and `CLAUDE_CODE_OAUTH_TOKEN` in `.env`. Pre-existing and unrelated to the Console; filed
separately rather than folded in here.
