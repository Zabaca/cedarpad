# Goal-first, one-thing planning

For any planning artifact — PRD, design plan, `/grill-with-docs` session output, `/to-issues` breakdown — name the goal explicitly, then back into the *one thing that, by doing it, makes everything else easier or unnecessary* (Keller & Papasan, _The One Thing_).

## Convention

Every plan artifact opens with two lines:

```
Goal: <one sentence — what success looks like for this episode>
One Thing: <the single highest-leverage step toward the goal>
```

Downstream consequences:

- `/to-issues` orders the resulting tickets so the One Thing is the first tracer-bullet slice. Everything else lines up behind it.
- During execution, "is this the one thing?" is the prioritization test. Work that doesn't serve the One Thing either gets deferred or forces a re-examination of the goal.
- If the One Thing is unclear, the goal isn't specific enough — sharpen the goal first, then re-derive.

## Scope

Applies at the **plan / spec / feature** level. Not per-PR (too small — usually trivial) and not per-sprint (too coarse — too easy to retrofit). The unit is "anything you'd write a PRD or plan for."

## Trade-offs accepted

- Two extra lines of overhead on every planning artifact
- Forces an explicit goal even when "we just need to do X" feels obvious — sometimes friction
- Risks under-investing in parallel non-One-Thing work that's still valuable; mitigated because the goal can be re-named for a new episode

In return: plans stop sprawling; PR scopes have a defensible reason to exist; reviewers and AFK agents have a single sentence telling them what's load-bearing.
