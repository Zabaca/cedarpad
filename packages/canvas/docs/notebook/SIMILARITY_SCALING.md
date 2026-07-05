# Similarity Search: Benchmark & Scaling

> **web-poc migration note (2026-06-29).** This doc was carried over from the
> apex monorepo. Two facts changed here: (a) embeddings are now **Voyage
> `voyage-3.5-lite` at 1024 dims** (was OpenAI `text-embedding-3-small` 1536) —
> smaller vectors shift the storage/latency numbers below favorably (~1.5×); the
> benchmark *shape* and the brute-force decision are unchanged. (b) Embedding is
> now **computed inline at create and search** (not in an async intake job), so
> the brute-force scan is hottest at **search** time, not intake. Path remap:
> `packages/db → lib/db`, `packages/config → lib/config`, `apps/api/src → worker`.
> See `./README.md` for the full delta.

> Status: **Brute-force exact scan shipped (2026-06-26)**; **pre-prod Turso mitigations shipped (2026-06-29, §2a)**; heavier levers (smaller dim, IVF, stateful-worker) **planned, not implemented**.
> Related: `AGENT_GRAPH_ACCESS.md` (its "ANN over every workspace" wording is superseded by this doc), `ASYNC_PIPELINE.md`, `CONFIGURATION.md`.

Find-similar (matching new observations/problems against existing ones at intake, for linking/synthesis) is the system's only vector workload. This doc records why it's a brute-force scan today, the benchmark behind that, and how to scale it on Turso.

## 0. What shipped

- The two `libsql_vector_idx` ANN indexes were **dropped** (migration `0001_cute_mulholland_black.sql`).
- `packages/db/src/queries/similar.ts` — `findSimilarProblems` / `findSimilarObservations` now do an **exact `vector_distance_cos` scan** (reusing the `cosineSimilarity` helper) with an `isNotNull(embedding)` guard. Cross-workspace, ordered by cosine, `LIMIT topK`.
- Config: **1536-dim** embeddings, `topK = 8` (`packages/config`).
- Reusable benchmark harness: `packages/db/scripts/bench-similarity.ts`.

## 1. Why brute force, not the ANN index

Benchmarked on a **local file DB / high-RAM Mac (best case)**:

| Strategy | index size /10k | build (10k) | write/row | recall@8 | query |
|---|---|---|---|---|---|
| **Default `libsql_vector_idx`** | **3.3 GB** (~40× the row data) | 226 s | ~23 ms | ~1.0 | ~18 ms |
| Compressed (`float1bit`, best) | ~0.33 GB | ~12 s | ~1 ms | **~0.6 (capped)** | ~18 ms |
| **Brute force** (no index) | 0 | 0 | ~0.3 ms | **1.0** | scales w/ N |

- Row data alone ≈ **8.2 KB/row** (82 MB / 10k).
- Index **compression** (`compress_neighbors=float8|float1bit`, any `max_neighbors`) cuts size 10–30× and build ~20×, but **recall plateaus at ~0.5–0.65** at 1536 dims — neither a larger candidate pool nor more neighbors recovers it.
- The default index would mean ~33 GB at 100k / ~330 GB at 1M, and ~23 ms/row writes (~40 inserts/sec) — storage and write walls hit in the **tens of thousands of rows**, long before recall ever matters.

**Brute-force latency vs N** (same machine):

| Rows | p50 latency | data size |
|---|---|---|
| 50k | 117 ms | 411 MB |
| 100k | 237 ms | 822 MB |
| 250k | 601 ms | 2.1 GB |
| ~400k | ~1–1.5 s (entering the cliff) | ~3.3 GB |
| 500k | 2.6 s | 4.1 GB |

Linear (~2.4 ms per 1k rows) to ~250k, then a **super-linear cliff** where the vector data stops fitting in page cache. **Decision:** brute force is strictly better up to ~100–250k rows — perfect recall, no multi-GB index, ~70× cheaper writes, sub-250 ms queries well inside the async intake path.

## 2. Production is Turso — what changes

