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
