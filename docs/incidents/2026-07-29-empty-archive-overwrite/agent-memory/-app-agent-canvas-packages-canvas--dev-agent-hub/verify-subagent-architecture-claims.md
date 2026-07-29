---
name: verify-subagent-architecture-claims
description: "Spot-read primary files before acting on a search-subagent's architectural characterization (monolith/coupled/not-extracted)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5561318f-c4c3-4781-9825-e144b1f1bc85
---

Before presenting OR acting on a subagent's *characterization* of architecture ("X is a monolith", "concern Y lives inline / isn't extracted", "these are tangled"), read the primary file myself — at minimum its import block.

**Why:** On the 2026-07-13 architecture-explore run, an Explore subagent reported `bridge.ts` as a "1020-LOC monolith conflating session registry + turn + web-poc + persistence" that needed splitting. I presented it as candidate #6, recommended it as the keystone, and built a two-turn leverage thesis on it — all before reading `bridge.ts`. In reality `bridge.ts:19,31` *import* `createSessionRegistry` and `runTurn`/`TurnDeps` from already-extracted, separately-tested modules (`canvas-sessions.ts`, `turn.ts` + `turn.test.ts`); the server was already 21 tested modules. The whole candidate was void. Excerpt-reading subagents conflate "imported from an extracted module" with "defined inline here" — they see the composition/wiring and miss the seam behind it. The Explore agent's own description warns it's for locating code, NOT for code review or cross-file architectural analysis.

**How to apply:** (1) Use search subagents to *find* files, not to *judge* structure. (2) For any load-bearing structural claim, Read the file (or its imports) before it leaves my mouth as a finding. (3) `wc -l` confirms size, never coupling — don't let a cheap confirmed fact (1020 lines was real) stand in for the expensive unverified one (that size == tangle). (4) Verify before recommending, not after the human pushes back. Ties to CLAUDE.md guideline #1 (don't assume, surface confusion).
