// The edge Notebook route (ADR-0024): a component names a QUERY out of a fixed registry,
// and the edge resolves it against the platform D1 (ADR-0018) — live, no materialize step,
// no container wake. The sibling of `mart-api.ts`, one namespace over: a mart is parquet in
// R2 as of its last run; the Notebook is rows in D1 as of right now.
//
// Two invariants this file exists to hold:
//   1. No free-form SQL crosses the boundary. The registry below is the whole vocabulary;
//      a name that is not in it is a 404, and nothing is interpolated into a statement.
//   2. Every query filters on `workspace_id` itself. Scoping is not the caller's job.

import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import type { Database } from '../web-poc/lib/db/client.ts';
import { schema } from '../web-poc/lib/db/index.ts';
import { NOTEBOOK_QUERIES, type NotebookQueryName, type NotebookRow } from '../shared/notebook-source.ts';

/** Path this route answers: `/api/workspaces/:ws/notebook/:query`, params in the query string. */
export const NOTEBOOK_ROUTE = /^\/api\/workspaces\/([^/]+)\/notebook\/([^/]+)$/;

/**
 * Who is asking. Unlike a mart — guest-readable when the shared canvas's own components
 * reference it (`decideMartAccess`) — the Notebook is MEMBER-ONLY. A canvas's shapes can
 * confine which marts a share link reaches because a mart is a published artifact; a
 * Notebook query reads the workspace's raw Observations and Problems, and no per-canvas
 * confinement makes those safe to hand whoever a link was pasted to. Default-deny.
 */
export type NotebookRequester = { kind: 'member' } | { kind: 'guest' };

const positiveLimit = z.coerce.number().int().positive().max(200).default(50);

/** Timestamps arrive as `Date` (the column is `timestamp_ms`); a row that crosses the wire
 * carries the ISO string, exactly as `coerceMartRow` does for a parquet TIMESTAMP. */
const iso = (d: Date | null) => (d === null ? null : d.toISOString());

/**
 * The registry: query name → params schema + the rows it reads. Each entry owns its own
 * params validation, so a missing or malformed param is a 400 at the boundary rather than
 * a silently empty result.
 */
const QUERIES: {
  [K in NotebookQueryName]: {
    params: z.ZodType<Record<string, unknown>>;
    run: (db: Database, ws: string, params: never) => Promise<NotebookRow[]>;
  };
} = {
  /** The workspace's open problems, heaviest first — the "what should we be working on" read. */
  open_problems: {
    params: z.object({ limit: positiveLimit }),
    run: async (db, ws, { limit }: { limit: number }) => {
      const rows = await db
        .select()
        .from(schema.problems)
        .where(and(eq(schema.problems.workspaceId, ws), eq(schema.problems.status, 'open')))
        .orderBy(desc(schema.problems.priority), desc(schema.problems.createdAt))
        .limit(limit);
      return rows.map((p) => ({
        id: p.id,
        title: p.title,
        body: p.body,
        impact: p.impact,
        priority: p.priority,
        urgency: p.urgency,
        status: p.status,
        origin: p.origin,
        created_at: iso(p.createdAt),
        updated_at: iso(p.updatedAt),
      }));
    },
  },

  /** The observations one problem was synthesized from, newest first. */
  problem_observations: {
    params: z.object({ problemId: z.string().min(1), limit: positiveLimit }),
    run: async (db, ws, { problemId, limit }: { problemId: string; limit: number }) => {
      // The problem is re-read in the caller's workspace first: an id from another
      // workspace resolves to no edges rather than to that workspace's observations.
      const links = await db
        .select({ observationId: schema.observationProblems.observationId })
        .from(schema.observationProblems)
        .innerJoin(schema.problems, eq(schema.problems.id, schema.observationProblems.problemId))
        .where(and(eq(schema.observationProblems.problemId, problemId), eq(schema.problems.workspaceId, ws)));
      if (links.length === 0) return [];
      return observationRows(
        db,
        and(
          eq(schema.observations.workspaceId, ws),
          inArray(
            schema.observations.id,
            links.map((l) => l.observationId),
          ),
        ),
        limit,
      );
    },
  },

  /** The workspace's most recent observations, optionally narrowed to one Source. */
  recent_observations: {
    params: z.object({ sourceId: z.string().min(1).optional(), limit: positiveLimit }),
    run: (db, ws, { sourceId, limit }: { sourceId?: string; limit: number }) =>
      observationRows(
        db,
        sourceId
          ? and(eq(schema.observations.workspaceId, ws), eq(schema.observations.sourceId, sourceId))
          : eq(schema.observations.workspaceId, ws),
        limit,
      ),
  },
};

/** Observations with their Source flattened alongside (ADR-0024: where it came from is a
 * row, and a component that renders an observation wants to show it). */
async function observationRows(db: Database, where: ReturnType<typeof eq> | undefined, limit: number): Promise<NotebookRow[]> {
  const rows = await db
    .select({ o: schema.observations, s: schema.sources })
    .from(schema.observations)
    .leftJoin(schema.sources, eq(schema.sources.id, schema.observations.sourceId))
    .where(where)
    .orderBy(desc(schema.observations.createdAt))
    .limit(limit);
  return rows.map(({ o, s }) => ({
    id: o.id,
    title: o.title,
    body: o.body,
    impact: o.impact,
    status: o.status,
    origin: o.origin,
    source_id: o.sourceId,
    source_kind: s?.kind ?? null,
    source_label: s?.label ?? s?.identifier ?? null,
    created_at: iso(o.createdAt),
    updated_at: iso(o.updatedAt),
  }));
}

const NOT_FOUND = () => Response.json({ error: 'not found' }, { status: 404 });

/**
 * The full route. A guest and an unknown query name get the SAME 404 as a real-but-denied
 * read — the shape must not become an oracle for what queries exist (same reasoning as
 * `handleMartApi`). Bad params are a 400, because by then the caller has already proven it
 * may ask; the only thing left to tell it is that it asked wrongly.
 *
 * Workspace membership for `{ kind: 'member' }` is checked by the caller (index.ts, against
 * the DB) before this is reached, exactly as the mart route does it.
 */
export async function handleNotebookApi(
  db: Database,
  ws: string,
  query: string,
  rawParams: Record<string, string | number>,
  requester: NotebookRequester,
): Promise<Response> {
  if (requester.kind !== 'member') return NOT_FOUND();
  if (!(NOTEBOOK_QUERIES as readonly string[]).includes(query)) return NOT_FOUND();
  const entry = QUERIES[query as NotebookQueryName];
  const params = entry.params.safeParse(rawParams);
  if (!params.success) {
    return Response.json({ error: params.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, { status: 400 });
  }
  return Response.json({ query, rows: await entry.run(db, ws, params.data as never) });
}
