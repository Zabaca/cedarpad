---
name: project-promote-component-not-durable
description: promote_component's write to shared/components/ has been confirmed to silently fail/not land, causing placed instances to fall through to an unrelated read-only platform-tier component of the same name
metadata:
  type: project
---

`mcp__canvas__promote_component` is supposed to *move* a component from this canvas's own directory into the workspace-wide `shared/components/` folder so any canvas can place it. Confirmed by direct testing (not just inference): after promoting `MarkdownCard`, `shared/components/` on disk contained only `.gitkeep` — the promoted file never durably landed there, even though the tool call itself reported success and reloaded other canvases.

**Why this matters:** because promotion *removes* the component from this canvas's own directory (tier 1) as part of the move, a failed/lost write to the shared tier (tier 2) means resolution falls through to tier 3 — the **read-only platform library** (`src/canvas-components/`), a large pre-existing library shared by every canvas. If the platform tier happens to already have a component with the same name (true for `MarkdownCard`, and likely others — `DiscussionThread`, `IssueCard`, `Kanban`, etc. all pre-exist there), placed instances silently start rendering that unrelated component instead — different props, different styling, broken-looking output, no error thrown. This is what the user observed: three placed "MarkdownCard" proposal cards went dark-themed and mostly blank after promotion, because the old platform `MarkdownCard` expects a `markdown` prop, not the `title`/`subtitle`/`body` props the proposal cards were passing.

See [[feedback_use_write_component_tool]] for the three-tier resolution model and why filesystem inspection is unreliable for diagnosing this — use `read_component` to see the actually-resolved live source, not `Bash`/`Read` on disk paths.

**How to apply:**
- Treat `promote_component` as currently broken/unreliable — do not use it to make a component available to other canvases until this is independently reverified as fixed.
- If a component must exist standalone in this canvas, just use `write_component` in this canvas's own directory (tier 1) and leave it there; don't promote it.
- If a placed component instance suddenly renders with unfamiliar styling/props after a promote_component call, immediately suspect this exact failure mode: re-run `write_component` with the correct source to re-establish the tier-1 shadow (this fixed it in practice — re-verify with `read_component`).
- This is a platform/infra bug in `promote_component`'s write path, not fixable from within the `src/canvas-components/` + `server/custom/` authoring boundary — flag it to whoever owns the canvas backend.
