---
name: execute-prd
description: Take a published PRD issue and dispatch TDD sub-agents in worktrees to implement its tracer-bullet child issues end-to-end. Discovers children from the issue tracker, builds a dependency graph from each child's "Blocked by" section, dispatches parallel-safe slices in background, and merges PRs in dependency order. Use when the user wants to execute a PRD, ship the issues for a PRD, run AFK on a PRD, or pipeline /to-prd → /to-issues → /execute-prd.
---

# /execute-prd

Final stage of the PRD pipeline. `/to-prd` produces a PRD issue; `/to-issues` breaks it into tracer-bullet slices; `/execute-prd` dispatches sub-agents to implement them.

## Quick start

```
/execute-prd 29
```

Argument: the PRD issue number. Skill discovers children, builds dep graph, dispatches.

## Workflow

1. **Validate input**
   - `gh issue view <prd>` — confirm it looks like a PRD (has Problem Statement / Solution / Acceptance Criteria sections).
   - Bail with a clear error if the issue doesn't look PRD-shaped.

2. **Discover children**
   - `gh issue list -R <repo> --search "<prd> in:body" --json number,title,body,state --limit 50`
   - Keep issues whose body contains `## Parent\n#<prd>` (case-sensitive header match).
   - Reject closed/merged children unless user opts in.

3. **Build dependency graph**
   - For each child, parse `## Blocked by` section. Each line is `- #<n> ...` or `#<n>`.
   - Build topological levels. Surface a cycle as an error — do not auto-resolve.

4. **Confirm before dispatch**
   - Print: dep-ordered phase list (Phase 1: foundation; Phase 2: parallel; …), PR target branch, agent model (opus).
   - Wait for user OK. Don't auto-proceed.

5. **Dispatch phase-by-phase**
   - For each phase, spawn one Agent call per slice in a single message (parallel within phase, sequential across phases).
   - Each Agent call: `isolation: "worktree"`, `run_in_background: true`, `model: "opus"`, prompt from `DISPATCH-PROMPT.md`.
   - Track agent IDs in tasks (TaskCreate per slice, status `in_progress`).

6. **Handle completion notifications**
   - On task-notification: `gh pr view <N> --json mergeStateStatus,state,title` to check state.
   - If green + acceptance criteria covered → `gh pr merge <N> --squash --delete-branch`. Pull main. `git worktree remove .claude/worktrees/<dir> -f -f` and `git branch -D <branch>`.
   - If `BEHIND` after a peer merge → SendMessage to agent: "main has moved (commit <hash>), please rebase against origin/main and force-push." Do NOT rebase from orchestrator.
   - If gaps → SendMessage with the specific gap quoted from the issue's acceptance criteria. Never dispatch a duplicate agent.

7. **Status report**
   - When all slices merged: print commit hashes, aggregate test counts, manual-verification checklist (derived from PRD's Acceptance Criteria).

## Rules

- **Default model**: opus. No effort knob — the Agent tool doesn't expose one.
- **One agent per slice.** SendMessage for follow-ups, never re-spawn.
- **Don't read agent output JSONL files** — they overflow context. Use task-notification result.
- **Check `git status` before exiting** — stop-hook fails on uncommitted state.
- **Respect CLAUDE.md** — the agent reads it in its worktree; the dispatch prompt does not repeat it.

## Templates and edge cases

- Per-slice dispatch prompt: [DISPATCH-PROMPT.md](DISPATCH-PROMPT.md)
- Rebase loops, missing deps, agent stuck: [EDGE-CASES.md](EDGE-CASES.md)
