import { z } from "zod";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { configuration } from "../lib/config/index.js";
import { type Database, schema } from "../lib/db/index.js";
import { urgencyToPriority } from "../lib/contract/schemas.js";
import type {
  NotebookCall,
  CreateProblemInput,
  ListProblemsInput,
  LinkProblemsInput,
  SearchNotebookInput,
  ReadRecordInput,
  RecordObservationInput,
  RecordSolutionInput,
  TieObservationInput,
  UpdateObservationInput,
} from "../lib/contract/notebook-tools.js";
import { canAccessWorkspace, scopeForWorkspace } from "./access.js";
import { getObservationDetail, getProblemDetail } from "./data.js";
import { observationAccessible, problemAccessible, sourceAccessible } from "./middleware.js";
import { matchExpression } from "./search-query.js";
import { serializeProblemLink, serializeSolution, serializeSource } from "./serializers.js";

/**
 * The Notebook's MCP tools (ADR-0024): "a store that agents write and canvas reads", as the
 * agent holds it. Pure and dependency-injected — no MCP SDK, no HTTP, no Hono context — so
 * this is the ONE seam every surface wraps: the edge MCP server, the platform-RPC verb the
 * container's turn calls, and the container's own SDK tool defs. Same shape as
 * `worker/mcp-tools.ts` is to `worker/mcp-server.ts`, one layer down.
 *
 * Two properties are contract rather than style:
 *
 * **The workspace comes from the caller, never a tool argument.** It is fixed here, at
 * construction, from whatever proved the caller's identity — the OAuth token's user at the
 * edge, the container's own workspace inside a turn. No tool input carries a workspace, so
 * isolation is a property of the surface rather than of each tool remembering to filter.
 *
 * **A list carries identifiers and one line, never bodies.** `read_canvas` returning a whole
 * canvas is what drove agents to spool results through a file; a Notebook that grows fast has
 * the same failure waiting. Full records are fetched one at a time, by id.
 *
 * A tool asked for something that is not there THROWS. Every caller turns that into a tool
 * error the agent reads — an empty success would have it record against a problem that does
 * not exist and never learn.
 */

export interface NotebookToolDeps {
  db: Database;
  /** The caller's workspace — the only one these tools can see. */
  workspaceId: string;
  /** Attribution (`created_by`). Null when the caller has no resolved user. */
  userId: string | null;
  /** Who is producing these records (`origin`) — the agent, or a human acting directly. */
  origin: "agent" | "human";
}

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

/** One search hit: enough to identify the record and see why it matched. Never a body. */
export interface SearchHit {
  id: string;
  kind: "observation" | "problem";
  title: string;
  snippet: string;
}

