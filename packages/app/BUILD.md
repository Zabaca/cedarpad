# Building cedarpad for self-install (macOS)

The v1 distribution model is "the implementer builds it on their own
machine and uses it." No public download, no notarised release —
acceptance criteria for this slice are bounded by what the implementer
needs for daily use.

## Prerequisites

- macOS 11+ on Apple silicon (Intel macs need a flag wired into
  `scripts/build-sidecar-release.sh` — see "Other platforms" below)
- Xcode Command Line Tools (`xcode-select --install`)
- Rust 1.77+ (`rustup install stable`)
- Bun 1.3+ (`curl -fsSL https://bun.sh/install | bash`)
- Python 3 (only if regenerating the icon — not needed for plain builds)

The OS keychain plugin (`keyring` crate) needs no extra setup on macOS.

## One-shot build

```sh
cd packages/app
bun install                # once per worktree, populates node_modules
bun run build:macos        # ~60s cold, ~20s warm
```

Output: `packages/app/build/cedarpad.app`. To install:

```sh
cp -R build/cedarpad.app /Applications/
open /Applications/cedarpad.app
```

Or run in place:

```sh
open build/cedarpad.app
```

## What the build does

`scripts/build-macos.sh` runs four steps:

1. **`build:sidecar:release`** (`scripts/build-sidecar-release.sh`).
   Bundles `src-sidecar/src/server.ts` into a single `server.js` with
   `bun build --target=bun`, marking `@libsql/*` and `libsql` as
   `external` (those packages contain native `.node` bindings that
   can't be inlined into a JS bundle). Then copies the platform-specific
   native package (`@libsql/darwin-arm64`) and the `libsql` JS shim
   that loads it into a sibling `node_modules/` tree. Output:
   `src-tauri/sidecar/{server.js, node_modules/...}`.
2. **`build:vite`**. Bundles the renderer into `dist/`.
3. **`tauri build`**. Runs `cargo build --release`, produces the .app
   bundle, embeds the icon set + `src-tauri/sidecar/` as resources, and
   ad-hoc signs the bundle (`signingIdentity: "-"` in `tauri.conf.json`).
4. **`codesign --force --deep --sign -`**. Defensive re-sign in case
   Tauri skipped any inner Mach-O. Then `codesign --verify`.

Final deliverable is copied to `packages/app/build/cedarpad.app`.

## Worktree-safe builds

Per `CLAUDE.md` §6, parallel worktrees never collide. The script
exports `CARGO_TARGET_DIR` to `${CARGO_HOME:-~/.cargo}/cedarpad-build/<worktree-name>`,
keyed off `basename($(git rev-parse --show-toplevel))`. Override by
exporting `CARGO_TARGET_DIR` yourself before running.

The `dist-sidecar` and `src-tauri/sidecar` outputs are inside the
worktree so they're naturally per-worktree.

## Codesigning

We use **ad-hoc signing** (`codesign -s -`). This produces a Gatekeeper
*"unidentified developer"* status (`spctl --assess` returns `rejected`),
but on the implementer's own machine the binary launches without
issue because:

- The `.app` is **not quarantined** (no `com.apple.quarantine` xattr is
  set when the user produces the binary themselves; that xattr is only
  applied to downloads).
- Some signature is required for arm64 Macs to launch any Mach-O at
  all — even ad-hoc. Without this the OS kills the process with no
  dialog.

Full Apple Developer ID signing + notarisation is **deferred** until v1.5
(public distribution). To enable it later: set `signingIdentity` in
`tauri.conf.json` to your Developer ID and export
`APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` (or
`APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_PATH`) before
running `bun run build:macos`. Tauri will pick them up.

## Bumping the version

Edit two files in lockstep:

- `packages/app/src-tauri/tauri.conf.json` → `version`
- `packages/app/src-tauri/Cargo.toml` → `package.version`

(Tauri picks up the conf value for `CFBundleShortVersionString`; cargo
needs the matching value for the binary's symbol.)

Tag the commit if you want a release marker (`git tag v0.1.1`) — there
is no auto-update channel in v1.

## Regenerating the icon

The source artwork is `src-tauri/icons/icon-source.png`, generated from
`scripts/gen-icon.py` (pure-stdlib Python; no PIL needed). To change the
brand:

```sh
# Edit scripts/gen-icon.py (BG, FG, glyph geometry)
bun run icon:gen   # python3 gen-icon.py + bunx tauri icon
```

Tauri's `icon` command emits all the platform sizes Tauri's bundler
needs (32px, 128px, 128@2x, .icns, .ico, plus iOS/Android sets we don't
ship today).

## Other platforms

Only macOS arm64 is wired in this slice. To add Intel macs / Linux /
Windows:

- `scripts/build-sidecar-release.sh` has a `case "$(uname -s)/$(uname -m)"`
  switch — add the `@libsql/<platform>` package name there.
- `scripts/build-macos.sh` is macOS-specific. For Linux and Windows
  write `build-linux.sh` / `build-windows.ps1` that call the same
  `build:sidecar:release` + `build:vite` + `tauri build` steps and skip
  the macOS codesign block.
- `tauri.conf.json` `bundle.targets` is currently `["app"]` (macOS-only).
  For other platforms add `deb` / `appimage` / `nsis` etc.

## Known limitations (v1)

- **macOS arm64 only.** As above.
- **Bun on PATH for the user.** `cedarpad.app` shells out to `bun run
  server.js`. If the implementer launches the .app from Finder and Bun
  isn't on the GUI-process PATH (`launchctl`-managed environment), the
  sidecar fails to spawn. Workarounds: launch from terminal, or add
  `/Users/<you>/.bun/bin` via `launchctl setenv PATH ...` in your login
  shell. A future slice may compile the sidecar to a single binary via
  `bun build --compile` (ADR-0005 risk #1) or rewrite as a pure-Rust
  process — neither is in scope here.
- **Ad-hoc signature.** As above.
- **No DMG / installer.** `cp -R build/cedarpad.app /Applications/`.
- **No auto-update.** Manual rebuild + replace.

These limitations are tolerable because v1's distribution model is
"the implementer to themselves." Public distribution earns a v1.5
slice with notarisation, a DMG, and an update channel.
