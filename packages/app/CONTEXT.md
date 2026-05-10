# App

The cedarpad application: a Workflowy-style outliner where any outline node can become the root of a Claude conversation, with the conversation living as descendant nodes in the same tree. Branching, retrying, and forking conversations are first-class operations on the tree.

**v1 shape:** Tauri desktop app. UI (WebView) + Claude Code SDK runner + libSQL store all bundled in one binary. Fully offline-first; no Vercel deployment in v1 (`production` env stays empty until v2 cloud sync). libSQL chosen specifically so v2 can enable Turso embedded replicas for cloud sync without a data-model rewrite.

## Language

**Node**:
The single primitive — a position in the tree with text content, addressable, branchable, zoomable. Every other concept is a kind of Node or a relationship between Nodes.
_Avoid_: bullet, item, line, entry

**Content Node**:
A human-authored outline Node — Workflowy-style text, no conversation attached. The default kind of Node.
_Avoid_: bullet, note

**Thread Root**:
A Content Node from which a conversation has been started. Its descendants form a conversation subtree.
_Avoid_: parent, anchor, conversation start

**Turn Node**:
One Claude turn rendered as a Node. Its children are the structured blocks of that turn (text, tool call, tool result). Lives only inside a Thread Root's subtree.
_Avoid_: message, response, reply

**Block Node**:
A child of a Turn Node — one structured piece of Claude's output (a paragraph, a code block, a tool call, a tool result). The unit of fine-grained addressing.
_Avoid_: chunk, segment, part

**Thread**:
The subtree rooted at a Thread Root. Synonym for "conversation" — but Thread is the canonical term because the same Thread Root may have multiple sibling threads via branching.
_Avoid_: chat, conversation, session

## Branch verbs

Three operations create new subtrees from a Node inside a Thread. They differ only in what prior context is sent to Claude on the next turn:

**Branch**:
Fork the conversation at this point with full history *including* this Node. "What if Claude had continued differently from here?" The unique-to-cedarpad capability — cheap because the tree makes forking natural.

**Retry from here**:
Fork with full history *up to but excluding* this Node. Re-do this turn with a different prompt or seed. Equivalent to "regenerate" / "edit and resend" in linear chat tools.

**New thread sibling**:
Start a fresh Thread under the same Thread Root, no conversation history. "New conversation, same topic seed."

## Relationships

- A **Node** has zero or more child **Nodes** (Workflowy-style infinite nesting)
- A **Content Node** becomes a **Thread Root** when a conversation is started on it; it remains a Content Node otherwise
- A **Thread Root** has one or more **Threads** as direct children — multiple Threads exist when branching has occurred
- A **Thread** consists of alternating human prompts (Content Nodes) and **Turn Nodes**
- A **Turn Node** has **Block Nodes** as children, mirroring Claude's structured response

## Flagged ambiguities

- "Branch" and "Thread" overlap in casual speech. **Resolution**: a Thread is the subtree (a noun); to Branch is to create a new Thread (a verb). Branching produces a new Thread.

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
