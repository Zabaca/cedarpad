# Repos are workspace assets; PAT-backed repos with encrypted-at-rest tokens

Status: accepted (design). Extends [ADR-0015](./0015-repos-are-workspace-config-jobs-are-repo-content.md)
(repository connection, jobs) and [ADR-0010](./0010-dev-agent-is-a-role-not-a-container.md)
(token custody); respects the gated-layer rule of
[ADR-0013](./0013-mcp-and-workspace-content-are-the-integration-seam.md). Vocabulary: canvas
[CONTEXT.md](../../packages/canvas/CONTEXT.md) ("Repo", "Repository connection").

Two shifts, decided together (grill session 2026-07-21). First: a repo is a **workspace asset** —
added like a canvas or skill, its *content* readable by every chat turn — not merely dev-agent
config. Second: a workspace can add repos **outside its GitHub App installation's identity** (the
driving case: a client issues a separate GitHub account for their repo), authenticated by a
per-repo **fine-grained PAT** stored encrypted at rest.

## Why

- A workspace's GitHub App installation is bound to one GitHub account/org. A consultant's
  workspace legitimately spans identities: their own org's repos plus a client-issued account's
  repo. One `installationId` per workspace cannot represent that, and reconnecting overwrites.
- "Ask questions about this repo" was only possible inside a dev-agent conversation — repo access
  was a property of the token-holding turn. That conflated two capabilities: *reading* (safe to
  widen) and *writing* (must stay gated). The asset framing splits them.

## Decision

**Repo = workspace asset.**

- The bridge (platform code, never a turn) maintains a **read-only checkout** of each selected
  repo in the container. Refresh is eventual: boot + periodic fetch + an explicit refresh
  affordance. Chat turns read it as plain files with the tools they already have.
- **No repo credential ever enters a turn's environment for reading.** The bridge uses the token
  transiently at fetch time. The gated-layer rule is untouched: chat turns still hold no tokens.
- Writing (worktrees, commits, `open_pr`) remains exclusively the dev-agent turn surface.
- Adding a repo remains a capability grant to the whole workspace: every member's chats can read
  every added repo. Owner-only mutation, workspace-wide benefit — same as ADR-0015.

**PAT-backed repos join the one model (no second flavor).**

- The selection is a child table (`workspace_repos`), one row per repo — replacing the JSON
  array column. Each row: repo full name, auth source (`installation` | `pat`), and for PAT rows
  the encrypted token. Per-row inserts kill the whole-array lost-update race and give rotation,
  expiry state, and provenance a home.
- **One choke point** turns a repo into a git credential: resolution returns
  `{repoFullName, auth}` (a discriminated union) and a single mint function branches —
  installation → short-lived scoped mint (today's path), PAT → decrypt. Callers (kick routes,
  inbox-bridge send, `run_dev_agent`, job discovery, the checkout refresher) never branch.
- **Uniform participation**: PAT repos appear in job discovery, platform-job targets, dev-agent
  triggers, and the checkout set, exactly like installation repos. One run = one repo holds.

**PATs are encrypted at rest.**

- AES-GCM via WebCrypto, keyed by a new platform secret (SOPS-delivered like
  `BETTER_AUTH_SECRET`). Decrypt only at the moment of use inside the mint choke point.
- Why not plaintext like `githubInstallationId`: the installation id is inert without the App's
  private key (platform env); a PAT is a live bearer credential — a DB-only compromise must not
  hand out working GitHub access. (Precedent check: `workspace_mcp_tokens.token` already stores
  external-MCP bearer tokens plaintext — ADR-0013 train 2 predates this decision. That is now
  the known debt, and the seal helper introduced here is its migration path, not a reason to
  add a second plaintext credential column.) Retrofitting encryption later would be a real
  migration; doing it first is cheap.
- Better-auth's `apiKey` hashing was examined and rejected: one-way hashes serve verification;
  we must *use* the token outbound.

## The custody asymmetry (recorded, accepted)

Installation tokens are minted per-turn, scoped to one repo, ~1 hour. **A PAT cannot be
down-scoped or shortened by us** — the turn-delivery header (`x-dev-agent-git-token`) carries
whatever the token can do, for the turn's duration, and a leak is bounded by the PAT's own scope
and expiry, not by our mint. Containment therefore lives at the edge of our control:

- ADR-0015's home-repo rule still bounds *steering*: a job merged in a PAT repo only ever steers
  runs whose credential is that repo's PAT.
- The add-repo UI insists on fine-grained, single-repo, expiring PATs. Add-time validation
  proves the token *can* reach the named repo; it cannot prove the token reaches nothing else.
  That residual risk is accepted and owned by the workspace owner.
- Expiry is a normal lifecycle event: rows carry an "Update token…" rotate flow, and a 401 on
  refresh badges the row rather than failing silently. Read-only PATs are accepted with a
  visible "PRs unavailable" badge, not rejected — least-privilege is a feature.

## Considered and rejected

- **A separate "external repo" concept outside the selection** — read-only research flavor next
  to the real one; forks every consumer and rebuilds dev-agent parity later. The stated goal was
  full parity (research now, PRs later).
- **Plaintext PAT column** — see above; the one-time crypto helper is smaller than the eventual
  retrofit migration.
- **Richer JSON blob instead of a child table** — keeps the read-modify-write race on concurrent
  adds; no home for per-row lifecycle (rotation, expiry, who added).
- **Read tokens for chat turns** — dissolves the chat/dev-agent custody line ADR-0010/0015 drew;
  the checkout delivers the same capability with zero credentials in turns.
- **Excluding PAT repos from job discovery** — strictly safer but re-forks the model; the
  home-repo rule plus `DEV_AGENT_ENABLED`/manual triggering bounds the risk during trust-building.
- **Multi-installation support** (N installations per workspace) — the "native" fix for the
  multi-identity case, but real schema + resolution rework for a problem held exactly once; the
  PAT path neither blocks nor forecloses it, and `workspace_repos` would absorb it as another
  auth source later.