export function buildNotebookTools(deps: NotebookToolDeps) {
  const scope = scopeForWorkspace(deps.workspaceId);

  /** The refusal every "no such record" takes, so an agent reads one sentence either way. */
  const notFound = (what: string, id: string): never => {
    throw new Error(`${what} not found in this workspace: ${id}`);
  };

  const requireObservation = async (id: string) => {
    if (!(await observationAccessible(deps.db, scope, id))) notFound("observation", id);
  };

  const requireProblem = async (id: string) => {
    if (!(await problemAccessible(deps.db, scope, id))) notFound("problem", id);
  };

  return {
    /** Record an observation, naming where it came from in the same call. */
    async recordObservation(input: z.infer<typeof RecordObservationInput>) {
      let sourceId: string | null = null;
      let source: ReturnType<typeof serializeSource> | null = null;
      if (input.source) {
        sourceId = newId("src");
        const row = {
          id: sourceId,
          workspaceId: deps.workspaceId,
          kind: input.source.kind,
          identifier: input.source.identifier ?? null,
          label: input.source.label ?? null,
          description: input.source.description ?? null,
          createdBy: deps.userId,
        };
        await deps.db.insert(schema.sources).values(row);
      } else if (input.source_id) {
        // A source from another workspace is the same refusal as one that does not exist:
        // an agent must never be able to probe for a neighbour's rows by id.
        if (!(await sourceAccessible(deps.db, scope, input.source_id))) notFound("source", input.source_id);
        sourceId = input.source_id;
      }

      const id = newId("obs");
      await deps.db.insert(schema.observations).values({
        id,
        workspaceId: deps.workspaceId,
        title: input.title,
        body: input.body,
        impact: input.impact ?? null,
        origin: deps.origin,
        sourceId,
        createdBy: deps.userId,
        projectTags: input.project_tags ?? [],
      });

      if (sourceId) {
        const rows = await deps.db.select().from(schema.sources).where(eq(schema.sources.id, sourceId)).limit(1);
        source = rows[0] ? serializeSource(rows[0]) : null;
      }
      return { id, source };
    },

    /** Edit an observation this workspace holds. */
    async updateObservation(input: z.infer<typeof UpdateObservationInput>) {
      await requireObservation(input.id);
      const patch: Partial<typeof schema.observations.$inferInsert> = { updatedAt: new Date() };
      if (input.title !== undefined) patch.title = input.title;
      if (input.body !== undefined) patch.body = input.body;
      if (input.impact !== undefined) patch.impact = input.impact;
      if (input.status !== undefined) patch.status = input.status;
      if (input.project_tags !== undefined) patch.projectTags = input.project_tags;
      await deps.db.update(schema.observations).set(patch).where(eq(schema.observations.id, input.id));
      return (await getObservationDetail(deps.db, input.id))!;
    },

    /** Record a problem. Urgency implies its sort weight; an explicit priority still wins. */
    async createProblem(input: z.infer<typeof CreateProblemInput>) {
      const id = newId("prob");
      await deps.db.insert(schema.problems).values({
        id,
        workspaceId: deps.workspaceId,
        title: input.title,
        body: input.body,
        impact: input.impact ?? null,
        priority: input.priority ?? urgencyToPriority(input.urgency ?? "medium"),
        urgency: input.urgency ?? "medium",
        solutionDirection: input.solution_direction ?? null,
        origin: deps.origin,
        createdBy: deps.userId,
        projectTags: input.project_tags ?? [],
      });
      return { id };
    },

    /** Tie an observation to a problem, recording how strongly it feeds it and why.
     *  Tying the same pair twice restates the tie rather than failing. */
    async tieObservation(input: z.infer<typeof TieObservationInput>) {
      await requireProblem(input.problem_id);
      await requireObservation(input.observation_id);
      const values = {
        observationId: input.observation_id,
        problemId: input.problem_id,
        relevance: input.relevance ?? null,
        rationale: input.rationale ?? null,
        createdBy: deps.origin,
      };
      await deps.db
        .insert(schema.observationProblems)
        .values(values)
        .onConflictDoUpdate({
          target: [schema.observationProblems.observationId, schema.observationProblems.problemId],
          set: { relevance: values.relevance, rationale: values.rationale, createdBy: values.createdBy },
        });
      return { problem_id: input.problem_id, observation_id: input.observation_id };
    },

    /** Link two problems deliberately (ADR-0024: never inferred). Both ends must be in the
     *  caller's workspace — a link never crosses one. Re-linking restates the link. */
    async linkProblems(input: z.infer<typeof LinkProblemsInput>) {
      await requireProblem(input.from_problem_id);
      await requireProblem(input.to_problem_id);
      const where = and(
        eq(schema.problemLinks.fromProblemId, input.from_problem_id),
        eq(schema.problemLinks.toProblemId, input.to_problem_id),
      );
      const values = { kind: input.kind, rationale: input.rationale ?? null, createdBy: deps.origin };
      const existing = await deps.db.select().from(schema.problemLinks).where(where).limit(1);
      if (existing[0]) await deps.db.update(schema.problemLinks).set(values).where(where);
      else
        await deps.db.insert(schema.problemLinks).values({
          id: newId("plink"),
          fromProblemId: input.from_problem_id,
          toProblemId: input.to_problem_id,
          ...values,
        });
      const link = (await deps.db.select().from(schema.problemLinks).where(where).limit(1))[0]!;
      return serializeProblemLink(link);
    },

    /** Attach a solution to an observation or a problem. */
    async recordSolution(input: z.infer<typeof RecordSolutionInput>) {
      if (input.target_kind === "problem") await requireProblem(input.target_id);
      else await requireObservation(input.target_id);
      const id = newId("sol");
      await deps.db.insert(schema.solutions).values({
        id,
        body: input.body,
        // The Notebook's own origin vocabulary for a solution: an agent writing one here is
        // synthesizing it from what the workspace holds; a human is authoring it directly.
        origin: deps.origin === "agent" ? "synthesized" : "human",
        status: "accepted",
        createdBy: deps.userId,
      });
      await deps.db
        .insert(schema.solutionLinks)
        .values({ solutionId: id, targetKind: input.target_kind, targetId: input.target_id });
      const created = (await deps.db.select().from(schema.solutions).where(eq(schema.solutions.id, id)).limit(1))[0]!;
      return serializeSolution(created);
    },

    /**
     * Search the workspace's Observations and Problems (D1's FTS5, ADR-0024). A hit is a
     * POINTER — id, kind, title and the matching excerpt — never a body: reading a record is
     * the separate call, one at a time.
     */
    async search(input: z.infer<typeof SearchNotebookInput>) {
      const match = matchExpression(input.q);
      const empty = { items: [] as SearchHit[], total: 0 };
      if (!match) return empty;
      const where = sql`notebook_fts MATCH ${match} AND workspace_id = ${deps.workspaceId}`;
      // `-1` lets FTS5 pick the column that matched best; the excerpt is bounded at 20
      // tokens, so a result stays a pointer however long the record is.
      const rows = await deps.db.all<SearchHit>(
        sql`SELECT record_id AS id, kind, title, snippet(notebook_fts, -1, '[', ']', '…', 20) AS snippet
            FROM notebook_fts WHERE ${where}
            ORDER BY rank
            LIMIT ${input.limit ?? configuration.defaultPageSize} OFFSET ${input.offset ?? 0}`,
      );
      const totals = await deps.db.all<{ total: number }>(
        sql`SELECT count(*) AS total FROM notebook_fts WHERE ${where}`,
      );
      return { items: rows, total: totals[0]?.total ?? 0 };
    },

    /**
     * The workspace's problems, highest priority first. Summaries only — the columns needed
     * to identify and rank a problem, never the body (the same discipline `GET /v1/problems`
     * keeps): a list that carried bodies is the read that blows an agent's context window.
     */
    async listProblems(input: z.infer<typeof ListProblemsInput>) {
      const conds = [eq(schema.problems.workspaceId, deps.workspaceId)];
      if (input.status) conds.push(eq(schema.problems.status, input.status));
      // Match a single tag inside the JSON-encoded `project_tags` array.
      if (input.tag) conds.push(sql`${schema.problems.projectTags} LIKE ${`%"${input.tag}"%`}` as never);
      const where = and(...conds);
      const items = await deps.db
        .select({
          id: schema.problems.id,
          title: schema.problems.title,
          status: schema.problems.status,
          priority: schema.problems.priority,
          urgency: schema.problems.urgency,
          createdAt: schema.problems.createdAt,
        })
        .from(schema.problems)
        .where(where)
        .orderBy(desc(schema.problems.priority), desc(schema.problems.createdAt))
        .limit(input.limit ?? configuration.defaultPageSize)
        .offset(input.offset ?? 0);
      const totalRow = await deps.db.select({ total: count() }).from(schema.problems).where(where);
      return {
        items: items.map((p) => ({ ...p, createdAt: p.createdAt.getTime() })),
        total: totalRow[0]?.total ?? 0,
      };
    },

    /** One problem in full, with its links, its solutions and the observations that feed it. */
    async readProblem(input: z.infer<typeof ReadRecordInput>) {
      const detail = await getProblemDetail(deps.db, input.id);
      if (!detail || !canAccessWorkspace(scope, detail.problem.workspaceId)) notFound("problem", input.id);
      return detail!;
    },

    /** One observation in full, with its source and its edges. */
    async readObservation(input: z.infer<typeof ReadRecordInput>) {
      const detail = await getObservationDetail(deps.db, input.id);
      if (!detail || !canAccessWorkspace(scope, detail.observation.workspaceId)) {
        notFound("observation", input.id);
      }
      return detail!;
    },
  };
}

export type NotebookTools = ReturnType<typeof buildNotebookTools>;

/**
 * Run one named call against a built set of tools — the single tool-name → method mapping,
 * used by every surface that dispatches by name (the platform-RPC handler, the container's
 * tool defs). A refusal propagates as the thrown error each surface turns into a tool error.
 */
export function runNotebookCall(tools: NotebookTools, call: NotebookCall): Promise<unknown> {
  switch (call.tool) {
    case "record_observation":
      return tools.recordObservation(call.input);
    case "update_observation":
      return tools.updateObservation(call.input);
    case "create_problem":
      return tools.createProblem(call.input);
    case "tie_observation":
      return tools.tieObservation(call.input);
    case "link_problems":
      return tools.linkProblems(call.input);
    case "record_solution":
      return tools.recordSolution(call.input);
    case "search":
      return tools.search(call.input);
    case "read_observation":
      return tools.readObservation(call.input);
    case "read_problem":
      return tools.readProblem(call.input);
    case "list_problems":
      return tools.listProblems(call.input);
  }
}
