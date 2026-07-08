import { and, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { observations, problems } from "../schema.js";
import { cosineSimilarity } from "../vector.js";

export interface SimilarProblem {
  id: string;
  title: string;
  body: string;
  similarity: number;
}

export type SimilarObservation = SimilarProblem;

/**
 * Find the nearest problems to `queryVector`, ordered by cosine similarity
 * (highest first), via an exact `vector_distance_cos` scan over the embedded
 * rows — no ANN index.
 *
 * Why exact and not `vector_top_k`: benchmarking the libSQL ANN index at 1536
 * dims showed it costs ~40× the row data in storage (≈3.3 GB per 10k rows) and
 * ~23 ms/row to maintain, while compression to shrink it caps recall at ~0.6. A
 * brute-force scan has perfect recall, zero index overhead, and stays well under
 * ~250 ms up to ~100k rows — comfortably inside the async intake path. Revisit
 * (ANN + a smaller embedding dim, or a dedicated vector store) past ~250k rows.
 *
 * By default the scan spans every workspace; pass `workspaceId` to confine it to
 * one platform workspace (Notebook search isolation, #57). `excludeProblemId`
 * omits the just-inserted problem from its own results.
 *
 * Turso-scaling note: this is a full scan, and on Turso every scanned row is a
 * metered read (see `docs/SIMILARITY_SCALING.md`). Two cheap levers narrow the
 * scan: `archived` rows are never match targets so they're filtered out, and an
 * optional `since` recency window (config-gated, off by default) bounds the scan
 * to recent rows. Cosine is computed once per row (selected, then ordered by the
 * `similarity` alias) rather than twice.
 */
export async function findSimilarProblems(
  db: Database,
  params: {
    queryVector: number[];
    topK: number;
    excludeProblemId?: string;
    /** Optional recency window: only consider rows created at/after this time. */
    since?: Date;
    /** When set, confine the scan to one platform workspace (isolation, #57). */
    workspaceId?: string;
  },
): Promise<SimilarProblem[]> {
  const { queryVector, topK, excludeProblemId, since, workspaceId } = params;

  const rows = await db
    .select({
      id: problems.id,
      title: problems.title,
      body: problems.body,
      // Aliased so the ORDER BY below can reference it — computing the cosine
      // once per row instead of again in the sort.
      similarity: cosineSimilarity(problems.embedding, queryVector).as("similarity"),
    })
    .from(problems)
    .where(
      and(
        isNotNull(problems.embedding),
        ne(problems.status, "archived"),
        excludeProblemId ? ne(problems.id, excludeProblemId) : undefined,
        since ? gte(problems.createdAt, since) : undefined,
        workspaceId ? eq(problems.workspaceId, workspaceId) : undefined,
      ),
    )
    .orderBy(sql`similarity desc`)
    .limit(topK);

  return rows as SimilarProblem[];
}

/**
 * Find the nearest observations to `queryVector`. Mirrors
 * {@link findSimilarProblems} (exact `vector_distance_cos` scan) — the agent uses
 * this to recognise when several loose observations cluster into a problem. Like
 * problem similarity, this spans every workspace unless `workspaceId` narrows it.
 * See {@link findSimilarProblems}
 * for the `archived` filter, `since` recency window, and single-cosine notes.
 */
export async function findSimilarObservations(
  db: Database,
  params: {
    queryVector: number[];
    topK: number;
    excludeObservationId?: string;
    /** Optional recency window: only consider rows created at/after this time. */
    since?: Date;
    /** When set, confine the scan to one platform workspace (isolation, #57). */
    workspaceId?: string;
  },
): Promise<SimilarObservation[]> {
  const { queryVector, topK, excludeObservationId, since, workspaceId } = params;

  const rows = await db
    .select({
      id: observations.id,
      title: observations.title,
      body: observations.body,
      // Aliased so ORDER BY reuses it — see findSimilarProblems.
      similarity: cosineSimilarity(observations.embedding, queryVector).as("similarity"),
    })
    .from(observations)
    .where(
      and(
        isNotNull(observations.embedding),
        ne(observations.status, "archived"),
        excludeObservationId ? ne(observations.id, excludeObservationId) : undefined,
        since ? gte(observations.createdAt, since) : undefined,
        workspaceId ? eq(observations.workspaceId, workspaceId) : undefined,
      ),
    )
    .orderBy(sql`similarity desc`)
    .limit(topK);

  return rows as SimilarObservation[];
}
