# PRD — Deploy agent-canvas to Cloudflare Containers (dev-stack-in-container)

> Local PRD (not published to the issue tracker). Governs the build of [ADR 0001](../decisions/0001-cloudflare-container-deploy.md). Use the agent-canvas glossary (workspace / canvas / page / chat) throughout.

## Problem Statement

agent-canvas only runs on James's machine. He wants to reach his canvas from other devices (and eventually share it), but it can't be deployed like a normal web app: the bridge is one long-lived stateful process, the agent is a full Claude Code agent (RCE + live file authoring), and the signature feature — the agent writing React components that appear on the canvas — only works because the vite **dev server** compiles those files on demand. A static build kills that feature, and a serverless deploy can't host the stateful bridge. So today there is no way to use the canvas away from the one laptop, and a restart loses the canvas and every component the agent authored.

## Solution

Run the existing dev stack (vite + bridge) **inside a Cloudflare Container**, fronted by a Worker that gates access and proxies the browser in. The canvas works exactly as it does locally — hand-drawing, chat, live component authoring, self-modification — but reachable at a URL. State survives restarts because the canvas and the agent-authored files are persisted to **R2** and restored on boot. For now it is one **workspace** (container) holding one **canvas**, gated by a shared-secret cookie and intended for James across his own devices; multi-canvas-per-workspace and per-identity workspaces (Cloudflare Access) are explicit fast-follows.

## Design / Visual Spec

N/A — no new user-facing surface. The deployed UI **is** the existing canvas, unchanged, still governed by `DESIGN.md`. This PRD is infrastructure: container, Worker, persistence. The only new pixels are failure/transition states (see stories 28-31), which reuse existing chrome tokens.

## User Stories

1. As James, I want to open my canvas at a URL from any device, so that I am not tied to the one laptop running it.
2. As James, I want hand-drawing, chat, and the agent's canvas tools to behave identically to local dev, so that nothing about the product regresses when deployed.
3. As James, I want the agent to keep authoring new React components live (write/edit/place), so that the canvas's signature capability survives the deploy.
4. As James, I want the agent to keep its full Claude Code abilities (Bash, Read, Write, Edit, Web, Task, impeccable skill), so that the deployed agent is as capable as the local one.
5. As James, I want the agent to be able to edit the running app's own code (bridge, SPA, config) and see the change apply live, so that in-session self-modification still works.
6. As James, I want my canvas (shapes, pages, chats) to be exactly as I left it after a container sleep or restart, so that I never lose work.
7. As James, I want every component the agent authored to still be there and still render after a restart, so that the component library is durable, not session-scoped.
8. As James, I want code the agent changed (any file) to persist across restarts, so that self-modifications are not silently reverted.
9. As James, I want the agent's "thinking" pill, tool-elapsed, and effort selector to work as they do locally, so that streaming visibility is preserved.
10. As James, I want the chat SSE stream to stream smoothly through the deploy (no long frozen gaps from buffering), so that the deployed experience matches local.
11. As James, I want the canvas SSE sync to reconnect and re-sync cleanly when the bridge reloads (e.g. after the agent edits server code), so that a self-modification doesn't desync the board.
12. As James, I want access gated behind a secret, so that an unauthenticated stranger can't reach an RCE agent on my Cloudflare account.
13. As James, I want the gate to be a cookie I set once via a key URL, so that I don't re-authenticate every visit.
14. As James, I want the Claude credential, R2 keys, and avatar keys injected as container env, so that no secret is baked into the image or persisted to R2.
15. As James, I want the container to sleep when idle and wake on demand, so that I'm not billed for an always-on box.
16. As James, I want the canvas restored from R2 on wake, so that sleeping costs nothing but loses nothing.
17. As James, I want a clean separation between what's in the image (base code) and what's in R2 (my runtime changes), so that I can reason about where state lives.
18. As James, I want only the files I actually changed to live in R2 (not the whole tree), so that a future base-image fix to untouched files still takes effect.
19. As James, I want deleted files to stay deleted across restarts, so that the overlay reflects reality, not just additions.
20. As James, I want canvas-state persisted per-canvas and the code overlay persisted per-workspace, so that the keying matches the containment hierarchy.
21. As James, I want a dependency I add (package.json change) to be installed on the next boot, so that a component importing a new npm dep works after restart.
22. As a future second user, I want my own workspace/container when I'm given access, so that I don't share James's filesystem or agent.
23. As a future user, I want Cloudflare Access to route me to my workspace by identity, so that access is per-person and auditable rather than a shared secret.
24. As James, I want to deploy the canvas with one command from my machine, so that shipping an update is low-friction.
25. As James, I want a `/health` endpoint open without the gate, so that I can check the deploy is up.
26. As James, I want persistence to be fire-and-forget off the interaction path, so that saving never blocks drawing or chat.
27. As James, I want canvas saves debounced (~1-2s) so that continuous dragging doesn't hammer R2.
28. As James, I want a clear "connecting…/reconnecting…" state while the container cold-starts or the bridge reloads, so that I can tell waiting from broken.
29. As James, I want a visible error if the boot restore from R2 fails, so that I'm not silently handed an empty canvas that then overwrites my saved one.
30. As James, I want the canvas to refuse to persist an empty state over a known-non-empty saved state on a failed load, so that a restore bug can't wipe my work.
31. As James, I want a sign-in prompt when my gate cookie is missing/expired, so that a 401 is understandable rather than a dead page.
32. As James, I want the build artifacts (Dockerfile, Worker, wrangler) to live in the agent-canvas package, so that the deploy ships the package directly rather than through a second package that mirrors it.

