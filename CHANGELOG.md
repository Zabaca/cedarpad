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

