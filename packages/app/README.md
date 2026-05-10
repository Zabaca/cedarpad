# @cedarpad/app

Slice 1 of cedarpad v1: a Tauri desktop outliner backed by a per-repo libSQL workspace.

## Architecture

Three processes:

1. **Tauri shell** (`src-tauri/`, Rust). Owns the OS window, the file picker, and the WebView. Spawns the Bun sidecar and forwards `invoke('rpc', ...)` calls to it as NDJSON over stdin/stdout.
2. **Bun sidecar** (`src-sidecar/`, TS). Owns all libSQL DBs. Validates every cross-process payload against `src/contract.ts` schemas — input on receive, output on send.
3. **Renderer** (`src/`, React + Vite). Imports the same `contract.ts` and validates every IPC call before it leaves the renderer and every response before it reaches the rest of the app.

Deep modules under `modules/` are pure TS, TDD'd, and unaware of the IPC layer:

- `modules/outline/ordering.ts` — fractional-indexing wrapper.
- `modules/outline/outlineStore.ts` — CRUD + tree ops on a libSQL handle.
- `modules/outline/migrations.ts` — idempotent schema bootstrap.
- `modules/workspace/workspaceManager.ts` — open/switch/recent workspaces, per-repo libSQL DB at `<repo>/.cedarpad/db.sqlite`.

Per ADR-0005, each repo opened gets its own libSQL DB. On first open, `.cedarpad/` is appended to the repo's `.gitignore`.

## Dev workflow

```sh
# All Vitest suites (unit + module + sidecar integration + e2e persistence)
bun run --bun vitest run

# Renderer-only dev (browser; IPC calls will throw — useful for layout work)
bun run dev:vite

# Full Tauri dev — spawns Vite + cargo + sidecar
bun run tauri:dev
```

## Worktree safety

- `scripts/with-worktree-env.sh` derives a per-worktree `PORT`, `E2E_PORT`, and `CEDARPAD_TMP` from `basename($(git rev-parse --show-toplevel))` — different worktrees never collide on temp dirs or dev ports.
- Tests use `mkdtempWorktreeScoped` (`modules/test-utils/worktreeTmp.ts`), which reads `CEDARPAD_TMP` with a fallback to `os.tmpdir()`. No fixed `/tmp/...` paths anywhere.
- Per-repo workspace DBs are inherently worktree-safe (each repo has its own DB).

## Known limitations (slice 1)

- The Tauri shell is wired and `cargo check`s cleanly, but a full `tauri build` requires the Tauri CLI prerequisites (Xcode CLT on macOS, an icon set Tauri's bundler can read, and an Apple developer ID for signing). The `icons/icon.png` shipped is a 32×32 placeholder; replace with a proper icon set before distribution.
- The release-mode sidecar path (`resources/sidecar/server.js`) expects you to bundle the sidecar with `bun build --compile` and copy it into Tauri resources. Slice 1 dev runs the unbundled `bun run src-sidecar/src/server.ts` directly.
- The plan's Playwright `tauri-driver` e2e was deemed too brittle (Risk #2). The fallback is `e2e/tests/persistence.spec.ts`, which exercises the full sidecar IPC stack — workspace open + 3 nested nodes + sidecar restart + tree-shape verification — without driving the Tauri WebView. Acceptance criterion #8 is therefore partially met: persistence-across-restart is verified end-to-end, just not via the actual rendered UI.