## Implementation Decisions

**Topology & deploy shape**
- The container runs `scripts/dev.ts` (vite :4510 + bridge :4511) — the dev stack, not a static build. Confirmed necessary: vite is the component compiler (ADR 0001).
- The container is a Durable-Object-owned `Sandbox` (claude-sandbox-poc pattern): `sleepAfter` idle timeout, `max_instances` cap.
- A Worker fronts it: gate cookie → proxy to **vite :4510** (the app origin); vite's own dev proxy forwards `/api/*` → bridge :4511. (Browser loads the app from vite, exactly as local.) SSE proven to stream unbuffered through this proxy (spike), so no WebSocket conversion.
- Deploy artifacts (`Dockerfile`, `worker/index.ts`, `wrangler.jsonc`) live **inside `packages/agent-canvas`**. The throwaway `packages/cedarpad-sse-spike` is the reference, not the home.
- One workspace, one canvas for v1. The bridge stays single-`CanvasStore`. Multi-canvas-per-workspace and Access→workspace identity routing are out of scope (fast-follows).

**Persistence — modules**
- **`R2Store` (deep module).** A thin, testable store over a swappable `BlobBackend` (`get`/`put`/`exists`) — Bun's native S3 client (`Bun.S3Client`) in the container, an in-memory `Map` in tests, a local-fs backend for local dev (no cloud). Keyed by the workspace/canvas scheme: `canvasStateKey`/`overlayKey`, `load`/`save` for canvas state and overlay. `get` returns null for an absent key (legitimately empty), and throws only on a real backend failure — the two are distinct. Keys: `workspaces/<ws>/canvases/<canvas>/canvas-state.json` and `workspaces/<ws>/overlay.tar`. No business logic; just blob IO. Credentials from injected env.
- **Why no diff/`computeOverlay`.** The agent is a full Claude Code agent (Bash/Write/Edit, `bypassPermissions`), so the changed-file set is unbounded and unpredictable — not just `write_component` output. A whole-subtree tar (the complete current source minus the excludes below) captures any write however made, handles deletions for free (the tar *is* the current state; restore replaces the subtree), needs no deletions manifest, and removes the requirement that the container be a live git checkout. The only big thing, `node_modules`, is excluded either way, and the source tree is small, so per-change incremental upload buys nothing at single-user scale. A git-diff overlay was specced and built, then dropped as premature optimization.
- **Canvas persistence** = the `CanvasPersistence` policy over `R2Store`, replacing `persist.ts`. Debounced save (~1-2s) of canvas-state. Load path: `R2Store.loadCanvasState` on boot; the safety rule (story 30) lives here — a *failed* load (error, vs legitimately-empty null) marks the store degraded and refuses to later persist empty-over-known-good. A non-empty save, or a clean/absent load, always proceeds.
- **Overlay sync** = an IO shell: an `fs.watch` on the package subtree (debounced ~3-5s) → tar the whole subtree excluding `node_modules`/`.git`/`dist`/`.wrangler` → `R2Store.saveOverlay`. Fire-and-forget with a dirty-flag retry on transient failure. No diffing; the tar is the complete current state.
- **Boot restore** = a startup routine run before `scripts/dev.ts`: fetch overlay (if any) → replace the package subtree with its contents (extract, so deletions are honored) → fetch canvas-state → write to the path the bridge reads → if the restored `package.json` differs from the image's, `bun install` → start the dev stack.

