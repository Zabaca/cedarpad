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

