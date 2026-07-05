# Design: AI-Agent Access to the Knowledge Graph

> Status: **Tier 2 + Tier 3 implemented**, hybrid write-time classifier shipped (2026-06-23). See §9.
> Related: `CONTRACT_ARCHITECTURE.md`, `CONFIGURATION.md`, `IMPLEMENTATION_PLAN.md`, `SIMILARITY_SCALING.md`.
>
> **Retrieval is an exact brute-force cosine scan, not ANN.** The "ANN" wording below is historical — the
> `libsql_vector_idx` index was dropped (2026-06-26) for a full `vector_distance_cos` scan, and pre-prod Turso
> mitigations shipped 2026-06-29 (archived-row exclusion, config-gated recency window, scan-latency telemetry,
> single cosine per row). Heavier levers are on hold. See `SIMILARITY_SCALING.md` for the full rationale.

## 0. What shipped

Tier 2 (vector + structural edges, exposed as bounded tools) is built end-to-end:

- **`packages/config`** — `graph` config section (`defaultK`, `defaultHops`, `maxHops`, `maxNodes`). The graph is cross-workspace by design — there is no scope type or param.
- **`packages/db`** — cross-workspace retrieval over existing rows (no LLM at read time):
  - `findSimilarProblems` / `findSimilarObservations` — ANN over every workspace (identicalness is cross-tenant).
  - `searchGraph` — ANN hits annotated with link kinds + accepted-solution flag.
  - `getProblemContext` — node + both-direction edges (kind/similarity/**rationale**) + solutions.
  - `neighborhood` — bounded multi-hop subgraph via `WITH RECURSIVE` over `problem_links`.
  - `findSolvedNeighbors` — nearest neighbours that already have an accepted solution.
  - Tests: `queries/graph.test.ts`.
- **`packages/contract` + `apps/api`** — REST endpoints for external (`x-api-key`) agents: `GET /v1/graph/search`, `/v1/problems/{id}/context`, `/v1/problems/{id}/neighborhood`, `/v1/problems/{id}/solved-neighbors`. Reads span every workspace (a root problem from any tenant is reachable); traversal bounded by `graph` config. Tests in `apps/api/src/app.test.ts`.
- **`packages/ai`** — `createGraphTools` (AI SDK `tool()` defs) for in-process LLM agents, wired to Drizzle via `createGraphToolDeps` in `apps/api/src/agent.ts`. Plus the §5 change: `getNeighborhoodContext` port feeds linked-problem context into `reasoner.synthesize`.

### 0a. Follow-on work (also shipped)

- **Tool-calling synthesis loop.** `createAiReasoner(model, { tools })` now runs `generateText` with the graph tools + `experimental_output` (structured `SynthesisResult`) under a `stepCountIs` budget, so when a provider key is present the agent explores the graph (search → expand → solved-neighbors) mid-synthesis. `createPipelineDeps` (`apps/api/src/agent.ts`) is the single wiring point: ports + reasoner (with tools when keyed) + embedder + run config. No key ⇒ heuristic path, no tools.
- **Eval harness.** `apps/api/src/eval.ts` runs the real pipeline over a golden fixture and scores **link recall** + **reuse accuracy**. Deterministic on the no-key path (hash embedder + heuristic) → guarded by `eval.test.ts`; `bun --filter @cedarpad/api eval` prints the report and (with keys) exercises the LLM tool loop.
- **Human GraphView wired to bounded endpoints.** `apps/web` GraphView now supports click-to-focus: selecting a problem switches from the whole-workspace graph to its bounded `neighborhood`, with a side panel showing the stored edge **rationale** + solutions from `getProblemContext` — dogfooding the same queries the agent uses.

## 1. Goal (corrected intent)

The primary consumer of the knowledge graph is the **AI agent**, not a human. Agents need to access the graph(s) to understand existing problems, solutions, and the connections between them — quickly and cheaply — so they can find relevant prior work and formulate better solutions.

The human React Flow view (`apps/web/.../GraphView.tsx`) is a **nice-to-have** for visual inspection and stays as-is, reading the same underlying data.

Two hard constraints:
- **Speed:** the agent must find connections fast (low read latency).
- **Cost:** generating/maintaining the graph must not be token- or compute-expensive. If a full graph is too costly, prefer a cheaper way to deliver the same graph knowledge.

## 2. Core principle: the graph is *data*, not a generated artifact

There are two meanings of "knowledge graph," and conflating them is the cost trap:

| Kind | How it's built | Cost | Fit for Cedarpad |
|------|----------------|------|--------------|
| **LLM-extracted semantic graph** (GraphRAG, what `/graphify` did to the codebase) | run an LLM over a corpus to infer entities + relations | high tokens, slow, goes stale → must re-extract | ❌ avoid for product data |
| **Structural graph derived from stored rows** | read edges you already persist | ~free, always fresh | ✅ this is what Cedarpad already has |

Cedarpad already persists the graph as first-class rows, written **once at intake**:
- `problem_links` — `kind` (identical/partial/related), `similarity`, **`rationale`**, `createdBy` (`packages/db/src/schema.ts`). `observation_links` carry the same shape for observation↔observation similarity, and `observation_problems` records observation→problem synthesis edges.
- `solution_links` — the polymorphic "solves" edges (`target_kind` observation|problem, `target_id`).
- `problems` / `observations` / `solutions` — nodes, each with a `F32_BLOB(1536)` embedding for semantic adjacency (observations are now embedded and similarity-linked just like problems).

**There is nothing to "generate" with an LLM at read time.** The work is to *expose the rows we already store as agent-navigable retrieval*. This removes essentially all of the generation-cost concern.

## 3. Cost model — where spend actually happens

Edges are written once per problem and read many times, so cost is amortized at write time. Read time should be **pure retrieval (indexed SQL + ANN), zero LLM** — which is also what makes it fast.

| Spend | When | Lever |
|------|------|-------|
| 1 embedding | per problem (intake) | batch via `embedMany` for bulk import; cheap model already (`text-embedding-3-small`, 1536d) |
| K link classifications | per problem (intake) | **hybrid**: use `createHeuristicReasoner` (0 tokens) for similarities clearly above `identicalThreshold` or clearly below `partialThreshold`; call the LLM only for the ambiguous middle band. Lower K. |
| cluster summaries | only if Tier 3 adopted | lazy + cached; recompute a cluster only when its membership changes |

Design rule: **spend tokens at write-time on edge quality, never at read-time.** Reads must not call an LLM.

## 4. How the agent accesses the graph: tools over existing data

Do **not** hand the agent "the whole graph." Expose a small set of **bounded, callable tools** that query the existing tables + vector index. Each tool is offered two ways so both agent types are served:
- **LLM agents** → as Vercel AI SDK `tool()`s the model can invoke mid-reasoning.
- **API agents** (`x-api-key`) → as REST endpoints in the contract.

Proposed tools / endpoints:

| Tool | Endpoint | Returns | Backed by |
|------|----------|---------|-----------|
| `searchGraph(query, k)` | `GET /v1/graph/search` | top-k problems by semantic similarity, each with existing link kinds + whether it has an accepted solution | exact cosine scan (`findSimilarProblems`) + 1-hop `problem_links` |
| `getProblemContext(id)` | `GET /v1/problems/:id/context` | node + edges (kind/confidence/**rationale**) + attached solutions (body/status/origin) | indexed FK joins |
| `expandNeighborhood(id, hops, maxNodes)` | `GET /v1/problems/:id/neighborhood` | a **bounded** subgraph | recursive CTE over `problem_links` |
| `findSolvedNeighbors(id)` | `GET /v1/problems/:id/solved-neighbors` | nearest problems that already have accepted solutions | BFS over links filtered by solution status |
| `getClusterSummary(id)` *(Tier 3, optional)* | `GET /v1/problems/:id/cluster-summary` | cached natural-language summary of the cluster | summary cache table |

Design notes:
- **Cross-workspace by design:** the graph is a shared knowledge layer — `findSimilarProblems`/`findSimilarObservations`, traversal, solved-neighbours and cluster summaries never filter by workspace, so an agent surfaces reusable prior work from any workspace. Ordinary listing of observations/problems also spans every accessible workspace by default; a caller is bounded only by its access allowlist (default = all) and may narrow a list with `?workspaceId=`.
- **Budgeted traversal:** every traversal tool caps `hops` and `maxNodes` so context stays small and latency bounded.
- **Return rationale, not just structure:** the agent reads the stored `rationale`/`confidence` instead of re-inferring why two problems relate — this is the main speed win.

## 5. Feed graph context *into* the pipeline (the highest-value change)

Today `runAgentPipeline` (`packages/ai/src/pipeline.ts`) only *writes* edges; it never *reads* the surrounding graph before synthesizing. Change:

1. After classification, gather the **neighborhood** of the linked problems (their solutions, outcomes, and 1–2 hop rationales) via a new port method `getNeighborhoodContext(problemIds, hops, budget)`.
2. Pass that compressed context into `reasoner.synthesize(...)`.

Effect: a new problem benefits from "this connects to a cluster that already has 3 accepted solutions → reuse/adapt the best one," directly serving the objective ("solutions from one problem formulate solutions for new problems"). It's a small change: one port method + one extra argument to synthesize.

## 6. What determines optimal usefulness + speed

- **Edge quality at write-time** — the graph is only as useful as the links/rationales captured at intake. Invest here (amortized).
- **Embedding recall** — better first-hop candidates ⇒ fewer hops needed.
- **Reasoning stored on edges** (rationale, confidence) ⇒ reads are lookups, not re-inference.
- **Node granularity** — keep nodes at problem/solution level. Do **not** decompose into sub-concepts (that's the expensive LLM-extraction path and adds little here).
- **Edge vocabulary** — keep the small, meaningful set (identical/partial/related/solves); resist proliferation.
- **Scope filters + bounded traversal + cached summaries** — the knobs that control latency and token cost.

## 7. Cost tiers — choose the ceiling

| Tier | What | Cost | Verdict |
|------|------|------|---------|
| 1. Vector-only | ANN similarity at query time, no stored edges | cheapest | too shallow (loses multi-hop + curated link kinds) |
| **2. Vector + structural edges (recommended)** | edges written at intake, queried on demand via tools | low, amortized | **Cedarpad already does this — expose + harden it** |
| 3. + cached community summaries (GraphRAG-lite) | lazy LLM summaries per cluster, cached | moderate, gated | **implemented** — membership-hash cache, REST + tool, `graph.summary.enabled` |
| 4. Full LLM graph extraction | re-extract corpus into a graph | expensive, stale-prone | avoid — relationships are already data |

**Recommendation: Tier 2, hardened.** No expensive generation step; reuse the existing tables + vector index.

## 8. Proposed implementation (Tier 2)

- `packages/db`: cross-workspace `findSimilarProblems`; `neighborhood(problemId, hops, maxNodes)` via `WITH RECURSIVE` over `problem_links`; `getProblemContext` joins. (SQLite/libSQL supports recursive CTEs — no new engine features.)
- `packages/ai`: a `graph` retrieval module + tool definitions (provider-agnostic via AI SDK `tool()`); add `getNeighborhoodContext` to `PipelinePorts` and use it in `synthesize`.
- `packages/contract`: route defs for the new endpoints (keeps them contract-first / typed end-to-end).
- `apps/api`: implement the ports/handlers; expose the tools to the agent runtime; reuse the workspace graph query (`GET /v1/graph`) for the human view (unchanged).
- `configuration.ts`: add `graph` config — default `hops`, `maxNodes`, ambiguous-band thresholds for hybrid classification.

Latency target: read tools < ~50–100 ms (ANN + indexed SQL, no LLM). Existing indexes (`problem_links_from/to_idx`, `problems_workspace_idx`, `problems_embedding_idx`) already support this.

## 9. Open decisions

1. **Scope for agent retrieval** — ✅ **resolved**: the `population`/`workspace` scope concept is removed. The graph knowledge layer (similarity, traversal, solved-neighbours, summaries) **and** ordinary listing are **cross-workspace by default**; a principal is bounded only by its access allowlist (default = all — see `PROGRESS.md` 2026-06-24), with an optional `?workspaceId=` narrow on lists.
2. **Hybrid classification band** — ✅ **resolved (2026-06-23)**: `createHybridReasoner` (`packages/ai/src/reasoner.ts`) classifies confidently-similar (≥ `identicalThreshold`) and confidently-dissimilar (< `partialThreshold`) candidates with the 0-token heuristic and sends only the ambiguous band `[partialThreshold, identicalThreshold)` to the LLM (and only when something is ambiguous). Synthesis still uses the LLM (+ graph tools). Selected by `similarity.classificationMode` (`hybrid` default; `llm`/`heuristic` available); no key ⇒ heuristic. Wired in `createReasoner` (`apps/api/src/agent.ts`).
3. **Tier 3 summaries** — ✅ **implemented (2026-06-23)**: `cluster_summaries` table (membership-hash-keyed cache) + `getClusterMembership`/`read`/`writeClusterSummary` (`packages/db/src/queries/clusterSummary.ts`); `createClusterSummarizer` + `templateClusterSummary` (`packages/ai/src/summarizer.ts`); orchestration `getClusterSummary` (`apps/api/src/cluster.ts`, cache-first, regenerates only when membership changes or TTL lapses, deterministic templated fallback with no key); `GET /v1/problems/{id}/cluster-summary` REST + `getClusterSummary` AI tool. Gated by `graph.summary.enabled`.
4. **Tool transport for LLM agents** — ✅ **resolved**: in-process `tool()` defs (`createGraphTools` + `createGraphToolDeps`) for internal agents; REST for external API agents — both run the same underlying `packages/db` queries.

## 10. Non-goals

- LLM re-extraction of the product graph (Tier 4).
- Replacing the human React Flow visualization (kept, reads the same data).
- A separate graph database (Neo4j etc.) — libSQL relational + native vectors cover Tier 2; revisit only if traversal depth/scale demands it.
