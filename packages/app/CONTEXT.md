# App

The cedarpad application: a Workflowy-style outliner where any outline node can become the root of a Claude conversation, with the conversation living as descendant nodes in the same tree. Branching, retrying, and forking conversations are first-class operations on the tree.

**v1 shape:** Tauri desktop app. UI (WebView) + Claude Code SDK runner + libSQL store all bundled in one binary. Fully offline-first; no Vercel deployment in v1 (`production` env stays empty until v2 cloud sync). libSQL chosen specifically so v2 can enable Turso embedded replicas for cloud sync without a data-model rewrite.

## Language (v1.1)

ADR-0006 reshapes the v1 conversation model. Below is the canonical vocabulary; slice 2/4/5/6 sections later in this file describe the v1 implementation that v1.1 supersedes.

**Node**:
The single primitive — a position in the tree with text content, addressable, branchable, zoomable. Every other concept is a kind of Node or a relationship between Nodes.
_Avoid_: bullet, item, line, entry

**Content Node**:
A human-authored outline Node — Workflowy-style text. The default kind of Node. Becomes a session-bearer or a Prompt by metadata or position; otherwise is a plain outline node.
_Avoid_: bullet, note

**Session-bearer Content Node** (or just "session-bearer"):
A Content Node carrying `metadata.sdkSessionId` — the SDK conversation session it represents. Created two ways: by Cmd+Enter on a Content Node whose parent is not yet a session-bearer (its parent gets stamped), or by Cmd+Shift+B on a Prompt selection (creates a forked session-bearer inside a Branches container). One concept replaces v1's Thread Root.
_Avoid_: thread root, conversation root, topic node

**Branch**:
A forked session-bearer. Same data shape as a top-level session-bearer, plus `metadata.branchedFromMessageUuid` and `metadata.branchedFromNodeId` recording where the fork occurred. Identity is positional: the Content Node's parent is a `branches` container.
_Avoid_: thread, conversation variant

**Branches container** (or just "Branches"):
A `kind: 'branches'` Node that holds Branch siblings. Materializes the moment the user first triggers Cmd+Shift+B inside a subtree; renders default-collapsed; positioned as the immediate next sibling of the source node. Fractal — a Branch's Prompt can itself sprout another Branches container when the user branches inside it.
_Avoid_: forks node, alternatives node

**Prompt**:
A Content Node sent to Claude. Lives somewhere under a session-bearer ancestor; the act of sending (Cmd+Enter) marks it as a Prompt. Parents the Block children Claude returns. Carries `metadata.state: 'streaming' | 'done' | 'cancelled' | 'interrupted'` once sent (absence of state = unsent draft) and `metadata.sdkMessageUuid` (the assistant message it produced — the fork target if a future Branch is created from it).
_Avoid_: message, query, question

**Block Node**:
A child of a Prompt — one structured piece of Claude's output. Subtype via metadata: `text` / `tool_use` / `tool_result`. The unit of fine-grained content. Adjacent matching `tool_use` + `tool_result` pairs render as one collapsible visual unit; tool blocks default-collapsed.
_Avoid_: chunk, segment, part

## Branch verb

One operation creates a forked conversation:

**Branch (Cmd+Shift+B)**:
Eager-fork the SDK session inclusive of the selected Prompt's `sdkMessageUuid`. A Branches container materializes as the immediate next sibling of the source (if not already present); a new Branch is added inside it; the Branch is focused with an empty Prompt child ready to type.

What v1's three verbs map to under this single primitive:
- **v1 Branch** (inclusive of selected Block): select the Prompt the Block lives in, Cmd+Shift+B. Same effect.
- **v1 Retry from here** (exclusive of a Prompt): select the *previous* Prompt, Cmd+Shift+B. The new Branch starts after that previous Prompt, so the user's first prompt under the Branch replaces what the original Prompt had been.
- **v1 New thread sibling** (no history): select the session-bearer or a top-level node, Cmd+Shift+B. The fork-point is "no messages yet," so the Branch is a fresh-history sibling.

The selected source determines the fork depth; the verb is the same.

## Relationships

- A **Node** has zero or more child **Nodes** (Workflowy-style infinite nesting).
- A **Content Node** becomes a **session-bearer** by carrying `sdkSessionId`. The same Content Node carries the conversation-topic text and the session pointer.
- A **Prompt** is a Content Node whose ancestor walk reaches a session-bearer; it parents **Block Nodes** as Claude streams its response.
- A **Branches container** is materialized on first branch in a subtree and holds **Branch** session-bearers as children. It is positioned as immediate next sibling of the source node.
- A **Branch** is structurally a Content Node with session+fork metadata; identity comes from its parent being a Branches container.
- The tree shape is decoupled from the SDK session graph. Each Prompt resumes its nearest session-bearer ancestor's `sdkSessionId`. Rearranging tree nodes (outdent, drag) does not change which session a Prompt resumes — fork relationships are immutable at the SDK layer.

