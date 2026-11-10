---
name: worktree
description: How parallel-safe git-worktree development works in cedarpad — agent hygiene (stay in your worktree, don't write to the main checkout), the per-worktree local-D1 state dir, per-worktree dev/e2e ports, the E2E_MODE shim convention, and the Playwright authoring loop for the canvas app. Use when working as an agent inside a git worktree, running the dev server / tests / e2e from a worktree, authoring an e2e spec, adding an E2E_MODE shim, or debugging a "port already in use" / shared-DB collision.
user-invocable: true
---

# Worktree Development (cedarpad)

This repo follows CLAUDE.md §6 (worktree-safe by default) and ADR-0003
(parallel-via-worktrees). Multiple worktrees can run the canvas dev stack,
unit tests, and Playwright e2e at the same time without colliding on ports or
dev databases. Everything below lives under `packages/canvas` (the deployable
app).

---

## Agent hygiene — STAY IN YOUR WORKTREE

If you are an agent working in a git worktree (path under `.claude/worktrees/…`),
read this first. It is separate from the port/DB isolation below: that keeps
parallel *processes* from colliding; this keeps you from writing to the wrong
*checkout*.

**The failure mode:** an agent in a worktree runs a command like
`cd /path/to/cedarpad && …` (the *main* checkout) and edits
or commits there instead of in its worktree. It has happened repeatedly. It's
dangerous because the main checkout may hold the human's own uncommitted work, or
another agent's — a stray write there can block a `git pull`, collide, or get lost.
Nothing in the port/DB scaffolding prevents it, because it's a wrong-directory
problem, not a port problem.

**Why the pull toward main exists — and how to resist each:**

1. **Your environment says the project is at the main path.** The system context
   advertises the repo's *main* working directory (`/path/to/cedarpad`).
   That is NOT where you are. Do not trust it as your cwd. **Run
   `git rev-parse --show-toplevel` first and treat *that* as your root** — it will be
   a `.claude/worktrees/agent-…` path.

2. **Your worktree has no `node_modules`.** A worktree shares `.git` but not
   untracked files, so tools may fail until deps exist. **`bun install` inside your
   own worktree** (it won't change `bun.lock`). Do NOT `cd` to main to borrow its
   `node_modules`.

3. **Habit.** "cd to the project and run the command" is reflex, and the path you
   memorized is main.

**Rules:**

- **Never put an absolute path to the main checkout in any command** — not in a bare
  `cd`, and *especially* not inside a compound `cd /main/path && …` or a
  `cat >> /main/path/file` heredoc. Each Bash call is a fresh shell, so a `cd` inside
  one command silently retargets just that command; that is exactly how the escapes
  happened.
- **Prefer paths relative to your worktree**, or absolute paths *under* your
  `git rev-parse --show-toplevel`. Run `pwd` before any write if unsure.
- **`git status` / `git add` / `git commit` operate on your worktree** as long as you
  don't `cd` out of it. If a git command reports files you didn't touch, STOP — you're
  in the wrong checkout.

The harder structural fixes (not advertising the main path to worktree agents,
pre-seeding `node_modules`, hard-sandboxing the filesystem) are harness-level and out
of scope here — until they land, this discipline is the guard.

---

## Architecture

Two wrappers compose. Both derive their values deterministically from
`basename(git toplevel)`, so the same worktree always gets the same ports and
the same dev DB — collisions are impossible and `lsof -i :$PORT` is always
informative.

### `packages/canvas/scripts/with-worktree-port.sh`

Hashes the worktree basename into an even base port in `[4520, 4900)` and
exports:

- `PORT` — vite dev server port. `vite.config.ts` reads it (fallback `4510`).
- `CANVAS_BRIDGE_PORT` — bun bridge listen port (`= PORT + 1`). `server/bridge.ts`
  reads it (fallback `4511`); `scripts/dev.ts` derives the vite `/api` proxy
  target (`CANVAS_BRIDGE`) from it so the browser proxies to the bridge this
  stack started.
- `PORT + 2` — vacant. It was the extension server's slot until the custom-handler
  feature was removed (#357); the later offsets kept their values so a worktree's
  ports did not move.
- `CANVAS_EDGE_PORT` — edge Worker (`wrangler dev`) listen port (`= PORT + 3`;
  `scripts/dev.ts` derives the vite `/v1` + `/api/auth` proxy target from it).
- `E2E_BASE_URL` — `http://localhost:$PORT`, Playwright's `baseURL`.
- `E2E_MODE=1` — flag e2e-aware code can read to short-circuit real auth /
  external calls (see the shim convention below).

### `packages/canvas/scripts/with-worktree-db.sh`

Since **ADR-0018** local dev's **platform data layer** is miniflare's local D1, bound
to the edge Worker — not a libSQL file the bridge migrates on boot. So what this
wrapper isolates is miniflare's **state directory**: it derives
`.wrangler/state-<worktree>` and exports it as `CANVAS_D1_STATE`. Both the edge Worker
(`wrangler dev --persist-to`) and the bridge (`server/local-d1.ts`, which opens the
same D1 file so dev has ONE datastore) read it.

**Migrations are explicit now** — nothing runs on boot:

```sh
bun run webpoc:db:migrate:local        # the canonical .wrangler/state (plain `bun run dev`)
bun run webpoc:db:migrate:local:e2e    # this worktree's state-<worktree> dir (`dev:e2e`)
```

Booting the bridge against an unmigrated state dir fails with an error naming the
command. Worse ergonomics than the old auto-migrate, better prod parity — a deliberate
trade (ADR-0018). `test:e2e` needs no extra step: Playwright's `globalSetup` applies
them.

> **Default behavior is preserved.** With none of these env vars set — a plain
> `bun run dev` — the ports are `4510`/`4511`/`4512`/`4513` and the state dir is
> `packages/canvas/.wrangler/state`. The wrappers are opt-in via the `:e2e` scripts.

The canonical composition is `with-worktree-port.sh with-worktree-db.sh <cmd>`,
already wired into the `package.json` scripts below.

---

## Running things in a worktree

From `packages/canvas`:

```sh
bun run test             # unit tests (./server ./shared ./src ./shell ./worker) — in-memory DBs, already parallel-safe
bun run webpoc:test      # web-poc's suite — a DIFFERENT runner (vitest), see below
bun run dev:e2e          # dev stack on the worktree's derived port + DB
bun run test:e2e         # Playwright over the dev stack (isolated port + DB)
bun run test:e2e:ui      # Playwright UI mode for iterating
```

**Never run bare `bun test`** (CLAUDE.md says the same). Its default glob also collects
`web-poc/`'s **vitest** specs and runs them under the wrong runner, producing ~10 spurious
failures in the `conversations` / `mcp-tokens` round-trips. They are not real — those files
pass under `webpoc:test`. `bun run test` is scoped to exclude them, and `bun test` exposes no
ignore option, so the script is the only guard. Typechecking splits the same way:
`bun run typecheck` covers canvas + the edge Worker, `bun run webpoc:typecheck` covers the
platform data layer.

`dev:e2e` starts a heavier stack than it used to: vite + bridge + **the edge Worker**
(ADR-0018), because the platform data layer is now served locally by the edge.

To iterate on a **canvas component** without a canvas, board or login, the dev stack also
serves a bench at `/dev/playground.html?m=<Module>&f=<fixture>` on the same `$PORT` — pick a
module, feed it a fixture as `data`, watch `setData`. See the `cedarpad-component` skill.

Open multiple worktrees and run these in parallel — each hits a different port
and a different local D1 state dir. No coordination needed. (`bun run dev` stays on the
canonical `4510`/`4511`; use `dev:e2e` when you need isolation.)

---

## The `E2E_MODE` shim convention

The canvas app is gated by Better Auth + the `cs_gate` cookie. A full
authenticated e2e flow needs a signed-in session, which is expensive to set up
per run. The convention for making gated / external-dependent paths hermetic in
e2e is a gated early return keyed off `E2E_MODE`:

```ts
if (process.env.NODE_ENV !== 'production' && process.env.E2E_MODE === '1') {
  // deterministic response matching the live shape, or a bypass of cs_gate /
  // a seeded test session for the Shell flow.
}
```

### Rules

1. **Belt-and-suspenders the prod gate.** Require `NODE_ENV !== 'production'`
   AND `E2E_MODE === '1'`. Either alone is not enough — the shim must be
   unreachable in prod.
2. **Place the shim AFTER real auth checks** where one exists, so a future
   auth regression surfaces rather than being papered over.
3. **Match the live response shape exactly** — every field.
4. **Shim only what blocks e2e** (auth gate, outbound email, third-party
   verification), not list/read endpoints.
5. **Mention any new shim in the PR body** so reviewers know what changed.

`with-worktree-port.sh` already exports `E2E_MODE=1`, so any spec run through
`test:e2e` gets it for free.

### The shims that exist today

| Shim | Where | Why |
| --- | --- | --- |
| Stubbed Claude SDK turn | `server/bridge.ts` (`E2E_MODE`) | a real turn needs an OAuth token + a model round-trip |

`E2E_MODE` gates that one shim and **nothing else**. In particular it does *not* gate the
container stand-in below — see the warning there before you reach for it.

---

## The container stand-in is LOCAL DEV, not e2e

**This is not a shim and is not e2e-gated.** Local dev runs no container at all, so it is
on for every local run — `bun run dev` included.

`server/dev-worker-config.ts` drops `containers` from the generated local config, so the
workspace's `CanvasContainer` DO has no container to start (`ctx.container` is absent).

The dev stack is right there as plain processes on ports, so the generated config carries
`LOCAL_CONTAINER_SHIM=1` + `LOCAL_BRIDGE_ORIGIN`, and `serveWorkspace` proxies to that
origin instead of the container (`localBridgeOrigin` in `worker/sandbox-resolver.ts`, #276).
Two belts guard it: the flag, and a loopback-only origin check — and **neither var exists in
`wrangler.jsonc`**, so nothing deployed can reach it. It sits at the START of
`serveWorkspace`, downstream of the session gate, the ownership check and the header
stamping, so it replaces the transport into the container and papers over no check.

The origin is **vite**, not the bridge: the container exposes ONE port and vite is what
listens on it, proxying `/api` to the bridge beside it. Point it at the bridge and every API
call works while the Shell's canvas stage 404s on `/w/:ws/canvas/:id/pad`.

### The Shell has no dev server — `dev.ts` rebuilds it instead

Same root cause, second symptom. The Shell (rail, canvas picker, **Inbox**) is served by the
edge Worker from `shell/dist` through its ASSETS binding, exactly as production does — there
is no vite dev server for it and `bun run dev:web` is the *pad*, not the Shell. So an edit to
`shell/src/` or to anything shared with it (`shared/ChatView.tsx`, `shared/chat.css`) does
**not** appear at `:4513` until the bundle is rebuilt.

This reads as "my change didn't apply", or worse as "the Inbox must use a different
component" — it does not; it renders the same `<ChatView>`. **Rebuild by hand:**

```bash
bunx vite build --config shell/vite.config.ts   # from packages/canvas
```

Check `ls -la shell/dist/index.html` before believing a Shell change is broken.

**Do not put that build on a `--watch` inside `dev.ts`.** Tried 2026-08-04, reverted the
same hour: `shell/vite.config.ts` has its `outDir` INSIDE its own `root`, so the watcher
rebuilds its own output forever — and the pad's dev server, whose root is the whole package,
full-page-reloads the browser on every write. The operator gets an infinite refresh loop,
which is strictly worse than a stale bundle. Excluding `shell/dist` from both watchers is
the prerequisite, not an afterthought.

### While you are at it: don't add scratch files under `packages/canvas/src/`

A temporary harness there is inside vite's root, so creating or touching it **full-page-
reloads whatever the operator has open**. Repeated over a work session that reads as the app
being broken, and it can drop an in-flight chat turn's SSE stream (see the recovery gap
below). Same trap, smaller blast radius: a non-component export from a `.tsx` (a helper, a
constant) breaks React Fast Refresh for that module, so every later edit to it is a full
reload rather than a patch — keep helpers in a sibling `.ts`.

### Why it has its own flag

It used to ride on `E2E_MODE`, and that cost us the same hour twice. Two symptoms, one
cause:

- a plain `bun run dev` → open the Shell at `:4513` → the canvas stage dies with
  *"Containers have not been enabled"*, because no stand-in was emitted;
- `E2E_MODE=1 bun run dev` "fixes" it — and **silently replaces the agent with the e2e
  stub**, because the same flag swaps `runChat` for `e2eRunChat` in `server/bridge.ts`.

So the only working local Shell was one with a fake agent. The flags are now separate:
`LOCAL_CONTAINER_SHIM` is a fact about local dev, `E2E_MODE` is a fact about e2e. If you
ever find yourself setting `E2E_MODE=1` to make the UI work, that is the bug, not the fix.

Without the stand-in, every edge-gated path stops at a 500 and only the *deny* half of an
authorization test is observable.

---

## The authenticated fixtures (`e2e/fixtures/test.ts`)

Since #276 the project-local `test` is an EXTENSION of Playwright's, not a re-export.
Five fixtures, all addressed at the **edge Worker's own origin**:

| Fixture | What it gives you |
| --- | --- |
| `owner` | the signed-in user who OWNS what the bridge files — **use this one** |
| `signIn()` | a fresh Better Auth account, signed in, owning nothing — the stranger side |
| `joinBridgeWorkspace(user)` | membership of the bridge's workspace — `setup` project ONLY (see below) |
| `promoteToAdmin(user)` | Better Auth's `admin` role — `setup` project ONLY, same reason |
| `edgeRequest` | an anonymous request context at the edge — the deny side of a gate assertion |

**Auth is NOT shimmed, and it is passwordless** (ADR-0020, #346). `signIn()` drives the same
two magic-link endpoints a real user does — `POST /api/auth/sign-in/magic-link`, then
`GET /api/auth/magic-link/verify?token=…` — and the session it returns is verified by the same
`worker/auth-gate.ts` production runs. Call it twice for two users, which is how an
authorization boundary gets proven.

The one thing a headless test cannot do is read email, and the fixture does **not** shim the
send seam for it. Instead `readMagicLinkToken` lifts the token out of the local D1: Better Auth
persists it to the `verification` table (as `identifier`, in plain form) *before* invoking the
send seam, keying the row's `value` to the address. So the whole hop stays production code —
no test-only branch anywhere — and the read is READ-ONLY, so the write-lock warning below does
not apply to it. Locally there is no `EMAIL` binding, so nothing is actually sent.

`promoteToAdmin` exists because the snapshot door the canvas migration loads through is
**admin**-gated, not member-gated (`worker/canvas-snapshot-api.ts` — replacing a canvas's whole
document is an operator action, #321). No signup path sets that role, so the owner carries it,
seeded in `setup` alongside the workspace membership.

**Talk to the edge port, not vite's.** In production the edge is in front of everything;
locally it sits BESIDE vite, which proxies only `/api/auth/*` and `/v1/*` to it. So
`http://localhost:$PORT/api/workspaces` hits the *bridge* and 404s, while the same path on
`$CANVAS_EDGE_PORT` is the real gate answering. The fixtures bind their request contexts to
`EDGE_BASE_URL` (derived from `CANVAS_EDGE_PORT`) for exactly this reason.

**Never write the live D1 from a test.** `joinBridgeWorkspace` and `promoteToAdmin` are the
only raw-SQL *write* seams — the container files its Conversations into the legacy `default`
workspace and no API creates that row (production seeded it by hand, once, #179), and no
signup path grants `admin`. But the edge Worker holds that SQLite file open, and D1's write
lock admits ONE writer: an external write landing mid-request makes *miniflare's* write fail,
and it surfaces somewhere else entirely — a sign-in that fails to create the user
(`422 FAILED_TO_CREATE_USER`), or `[platform-rpc] conversation.start failed: 500` in an
unrelated parallel test. Seeding per test made ~25% of a 4-worker run fail that way.

So the seed runs exactly once, in the **`setup` project** (`e2e/specs/auth.setup.ts`, which
every other project `dependencies`-on), where nothing else is in flight. It parks the
session in `test-results/.auth/owner.json`, and the `owner` fixture picks it up. **Reads
are fine** — WAL readers don't block writers, which is why the specs can poll the D1 as a
witness. If you need new seeded state, extend the setup project; don't add a write to a
test.

---

## Authoring a new e2e spec

Specs live in `packages/canvas/e2e/specs/*.spec.ts` and get `test` / `expect`
from `../fixtures/test.ts`, never from `@playwright/test` directly — that is where the
authenticated fixtures documented above live. (Importing a *type* from `@playwright/test`
is fine; `authed-edge.spec.ts` takes `APIRequestContext` that way.)

### The loop

1. Start the dev stack in this worktree: `bun run dev:e2e &`. It prints the
   derived `$PORT` / `$E2E_BASE_URL`.
2. Drive the running server (Playwright codegen, or the Playwright MCP if
   registered) at `$E2E_BASE_URL` to discover stable role/label locators rather
   than guessing them.
3. Write the spec, then run `bun run test:e2e` (Playwright's `webServer` will
   reuse the already-running dev server locally).
4. Iterate until green. Commit.

### Conventions

- Use unique-per-run identifiers (e.g. `` `e2e-${Date.now()}@example.com` ``) so
  a spec doesn't collide with a previous run in this worktree's dev DB.
- Don't `test.skip` / `test.fixme` to make CI green — fix or remove the spec.

---

## Current specs

**Harness and platform**

- `auth.setup.ts` — the `setup` project every other project depends on: signs in the ONE
  owning user, joins it to the bridge's workspace, promotes it to `admin`, and parks the
  session in `test-results/.auth/owner.json`. The only place that writes the live D1.
- `smoke.spec.ts` — proves the harness round-trips: the wrappers derive a port + DB,
  Playwright launches the canvas dev stack on that port, and the app shell
  (`<title>Agent Canvas</title>`, `#root`) renders. No auth.
- `open-conversation.spec.ts` — the bridge's half of the forwarded-row seam (#261), driven
  directly with the header stamped by hand.
- `chat-turn-conversation.spec.ts` — a chat turn files its Conversation via the platform RPC
  (#262, #266), driven at the bridge.
- `authed-edge.spec.ts` — the gated paths (#276): the session gate, **a user cannot open a
  Conversation they do not own**, and a chat turn driven through the edge over the real
  container→edge RPC hop.

**Canvas**

- `canvas-room-writes.spec.ts` — #305: the browser reads the Durable-Object-hosted room
  (#290) while the bridge writes to it, so a 200 actually means something appeared.
- `canvas-chat-agent-writes.spec.ts` — #310: an in-canvas chat agent draws and a watching
  browser sees it.
- `canvas-binding-cleanup.spec.ts` — #292 item 2: the CLIENT side of binding cleanup, which
  only the server sweep in `worker/canvas-mutate.ts` prevents (sync-core has no binding
  logic — ADR-0019).
- `canvas-ui-drag.spec.ts` — #301 (#285 criterion 1): the one spec that *drives* the tldraw
  surface — tool keys and pointer drags across `.tl-canvas` — rather than writing through
  HTTP and watching.
- `canvas-presence.spec.ts` — #293: two independent browser contexts on the same canvas over
  tldraw sync's own presence channel, both upgrades authorized by the real edge gate.
- `canvas-guest-read.spec.ts` — #294: a component-scoped share link (#221) end to end — a
  real member mints it, a real anonymous browser walks `/share/<id>`.
- `canvas-asset-migration.spec.ts` — #321: the migration's asset upload over real HTTP
  against a real bucket (the admin-gated snapshot door — hence `promoteToAdmin`).

---

## Troubleshooting

- **"port already in use"** — two worktrees with the same basename (rename one),
  or you started both `dev` and `dev:e2e` in the same worktree.
- **Playwright starts its own server unexpectedly** — locally `webServer`
  reuses an existing one; make sure your `dev:e2e` is on the derived `$PORT`.
- **Stale dev DB** — delete `packages/canvas/.wrangler/state-<worktree>/`, then
  re-run `bun run webpoc:db:migrate:local:e2e`.
- **"No local D1 database in …"** — the state dir has never been migrated; run the
  migrate command above (nothing migrates on boot any more).
- **CI** — `.github/workflows/e2e.yml` runs `bun run test:e2e` with `CI=true`,
  which flips Playwright to no-reuse + retries and launches a fresh dev stack.
