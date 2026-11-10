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

### 7. Single Contract for FE/BE

All cross-process boundaries (renderer ↔ Tauri ↔ sidecar, sidecar ↔ external services, persisted JSON) share a single zod-defined contract. One file (or one scoped contract module) holds every method's input and output schemas. Both sides import from it; both sides parse at the boundary.

- Type safety end-to-end via `z.infer<typeof Schema>` — no hand-maintained `interface` mirrors that drift.
- JSON fields stored in libSQL (or any text-as-JSON column) are typed by zod schemas in the same contract module. Encode at write, parse-and-validate at read. Never let raw JSON cross a module boundary.
- A schema change is a contract change is a deliberate code-review event. No silent drift between sender and receiver.

Why: IPC payloads, future sync messages, and persisted JSON are all "data crosses a trust boundary" moments — the same moments that drive most subtle bugs. One source of truth means renames, additions, and removals are mechanical refactors, not archaeology.

## Running the tests

`packages/canvas` has **three** test runners. Use the package scripts — never a bare runner invocation.

| Scope | Runner | Command |
| --- | --- | --- |
| `server/`, `src/`, `shell/`, `worker/` | `bun test` | `bun run test` |
| `web-poc/` (the platform data layer) | **vitest** | `bun run webpoc:test` |
| `e2e/` | Playwright | `bun run test:e2e` |

**Do not run bare `bun test`.** Its default glob also collects `web-poc/`'s **vitest** specs and runs them under the wrong runner, producing ~10 spurious failures in `conversations` / `mcp-tokens` query round-trips. They are not real — those files pass under `webpoc:test`. `bun run test` is scoped to exclude them, and `bun test` exposes no ignore option, so the script is the only guard.

Typechecking is likewise split: `bun run typecheck` covers canvas + the edge Worker; `web-poc` needs `bun run webpoc:typecheck` separately. A change to the platform data layer's types is only fully checked once both have run.

## Agent skills

### Issue tracker

Issues are GitHub issues, driven by the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Multi-context layout: `CONTEXT-MAP.md` at the root points to per-package `CONTEXT.md` files under `packages/`. See `docs/agents/domain.md`.
