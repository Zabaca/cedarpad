# Per-slice dispatch prompt template

Fill in `<ISSUE_NUMBER>`, `<OWNER>/<REPO>`, `<PRD_TITLE>`. Other context the agent gathers itself from its worktree.

---

You are implementing slice #<ISSUE_NUMBER> of <PRD_TITLE>. Working in a fresh git worktree branched from origin/main.

**Source of truth — read first:**
- `gh issue view <ISSUE_NUMBER> -R <OWNER>/<REPO>` for the full slice spec, acceptance criteria, TDD test list, and file inventory. Treat the body as the contract.
- The repo's `CLAUDE.md` for hard rules (think before coding, simplicity, surgical changes, worktree-safe, single contract).
- Any ADRs referenced from the issue body.

**Your job:**
1. Implement the slice using TDD (red → green → refactor). Use the test modules listed under the issue's "TDD modules" section if present.
2. Open a PR against `main`, ready for review (NOT draft).
3. PR description includes: verification commands run, test counts (unit + e2e), and an acceptance-criteria checklist copied from the issue.

**Before opening PR:**
- Type checking / Rust check pass.
- Full unit test suite green.
- At least one e2e spec exercises the slice's user-facing affordance (the issue specifies which).

**Operational rules:**
- Conventional Commits style; match `git log --oneline -20` for format.
- Branch name: descriptive (`feat/<slug>`, `refactor/<slug>`).
- Never skip pre-commit hooks. If a hook fails, fix the root cause and create a NEW commit (not `--amend`).
- Do NOT merge the PR yourself — the orchestrator will merge after review.
- If a requirement is genuinely ambiguous, post a `gh issue comment` on the slice issue asking the question. Otherwise pick the simpler interpretation and note it in the PR.

**Worktree-safety reminders (CLAUDE.md §6):**
- Read ports from env (`PORT`, `E2E_PORT`). Don't hardcode.
- DB names include the worktree. Don't share fixed dev DBs.
- Don't write to fixed `/tmp` paths.

Output: a tight PR matching the issue body. No scope creep.
