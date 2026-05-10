# v1 form: Tauri desktop app + per-repo libSQL workspace

cedarpad v1 ships as a single Tauri binary. The WebView UI, the Claude Code SDK runner, and a libSQL store are bundled together. Each repo the user opens becomes its own workspace with its own libSQL database. There is no Vercel deployment in v1; the `production` zbc environment stays empty until v2 cloud sync exists.

## Why

- **Offline-first is a stated commitment.** Hosting the UI on Vercel means the app can't load without internet — disqualifying for a daily-driver tool.
- **No multi-tenancy code yet.** ADR-0001 commits to single-tenant; v1 has one user (the local OS user) and no auth. Cloud-anything is premature.
- **Cloud sync is the v2 problem, not the v1 one.** Solving sync now blocks shipping the One Thing; deferring it costs nothing because libSQL gives a clean migration path (see below).
- **Per-repo workspaces match how Claude Code thinks about projects.** One project = one CLAUDE.md = one mental context = one cedarpad workspace.

## Why libSQL (not plain SQLite, not Postgres, not IndexedDB)

libSQL is the SQLite fork that powers Turso. Choosing it now means v2 cloud sync can be enabled by turning on **Turso embedded replicas** — local libSQL files that sync to a remote Turso instance — with no schema or data-model rewrite. Plain SQLite works locally but offers no sync path; Postgres is overkill and removes the option of running fully in-process; IndexedDB locks the data inside the WebView.

## Workspace model

- App is bound to one repo at a time. A switcher (Cmd+Shift+P style) opens a different workspace.
- Each workspace = one libSQL database. Location TBD: either `<repo>/.cedarpad/db.sqlite` (commitable for shared team threads, gitignorable for private) or `~/.cedarpad/<repo-hash>/db.sqlite` (always private). Decision deferred until first user actually has the choice.
- Outline tree, Thread Roots, Turn Nodes, and Block Nodes are all scoped to the workspace. Switching the repo switches the entire visible tree.

## Trade-offs accepted

- **Single-device for v1.** No cross-device sync until v2.
- **No web access.** If you're on a different machine without the binary installed, you can't see your outlines.
- **Tauri build pipeline.** Per-OS packaging, code signing, update channel — all to ship a binary. Not free.
- **Vercel sits empty.** The infra stack is set up but nothing is deployed in v1. Documented as expected, not a gap.

## Rejected alternatives

- **Web app on Vercel + cloud DB.** Requires multi-tenancy code paths (auth, per-user data scoping) before the One Thing works. Pulls in v2 problems before v1 is validated.
- **Web app on Vercel + local daemon.** Daemon-as-a-separate-process adds pairing/auth complexity for no payoff vs. bundling everything in one Tauri binary. Could revisit if a "headless cedarpad-daemon" use case emerges.
- **Pure desktop with plain SQLite.** Forecloses the Turso sync path; v2 would be a rewrite.
- **Pure local with custom file format.** Same problem as SQLite plus reinventing storage primitives.

## Path to v2

1. Switch libSQL local file to a Turso embedded replica (config change, not data rewrite).
2. Add auth + user accounts on the Vercel side (now the `production` zbc environment earns its keep).
3. Per-user data scoping on the Turso side (multi-tenancy code paths arrive — explicit re-evaluation against ADR-0001).
4. Optional: cloud-hosted Claude Code sessions via CodeSandbox SDK or Fly Sprites for users who don't want a local Claude Code install (research brief from session captured separately if needed).
