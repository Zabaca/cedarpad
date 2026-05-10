# Claude Code SDK as cedarpad's transport

cedarpad drives Claude through the Claude Code SDK, not the raw Anthropic Messages API. The phrase "new type of Claude Code interface" is taken literally: cedarpad is a frontend for Claude Code, not "yet another app that uses Claude."

## Why

Claude Code already solves: tool use protocol, sandbox/permissions, MCP, hooks, skills, session management, context compaction, file I/O safety, and the agent loop. Reimplementing any of these to talk to the raw API would be months of work for parity that adds nothing to the product story.

The product story *is* the new interface. The tree-with-branching UX replaces the terminal scrollback as how a human navigates a Claude Code session.

## Trade-offs accepted

- **Coupled to Claude Code's session model and SDK.** If Claude Code's interface changes, cedarpad changes with it.
- **Anthropic-only.** Cannot multi-model trivially (would require a parallel transport for non-Claude providers — out of scope for the foreseeable future).
- **Memory-leak risk.** Long Claude Code sessions can grow process memory significantly (known issue). cedarpad must recycle the process per Thread Root or on idle.
- **BYOK is the auth story** — Anthropic has no OAuth-style delegated-auth flow today. Each user supplies their own key.

## Rejected alternatives

- **Raw Anthropic API + custom tool layer.** Loses everything Claude Code already gives us; demands rebuilding tool use, MCP, hooks, sandbox, etc. Rejected as a category error.
- **Hybrid (API for some Threads, SDK for others).** Adds a transport switch the user has to think about. Postponed until there's a concrete reason — e.g. a non-coding Thread mode that doesn't need any tools.
