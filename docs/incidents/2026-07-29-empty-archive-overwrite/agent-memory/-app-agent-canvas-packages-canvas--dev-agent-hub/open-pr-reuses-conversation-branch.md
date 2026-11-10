---
name: open-pr-reuses-conversation-branch
description: open_pr reuses the one conversation branch as the PR head — so a run cannot cleanly ship multiple independent one-candidate PRs
metadata: 
  node_type: memory
  type: project
  originSessionId: 27719e6c-52c8-4544-999c-8cb42506aef2
---

`mcp__canvas__open_pr` commits the worktree's uncommitted diff onto the **conversation's single branch** (`dev-agent/<run-id>`) and opens/updates the PR from that branch → `main`. Observed 2026-07-13: after opening PR #191, the conversation branch itself advanced to the PR commit and was pushed as the PR head.

**Why:** a dev-agent conversation = one worktree = one reused branch (ADR-0003 / ADR-0011). The branch IS the PR head.

**How to apply:** the architecture-explore run's "one PR per candidate" is in tension with this — a second `open_pr` in the same run advances the same branch and would fold the second candidate into the first PR (GitHub allows one open PR per head→base). So in practice a single run ships **at most one EXECUTE PR cleanly**. If multiple candidates are EXECUTE-ready, ship the strongest and record the rest as execute-ready deferrals for a later run (each gets its own fresh conversation/branch). Do NOT reset/force-push the branch to separate them — that rewrites the already-opened PR. Relates to [[verify-subagent-architecture-claims]].
