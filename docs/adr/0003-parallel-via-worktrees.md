# Parallel-via-worktrees as the default development model

cedarpad commits to parallel git-worktree development as the default, not an occasional pattern. Every non-trivial feature, ticket, or experiment runs in its own worktree — provisioned by `create-worktree-friendly` tooling, with per-worktree DB, dev port, and e2e port — so multiple AI agents (and humans) can work concurrently without colliding.

## Why

The principle in CLAUDE.md §5 (AI is the implementer) makes the bottleneck human-decision throughput, not AI keystroke throughput. Maximising throughput means having many AI workers in flight at once. Sequential development on a single working tree caps that at one. Worktrees lift the cap.

## Trade-offs accepted

- Every dev-touching primitive (server, DB, test runner, cache) must be worktree-aware. Hardcoded ports and shared dev DBs are bugs (CLAUDE.md §6).
- Slightly more setup per ticket: `/new-worktree <ticket>` instead of `git checkout -b`.
- Higher local resource use — multiple dev servers, multiple DBs.
- Tooling maintenance: the `create-worktree-friendly` scaffold becomes part of the project's contract; breaking it breaks parallel work for everyone.

## Rejected alternatives

- **Single working tree, branches only.** Forces sequential AI work. Rejected: directly contradicts §5.
- **Dev containers per branch.** Heavier per-environment, slower spin-up, harder to share host tooling. Worktrees are lighter and integrate with the existing git mental model.
- **Worktrees as opt-in for "big" features.** Half-measure — code written without worktree-safety creeps in and breaks parallel work later. Default-on forces the discipline at write-time.
