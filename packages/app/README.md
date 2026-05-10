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
# All Vitest suites (unit + module + sidecar integration + IPC-level e2e)
bun run --bun vitest run

# Renderer-only dev (browser; IPC calls will throw — useful for layout work)
bun run dev:vite

# Full Tauri dev — spawns Vite + cargo + sidecar
bun run tauri:dev

# WebView-level e2e (slow, drives the rendered WKWebView via tauri-webdriver)
bun run test:e2e:webview
```

## Two e2e tiers

We deliberately keep two e2e tiers; they verify different things and run at
different speeds.

| | `e2e/tests/**` (vitest) | `e2e/webview/**` (wdio) |
| --- | --- | --- |
| Boundary | NDJSON RPC over stdio | Rendered WebView DOM + real React |
| Driver | `vitest run` (default in CI) | `tauri-webdriver` + `webdriverio` |
| Speed | <1s per test | ~5s per test (binary launch dominates) |
| Coverage scope | Deep modules + sidecar + persistence | Boot, IPC wiring, keymap, render, persistence |
| Runs by default | yes (`bun run --bun vitest run`) | no — request only / nightly |

The IPC tier is the bulk of e2e coverage; it's fast and stable because it
spawns the bun sidecar directly and exercises the same handlers the
renderer uses. The WebView tier exists so we have at least one
end-to-end test through the actual rendered Tauri app — proving the
shell, sidecar, IPC wiring, React, contentEditable keymap, and libSQL
persistence all hang together. We add WebView tests sparingly because
they're slower and depend on a built binary; the IPC tier is the right
place for most new tests.

WebView tier prereqs (one-time per machine):

```sh
cargo install tauri-webdriver --locked
```

The webdriverio CLI requires Node 20+ (execa@9 imports `node:events`'s
`addAbortListener`, added in Node 20). Bun's bundled Node compat is 18,
so `bun run test:e2e:webview` invokes `node` (not `bun`) for the wdio
step — make sure your shell's `node` resolves to 20.x or newer.

The plugin (`tauri-plugin-webdriver`) is wired into the cedarpad shell
behind `cfg(debug_assertions)` only — release builds don't expose the
WebDriver server. macOS doesn't ship a native WebDriver for embedded
WKWebView (Apple's `safaridriver` only drives Safari itself), so
`tauri-plugin-webdriver` injects the bridge and `tauri-webdriver` proxies
W3C requests into it. Linux and Windows reuse the same plugin.

`bun run test:e2e:webview` runs `bun run build:debug:bin` first, which
does `vite build` then `tauri build --debug --no-bundle`. We use
`tauri build --debug` (not plain `cargo build`) so the binary embeds the
`frontendDist` instead of trying to fetch from `devUrl` — this lets the
test launch a self-contained app without a co-running vite server.

Caveats:

- macOS WebKit's WebDriver delivers keydown/keyup correctly but does not
  trigger native text insertion against contentEditable. The spec works
  around this by driving the React `onInput` path via a JS-injected
  `InputEvent` for printable characters; Enter and Tab still go through
  the W3C Actions API and hit the React keymap as real keystrokes.
  Documented inline in `e2e/webview/specs/restart.spec.ts`.
- `tauri-webdriver`'s port (4444) is currently fixed, so only one
  WebView e2e run can be active per machine. Two parallel worktrees
  could not run this suite simultaneously today (the IPC-level vitest
  tier has no such limitation).

## Worktree safety

- `scripts/with-worktree-env.sh` derives a per-worktree `PORT`, `E2E_PORT`, and `CEDARPAD_TMP` from `basename($(git rev-parse --show-toplevel))` — different worktrees never collide on temp dirs or dev ports.
- Tests use `mkdtempWorktreeScoped` (`modules/test-utils/worktreeTmp.ts`), which reads `CEDARPAD_TMP` with a fallback to `os.tmpdir()`. No fixed `/tmp/...` paths anywhere.
- Per-repo workspace DBs are inherently worktree-safe (each repo has its own DB).

## Known limitations (slice 1)

- The Tauri shell is wired and `cargo check`s cleanly, but a full `tauri build` requires the Tauri CLI prerequisites (Xcode CLT on macOS, an icon set Tauri's bundler can read, and an Apple developer ID for signing). The `icons/icon.png` shipped is a 32×32 placeholder; replace with a proper icon set before distribution.
- The release-mode sidecar path (`resources/sidecar/server.js`) expects you to bundle the sidecar with `bun build --compile` and copy it into Tauri resources. Slice 1 dev runs the unbundled `bun run src-sidecar/src/server.ts` directly.
- The plan's Playwright `tauri-driver` e2e was deemed too brittle in the initial slice; the IPC-level vitest at `e2e/tests/persistence.spec.ts` covers the same persistence semantics without driving the WebView. A WebView-level equivalent now also exists at `e2e/webview/specs/restart.spec.ts` (see "Two e2e tiers" above) — it produces three nested nodes via real keystrokes and asserts they're rendered after a fresh launch. Acceptance criterion #8 is therefore now fully met.
