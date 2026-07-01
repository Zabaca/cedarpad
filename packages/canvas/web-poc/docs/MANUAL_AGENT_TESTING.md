# Manual agent testing — be the LLM, no API keys

Two ways to run the agent flows by hand, with **no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`**:

| Role (see `AGENT_GRAPH_ACCESS.md`) | What it is | How you drive it |
| --- | --- | --- |
| **Internal LLM agent** | The in-process reasoner (`classify` / `synthesize` / `draftProblem`) | The **bridge**: each call is written to a file and the pipeline blocks until you answer it. |
| **External API agent** | A REST client that queries the graph (`x-api-key`, or the dev bypass) | The **`external-agent` CLI**: you call the read-only graph endpoints and reason a solution. |

Both require the **bun** dev server (`dev:node`), not `wrangler dev` — the bridge touches the
filesystem, which Workers don't have. Embeddings still use the deterministic hash embedder, so no
embedding key is needed either.

> **Prefer the slash command:** the `/agent-sim` Claude Code command automates everything below
> (preflight, watch, answer, repeat). See [`AGENT_SIM.md`](./AGENT_SIM.md) — including `/loop /agent-sim`
> for hands-off draining and how to install the command in another environment. This doc is the manual
> fallback / reference for what the command does under the hood.

---

## 1. Internal LLM agent (the bridge)

### Start the API with the bridge on

From the repo root (stop any existing API on 8787 first):

```bash
AI_BRIDGE_DIR=.agent-bridge TURSO_DATABASE_URL="file:local.db" PORT=8787 \
  bun apps/api/scripts/dev-server.ts
```

The startup banner prints `Agent reasoner: MANUAL BRIDGE → .agent-bridge`. Keep the Vite web app
(`bun --filter @cedarpad/web dev`) running as usual; it proxies to 8787.

### Trigger a run, then answer it

Intake is **async** (see `ASYNC_PIPELINE.md`): adding/reprocessing/synthesizing enqueues an
`agent_jobs` row and returns instantly. The dev server auto-spawns a **worker** that drains the
queue; with the bridge on, each reasoner call blocks **the worker** (not the web request) until you
answer it.

1. In the web app, **add an observation/problem** (or click **Reprocess** on an existing one, or
   **Synthesize** from selected observations). The modal closes immediately and the item shows
   "Agent is processing…"; the worker is now blocked on the bridge waiting for you.
2. See what's pending:
   ```bash
   bun apps/api/scripts/ai-bridge.ts            # = `list`
   ```
   Each entry shows the `method`, the system prompt, the exact `input`, the required response shape,
   and a fill-in example.
3. Answer it (JSON via a file or stdin):
   ```bash
   echo '{"classifications":[{"candidateId":"prob_demo_2","kind":"related","confidence":0.6,"rationale":"same area"}]}' \
     | bun apps/api/scripts/ai-bridge.ts answer <id>
   ```
   The pipeline picks up the answer on its next poll (≤0.5s) and continues. A problem intake makes
   **two** calls in sequence — `classify` then `synthesize`; answer both.

Answers are validated against the same Zod schemas the real reasoner uses, so a malformed answer is
rejected (the call keeps waiting). Completed exchanges are archived under `.agent-bridge/archive/`.
Each call times out after 15 min (`AI_BRIDGE_TIMEOUT_MS` to change).

> **Letting Claude Code be the LLM:** point Claude at this repo and say *"drain the agent bridge."*
> It runs `ai-bridge.ts list`, reasons over each request, and writes the answer files.

---

## 2. External API agent (the graph consumer)

With the dev server up (bridge optional here), drive the read-only, cross-workspace graph endpoints
the way a third-party agent would. Auth uses the `x-dev-workspace` bypass by default — set
`AGENT_API_KEY` to use a real `x-api-key` instead.

```bash
bun apps/api/scripts/external-agent.ts problems "checkout"      # find a target problem id
bun apps/api/scripts/external-agent.ts search "payment timeout" # /v1/graph/search
bun apps/api/scripts/external-agent.ts context <problemId>      # edges + solutions
bun apps/api/scripts/external-agent.ts neighborhood <problemId> # bounded subgraph
bun apps/api/scripts/external-agent.ts solved <problemId>       # nearest solved neighbours
```

Env: `BASE` (default `http://localhost:8787`), `WORKSPACE` (default `ws_demo`), `AGENT_API_KEY`
(optional). A natural manual flow is `search → context → neighborhood → solved`, then write the
solution you'd return.

---

## Turning it off

Restart the API **without** `AI_BRIDGE_DIR` and the reasoner returns to its normal selection
(heuristic with no key, real LLM when a provider key is present).

---

## Realtime (optional) — live UI updates while you test

The web app updates live via **Ably** when both keys are set. Without them, publish and
subscribe both no-op (the app still works; you just refresh manually):

- **Web (subscriber):** `VITE_ABLY_KEY` in `apps/web/.env.local` (Vite loads it from `apps/web/`).
- **API (publisher):** `ABLY_API_KEY` — for this manual `dev-server.ts` path it must live in the
  **repo-root** `.env.local`. The launch command runs `bun apps/api/scripts/dev-server.ts` from the
  repo root, and bun only auto-loads `.env.local` from its launch cwd — so a key in
  `apps/api/.env.local` is **not** read here. (The `wrangler dev` path reads `apps/api/.dev.vars`
  instead.)

Both servers read env only at startup, so **restart** after setting the keys. The realtime view
subscribes to every workspace currently on screen — the scoped one, or all accessible workspaces in
"All workspaces" view — so an insert into any visible workspace appears without a refresh.