**Worker / auth**
- Gate = the sandbox-poc shared-secret `cs_gate` cookie; `?key=<secret>` sets it; `/health` is open; everything else 401s without it. The 401 body is a sign-in prompt (story 31).
- Secrets (Claude OAuth token, R2 access key/secret/endpoint, avatar keys) injected into the container via `setEnvVars` from Worker secrets. `ANTHROPIC_API_KEY` intentionally absent (would override the OAuth token).
- The bridge keeps its current behavior unchanged except for the persistence backend swap; no auth logic added inside the bridge (the Worker is the gate).

**Boot/runtime details**
- The Dockerfile uses the claude-sandbox-poc base image; bakes the agent-canvas package + a `bun install` at build (so `node_modules` is image-resident). Base entrypoint stays; the Worker starts the dev stack via `startProcess` + `waitForPort` (mirrors `ensurePtyServer`).
- `CANVAS_CWD` / the agent's working dir = the in-container package path, so authored components land where vite serves them and where the overlay watcher sees them.

## Testing Decisions

Good tests here assert **external behavior**, not implementation: given inputs, the module produces the right outputs/effects, with no coupling to private structure. Prior art: `server/classify.test.ts`, `server/store.test.ts`, `server/components.test.ts` (pure-function + fixture style, `bun test`).

- **`R2Store`** — tested against the in-memory `Map` backend: save-then-load round-trips for canvas-state and overlay, absent-key (null) vs backend-error (throws) distinction, correct key construction for the workspace/canvas scheme. **Done.**
- **Canvas persistence safety rule** (story 30) — a test that a *failed* load does not allow a subsequent empty-state persist to overwrite a known-good object, that a clean/absent load still allows an empty save, and that a non-empty save always proceeds. **Done** (it guards against data loss).
- Boot-restore and the fs-watcher overlay sync (whole-subtree tar) are IO shells; their precious logic — the empty-over-known-good guard — is covered by `canvas-persistence.test.ts`. An end-to-end "deploy + restart preserves canvas + components" check is a manual acceptance step, not an automated test.
- Open for James: confirm the three recommended test targets, and whether the boot-restore sequencing warrants its own integration test.

## Out of Scope

- Multi-canvas-per-workspace (the bridge hosting multiple `CanvasStore`s) and a canvas switcher UI.
- Cloudflare Access / per-identity workspace routing; multi-user. v1 is shared-secret, James-only.
- The separate **control plane** for managing broken state (a bad persisted self-edit). v1 deliberately has no restart-heal; recovery is manual until the control plane exists.
- Per-file overlay objects / incremental (diff-based) upload optimization (v1 tars the whole package subtree into one object on each debounced change; revisit only if measured too coarse).
- Custom domain / DNS for the canvas (use the `workers.dev` URL initially).
- A production tldraw license (watermark remains).
- Any change to the canvas product behavior itself.

## Further Notes

- The SSE-through-container question is already settled GREEN by `packages/cedarpad-sse-spike` (frames arrive ~55ms after emit, not batched). That spike is the deploy reference and can be deleted once the real artifacts land in `packages/agent-canvas`.
- **Risk accepted in ADR 0001:** persist-all means a bad agent edit to `bridge.ts` survives restart, so a restart does not heal it; and the R2 overlay masks base-image changes for any file the agent has touched. Both are intentional, pending the control plane.
- **Security:** the deployed bridge is unauthenticated RCE + self-modifying with only the gate cookie in front. The cookie is acceptable for James-only; **before the URL is shared with anyone, the gate must become Cloudflare Access.**
- Deploying CF Containers from a headless agent session needs the `DOCKER_CONFIG` keychain/buildx/contexts workaround (in auto-memory: `reference_cf_container_deploy_headless`).
