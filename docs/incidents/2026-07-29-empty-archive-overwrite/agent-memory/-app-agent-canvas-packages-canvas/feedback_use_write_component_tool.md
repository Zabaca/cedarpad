---
name: feedback-use-write-component-tool
description: Always use mcp__canvas__write_component/edit_component/read_component/list_components (never raw filesystem tools) to author or verify canvas components — direct filesystem paths are misleading in this environment
metadata:
  type: feedback
---

When authoring canvas components, always use the dedicated canvas MCP tools — never the generic filesystem `Write`/`Edit`/`Read`/`Bash` tools — even to just *check* what's live. This app resolves a component name through three tiers, in priority order:

1. **This canvas's own directory** — a per-canvas UUID path like `src/canvas-cv_<id>/components/` (NOT `src/canvas-components/`). This is where `write_component`/`edit_component` actually write.
2. **Workspace shared library** — `shared/components/`, populated by `promote_component`. See [[project_promote_component_not_durable]] — this tier has been observed empty/broken.
3. **Read-only platform library** — `src/canvas-components/` (confusingly similar-looking path to tier 1, but a different, pre-existing, shared-across-every-canvas directory full of components you never authored: `MarkdownCard`, `DiscussionThread`, `IssueCard`, `Kanban`, and dozens more). Falls back here if tiers 1 and 2 don't have the name.

**Why this matters:** Using the plain filesystem `Write` tool on `src/canvas-components/<Name>.tsx` silently writes into the read-only platform tier's path, not your own canvas's actual directory — it does not register with the canvas backend, and `list_components`/the browser both fail to reflect it ("Failed to fetch dynamically imported module" 404). Separately, inspecting `src/canvas-components/` via `Bash`/`Read` is actively misleading even for verification: it shows the read-only platform tier's content, NOT necessarily what a component named the same thing actually resolves to live (which depends on tiers 1 and 2 too). A file's mtime/content on that path tells you nothing about your own canvas's shadow copy.

**How to apply:**
- Author/edit: only `write_component` (full file) or `edit_component` (targeted diff).
- Verify what's actually live: only `read_component` (returns the resolved, live source through all three tiers) and `list_components`. Never trust `Bash`/`Read`/`find`/`stat` on `/app/agent-canvas/packages/canvas/src/canvas-components/` or `shared/components/` as evidence of what a placed instance renders — confirmed in practice to diverge from the live resolved source.
- If a placed component shows a "Failed to fetch dynamically imported module" error, or renders with unexpected props/styling you didn't write, suspect a tier-resolution issue first (wrong tool used, or fell through to the platform tier) — check with `read_component`, not the filesystem.
