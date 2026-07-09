# One chat system: every chat interface is a live view of its session's bridge

Status: accepted. Amends the Inbox transport described in root [CONTEXT.md](../../CONTEXT.md)
(supersedes the "Inbox UI renders history from the R2 JSONL while runners sleep" storage
note) and the dev-agent reply path in `packages/canvas/server/bridge.ts`. Target model;
Tier 1 built now, Tier 2 (dev-agent interactive bridge) built alongside but dark until the
dev-agent is enabled (#96).

## Decision

**A chat interface is a live view of the bridge that owns its session — never a rendering
from anywhere else.** Every interactive chat surface (a canvas `chat` shape, an opened Inbox
Conversation, any future one) connects to the Claude Agent SDK session *in its runner's
bridge*, with that runner's real environment (filesystem, authored components, cwd, tools).
A chat rendered from a secondary store (e.g. an R2 transcript at the edge) is a photograph of
a **different environment**, not the session.

Concretely:

- **One shared chat component.** `ChatView` + the tldraw-free `chat-store` (SSE stream, send,
  per-`chatId` state) are shared. The canvas keeps its `ChatShapeUtil` tldraw wrapper, which
  renders `<ChatView>`; the edge Shell's Inbox renders `<ChatView>` directly. `chat-store`
  gains a **connection target** so it can address a bridge through an edge proxy instead of
  assuming same-origin.
- **Opening a Conversation connects to — and wakes — its runner's bridge.** The Conversation's
  `workspaceId` resolves (via the existing sandbox resolver) to the owning runner's coords; the
  edge Worker proxies the chat stream + send to that bridge. History and live stream come from
  that one source. Cold-boot latency is the honest cost of "I am opening this session," the
  same as opening a canvas. The existing idle gate (`src/idle.ts`) governs re-sleep unchanged.
- **The Inbox list is not a chat interface.** It is triage metadata (Turso: status, waiting-on,
  unread, last-activity, denormalized preview), so browsing the list never wakes a runner. R2's
  only consumer is **resume-restore** (durability substrate), not display.
- **Every runner runs the interactive bridge; there is no separate "approval" interaction.** A
  reply always resumes the session as a chat turn on its owning bridge. A **dev-agent**
  Conversation is a chat too — you grill it in-thread, and it **opens the PR as a tool action
  mid-conversation**, not as the hardcoded outcome of the reply. This dissolves the
  `isDevAgentConversation` reply special-case.
- **One reply/send contract.** The Inbox reply endpoint unifies with the canvas `/send`
  contract (gaining `images`); no second, narrower contract.

## Why

The three symptoms that surfaced this (Inbox chat couldn't paste images, didn't stream, was a
separate component) are all one root cause: the Inbox was built as a *rendering* of a session
(edge + R2 + fire-and-forget POST) rather than a *view of* the session (the live bridge). The
domain model already says "Inbox = coordinator over Sessions, agnostic to where a Session
runs" and that the dev-agent "grills through that thread" — so uniformity across runners was
always the intent; the divergence was implementation drift (the old vanilla-JS `INBOX_HTML`,
then a faithful-but-limited React port in PRD #103 slice #108).

## Considered options

- **Keep the edge/R2 read path for the Inbox (render history without waking the runner).**
  Rejected: it is precisely the photograph-of-a-different-environment this ADR forbids. It
  produces a chat you can read but cannot faithfully act in, and forces a two-source component
  ("stale render until you reply, then it jumps").
- **Everything (including the list) through the bridge.** Rejected: browsing the Inbox to see
  what needs attention would wake a container every time. The list is metadata, not a chat —
  the environment question never arises for it.
- **Dev-agent stays a distinct "approval" card (approve/reject, no chat).** Rejected: it makes
  "one chat system" carry a permanent asterisk and contradicts "agnostic to where a Session
  runs." Under the unified model the PR is just a tool the agent invokes in conversation.

## Consequences

- **Opening an Inbox Conversation incurs container cold-boot latency** (seconds, up to ~a
  minute after a long sleep). Accepted: fidelity over instant-but-fake. The list's last-message
  preview covers "what did it say" without a wake.
- **The dev-agent sandbox must run the interactive bridge** (SSE multiplexer + resume), not just
  the batch workflow — a real infra lift, and it can only be exercised end-to-end once the
  dev-agent is enabled (**#96**). Built now, dark until then.
- **A session homed as both a canvas chat and an Inbox Conversation** becomes two live views of
  one bridge stream (same `chatId`) — auto-consistent by construction, not by syncing.
- `worker/inbox.ts`'s edge R2 read (`GET /api/inbox/:id` via `edgeBlobGetter`) stops being the
  interactive read path; R2 transcript code narrows to backup + resume-restore.
