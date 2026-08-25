# Changelog

Every release of cedarpad, newest first.

A release **is** a deploy ([ADR-0025](docs/adr/0025-a-release-is-a-deploy.md)): each version
below was stamped into a container image, verified serving at `/api/buildrev`, and only then
tagged. So `v0.2.0` names exactly one commit that provably ran in production.

## How to write an entry

This file is the single source of truth for two audiences, and the split is the format:

- **`### Internal`** — refactors, CI, test coverage, docs. Recorded here, **never** shown on
  cedarpad.com.
- **Everything else** — written for the person *using* cedarpad, not for the person who wrote
  the code. "Components no longer vanish after a restart", not "fix materialize sibling walk".

```markdown
## [0.2.0] — 2026-07-31

### Added
- **Ilograph diagrams** — architecture views with perspectives and drill-down. (#393)

### Fixed
- Components no longer fail to render after a container restart. (#390)

### Internal
- Cold-container e2e coverage; e2e moved to the self-hosted runner.
```

Section headings are `Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Internal` — that
set exactly. PR references stay here for traceability and are stripped from the public page,
since the repo is private and the link would 404.

The shape is a contract: `packages/www/src/lib/changelog.ts` parses this file at build time to
render [cedarpad.com/changelog](https://cedarpad.com/changelog), and it **throws** rather than
skipping, so a malformed entry fails the tests and the build instead of silently vanishing
from the site.

<!-- Releases below, newest first. The /release skill prepends each one here. -->

## [0.2.6] — 2026-08-25

### Internal
- **The checks a release requires now run on every commit.** `e2e.yml` was the only workflow,
  so the unit tests, typechecks and lint ran for the first time during a release — against
  every commit since the last tag. Anything broken in that window surfaced at once, at the
  moment someone was trying to ship, which is why releasing had become a multi-day activity.
  `gates.yml` runs them per push and per PR instead.
- **Two test files could not pass on their own.** Both leaned on global state another file
  happened to leave behind: the shared SSE stream in the chat store, and an `EventSource` that
  happy-dom does not provide. `Shell.test.tsx` run alone was 0 pass / 31 fail. Whether they
  passed was a function of file ordering, which held on a developer's machine and nowhere else.
- **The release no longer stops to have its changelog read.** The prose describes work that has
  already merged and stays editable afterwards, so the gate bought review of wording at the
  cost of a release that could not run unattended.
- **The workspace Access policy is expressed against the general `cloudflare-access` module,**
  with `sessionDuration` and `appLauncherVisible` stated explicitly — both were defaults that
  moved, and the second found a defect in the module rather than avoiding one.
- **`bun run apply` refuses when the two halves of the zbc version disagree,** and `vendor/zbc`
  moved to `zbc-core-v0.12.0`.
- **Two guards that did not guard what their names claimed,** and a comment in `ws-tunnel` that
  described a supervisor restart as safe when it is not.

## [0.2.5] — 2026-08-23

### Internal
- **The workspace Guest now converges to the commit being applied.** `ws-app`'s provision
  digest was constant, so `zbc apply workspace` skipped the fetch-and-reset it declares: the
  Guest sat on whichever commit it happened to fetch when that file was last edited, six
  behind main by the time anyone looked. A release's "same commit" now holds for the Guest as
  well as the container.
- **The workspace supervisor's provision records itself.** Its readiness poll ended in
  `exit 0`, which returned before the marker write appended after it could run — so it
  re-provisioned on every apply from 14 to 22 August, restarting the live supervisor each time
  and reporting success each time.
- **zbc-core vendored at v0.10.8**, up from v0.10.4. Provision markers moved from
  `/var/lib/foundry-provision` to `/var/lib/zbc-provision`, and `vm` no longer defaults its
  `sshUser`. The `exit 0` trap above is fixed upstream in the same version, so no consumer can
  reach it again.
- The ws.cedarpad.com Guest is declared here and converged over ryzen-9's incus remote, rather
  than by the repository that owns the box.
- The infra engine comes from `vendor/zbc`; `@cedarpad/infra` retires.
- Khoa's age key, and the re-key that makes it work. (#409)

## [0.2.4] — 2026-08-17

### Fixed
- **An outline is now shared by everyone on the canvas.** Edits to an Outliner card stayed in
  the tab that made them — each person was quietly editing a private copy of the same card,
  and publishing an edit could wipe out rows someone else had added since. Bullets, notes,
  indents and completions now reach everyone. Which bullet you have zoomed into stays yours.

### Internal
- The explorer agent's description no longer truncates at its issue number — an unquoted `#`
  in YAML was discarding over half of it before agent selection ever saw it.

## [0.2.3] — 2026-08-13

### Changed
- **The default workspace now runs on hardware we own**, reached over a private tunnel
  instead of a Cloudflare Container. The container's filesystem did not survive sleep, so
  every cold start rebuilt its dependency bundle from scratch — and a page load that raced
  that rebuild got a canvas referring to files that briefly did not exist. A long-lived guest
  keeps its filesystem, so that way of failing to load is gone.

### Fixed
- A canvas that had gone to sleep now wakes on the first try. Reopening an idle canvas could
  fail for minutes with `canvas error: ProcessExitedBeforeReadyError` instead of showing the
  board. Waking was tied to the request that asked for it, so a browser giving up mid-load
  canceled the wake — and each retry canceled the one before it. A canvas now wakes once, and
  finishes waking even when the request that triggered it is gone.
- A workspace that only needed waking no longer answers "Bad gateway". When its stack was not
  yet listening, the error page went straight to the browser and stayed there, with no retry —
  for exactly the case a single boot would have fixed.

### Internal
- A container whose dev stack dies now exits with the real cause instead of always reporting
  code 0, and names which process died — so a failed boot says what happened rather than
  "Process exited with code 0".
- A workspace can be served from a self-hosted guest that holds no cedarpad credential at
  rest: the guest starts nothing until the Worker pushes it the environment the Worker
  already owns.
- Deploy verification asks the container image for its build stamp rather than following a
  self-hosted workspace to hardware that answers `dev` — which had been failing deploys whose
  Worker had shipped correctly.

## [0.2.2] — 2026-08-07

### Fixed
- Adding a component now puts it on the page you are looking at. On a canvas whose pages
  had been reordered, cards added from any page landed on the first one instead.

### Removed
- **FlintGallery** — the chart showcase. Every chart type it demonstrated is documented in
  the chart-authoring reference, and ChartCard renders them all.

## [0.2.1] — 2026-08-07

### Added
- **Filter the Components page by tier** — chips for built-in, shared, canvas and
  no-source, each with a count, so you can audit one tier without scrolling past the
  others. A chip only appears for a tier that has components in it.
- **State machines in components** — xstate is available to anything built on the
  canvas, so a component with real states and transitions can model them directly
  instead of juggling booleans.

### Removed
- **BarChart** — superseded by ChartCard, which renders Bar, Grouped Bar, Stacked Bar
  and Histogram among 35 chart types, with axes, scales and legends derived from your
  data. Any card still placed as a BarChart will show as having no source; place a
  ChartCard instead.

### Fixed
- Chart slides no longer render their bar labels in near-invisible text.

## [0.2.0] — 2026-08-07

### Added
- **Outliner** — a Workflowy-style outliner you can place on any canvas. Enter splits a
  bullet, Tab and Shift+Tab indent and outdent, Shift+Enter adds a description, ⌘/Ctrl+Enter
  marks an item done, and clicking a bullet zooms into it. Edits persist across reloads, and
  an agent can write a whole outline in a single call.

### Fixed
- An outline that references a missing item no longer crashes the card — the stray row is
  skipped.
- An outline containing a loop no longer hangs the tab.

### Internal
- Outline edit semantics extracted to a pure module (`src/outline-tree.ts`), unit tested
  without a DOM, keeping Fast Refresh on the component.
- e2e: pin node on the self-hosted runner. wrangler cannot run under bun, node had gone
  missing from the box, and every run since 2026-08-04 died at auth setup before testing
  anything.
- e2e: reap the dev stack a cancelled run strands — before the suite and after it.

## [0.1.0] — 2026-08-04

### Added
- **Notebook search** — type in the Notebook and get ranked results with highlighted
  excerpts instead of a filter over what is already on screen. (#396)
- **Agents write the Notebook** — an agent can record an Observation and where it came
  from, create a Problem, tie Observations to it, link Problems, and record a Solution.
  Works from the in-canvas agent and from an outside agent over MCP. (#399)
- **A canvas reads the Notebook live** — place a component against a Notebook query (open
  problems, a problem's observations, recent observations) and it shows what is there now,
  not a nightly snapshot. Members only. (#397)
- **Solutions and Problem links** — record how a Problem was solved, and link one Problem
  to another. (#395)
- **The chart gallery** — browse every chart type on the pad with live data and the spec
  that produced it, so you can see what an agent can build. (#393)
- **An agent-terminal chat card** — a chat rendered in the grammar of Claude Code, Codex or
  Grok, with three skins.

### Changed
- **The Notebook is a reading surface.** The capture box and modal are gone — agents write
  it, you read it. (#398)
- **Chat reads as a terminal.** Turns, tool calls, plans and approvals share one column, and
  a tool call opens to show the full command it ran.
- **The interface is a true neutral.** Surfaces lost their warm tint; the cedar ember is now
  the only colour in the chrome.

### Fixed
- Charts fill the card they are placed in, at any zoom. Before, one drew at a fixed size and
  left the rest of the card empty.

### Security
- Notebook graph reads are confined to your workspace. A problem-context or neighbourhood
  read could previously return a record from another workspace, and a traversal could route
  through one. (#395)

### Internal
- The local container stand-in was split off `E2E_MODE`, which had been forcing a choice
  between a dead canvas stage and a stubbed agent in local dev. Chart sizing moved out of the
  component module to stop breaking Fast Refresh. Release tooling: the publish check follows
  its redirect; /changelog carries the site nav.

## [0.0.1] — 2026-07-31

The first release. Cedarpad has been live for months; this is the point it starts carrying a
version, so this entry describes what it does today rather than the 406 commits it took.

### Added
- **The shared canvas** — a multiplayer surface where you and AI agents work on the same
  artifacts. Multi-page, with the picker reorderable by drag; a reload returns you to the page
  and camera you left. (#344) (#384)
- **Live components** — agents write real React components onto the canvas instead of
  describing them. Each canvas has its own; promote one and every canvas sees it. A gallery to
  place them, a Components stage for the workspace-wide inventory, and preview on demand.
- **The Notebook** — record an Observation and where it came from, and synthesize Observations
  into a Problem. API-first, so agents can write to it while working with you. (#392) (#394)
- **Ilograph diagrams** — architecture views with perspectives, drill-down, and a sequence
  walkthrough. (#393)
- **Passwordless sign-in** — a magic link by email; no password to set or forget. (#346)
- **The Inbox** — conversations with agents, with an unread badge pushed to you rather than
  polled for. (#383) (#385)
- **Agents reach cedarpad over MCP** — an external agent can read and write your canvases with
  the same reach the in-app agent has.
- **Huddles** — talk over voice on a canvas. Join from the side panel, see who is in, and get
  a live transcript as you go; guests on a share link can join too. (#222)
- **The dev agent** — point an agent at a connected repo and it works in a branch and opens a
  pull request. Run it from Jobs, or trigger it from an outside agent over MCP.
- **Marts** — components read the workspace warehouse by name. A component names a mart, never
  a URL, and a shared canvas exposes only the marts it actually uses.
- **Shareable canvases** — invite a guest by link, see their presence, revoke it. (#320)
- **Workspace settings** — members and invitations, private canvases, connected GitHub
  repositories, and web push notifications.
- **This changelog**, and the running version in Settings.

### Fixed
- Components no longer fail to render after the container restarts — one that imports another
  now materializes together with it.

### Internal
- Everything shipped before this release. Structurally: workspace content became records in D1
  (ADR-0022), the platform data layer moved from Turso to D1 (ADR-0018), canvas sync moved onto
  tldraw sync (ADR-0019), and e2e moved to a self-hosted runner. (#388)

