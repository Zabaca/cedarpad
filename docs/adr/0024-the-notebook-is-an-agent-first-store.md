# The Notebook is an agent-first store, searched by FTS5, read by canvas

Status: **superseded (2026-10-09)** — the Notebook (stage, `/v1` API, `notebook_*` MCP tools, live data source) was removed when cedarpad was cut back to the canvas; its tables remain until the data cleanup. Kept as history. Was: **accepted** (grill session 2026-07-30). Vocabulary: Notebook
[CONTEXT.md](../../packages/canvas/web-poc/CONTEXT.md) — **Observation**, **Problem**,
**Source**, **Solution**; root [CONTEXT.md](../../CONTEXT.md) — **Workspace**, **App**,
**Platform data layer**.

The Notebook was built as "Problem/Solution intelligence": an LLM intake pipeline that
classified, similarity-linked, and synthesized, behind a capture UI a human typed into. It
has been live for a month and holds **five seed rows**. Nothing about it is load-bearing, so
this rewrites what it is rather than repairing it.

**The Notebook is a store that agents write and canvas reads.** Its API and MCP tools are the
product; its UI is a read surface for viewing and debugging, not the way records get in.
Agents record observations while working with a human or running a workflow — that is the
main use case, and everything below follows from it.

## The domain, after simplification

```
Source ─1──*─ Observation ─*──*─ Problem ─*──*─ Problem
                                    │
                                    *
                                 Solution
```

**Source** is new and means *where an observation came from* — a URL, a call, a document, or
a cedarpad entity (a Conversation, a canvas, a repo). It is a row, not a string, so "what
else did that call surface?" is a join rather than a grep over free text. When there is
nothing to point at, it carries a description instead. `source_id` is **nullable**: an
observation you simply think of has no source, and a mandatory Source is friction on the one
action that must stay frictionless.

The existing `source: 'human' | 'agent'` column becomes **`origin`**. It answers *who
produced this*, which is a different question from *where it came from*, and the collision
was making both unclear.

One Source per Observation, deliberately. The many-to-many case — the same thing said on a
call and in a ticket — is two observations, and "these are the same thing" is already
expressed by both synthesizing into one Problem. A join table would be a second, weaker way
to say what the observation→problem edge says properly. Widening later is mechanical.

## What was dropped, and why

- **`agent_runs`, `agent_jobs`, and the LLM intake pipeline.** The queue had no consumer —
  `POST /v1/problems/synthesize` returned `202 Synthesis enqueued` and nothing ever drained
  it, so the synthesize and reprocess buttons in the UI have been dead since the D1 cutover.
  Cedarpad already has a Jobs concept (ADR-0015); a second one inside an App is not wanted.
  The thinking moves to cedarpad agents, which reach the Notebook over MCP.
- **`observation_links`, `observation_solved_match_dismissals`, `cluster_summaries`.** All
  three were downstream of similarity matching. With the pipeline gone and embeddings gone
  (below), nothing creates them. Summarizing a cluster is now an agent's job, on demand.
- **`embedding` / `embedding_model` columns and the Voyage dependency.** See below.

**`problem_links` stays**, written deliberately by a human or an agent rather than inferred —
so `neighborhood` and `getProblemContext` stay with it. **Solutions stay.**

## FTS5, not a vector index — and why there was no choice

Similarity search has been **broken in production since the D1 cutover**, unnoticed because
nothing writes to the Notebook. `vector_distance_cos` and `vector32()` are libSQL/Turso
functions; D1 is stock SQLite. Verified against production:

```
select vector_distance_cos(embedding, embedding) from observations
→ no such function: vector_distance_cos [code: 7500]
```

The `float32Array` column serializes writes through `vector32(...)`, so both the read and the
write path are dead. The two seed rows carry `local-hash-v1` blobs migrated across as raw
bytes. So this is not a choice between a working vector search and FTS — it is a rebuild
either way, and the question is only which one to build.

**D1's native FTS5** — verified working, `match` and `rank` included. The corpus is your own
writing: short, dense, deliberately worded, and already the summary of the thing it describes.
An approximate index earns its keep over *other people's* text at volume, which is the content
ingestion this ADR deliberately scopes out (a Source points at its material; it does not carry
it, so there is no chunking question to answer).

Cloudflare's vector option is **Vectorize** — a separate index with its own write path,
consistency story, and cost, not Chroma, which is not a Cloudflare service. Nothing about
FTS5-first forecloses it: an observation *is* the chunk, so adding a vector index later is one
index and one write path, with no schema change. Revisit when the corpus makes search fail,
not before.

## Consequences

**Workspace isolation stops being aspirational.** Root CONTEXT.md already claims Notebook
records are isolated per platform workspace, but #57 only scoped list and search — of six
reads in `lib/db/queries/graph.ts`, exactly one takes a `workspaceId`, and the code comments
defend the gap ("the graph spans every workspace"). Keeping `problem_links` means keeping
`neighborhood`, so this is real work rather than something subtraction fixes. **Every MCP tool
scopes from the caller's token, never a parameter**, so the isolation holds by construction.

**MCP responses are size-disciplined by contract.** `read_canvas` returning a whole canvas
drove agents to write results to a file and read them back; a Notebook that grows fast has the
same failure waiting. Lists are paginated and return identifiers plus a line — never bodies.
Full records are fetched by id.

**Canvas reads the Notebook through a second data-source kind.** ADR-0017 settled that a
component names a mart and never a URL — the namespace *is* the boundary. `DataSourceSchema`
is a `z.literal('mart')` discriminator with one member; the Notebook adds
`{ kind: 'notebook', query }` — a *named, parameterized* query, never free SQL — resolved at
the edge against D1 as a mart is resolved against R2. Going through marts instead would mean
a DuckDB job moving a thousand rows into parquet so a component could read them back, and
would make every view stale by a schedule. The cost of extending the union is a resolver, a
named-query registry, and a guest-scoping answer: `martsInRoomSnapshot` bounds which marts a
share-link guest may read, and a notebook source needs its equivalent or a shared canvas leaks
the workspace's observations.