These numbers are local-file/Mac. Production is **Cloudflare Workers → Turso** (`deploy:cf`), which shifts this from a latency problem to a latency **and cost** problem:

1. **Reads are remote + metered by rows-read.** A scan reads every row, so each intake = N rows read against the primary. Cost scales with `N × intake-rate`, not just latency.
2. **The cliff lands earlier.** Turso instance RAM is smaller than the bench Mac, so the page-cache cliff is likely **below 400k**, plus network RTT per query.
3. **Storage is capped/metered** — extra confirmation that dropping the 3.3 GB-per-10k index was right.
4. **CF Workers are stateless** → cannot hold a Turso **embedded replica**.

**Reframe:** on Turso, strategies that make a query **touch fewer rows** win twice (latency + metered reads). The scan is hot mainly at **intake**; read-time "similar" mostly traverses already-materialized `observation_links` / `problem_links` + the graph.

## 2a. Shipped pre-prod mitigations (2026-06-29)

Architecture decision resolved: the prod `agent_jobs` worker **will be a stateless CF Cron/Queue Worker** (not yet set up). That rules out the embedded replica / in-RAM ANN levers (roadmap 1–2) until/unless the worker moves to a stateful process. The following in-Turso, no-migration mitigations landed in `similar.ts` / `pipeline.ts` / `config`:

- **`archived` rows excluded from the scan** — `findSimilarProblems`/`findSimilarObservations` now filter `status != 'archived'` (dead records are never match targets). Fewer metered rows-read, semantics-preserving. (Roadmap #4, partial.)
- **Config-gated recency window** — `similarity.recencyWindowMs` (default `null` = full scan) bounds the scan to recent rows when flipped on. Plumbed through the port adapter as a `since` cutoff; flip it once the rows-read signal warrants. (Roadmap #4, partial.)
- **Scan-cost observability** — the intake `retrieve` step now records `ms` (scan wall-clock), the app-side complement to Turso's rows-read dashboard — it grows with N and flags the page-cache cliff early.
- **Cosine computed once per row** — the scan aliases `similarity` and orders by the alias instead of recomputing `vector_distance_cos` in the ORDER BY (was 2× the vector math per row).

Still pending (need a migration or infra): smaller embedding dim (#5), IVF bucketing (#3), stateful-worker levers (#1–2).

## 3. Mitigation roadmap (priority order)

1. **Embedded replica on a stateful worker** (Fly/VM/container with a persistent disk) running the `agent_jobs` intake worker → local-speed scans, no metered per-query primary reads. Biggest lever — but only works off CF Workers.
2. **In-memory ANN** (hnswlib/faiss) on that same stateful worker → zero per-query Turso reads for search.
3. **IVF / centroid bucketing** — best *in-Turso* option: tag rows by k-means cluster, scan only the nearest cluster's rows → fewer rows read, no index bloat.
4. **Hot/cold table offloading + workspace scoping + recency window** — scan only active / in-scope / recent rows (uses existing `status` fields). Lowers metered rows-read directly.
5. **Smaller embedding dim** (Matryoshka 256/512) + **int8 quantization** of stored vectors → pushes the cliff out 4–6×.
6. **Dedicated vector store** (Qdrant / LanceDB / pgvector-HNSW) only at real scale — outside Turso, since Turso's own vector index is the heavy `libsql_vector_idx` measured above.

**Open question — resolved (2026-06-29):** the prod `agent_jobs` worker will be a **stateless CF cron/queue Worker** (not yet set up) → pursue options 3–5. Revisit 1–2 only if the worker later moves to a persistent process.

**Early-warning signal:** watch Turso's **rows-read** dashboard metric as the corpus grows — that, not local latency, tells you when to pull a lever.

## 4. Re-running the benchmark

```bash
# size ladder, queries per checkpoint; reports recall@8 vs exact, latency, index build time
LADDER=10000,50000,100000,250000 Q=60 bun packages/db/scripts/bench-similarity.ts
```

Synthetic clustered data — absolute recall depends on the distribution; the **trends vs N** and the **relative cost of each strategy** are what transfer. Re-run after any change to the embedding dimension or model.
