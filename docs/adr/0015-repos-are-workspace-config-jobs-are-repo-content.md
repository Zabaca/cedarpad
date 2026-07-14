# Repositories are workspace config; Jobs are repo content, armed by merge

Status: accepted (design). Extends [ADR-0008](./0008-workspace-is-a-deployment.md) (tenancy),
[ADR-0010](./0010-dev-agent-is-a-role-not-a-container.md) (dev-agent token custody) and
[ADR-0013](./0013-mcp-and-workspace-content-are-the-integration-seam.md) (the content/capability
line). Vocabulary: canvas [CONTEXT.md](../../packages/canvas/CONTEXT.md) ("Repository connection",
"Job").

The dev-agent is hardcoded to `Zabaca/cedarpad` (`DEFAULT_REPO`, `DEV_AGENT_REPO_NAME`, a global
`GITHUB_APP_INSTALLATION_ID` secret). This ADR makes the GitHub link workspace configuration and
defines where agent-executable Jobs live.

## Decision

**Repository connection is workspace config.**

- The **GitHub App identity** (app ID, private key) stays platform env — never tenant data.
- The **installation** is per-workspace: the owner installs cedarpad's App on their org via a
  signed-`state` connect flow; the callback owner-checks, verifies with a test mint, and stores
  `installationId` on the workspace record.
- **Selected repos** (multiple allowed) are workspace config: the owner's declaration that these
  repos are in scope for this workspace's agents. Selection drives job discovery, platform-job
  targets, and token minting. Granted-but-unselected repos are invisible.
- **One run = one repo.** Every dev-agent run targets a single repo chosen at trigger time; the
  conversation stays bound to it (like `canvasId`). No multi-repo turns.
- Transition: the default workspace falls back to the env installation + `Zabaca/cedarpad` until
  its row exists; then the fallback and env secret are deleted.

**Content layers (the gated-layer rule).**

> Content that steers a token-holding turn must come from a gated layer — platform (deploy-gated)
> or repo (PR-gated). The workspace layer is agent-writable and ungated, so it feeds chat turns
> only.

| Artifact | Platform (deploy-gated) | Repo (PR-gated) | Workspace (ungated) |
|---|---|---|---|
| Code | image | target repo | — |
| Skills | image `~/.claude/skills/` | repo `.claude/skills/` | chat turns only (ADR-0013) |
| Agents | image (possible) | repo `.claude/agents/` | permissible for chat, unbuilt |
| Jobs | built-in, code | repo `.claude/jobs/` | **none** |

**Jobs are repo content; the PR merge is the arming step.**

- A Job is `.claude/jobs/<name>.md` in a selected repo (frontmatter: `name`, `description`,
  `schedule`; body: the prompt). Agents author jobs by opening PRs — creation is open, arming is
  consented: nothing runs until a human merges to the default branch.
- **Discovery is pull-based; the default branch is the registry.** The edge fetches
  `.claude/jobs/` via the contents API (read-scoped mint), cached by branch SHA. No registration,
  no stored job list — reconcile, don't register. Merge → appears; delete → gone.
- **Cron is an evaluator**: the platform tick discovers, checks due-ness against a `lastRunAt`
  stamp (edge DB, bookkeeping not content), and dispatches. `DEV_AGENT_ENABLED` stays the master
  breaker.
- **The platform wrapper is not opt-out-able**: every run wraps the job body in the code-defined
  triage law, decision record, and token custody. A job steers *what*, never *under which rules*.
- Repo-level craft (explorer agents, skills, decline markers) comes from the target repo and
  degrades gracefully when absent (no explorer defined → orchestrator reads without fan-out).

**Token minimization.** `workflows: write` is dropped from the mint — GitHub then rejects any push
touching `.github/workflows/`, converting the triage law's "no CI changes" from prompt rule to
enforcement. Discovery mints request `contents: read` only.

## The enforcement caveat

The installation token's `contents: write` can push directly to the default branch — **"merge is
the arming step" is enforced only where branch protection exists.** Cedarpad itself is a private
repo on a free plan where protection is unavailable; until the repo is public or the org upgraded,
the PR discipline is prompt-law, not enforcement. The settings UI surfaces a per-repo
default-branch-protection badge; the accepted interim risk is that job sources are code plus
merges by the owner.

Why the design still holds: the threat is prompt injection — anyone who can write text the agent
reads (issues, canvas docs, MCP results, uploaded skills) is transitively an author. The gated
layers cut the injection→persistence→token-escalation ladder at near-zero feature cost; branch
protection is the last rung and is the repo owner's lever, not the platform's.

## Considered and rejected

- **Platform-level installation, workspace repo selection only** — a second workspace could never
  connect its own org; forces the schema migration later anyway.
- **Jobs as edge DB rows with a human "armed" bit** — a second trust mechanism next to PR review;
  loses versioning, diff review, and repo-travel. PR-driven reuses the one gate we already trust.
- **Jobs/agents in the workspace layer** — a planted job would execute with a repo write token
  with no human diff in between; exactly the ladder ADR-0013 cut.
- **Per-job Cloudflare cron triggers** — static deploy-gated config would make "merge needs a
  deploy" true again; one platform tick + evaluator instead.
- **Multi-repo runs** — token minting, branch naming, `open_pr`, decline markers are all
  single-repo shaped; "survey many repos" = many runs or many workspaces.
