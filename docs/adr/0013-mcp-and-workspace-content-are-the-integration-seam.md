# MCP + workspace content are the integration seam, never code ingestion

Status: accepted (design). Informed by #174 (problem) / #173 (direction sketch); supersedes PR #172's approach (closed unmerged, kept as the worked evidence case).

External apps meet cedarpad through exactly two doors: **content** (skills and files living in a workspace) and **tools over MCP** (in both directions). An app's code and data are never merged into this repo to give it a cedarpad surface, and there is deliberately no inbound REST/turn API. Everything that *grants* — tokens, scopes, tool servers, routing — stays code-gated and edge-custodied; everything that merely *asks* — skill text, workspace files — is self-serve per workspace.

## Why

Two integrations in one week exposed the missing seam from opposite directions. yc-critic (rubric-driven YC application critic, source of truth in `zabaca/ceo`) could only reach cedarpad by copying 5.5k lines of skills + corpus into this repo, editing the chat flavor's skill allowlist in `bridge.ts`, and opening PR #172 — creating a drifting copy that also turned out to be dead on deploy (the image never baked repo skills; prod had been running zero skills unnoticed). Ledgerbot (bookkeeping agent, same repo) looked at that cost and built a bespoke console UI instead of using cedarpad at all.

Both point at the same fact: `turnFlavor` (workspace + kind + skill allowlist) is already the app-extension seam, but it is code-shaped, so every app costs a PR, a redeploy, and a synced copy.

The constraint that shapes the answer is cedarpad's trust model: a workspace container is trusted-humans-only unsandboxed RCE by design. Any programmatic credential that can execute a turn is therefore an RCE credential — which is why an inbound API for apps was rejected (#173) and why the seam must distinguish **content-that-asks** (text the model reads; the worst it can do is ask) from **capability** (a grant: tools, tokens, scopes, routing; the worst it can do is act).

## Decision

**1. Skills are workspace content, discovered not allowlisted.** Workspace skills live at `${CANVAS_CWD}/.claude/skills/` (SDK `project` setting source), persisted per workspace as a `skills.tar` overlay sink — the same extension-zone pattern as `components.tar`/`custom.tar`. A skill dir carries its supporting files (yc-critic's corpus lives inside its skill). Chat turns enable **all discovered** skills; the chat allowlist is removed. Platform skills are a separate tier baked into the image at the container's `~/.claude/skills/` (`user` source): deploy-versioned, PR-reviewed, unshadowable by workspace restore; the tier launches empty. Dev-agent turns keep a pinned skill list resolved in a cwd containing no workspace skills (their prepared worktree), so a planted workspace skill can never ride a name into a git-token-bearing turn.

**2. External MCP (the agent consumes outside servers).** A global, code-side **MCP registry** (`name → {url, auth kind}`) is the catalog of approved remote HTTP servers; adding an entry is a PR — that is the capability gate, deliberately. **Enablement is per-workspace owner consent**: v1 is a pasted per-workspace bearer token, and a registry entry may later declare `auth: 'oauth'` (each workspace does its own OAuth dance — Jae connecting Ledgerbot gets Jae's books). **Token custody is edge-side**: per-workspace credentials live in the worker's DB and are attached as headers on the proxied `/send` for that turn only — the container and R2 never store them (the ADR-0008 git-token pattern). A workspace that hasn't connected a server gets no tools, no token, no connection attempt; an unreachable server degrades the turn's toolset, never fails the turn. Chat flavor only; dev-agent turns get no external MCP servers.

**3. Inbound MCP (outside agents interact with a workspace) is the only programmatic surface.** An edge-hosted MCP server, OAuth on top of Better Auth; a token acts as its human and every tool is ownership-checked per workspace. Tools split by the same line: content + read (`upload_skill`, `read_canvas`, `list_inbox`, `read_conversation`, …) and execution (`send_message`). Pure reads serve from the edge (work while the container sleeps); mutations funnel through the bridge — the single writer of the workspace tree — so `upload_skill` proxies to a bridge endpoint and wakes the container rather than writing R2 from the edge (no second writer of `skills.tar`). An MCP-originated chat is an ordinary Conversation: indexed row-at-start (ADR-0011), visible and adoptable in the Inbox, resumed via the existing reply path. `send_message` is async — it returns `conversation_id` immediately and callers poll `read_conversation` — and always runs plain chat flavor.

## Consequences

- Wiring a new app = upload a skill dir (or connect a registry server) into your own workspace: no cedarpad PR, no redeploy, no synced copy, removal is deleting the directory — #174's acceptance criteria.
- A new *external MCP server* still costs a one-line registry PR plus a secret. That is intentional: it is a credential grant, and the review gate is the security control.
- Persistent-instruction injection via planted workspace skills is accepted for chat turns (single-tenant workspace; the same actor could already write `server/custom/` handlers) and structurally excluded for dev-agent turns.
- The outer-agent → `send_message` → container chain means a prompt injection in a remote session can drive a workspace turn; it is bounded to plain chat flavor (no capabilities beyond the UI chat) and fully visible in the Inbox.
- The edge worker grows real subsystems: an OAuth provider, an MCP endpoint, a per-workspace token store. The container grows a skills sink and per-turn `mcpServers` wiring.
- Prod's silent zero-skills regression gets fixed as a by-product (skills finally reach the container, via workspace sync rather than image baking).

## Considered and rejected

- **Merging app code/data into the repo** (PR #172): drifting copies, a PR + redeploy per app, and it scales as archaeology. Closed unmerged.
- **Apps-as-manifests registry** (#173's fuller shape: git-URL skill syncing, versioning, cache invalidation): most of its value is delivered by workspace skills + discovered-skills-enabled + the MCP registry at a fraction of the machinery. Revisit only if a real need outgrows this seam.
- **An inbound REST/turn API with service credentials**: a credential that can execute turns is an RCE credential on a by-design-unsandboxed container. MCP's OAuth consumer story keeps the boundary at authenticated humans delegating to their own agents.
- **Free-form MCP server config in workspace data**: workspace data is writable by any turn (including an injected one); it must never mint a connection target or carry a token. Registry in code; custody at the edge.
- **Edge-written skills as loose R2 objects** (no container wake on upload): creates a second writer of the skills tree racing the container's tar flush — a bidirectional sync subsystem hiding in a v1. Single writer through the bridge instead.
- **A blocking `send_message`**: turns run minutes; MCP clients time out. Async + poll matches the bridge's fire-and-forget reality (a bounded `wait` variant can come later as sugar).
