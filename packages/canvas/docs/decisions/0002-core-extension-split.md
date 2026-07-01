# 0002 — Core/extension split: a protected core, agent-writable extensions, backend extensions in an isolated process

Status: accepted (supersedes ADR 0001's "no immutability boundary" + whole-subtree overlay; backend-extension server is decided but not yet built)

## Context

ADR 0001 chose "**everything mutable and persisted, no immutability boundary** — the agent may change any file (backend included) and it survives restart via the [whole-subtree] overlay." Operating it exposed that this stance is the root of a cluster of failures:

- **The whole-subtree overlay shadows our own code.** It tars all of `src/` + `server/` and restores it over the image on every boot, so a deploy's new code (e.g. a debounce fix, `/api/status`) was silently overwritten by the stale overlay. Deploys looked "out of date" for no visible reason.
- **Agent backend code shares the bridge process, so a crash takes the canvas down with it.** A `runpodctl` poll threw an unhandled rejection every 5s (Bun treats that as fatal) → the bridge crashed → `bun --watch` restarted it → in-memory canvas edits + the pending R2 save were lost. The canvas reverted to a stale snapshot on a ~5s loop.
- **The overlay's change-watcher can't even run on the deploy target.** It used `fs.watch({ recursive: true })`, which throws `EINVAL` on Linux — so on the container the overlay (and sessions) never auto-saved at all.

The common cause: there is no boundary between **our code** (the app shell + the bridge — the thing that must stay correct for the canvas to work) and **the agent's authored content** (the components, and any backend it needs). Conflating them means our deploys fight the agent's persistence, and the agent's code can crash our core.

## Decision

Introduce an explicit **core vs. extension** boundary on both tiers.

| Tier | **Core** — protected, image-only, agent must not modify | **Extension** — agent-writable, hot-reloaded, persisted to R2 |
|------|---|---|
| **Frontend** | the **shell**: `App.tsx`, `sync.ts`, `ComponentShape`, `LeftPanel`, canvas chrome | `src/canvas-components/*.tsx` — vite HMR (existing) |
| **Backend** | the **bridge core**: `bridge.ts`, `agent.ts`, the `CanvasStore`, persistence | **custom handlers** in a separate **extension server** process |

Concretely:

- **Persistence is scoped to the extension content, not the whole subtree.** The overlay is now `components.tar` = only `src/canvas-components/` (a flat dir). Our app code is **image-only**, so a deploy can never be shadowed. (Shipped.) A flat dir also lets the watcher drop `recursive: true`, which is the only `fs.watch` mode Linux supports — fixing the EINVAL. (Shipped.)
- **The core bridge runs without `--watch` in the container.** Its code only changes via a redeploy (a fresh image), so `--watch` bought nothing and only added a window where a stray file touch restarts the live, stateful bridge mid-session. `--watch` stays in local dev only (gated on `IS_SANDBOX`). (Shipped.)
- **Backend extensions run in a separate, stateless "extension server" process** (its own `--watch` is fine — it holds no durable state), which the core proxies to at **`/api/custom/:handler`**. (Decided; not yet built.)
- **Custom handler contract:** receives an HTTP request → may make outbound calls (third-party APIs, databases, and the core's own `/api/canvas`) → returns an HTTP response. It has **no direct access to the `CanvasStore`** — that's a structural consequence of being a separate process, not a rule, so it can only reach canvas state through the core's validated HTTP API (which keeps the version counter, SSE broadcast, and save path authoritative).

The point: **core = stateful, stable, no-watch, image-only; extension = stateless (backend) or content (frontend), disposable, watched, persisted.** A misbehaving extension can break itself but not the canvas.

## Considered options

- **Backend extensions via dynamic import inside the core bridge** (cache-busted `import('./ext.ts?rev=N')`, mirroring the frontend's `component-loader`). Rejected: the agent's backend code would run **in the core process**, so a crash/loop/leak takes the bridge — and the canvas state it holds — down. We just lived this exact failure with `runpodctl`. The separate process buys isolation worth more than the saved process.
- **Keep ADR 0001's whole-subtree overlay + "everything mutable."** Rejected: it is the direct cause of the deploy-shadowing and the broken Linux watcher, and it offers no protection for the core.
- **No backend extensibility at all** (components are frontend-only, call existing endpoints). Rejected: the agent needs to add real backend surface (data fetchers, webhooks) for the components it builds.

## Consequences

- The agent's durable output is now exactly two dirs: `src/canvas-components/` (frontend) and the custom-handler dir (backend). Everything else is image-only and reverts on recycle.
- An edit to the **shell** still hot-reloads via vite (a residual exposure), and an edit to the **bridge core** is now inert (no `--watch`) and ephemeral (not persisted). True write-enforcement that keeps the agent *out* of the core (e.g. a Claude Code permission hook scoping writes to the two extension dirs) is a **follow-up**, not yet decided.
- The extension server is a new process to spawn/health-check/proxy in `scripts/dev.ts`; its content persists and restores alongside components.
- ADR 0001's container deploy, vite-as-compiler, R2 persistence, and workspace/canvas topology all stand. Only its "no immutability boundary / whole-subtree overlay / self-modifying backend" stance is superseded here.
