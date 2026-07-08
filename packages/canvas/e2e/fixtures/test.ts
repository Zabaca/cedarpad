/**
 * Project-local Playwright `test` re-export.
 *
 * Specs import `test` / `expect` from here rather than from `@playwright/test`
 * directly, so future per-project fixtures (an E2E_MODE auth cookie, a seeded
 * workspace, multi-context page pairs) can be added in one place without
 * rewriting every spec. When you add a fixture, extend the base `test` rather
 * than replacing it, and document it in `.claude/skills/worktree/SKILL.md`.
 */
export { test, expect } from '@playwright/test';
