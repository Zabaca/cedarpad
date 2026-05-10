# Edge cases for /execute-prd

## Agent reports a PR but acceptance criteria are incomplete

SendMessage to the agent with the specific gap quoted from the issue's acceptance criteria. Don't dispatch a fresh duplicate.

```
{"to": "<agent-id>", "summary": "missing AC item", "message": "PR is open but acceptance criterion N ('<quote>') isn't covered. Please add and push to the same branch."}
```

## PR is BEHIND after a peer merge

Check `gh pr view <N> --json mergeStateStatus`. If `BEHIND`:

```
{"to": "<agent-id>", "summary": "rebase needed", "message": "main has moved (commit <hash>) since you opened this PR. Please rebase your branch against origin/main and force-push."}
```

Do NOT rebase from the orchestrator session. The agent's worktree is the correct place — its build cache, test runs, and any in-flight uncommitted state live there.

## Cycle in dependency graph

If `Blocked by` references form a cycle (#A blocked by #B, #B blocked by #A), surface the cycle and stop. Do not auto-resolve — this is a `/to-issues` authoring bug to fix at the source.

## Child issue is missing `## Blocked by`

Treat as unblocked (Phase 1 candidate). Print a warning so the user can spot a `/to-issues` regression.

## Agent goes silent (no notification after dispatch)

The Agent tool docs say "you will be notified when it completes." If a long time passes with no notification and the user asks, say the agent is still running. Don't proactively probe its output file.

## Worktree cleanup fails

`git worktree remove <dir> -f -f` can fail if the agent has uncommitted state. After a successful merge, this shouldn't happen — if it does, surface the error and let the user decide whether to discard.

## User wants to dispatch only a subset

If invoked as `/execute-prd 29 --only 30,32`, restrict the slice set to those issues. Still respect `Blocked by` deps — fail loudly if a requested slice has an unmet dep outside the subset.

## Child issue is closed

Skip it (already implemented). If ALL children are closed, surface that the PRD looks done and exit without dispatching.

## PR fails CI checks

If `gh pr checks <N>` shows failures after the agent reports completion, SendMessage with the failed check name and a one-line summary of the failure. Don't try to debug from the orchestrator — the agent has the full repo state.
