# 0001 — Deploy agent-canvas as a self-modifying dev-mode container on Cloudflare, with R2 overlay persistence

Status: accepted, but partially superseded by [ADR 0002](./0002-core-extension-split.md) — the container deploy, vite-as-compiler, R2 persistence, and workspace/canvas topology stand; the "everything mutable / no immutability boundary / whole-subtree overlay / self-modifying backend" stance below is replaced by the core/extension split (the core is image-only; only `src/canvas-components/` + custom handlers persist). **Further amended by root [ADR-0007](../../../../docs/adr/0007-workspace-platform-topology.md)** — the "one workspace / one canvas", "shell served by the container", and "Cloudflare Access as the gate" stances are replaced by a static edge Shell over one container hosting many canvases, with Better Auth at the edge (`cs_gate` removed).

## Context

agent-canvas is not a serverless app and can't be built into one. The bridge is a single stateful Bun process that owns the in-memory `CanvasStore`, fans one SSE stream to every browser, and runs the Claude Agent SDK in-process as a **full Claude Code agent** (unsandboxed Bash/Write/Edit, full RCE). Its signature feature — the agent authoring real React components onto the canvas — works only because **vite is the compiler**: `component-loader.ts` dynamic-imports `/src/canvas-components/<X>.tsx?v=<rev>` and vite transpiles it on request. A static `vite build` has no compiler for files written after the build, so a production build amputates live authoring.

The agent can edit *any* file, not just components. An edit to `src/**` triggers vite HMR (or the rev-bump re-import for components); an edit to `server/**` (or a bridge-imported `src/` module like `store.ts`) triggers `bun --watch` to reload the bridge. So the running app is **self-modifying**: the agent can rewrite its own SPA, bridge, and config, and the reloaders apply it live. Locally this is fine — the working tree is real disk in an isolated git worktree, single trusted user. We want to run it off-local (other devices, eventually other people) without losing live authoring or self-modification.

## Decision

**Run the dev stack inside a Cloudflare Container, not a static build.** The container (a Durable-Object-owned `Sandbox`, the claude-sandbox-poc pattern) runs `scripts/dev.ts` (vite :4510 + bridge :4511). A Worker fronts it: gate → proxy to vite → vite proxies `/api` → bridge. SSE was proven to stream unbuffered through the CF container proxy (frames arrive ~55ms after emit, not batched), so the existing one-shared-SSE-stream design ships as-is — **no WebSocket conversion**.

**Persistence: R2 via Bun's native S3 client** (no SDK dep; R2 access key injected as container env like the Claude token). The split is base-vs-delta:
- **git → baked into the image** = the base app at the build commit + `node_modules`. The boot floor.
- **R2 = the runtime delta**, two objects:
  - **code overlay** (`workspaces/<ws>/overlay.tar`) — the whole package subtree (excluding `node_modules`/`.git`/`dist`/`.wrangler`) tarred by a debounced file-watcher; restore replaces the subtree, so deletions are honored without a diff or manifest. The agent writes via Bash/Write/Edit (not just `write_component`), so the changed set is unbounded; whole-subtree tar captures any write and needs no live git checkout. **Per-workspace** (shared filesystem/component library).
  - **canvas state** (`workspaces/<ws>/canvases/<canvas>/canvas-state.json`) — written by the existing debounced `persist.ts` hook. **Per-canvas.**
- **Worker-injected env = secrets** (Claude token, R2 keys, avatar keys) — never in git or R2.

Boot order: start from image → fetch + apply the code overlay (incl. deletions) → load `canvas-state.json` → if the overlay's `package.json` differs, `bun install` → start the dev stack.

**Durable surface = everything mutable and persisted.** No immutability boundary: the agent may change any file (backend included) and it survives restart via the overlay. A separate **control plane** (outside the container, not yet built) will manage broken state; we explicitly are *not* relying on "restart heals" for now.

**Topology = workspace/canvas hierarchy** (see CONTEXT.md): **workspace = container** (isolated fs + bridge + one component library), **canvas = a board within it** (its own `CanvasStore`). For now: **one workspace, one canvas**, fronted by the claude-sandbox-poc shared-secret gate cookie. Fast-follows: the bridge hosting multiple `CanvasStore`s per workspace, and **Cloudflare Access mapping each identity → its own workspace/container** (the per-user isolation boundary), at which point there is no shared RCE agent and R2 namespaces are per-user.

## Considered options

- **Static `vite build` + serve assets** (web-poc pattern) — rejected: kills live component authoring (no runtime compiler).
- **Durable Object SQLite / D1 / Turso for persistence** — rejected: they're Worker-side, but our persistence writer runs *inside* the container; R2's S3 API is the only durable store the in-container bridge reaches directly. Also, the canvas is a whole-document JSON snapshot, not a queryable DB.
- **Whole-tree tarball in R2** — rejected: it masks the entire base image on every boot, so a base-code fix never takes effect until R2 is cleared. The changed-files overlay only masks files the agent actually touched.
- **Immutability boundary (bake code immutable, restart heals)** — deferred in favor of the future control plane; we chose persist-all for simplicity now.
- **Single shared canvas for all users** — rejected in favor of workspace-per-user (via Access) as the multi-user story; avoids everyone sharing one self-modifying RCE agent.

## Consequences

- The deployed bridge is **unauthenticated RCE + self-modifying**, with only the gate cookie in front. The gate must become **Cloudflare Access before the URL is shared with anyone**; until then it is James-only across his devices.
- **persist-all means a bad agent edit persists**: a broken `bridge.ts` survives restart (the overlay re-applies it), so a restart does *not* heal it. Accepted; the control plane is the recovery path.
- The R2 overlay **masks base-image changes for any file the agent has touched** — base fixes to those files won't take effect until the overlay entry is cleared.
- The container **sleeps after 5m idle**; in-memory canvas + authored components are restored from R2 on wake. An open tab holding the SSE stream keeps it awake (continuous billing).
- Deploying CF Containers from a headless agent session needs the `DOCKER_CONFIG` keychain/buildx/contexts workaround (separately documented).
