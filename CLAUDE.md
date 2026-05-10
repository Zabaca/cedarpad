# cedarpad

## Guidelines

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### 5. AI Is the Implementer

Assume AI is doing the coding. Humans are not coding. Reframe complexity, difficulty, and estimates accordingly — human-centric framings produce wrong plans here.

| Dimension | Human framing | Reframe |
| --- | --- | --- |
| **Complexity** | Lines, layers, mental load. A 2000-line refactor is "complex." | *Ambiguity*. A 2000-line mechanical refactor is trivial; a 20-line change with one fuzzy requirement is hard. Measure as: decisions that can't be made from local code + tests + spec. |
| **Difficulty** | Novelty, skill required. New framework = "hard." | *External judgment AI can't supply*. Hard = needs product calls, access to systems AI can't see, values AI can't infer. New framework alone isn't hard — AI reads docs. |
| **Time / estimates** | Days/weeks at human pace, gated by attention. "Two weeks." | *Units of human input required*, not units of AI work. "Two weeks" → "3 issues, ~1 tool-loop each, gated on 2 product decisions." The bottleneck is human-decision throughput. |

Implication: plan estimates name the number of human-decision gates and clarifying questions, not wall-clock time. Issues marked `ready-for-agent` are by definition zero-gate.

### 6. Worktree-Safe by Default

Assume every change runs in a parallel git worktree alongside other copies of itself. No singletons that would collide:

- **Ports**: read from env (`PORT`, `E2E_PORT`), never hardcode.
- **Databases**: name includes the worktree (`${PROJECT}-${WORKTREE}`), never share a fixed dev DB.
- **Tests**: no shared fixtures across processes, no fixed `/tmp` paths.
- **Caches and locks**: scope to the worktree, not the user.

If a feature can't run alongside a copy of itself in another worktree, it's not worktree-safe — fix it before merging. Background: ADR-0003.

## Agent skills

### Issue tracker

Issues are tracked on GitHub at `Zabaca/cedarpad` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout: `CONTEXT-MAP.md` at the root points to per-package `CONTEXT.md` files under `packages/`. See `docs/agents/domain.md`.
