# Declined candidates (dev-agent dedup markers)

One file per candidate a human has **declined** in a dev-agent grill thread (issue #184).
The dev-agent's explore run reads this directory and DROPS any candidate matching a marker,
so a declined idea never costs a human interaction twice.

Markers are written by the dev-agent itself, in its worktree, when the human declines —
shipped piggybacked on an open run PR or as a marker-only micro-PR. Written by humans too,
if you want to pre-emptively veto a category.

Format — `<candidate-slug>.md`:

```markdown
# <candidate title>

- Date: YYYY-MM-DD
- Reason: <one line — why the human declined>
- Match hints: <files/modules/phrases a future explore would use to recognize this candidate>
```

Markers record **human declines only**. Candidates the agent DROPs on its own live in the
run's decision record (the closing `end_turn` summary), not here. Deleting a marker
re-opens the candidate.
