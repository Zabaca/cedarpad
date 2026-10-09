# The warehouse is R2 parquet; a mart is one artifact with two readers

**Status:** **superseded (2026-10-09)** — the warehouse, marts, connectors and the materialize job were removed; a component's live data is a named Notebook query. The `Warehouse` container class stays bound until the Cloudflare container migration. Kept as history. Was: accepted (grill session 2026-07-26)

A cedarpad workspace can own a data pipeline: the `ceo` Python toolchain (dlt + dbt +
DuckDB) runs **in the workspace container**, invoked one-shot by a Job (ADR-0015) rather
than by a Dagster daemon, because a daemon cannot live in a container that sleeps at 5
minutes. Durable storage is **R2 parquet under `workspaces/<ws>/warehouse/`** — never a
container-resident DuckDB file. DuckDB is a *stateless query engine* over those files.

A **mart** is exactly one artifact — a parquet file in R2 — read two ways: by DuckDB in
the container (transforms, joins, ad-hoc agent SQL) and by a **pure-JS parquet reader in
the edge Worker** (cold renders). There is no publish step, no second storage engine, and
no copy of a mart anywhere.

## Why not a DuckDB file in the container

Not a cost trade-off — a hard ceiling. Cloudflare container disk is **8 GB on
`standard-1`** (what canvas runs) and **capped at 20 GB on any instance type, including
custom**. The `ceo` warehouse measured **22.3 GiB used** (91,691 blocks, only 3,920 free —
real data, not reclaimable bloat). A warehouse of that size *cannot physically exist* in a
cedarpad container at any tier, so restoring the DB from R2 on wake is impossible
rather than merely slow. Parquet-in-R2 also dissolves DuckDB's single-writer problem:
parquet files are immutable, so a write is a new file.

## Why not MotherDuck

MotherDuck's free Lite tier caps at 10 GB / 10 compute-hours / 3 users. `ceo`'s warehouse
exceeds that **2.2× today**, before cedarpad ingests anything, so there is no ramp — you
land on Business at **$250/mo** on day one. Measured against a daily 5-minute materialize:
**~$253/mo (MotherDuck) vs ~$0.25/mo (R2 + containers)**; hourly, ~$288 vs ~$4. The ~70×
is almost entirely the platform fee — per-hour compute is only ~10×. The deciding argument
is the *shape*, not the multiple: MotherDuck's pricing is a step function already tripped,
R2's is a slope that stays linear as workspaces multiply. Tenancy compounds it — the $250
is per *organization*, so every customer workspace would share one MotherDuck account or
need its own, while R2 partitions by prefix for free.

## Why not publish marts to Turso

Considered, and rejected as a special case: publishing copies a mart's rows into a second
engine with a second schema to keep in sync, forking the definition the dbt layer exists
to keep single. Turso stays the **metadata** store and never becomes a data plane. (The
standing objection to Turso — row-oriented, slow wide scans — was aimed at the whole
warehouse and doesn't apply to marts anyway: all 24 of `ceo`'s marts total **21,312
rows**, already pre-aggregated. The scanning happened in DuckDB.)

## Verified before accepting

The design rests on one unproven claim, so it was probed in real `workerd` (`wrangler dev`,
**no `nodejs_compat`**) against parquet written by DuckDB's own
`COPY … (FORMAT PARQUET)` — SNAPPY + `PLAIN_DICTIONARY`/`PLAIN`, which is what
`dbt-duckdb`'s external materialization emits:

| Mart | Size | Rows | Cols | Parse |
|---|---|---|---|---|
| `mart_daily_activity` | 47 KB | 11,066 | 4 | **17 ms** |
| `mart_claude_session_digest` | 2.6 MB | 1,658 | 14 | **33 ms** |

`hyparquet` (~448 KB on disk; only its optional `src/node.js` touches node builtins)
decoded both natively, well inside Worker CPU limits. Whole-file reads suffice at mart
scale — no range logic needed.

## Consequences

- **`INT64` arrives as `BigInt`** and does not `JSON.stringify`. The mart contract layer
  must coerce before rows reach a component as props (CLAUDE.md §7 — the mart schema *is*
  the boundary contract, declared per mart, never inferred; `ceo` shipping 61 of 93 models
  with no `description:` is the argument for requiring it from day one).
- **A component names a mart, not a URL**: `dataSource: { kind: 'mart', name: 'mart_x' }`.
  This closes issue #219's hardest open question — there is no arbitrary-fetch surface to
  allowlist, because the mart namespace *is* the boundary.
- **Guest exposure is scoped to canvas content, not to the namespace.** Marts are
  guest-readable (a shared canvas must render), but the gate resolves the marts a shared
  canvas actually *references* from its component instances and allows only those —
  otherwise a share link pasted in Slack makes every mart enumerable. Same principle as
  `worker/guest-gate.ts`, one level down.
- **Retention is the constraint that replaces disk size.** Transform-time scratch still
  has to fit in 8 GB. `ceo`'s 22 GB was overwhelmingly `claude_code_session_chunks` (3.77M
  rows) — the LLM chunking/summarization/embedding layer, which cedarpad is **not**
  adopting (it also required an unreachable LM Studio on a laptop). Raw events are cheap:
  `stg_claude_code__events` is 245k rows.
- **Fallback if a codec ever mismatches**: materialize marts as JSON alongside parquet.
  Still one storage system, still no second database.
