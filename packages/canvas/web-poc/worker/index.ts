import { configuration } from "../lib/config/index.js";
import {
  dismissSolvedMatch,
  enqueueAgentJob,
  findSolvedNeighbors,
  findSolvedProblemsForObservation,
  getProblemContext,
  neighborhood,
  schema,
  searchGraph,
  type Database,
} from "../lib/db/index.js";
import * as contract from "../lib/contract/index.js";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { and, count, desc, eq, exists, inArray, like, or, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { type AccessScope, accessWhere, canAccessWorkspace, workspaceFilter } from "./access.js";
import { createEmbedder, providerModelLabel } from "./agent.js";
import { embedText } from "../lib/ai/index.js";
import { getClusterSummary } from "./cluster.js";
import { createAuth } from "./auth.js";
import type { AppEnv } from "./context.js";
import {
  getObservationDetail,
  getProblemDetail,
  getWorkspaceGraph,
} from "./data.js";
import {
  authMiddleware,
  dbMiddleware,
  observationAccessible,
  problemAccessible,
} from "./middleware.js";
import { publish, workspaceChannel } from "./realtime.js";
import {
  serializeApiKey,
  serializeObservation,
  serializeProblem,
  serializeSolution,
} from "./serializers.js";

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

/** Match a single tag inside the JSON-encoded `project_tags` array. */
const tagFilter = (column: unknown, tag: string) =>
  sql`${column} LIKE ${`%"${tag}"%`}`;

/**
 * Workspace `WHERE` conditions for a list query. By default a list spans every
 * accessible workspace (`accessWhere` is a no-op when scope is `all`); an
 * explicit `workspaceId` narrows to that one — honoured only when it's in scope,
 * otherwise the result is forced empty.
 */
function listWorkspaceConds(
  scope: AccessScope,
  column: SQLiteColumn,
  workspaceId?: string,
): SQL[] {
  const w = workspaceFilter(scope, column, workspaceId);
  return w ? [w] : [];
}

/**
 * OpenAPI document metadata. Shared by the live `/doc` route and the
 * `emit-openapi` script so the served spec and the committed `openapi.json`
 * cannot diverge (a drift test enforces this).
 */
export const DOC_CONFIG = {
  openapi: "3.0.0",
  info: { version: "0.1.0", title: "Cedarpad API", description: "Observation/Problem/Solution intelligence API" },
} as const;

export interface BuildAppOptions {
  /** Inject a db (tests use a node-backed libSQL). Defaults to the Worker web client. */
  db?: Database;
}

export function buildApp(opts: BuildAppOptions = {}) {
  const app = new OpenAPIHono<AppEnv>();

  // Every request gets a db. Auth handler is public; /v1/* requires auth.
  app.use(
    "*",
    opts.db
      ? createMiddleware<AppEnv>(async (c, next) => {
          c.set("db", opts.db!);
          await next();
        })
      : dbMiddleware,
  );

  app.on(["POST", "GET"], "/api/auth/*", (c) => createAuth(c.get("db"), c.env).handler(c.req.raw));

  // `reasoner` lets tooling see which agent path is active without auth — e.g.
  // /agent-sim checks for "bridge:manual" to confirm the manual bridge is on.
  app.get("/health", (c) => c.json({ ok: true, reasoner: providerModelLabel(c.env) }));

  app.use("/v1/*", authMiddleware);

  // Routes are CHAINED so their types accumulate onto `routed` — this is what
  // lets the web `hc<AppType>` client infer paths, params, and responses.
  const routed = app
    /* ---- Observations ---- */
    .openapi(contract.createObservationRoute, async (c) => {
      const db = c.get("db");
      const input = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      const id = newId("obs");
      // Embed inline (Voyage) so the observation is searchable immediately — no
      // background worker needed. Best-effort: on failure the record is still
      // created (embedding stays NULL) and can be re-embedded later.
      const embedder = createEmbedder(c.env);
      let embedding: number[] | undefined;
      let embeddingModel: string | undefined;
      try {
        embedding = await embedder.embed(
          embedText({ title: input.title, body: input.body, impact: input.impact ?? null }),
          "document",
        );
        embeddingModel = embedder.model;
      } catch (err) {
        console.error("inline embed failed (observation)", err);
      }
      await db.insert(schema.observations).values({
        id,
        workspaceId,
        title: input.title,
        body: input.body,
        impact: input.impact ?? null,
        source: c.get("isAgent") ? "agent" : "human",
        createdBy: c.get("userId"),
        projectTags: input.projectTags ?? [],
        ...(embedding ? { embedding, embeddingModel } : {}),
      });
      await publish(c.env, workspaceChannel(workspaceId), {
        type: "observation.created",
        payload: { id },
      });
      if (input.runAgent) {
        // Non-blocking: enqueue intake; a worker drains it at its own pace and
        // publishes `observation.processed` when done (realtime updates the UI).
        await enqueueAgentJob(db, {
          kind: "observation_intake",
          payload: { targetId: id },
          workspaceId,
        });
      }
      const detail = await getObservationDetail(db, id);
      return c.json(detail!, 201);
    })
    .openapi(contract.listObservationsRoute, async (c) => {
      const db = c.get("db");
      const { limit, offset, q, tag, status, solved, workspaceId } = c.req.valid("query");
      // Reads span every accessible workspace; `workspaceId` narrows to one.
      const conds = listWorkspaceConds(
        c.get("accessScope"),
        schema.observations.workspaceId,
        workspaceId,
      );
      if (q && q.trim()) {
        const term = `%${q.trim()}%`;
        conds.push(or(like(schema.observations.title, term), like(schema.observations.body, term))!);
      }
      if (status) conds.push(eq(schema.observations.status, status));
      if (tag) conds.push(tagFilter(schema.observations.projectTags, tag) as never);
      if (solved) {
        // Only observations that carry at least one accepted solution.
        conds.push(
          exists(
            db
              .select({ x: sql`1` })
              .from(schema.solutionLinks)
              .innerJoin(schema.solutions, eq(schema.solutions.id, schema.solutionLinks.solutionId))
              .where(
                and(
                  eq(schema.solutionLinks.targetKind, "observation"),
                  eq(schema.solutionLinks.targetId, schema.observations.id),
                  eq(schema.solutions.status, "accepted"),
                ),
              ),
          ),
        );
      }
      const where = and(...conds);
      const items = await db
        .select()
        .from(schema.observations)
        .where(where)
        .orderBy(desc(schema.observations.createdAt))
        .limit(limit ?? configuration.defaultPageSize)
        .offset(offset ?? 0);
      const totalRow = await db.select({ total: count() }).from(schema.observations).where(where);
      return c.json({ items: items.map(serializeObservation), total: totalRow[0]?.total ?? 0 }, 200);
    })
    .openapi(contract.getObservationRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const detail = await getObservationDetail(db, id);
      if (!detail || !canAccessWorkspace(c.get("accessScope"), detail.observation.workspaceId)) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json(detail, 200);
    })
    .openapi(contract.updateObservationRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      if (!(await observationAccessible(db, c.get("accessScope"), id))) {
        return c.json({ error: "not_found" }, 404);
      }
      const patch: Partial<typeof schema.observations.$inferInsert> = { updatedAt: new Date() };
      if (input.title !== undefined) patch.title = input.title;
      if (input.body !== undefined) patch.body = input.body;
      if (input.impact !== undefined) patch.impact = input.impact;
      if (input.status !== undefined) patch.status = input.status;
      if (input.projectTags !== undefined) patch.projectTags = input.projectTags;
      await db.update(schema.observations).set(patch).where(eq(schema.observations.id, id));
      const detail = await getObservationDetail(db, id);
      return c.json(detail!, 200);
    })
    .openapi(contract.reprocessObservationRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      if (!(await observationAccessible(db, c.get("accessScope"), id))) {
        return c.json({ error: "not_found" }, 404);
      }
      await enqueueAgentJob(db, {
        kind: "observation_intake",
        payload: { targetId: id },
        workspaceId: c.get("workspaceId"),
      });
      const detail = await getObservationDetail(db, id);
      return c.json(detail!, 200);
    })
    .openapi(contract.getObservationSolvedMatchesRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      if (!(await observationAccessible(db, c.get("accessScope"), id))) {
        return c.json({ error: "not_found" }, 404);
      }
      const matches = await findSolvedProblemsForObservation(db, {
        observationId: id,
        topK: configuration.similarity.topK,
        minSimilarity: configuration.similarity.partialThreshold,
      });
      return c.json((matches ?? []) as contract.SolvedMatch[], 200);
    })
    .openapi(contract.dismissObservationSolvedMatchRoute, async (c) => {
      const db = c.get("db");
      const { id, problemId } = c.req.valid("param");
      if (!(await observationAccessible(db, c.get("accessScope"), id))) {
        return c.json({ error: "not_found" }, 404);
      }
      // Negative signal only — record the false positive, then return what's left.
      const ok = await dismissSolvedMatch(db, { observationId: id, problemId, createdBy: c.get("userId") });
      if (!ok) return c.json({ error: "not_found" }, 404);
      const matches = await findSolvedProblemsForObservation(db, {
        observationId: id,
        topK: configuration.similarity.topK,
        minSimilarity: configuration.similarity.partialThreshold,
      });
      return c.json((matches ?? []) as contract.SolvedMatch[], 200);
    })
    /* ---- Problems ---- */
    .openapi(contract.createProblemRoute, async (c) => {
      const db = c.get("db");
      const input = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      const id = newId("prob");
      // Urgency implies a default sort weight; an explicit priority still wins.
      const priority = input.priority ?? contract.urgencyToPriority(input.urgency ?? "medium");
      // Embed inline (Voyage) so the problem is searchable immediately — see the
      // observation handler. Best-effort: NULL embedding on failure.
      const embedder = createEmbedder(c.env);
      let embedding: number[] | undefined;
      let embeddingModel: string | undefined;
      try {
        embedding = await embedder.embed(
          embedText({ title: input.title, body: input.body, impact: input.impact ?? null }),
          "document",
        );
        embeddingModel = embedder.model;
      } catch (err) {
        console.error("inline embed failed (problem)", err);
      }
      await db.insert(schema.problems).values({
        id,
        workspaceId,
        title: input.title,
        body: input.body,
        impact: input.impact ?? null,
        priority,
        urgency: input.urgency ?? "medium",
        solutionDirection: input.solutionDirection ?? null,
        source: c.get("isAgent") ? "agent" : "human",
        createdBy: c.get("userId"),
        projectTags: input.projectTags ?? [],
        ...(embedding ? { embedding, embeddingModel } : {}),
      });
      await publish(c.env, workspaceChannel(workspaceId), {
        type: "problem.created",
        payload: { id },
      });
      if (input.runAgent) {
        // Non-blocking: enqueue intake; a worker drains it and publishes
        // `problem.processed` when done (realtime updates the UI). The job
        // inherits the problem's priority so urgent problems drain first.
        await enqueueAgentJob(db, {
          kind: "problem_intake",
          payload: { targetId: id },
          workspaceId,
          priority,
        });
      }
      const detail = await getProblemDetail(db, id);
      return c.json(detail!, 201);
    })
    .openapi(contract.synthesizeProblemRoute, async (c) => {
      const db = c.get("db");
      const input = c.req.valid("json");
      const workspaceId = c.get("workspaceId");
      // Source observations may come from any accessible workspace; the new
      // problem lands in the caller's create target (`workspaceId`).
      const accessibleObs = await db
        .select({ id: schema.observations.id })
        .from(schema.observations)
        .where(
          and(
            inArray(schema.observations.id, input.observationIds),
            accessWhere(c.get("accessScope"), schema.observations.workspaceId),
          ),
        );
      if (accessibleObs.length !== new Set(input.observationIds).size) {
        return c.json({ error: "not_found", message: "Observation not accessible" }, 404);
      }
      // Non-blocking: enqueue synthesis. The worker drafts + creates the problem,
      // then publishes `problem.synthesized` so the UI surfaces it (the problem
      // doesn't exist yet, so we return a job ack instead of the problem).
      const jobId = await enqueueAgentJob(db, {
        kind: "synthesis",
        payload: {
          workspaceId,
          observationIds: input.observationIds,
          createdBy: c.get("userId"),
          hint: {
            title: input.title,
            body: input.body,
            impact: input.impact,
            urgency: input.urgency,
          },
          projectTags: input.projectTags,
        },
        workspaceId,
      });
      return c.json({ jobId }, 202);
    })
    .openapi(contract.listProblemsRoute, async (c) => {
      const db = c.get("db");
      const { limit, offset, q, tag, solved, workspaceId } = c.req.valid("query");
      // Reads span every accessible workspace; `workspaceId` narrows to one.
      const conds = listWorkspaceConds(
        c.get("accessScope"),
        schema.problems.workspaceId,
        workspaceId,
      );
      if (q && q.trim()) {
        const term = `%${q.trim()}%`;
        conds.push(or(like(schema.problems.title, term), like(schema.problems.body, term))!);
      }
      if (tag) conds.push(tagFilter(schema.problems.projectTags, tag) as never);
      if (solved) {
        // Only problems that have at least one accepted solution.
        conds.push(
          exists(
            db
              .select({ x: sql`1` })
              .from(schema.solutionLinks)
              .innerJoin(schema.solutions, eq(schema.solutions.id, schema.solutionLinks.solutionId))
              .where(
                and(
                  eq(schema.solutionLinks.targetKind, "problem"),
                  eq(schema.solutionLinks.targetId, schema.problems.id),
                  eq(schema.solutions.status, "accepted"),
                ),
              ),
          ),
        );
      }
      const where = and(...conds);
      const items = await db
        .select()
        .from(schema.problems)
        .where(where)
        .orderBy(desc(schema.problems.priority), desc(schema.problems.createdAt))
        .limit(limit ?? configuration.defaultPageSize)
        .offset(offset ?? 0);
      const totalRow = await db.select({ total: count() }).from(schema.problems).where(where);
      return c.json({ items: items.map(serializeProblem), total: totalRow[0]?.total ?? 0 }, 200);
    })
    .openapi(contract.listItemsRoute, async (c) => {
      // Unified feed: observations and problems interleaved under ONE offset, in
      // a single createdAt order. Paging each stream separately (the old client
      // approach) broke global ordering across page boundaries; here we over-fetch
      // the newest (offset+limit) of each enabled stream — the globally newest
      // (offset+limit) items must live within those — then merge, sort, and slice.
      const db = c.get("db");
      const { limit, offset, q, tag, solved, workspaceId, type } = c.req.valid("query");
      const scope = c.get("accessScope");
      const lim = limit ?? configuration.defaultPageSize;
      const off = offset ?? 0;
      const fetchN = off + lim;
      const obsEnabled = type !== "problems";
      const probEnabled = type !== "observations";

      const term = q && q.trim() ? `%${q.trim()}%` : null;

      let obsItems: ReturnType<typeof serializeObservation>[] = [];
      let probItems: ReturnType<typeof serializeProblem>[] = [];
      let obsTotal = 0;
      let probTotal = 0;

      if (obsEnabled) {
        const conds = listWorkspaceConds(scope, schema.observations.workspaceId, workspaceId);
        if (term) conds.push(or(like(schema.observations.title, term), like(schema.observations.body, term))!);
        if (tag) conds.push(tagFilter(schema.observations.projectTags, tag) as never);
        if (solved) {
          conds.push(
            exists(
              db
                .select({ x: sql`1` })
                .from(schema.solutionLinks)
                .innerJoin(schema.solutions, eq(schema.solutions.id, schema.solutionLinks.solutionId))
                .where(
                  and(
                    eq(schema.solutionLinks.targetKind, "observation"),
                    eq(schema.solutionLinks.targetId, schema.observations.id),
                    eq(schema.solutions.status, "accepted"),
                  ),
                ),
            ),
          );
        }
        const where = and(...conds);
        const rows = await db
          .select()
          .from(schema.observations)
          .where(where)
          .orderBy(desc(schema.observations.createdAt))
          .limit(fetchN);
        obsItems = rows.map(serializeObservation);
        const totalRow = await db.select({ total: count() }).from(schema.observations).where(where);
        obsTotal = totalRow[0]?.total ?? 0;
      }

      if (probEnabled) {
        const conds = listWorkspaceConds(scope, schema.problems.workspaceId, workspaceId);
        if (term) conds.push(or(like(schema.problems.title, term), like(schema.problems.body, term))!);
        if (tag) conds.push(tagFilter(schema.problems.projectTags, tag) as never);
        if (solved) {
          conds.push(
            exists(
              db
                .select({ x: sql`1` })
                .from(schema.solutionLinks)
                .innerJoin(schema.solutions, eq(schema.solutions.id, schema.solutionLinks.solutionId))
                .where(
                  and(
                    eq(schema.solutionLinks.targetKind, "problem"),
                    eq(schema.solutionLinks.targetId, schema.problems.id),
                    eq(schema.solutions.status, "accepted"),
                  ),
                ),
            ),
          );
        }
        const where = and(...conds);
        const rows = await db
          .select()
          .from(schema.problems)
          .where(where)
          .orderBy(desc(schema.problems.createdAt))
          .limit(fetchN);
        probItems = rows.map(serializeProblem);
        const totalRow = await db.select({ total: count() }).from(schema.problems).where(where);
        probTotal = totalRow[0]?.total ?? 0;
      }

      const items = [
        ...obsItems.map((data) => ({ kind: "observation" as const, ...data })),
        ...probItems.map((data) => ({ kind: "problem" as const, ...data })),
      ]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(off, off + lim);

      return c.json({ items, total: obsTotal + probTotal }, 200);
    })
    .openapi(contract.getProblemRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const detail = await getProblemDetail(db, id);
      if (!detail || !canAccessWorkspace(c.get("accessScope"), detail.problem.workspaceId)) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json(detail, 200);
    })
    .openapi(contract.reprocessProblemRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      if (!(await problemAccessible(db, c.get("accessScope"), id))) {
        return c.json({ error: "not_found" }, 404);
      }
      // Re-run at the problem's current priority so urgent problems drain first.
      const [{ priority } = { priority: 0 }] = await db
        .select({ priority: schema.problems.priority })
        .from(schema.problems)
        .where(eq(schema.problems.id, id))
        .limit(1);
      await enqueueAgentJob(db, {
        kind: "problem_intake",
        payload: { targetId: id },
        workspaceId: c.get("workspaceId"),
        priority,
      });
      const detail = await getProblemDetail(db, id);
      return c.json(detail!, 200);
    })
    .openapi(contract.updateProblemRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      if (!(await problemAccessible(db, c.get("accessScope"), id))) {
        return c.json({ error: "not_found" }, 404);
      }
      const patch: Partial<typeof schema.problems.$inferInsert> = { updatedAt: new Date() };
      if (input.title !== undefined) patch.title = input.title;
      if (input.body !== undefined) patch.body = input.body;
      if (input.impact !== undefined) patch.impact = input.impact;
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.urgency !== undefined) patch.urgency = input.urgency;
      if (input.solutionDirection !== undefined) patch.solutionDirection = input.solutionDirection;
      if (input.status !== undefined) patch.status = input.status;
      if (input.projectTags !== undefined) patch.projectTags = input.projectTags;
      await db.update(schema.problems).set(patch).where(eq(schema.problems.id, id));
      const detail = await getProblemDetail(db, id);
      return c.json(detail!, 200);
    })
    /* ---- Solutions (polymorphic) ---- */
    .openapi(contract.listSolutionsRoute, async (c) => {
      const db = c.get("db");
      const { targetKind, targetId } = c.req.valid("query");
      const scope = c.get("accessScope");
      const accessible =
        targetKind === "problem"
          ? await problemAccessible(db, scope, targetId)
          : await observationAccessible(db, scope, targetId);
      if (!accessible) return c.json([], 200);
      const rows = await db
        .select({ solution: schema.solutions })
        .from(schema.solutionLinks)
        .innerJoin(schema.solutions, eq(schema.solutions.id, schema.solutionLinks.solutionId))
        .where(
          and(
            eq(schema.solutionLinks.targetKind, targetKind),
            eq(schema.solutionLinks.targetId, targetId),
          ),
        );
      return c.json(rows.map((r) => serializeSolution(r.solution)), 200);
    })
    .openapi(contract.createSolutionRoute, async (c) => {
      const db = c.get("db");
      const input = c.req.valid("json");
      const scope = c.get("accessScope");
      const accessible =
        input.targetKind === "problem"
          ? await problemAccessible(db, scope, input.targetId)
          : await observationAccessible(db, scope, input.targetId);
      if (!accessible) {
        return c.json({ error: "not_found", message: "Target not accessible" }, 404);
      }
      const id = newId("sol");
      await db.insert(schema.solutions).values({
        id,
        body: input.body,
        origin: input.origin,
        status: "accepted",
        createdBy: c.get("userId"),
      });
      await db.insert(schema.solutionLinks).values({
        solutionId: id,
        targetKind: input.targetKind,
        targetId: input.targetId,
      });
      const created = (
        await db.select().from(schema.solutions).where(eq(schema.solutions.id, id)).limit(1)
      )[0]!;
      await publish(c.env, workspaceChannel(c.get("workspaceId")), {
        type: "solution.created",
        payload: { targetKind: input.targetKind, targetId: input.targetId, solutionId: id },
      });
      return c.json(serializeSolution(created), 201);
    })
    .openapi(contract.updateSolutionRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      // The solution must be attached to a target the caller can access.
      const linkRows = await db
        .select({ targetKind: schema.solutionLinks.targetKind, targetId: schema.solutionLinks.targetId })
        .from(schema.solutionLinks)
        .where(eq(schema.solutionLinks.solutionId, id))
        .limit(1);
      const link = linkRows[0];
      const scope = c.get("accessScope");
      const accessible =
        link &&
        (link.targetKind === "problem"
          ? await problemAccessible(db, scope, link.targetId)
          : await observationAccessible(db, scope, link.targetId));
      if (!accessible) {
        return c.json({ error: "not_found", message: "Solution not accessible" }, 404);
      }
      const patch: Partial<typeof schema.solutions.$inferInsert> = {};
      if (input.body !== undefined) patch.body = input.body;
      if (input.status !== undefined) patch.status = input.status;
      if (Object.keys(patch).length) {
        await db.update(schema.solutions).set(patch).where(eq(schema.solutions.id, id));
      }
      const updated = (
        await db.select().from(schema.solutions).where(eq(schema.solutions.id, id)).limit(1)
      )[0]!;
      return c.json(serializeSolution(updated), 200);
    })
    /* ---- Knowledge graph + agent retrieval ---- */
    .openapi(contract.getGraphRoute, async (c) => {
      const db = c.get("db");
      const { workspaceId } = c.req.valid("query");
      return c.json(
        await getWorkspaceGraph(db, { scope: c.get("accessScope"), workspaceId }),
        200,
      );
    })
    .openapi(contract.searchGraphRoute, async (c) => {
      const db = c.get("db");
      const { q, k } = c.req.valid("query");
      const queryVector = await createEmbedder(c.env).embed(q, "query");
      const results = await searchGraph(db, {
        queryVector,
        topK: k ?? configuration.graph.defaultK,
        // Isolation (#57): confine search to the caller's active platform workspace.
        workspaceId: c.get("workspaceId"),
      });
      return c.json(results, 200);
    })
    .openapi(contract.getProblemContextRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      // The graph is cross-workspace: a problem from any tenant is readable.
      const ctx = await getProblemContext(db, id);
      if (!ctx) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json(ctx as contract.ProblemContext, 200);
    })
    .openapi(contract.getNeighborhoodRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const g = configuration.graph;
      // Cross-workspace graph: root at any existing problem; null ⇒ not found.
      const result = await neighborhood(db, {
        rootId: id,
        hops: Math.min(query.hops ?? g.defaultHops, g.maxHops),
        maxNodes: Math.min(query.maxNodes ?? g.maxNodes, g.maxNodes),
      });
      if (!result) return c.json({ error: "not_found" }, 404);
      return c.json(result as contract.Neighborhood, 200);
    })
    .openapi(contract.getSolvedNeighborsRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const g = configuration.graph;
      // Cross-workspace graph: root at any existing problem; null ⇒ not found.
      const result = await findSolvedNeighbors(db, {
        rootId: id,
        hops: Math.min(query.hops ?? g.defaultHops, g.maxHops),
        maxNodes: Math.min(query.maxNodes ?? g.maxNodes, g.maxNodes),
      });
      if (result === null) return c.json({ error: "not_found" }, 404);
      return c.json(result as contract.SolvedNeighbor[], 200);
    })
    .openapi(contract.getClusterSummaryRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      // Cross-workspace graph: summarise the cluster around any existing problem.
      const summary = await getClusterSummary(db, c.env, id);
      if (!summary) return c.json({ error: "not_found" }, 404);
      return c.json(summary, 200);
    })
    /* ---- Meta ---- */
    .openapi(contract.listProjectTagsRoute, async (c) => {
      const db = c.get("db");
      const scope = c.get("accessScope");
      const obsTags = await db
        .select({ tags: schema.observations.projectTags })
        .from(schema.observations)
        .where(accessWhere(scope, schema.observations.workspaceId));
      const probTags = await db
        .select({ tags: schema.problems.projectTags })
        .from(schema.problems)
        .where(accessWhere(scope, schema.problems.workspaceId));
      const all = new Set<string>();
      for (const r of [...obsTags, ...probTags]) for (const t of r.tags ?? []) all.add(t);
      return c.json({ tags: [...all].sort() }, 200);
    })
    /* ---- Workspaces (soft grouping, not isolation) ---- */
    .openapi(contract.listWorkspacesRoute, async (c) => {
      const db = c.get("db");
      const rows = await db
        .select({
          id: schema.workspace.id,
          name: schema.workspace.name,
          slug: schema.workspace.slug,
        })
        .from(schema.workspace)
        .where(accessWhere(c.get("accessScope"), schema.workspace.id))
        .orderBy(schema.workspace.name);
      return c.json(rows, 200);
    })
    .openapi(contract.activateWorkspaceRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const ws = (
        await db
          .select({
            id: schema.workspace.id,
            name: schema.workspace.name,
            slug: schema.workspace.slug,
          })
          .from(schema.workspace)
          .where(eq(schema.workspace.id, id))
          .limit(1)
      )[0];
      if (!ws || !canAccessWorkspace(c.get("accessScope"), ws.id)) {
        return c.json({ error: "not_found" }, 404);
      }
      // Auto-enroll membership so Better Auth's active-workspace switch succeeds
      // — membership is a side effect of touching a workspace, not an access gate.
      const userId = c.get("userId");
      if (userId) {
        const existing = await db
          .select({ id: schema.member.id })
          .from(schema.member)
          .where(and(eq(schema.member.userId, userId), eq(schema.member.workspaceId, id)))
          .limit(1);
        if (existing.length === 0) {
          await db
            .insert(schema.member)
            .values({ id: newId("mem"), userId, workspaceId: id, role: "member" });
        }
      }
      return c.json(ws, 200);
    })
    /* ---- API keys (shared registry; no admin role) ---- */
    .openapi(contract.listApiKeysRoute, async (c) => {
      // Every key, every owner — there is no admin concept and workspaces are a
      // soft grouping, so any authenticated user manages the whole registry. The
      // secret column (`key`) is deliberately never selected.
      const db = c.get("db");
      const rows = await db
        .select({
          id: schema.apikey.id,
          name: schema.apikey.name,
          start: schema.apikey.start,
          enabled: schema.apikey.enabled,
          createdAt: schema.apikey.createdAt,
          lastRequest: schema.apikey.lastRequest,
          expiresAt: schema.apikey.expiresAt,
          metadata: schema.apikey.metadata,
          ownerId: schema.user.id,
          ownerName: schema.user.name,
          ownerEmail: schema.user.email,
        })
        .from(schema.apikey)
        .leftJoin(schema.user, eq(schema.user.id, schema.apikey.userId))
        .orderBy(desc(schema.apikey.createdAt));
      return c.json(rows.map(serializeApiKey), 200);
    })
    .openapi(contract.revokeApiKeyRoute, async (c) => {
      const db = c.get("db");
      const { id } = c.req.valid("param");
      const existing = await db
        .select({ id: schema.apikey.id })
        .from(schema.apikey)
        .where(eq(schema.apikey.id, id))
        .limit(1);
      if (existing.length === 0) return c.json({ error: "not_found" }, 404);
      await db.delete(schema.apikey).where(eq(schema.apikey.id, id));
      return c.json({ success: true }, 200);
    });

  // Auth schemes for `/v1/*` (attached per route in the contract via `security`).
  routed.openAPIRegistry.registerComponent("securitySchemes", "ApiKeyAuth", {
    type: "apiKey",
    in: "header",
    name: "x-api-key",
  });
  routed.openAPIRegistry.registerComponent("securitySchemes", "DevWorkspace", {
    type: "apiKey",
    in: "header",
    name: "x-dev-workspace",
  });

  routed.doc("/doc", DOC_CONFIG);
  routed.get("/ui", swaggerUI({ url: "/doc" }));

  return routed;
}

const app = buildApp();

// Plain Hono app. Embeddings are computed inline at create/search time, so no
// background consumer (Cron/scheduled) is required for the core embed→store→
// search loop. The `agent_jobs` queue (LLM classification/linking/synthesis) is
// still enqueued behind `runAgent` but is inert unless a consumer is run
// (`bun run dev:worker`). See MIGRATION.md "Async agent jobs".
export default app;
export type AppType = ReturnType<typeof buildApp>;