## Flagged ambiguities

(none currently — v1's "Branch" vs "Thread" ambiguity dissolved with the verb collapse and Thread Root removal)

## v1.x slice notes (historical)

Sections below describe the v1 implementation as it landed, slice by slice. ADR-0006 + the Language section above supersede the conversation-tree shape established in slices 2, 4, 5, and 6 (Turn Node, Thread Root, three branch verbs, sibling-Threads-under-Thread-Root). Read the slice notes for context on what was built and why; treat the v1.1 sections at the top of this file as the current model.

## Slice 5 additions

- `threadEngine.branch(sourceBlockId)` — the killer verb. Implemented as a
  thin wrapper over `branchInternal({ sourceBlockId, mode })`; only `mode:
  'branch'` is publicly surfaced in slice 5. Slice 6 adds `retry` and
  `new-sibling` wrappers over the same internal op.
- The new sibling Thread is a Content Node child of the original Thread
  Root, stamped `{ isThreadRoot: true, branchedFromBlockId: <id> }`.
  Cloned history (each prompt + Turn with all blocks, then the source
  Turn with blocks sliced per mode) is appended under it, followed by an
  empty Content Node = the next prompt slot. This satisfies CONTEXT.md's
  "A Thread Root has one or more Threads as direct children — multiple
  Threads exist when branching has occurred."
- `thread.branch` IPC method takes `{ workspaceId, blockId }`, returns
  `{ newThreadId, promptNodeId }`. Renderer focuses `promptNodeId` after
  the call.
- Renderer keymap: `Cmd/Ctrl+Shift+B` over a selected Block triggers
  branch. Block rows aren't contentEditable, so a window-level keydown
  handler dispatches based on `selectedBlockId` state (clicking a Block
  row toggles selection; the `block-selected` class + outline gives a
  visible cue).
- Cross-feature with zoom: when branching while zoomed and the new
  Thread would land outside the current zoom, the renderer clears zoom
  (`onZoomTo(null)`). Per slice 5 issue's option (a) — least surprising.
- E2E hooks: `cedarpadE2E.selectBlock(id|null)` mirrors click-selection,
  `cedarpadE2E.branch(blockId)` fires `thread.branch` and reloads the
  tree. Used by `e2e/webview/specs/branch.spec.ts`.

## Slice 4 additions

- Turn lifecycle: `metadata.state` is one of
  `streaming | done | cancelled | interrupted`.
  `beginTurn` stamps `streaming`; `markTurnDone` (called by the runner on
  natural completion), `markTurnCancelled` (user-driven via `sdk.cancel`),
  `markTurnInterrupted` (crash-recovery scan) are the terminal verbs.
  Slice 3's legacy `cancelled: true` boolean is still set for back-compat.
- `modules/thread/crashRecovery.ts` — `scanInterruptedTurns(store)`
  walks the workspace tree, finds Turn Nodes with `state: 'streaming'`
  (necessarily orphaned since the sidecar process is fresh), and stamps
  them `state: 'interrupted'`. Idempotent. Surfaced as the
  `thread.scanInterrupted` IPC method, called from App.tsx on workspace
  activation.
- Renderer keymap (`src/keymap.ts`):
    - `Cmd/Ctrl+Enter` on a Content Node child of a Thread Root sends
      the prompt to Claude (overrides the toggle-complete binding for
      prompt slots only — other Content Nodes still toggle).
    - `Cmd/Ctrl+Shift+.` cancels the in-flight Turn for the active
      Thread. Distinct from `Cmd+.` (zoom-in).
- Renderer Tree (`src/components/Tree.tsx`):
    - On send: `streamSendPrompt`; reload tree on each `block-complete`
      so Block Nodes appear as they land. On natural completion, auto-
      create a fresh empty Content Node child of the Thread Root so the
      next prompt slot is ready to type into.
    - Visible "Claude is working" indicator while a Turn is streaming;
      pulses + shows the cancel hint.
    - Per-turn visual treatments via `data-turn-state` and CSS
      (`turn-state-streaming` pulse, `turn-state-cancelled` dimmed,
      `turn-state-interrupted` red-tinted with explanatory label).
- E2E hooks: `cedarpadE2E.sendPromptFireAndForget`, `cedarpadE2E.cancel`,
  `cedarpadE2E.createOrphanStreamingTurn`, `cedarpadE2E.scanInterrupted`
  on top of the existing `appendTurn` / `sendPrompt` / `reload` hooks.
- Bug fix: `outline.create` sidecar handler now forwards `kind` and
  `metadata` instead of dropping them — slice 4 is the first caller that
  needs this end-to-end.

## Slice 3 additions

- `modules/auth/keychainStore.ts` — sidecar-side in-memory cache of the
  API key. The OS keychain itself is owned by the Tauri Rust shell via
  the `keyring` crate. Renderer flow:
    1. `authSetApiKey(key)` (Tauri command, not RPC) → Rust writes
       keychain → Rust pushes `auth.injectApiKey` over sidecar stdin.
    2. `authHasApiKey()` → Rust → bool. The renderer never reads the
       key back.
- `modules/sdk/sdkRunner.ts` — wraps `@anthropic-ai/claude-agent-sdk`'s
  `query()` and translates SDK messages into Block Nodes via the Thread
  engine. Read-only allowlist (`Read`, `Grep`, `Glob`) enforced at the
  SDK boundary via `tools` + `allowedTools`. Process recycling and
  cancellation are first-class verbs from day one.
- `threadEngine` grows three streaming verbs: `beginTurn`,
  `appendBlock`, `markTurnCancelled`. The slice 2 `appendTurn`
  (one-shot) stays for fixture turns + the e2e harness.
- Wire envelope grows `{kind:'stream', id, event}` between the sidecar
  and the renderer. Tauri shell forwards stream frames as
  `rpc:stream:<id>` Tauri events; the renderer hooks them up via
  `streamSendPrompt`.
- E2E mode: `CEDARPAD_KEYCHAIN_MEMORY=1` (in-memory keychain),
  `CEDARPAD_E2E_FAKE_SDK=1` (deterministic SDK fake),
  `CEDARPAD_E2E_DEFAULT_KEY` (auto-populates the in-memory keychain
  for non-auth specs). All three are set by the wdio harness.

## Slice 2 additions

- `modules/thread/threadEngine.ts` — composes the OutlineStore. Three verbs:
  `startThread(rootNodeId)` (Content Node → Thread Root via metadata),
  `appendPrompt(threadRootId, content)` (Content Node child of Root),
  `appendTurn(threadRootId, blocks)` (Turn Node child + Block Node grandchildren).
  Sidecar exposes the three as `thread.start` / `thread.appendPrompt` / `thread.appendTurn`.
- Schema v2 widens `nodes.kind` to `content | turn | block`. Migration is
  versioned via `PRAGMA user_version`: fresh DBs land at v2; legacy v1 DBs
  rebuild the `nodes` table inside a transaction (SQLite has no
  ALTER CHECK), preserving rows + FTS index. Idempotent.
- Renderer: `Cmd/Ctrl+Shift+T` over a focused Content Node fires `thread.start`.
  Tree.tsx classifies each Node into a `Visual` and renders five distinct
  styles (content / thread-root / turn / block-text / block-tool-use /
  block-tool-result). Block payloads parse through `BlockMetadataSchema` at
  the rendering boundary — no untyped JSON access.
- Test hook: `window.cedarpadE2E.appendTurn` is exposed by the renderer so
  the WebView e2e (`e2e/webview/specs/thread-root.spec.ts`) can drive a
  fixture turn through the same `thread.appendTurn` IPC the SDK runner will
  use in slice 3.

## Slice 1 module map (v1, in-tree)

Three processes:

1. **Tauri shell** (`src-tauri/`, Rust) — OS window, file picker, sidecar spawn. One `rpc` invoke command; no domain logic.
2. **Bun sidecar** (`src-sidecar/`, TS) — owns all libSQL DBs. Single NDJSON loop over stdio. Validates payloads against `src/contract.ts`.
3. **Renderer** (`src/`, React) — imports the same `contract.ts`, validates IPC at the boundary.

Deep modules (pure TS, TDD'd):

- `modules/outline/ordering.ts` — fractional-indexing wrapper. `keyBetween(prev, next)`.
- `modules/outline/outlineStore.ts` — CRUD on a libSQL handle: `createNode`, `getNode`, `getChildren`, `updateNode`, `deleteNode`, `moveNode`, `searchNodes`.
- `modules/outline/migrations.ts` — idempotent schema bootstrap.
- `modules/workspace/workspaceManager.ts` — `open`/`switch`/`recent`/`active`. Per-repo DB.
- `modules/db/{libsqlClient,txn}.ts` — thin wrappers.

`src/contract.ts` is the **single source of truth** for FE/BE IPC. All cross-process payloads (including JSON-encoded columns like `nodes.metadata`) are described by zod schemas there and validated at every boundary. No hand-maintained interface mirrors.

## DB location (slice 1 resolution of ADR-0005's deferred decision)

- **Workspace DB**: `<repo>/.cedarpad/db.sqlite`. In-tree so it can become commitable for shared team threads later. On first `workspace.open`, `.cedarpad/` is appended to the repo's `.gitignore`.
- **Recents DB**: `~/.cedarpad/global.db`. Single table `recent_workspaces(id, repo_path, display_name, db_path, last_opened_at)`.
