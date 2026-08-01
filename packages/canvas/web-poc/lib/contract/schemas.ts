import { z } from "@hono/zod-openapi";

export const ObservationStatus = z.enum(["open", "synthesized", "archived"]);
export const ProblemStatus = z.enum(["open", "investigating", "resolved", "archived"]);
export const Urgency = z.enum(["low", "medium", "high", "critical"]);

/**
 * Urgency seeds a problem's default sort weight ("urgency implies priority").
 * The gaps leave headroom to hand-tune `priority` within an urgency tier without
 * crossing into the next one (e.g. nudge a "high" problem to 25 to outrank its
 * peers while still sorting below every "critical").
 */
export const URGENCY_PRIORITY: Record<z.infer<typeof Urgency>, number> = {
  low: 0,
  medium: 10,
  high: 20,
  critical: 30,
};

/** Default priority implied by an urgency level. */
export function urgencyToPriority(urgency: z.infer<typeof Urgency>): number {
  return URGENCY_PRIORITY[urgency];
}
/** Who produced a record. Distinct from a Source, which is where it came from. */
export const Origin = z.enum(["human", "agent"]);
/** What a Source points at: external things and cedarpad entities in one list. */
export const SourceKind = z.enum([
  "url",
  "call",
  "document",
  "person",
  "conversation",
  "canvas",
  "repo",
]);
export const LinkKind = z.enum(["identical", "partial", "related"]);
export const SolutionOrigin = z.enum(["reused", "synthesized", "research", "human"]);
export const SolutionStatus = z.enum(["draft", "accepted", "rejected"]);
export const SolutionTargetKind = z.enum(["observation", "problem"]);

/** Weightless human meta tags. Never fed to embeddings or the LLM. */
const ProjectTags = z
  .array(z.string())
  .openapi({ description: "Human-only meta tags ('Project'); excluded from all heuristics/LLM input" });

/* ------------------------------------------------------------------ *
 * Observation — a loose record of something worth noting
 * ------------------------------------------------------------------ */

export const SourceSchema = z
  .object({
    id: z.string().openapi({ example: "src_01h..." }),
    workspaceId: z.string(),
    kind: SourceKind,
    identifier: z
      .string()
      .nullable()
      .openapi({ description: "The thing pointed at — a URL, a conversation id, a file path" }),
    label: z.string().nullable(),
    description: z
      .string()
      .nullable()
      .openapi({ description: "Carries the source when there is nothing to point at" }),
    createdAt: z.number().openapi({ description: "epoch ms" }),
  })
  .openapi("Source");

/**
 * A Source created inline with the observation that names it. Either an
 * `identifier` or a `description` must be present: a Source that says neither
 * what it points at nor what it was records nothing.
 */
export const CreateSourceSchema = z
  .object({
    kind: SourceKind,
    identifier: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
  })
  .refine((v) => v.identifier != null || v.description != null, {
    message: "a Source needs an identifier or a description",
  })
  .openapi("CreateSource");

export const ObservationSchema = z
  .object({
    id: z.string().openapi({ example: "obs_01h..." }),
    workspaceId: z.string(),
    title: z.string().openapi({ example: "Checkout felt sluggish this morning" }),
    body: z.string(),
    impact: z
      .string()
      .nullable()
      .openapi({ description: "The concrete impact this observation calls out" }),
    status: ObservationStatus,
    /** Who produced it. */
    origin: Origin,
    /** Where it came from; null when there was nothing to point at. */
    sourceId: z.string().nullable(),
    projectTags: ProjectTags,
    createdBy: z.string().nullable(),
    createdAt: z.number().openapi({ description: "epoch ms" }),
    updatedAt: z.number(),
  })
  .openapi("Observation");

/**
 * Record an observation. Its Source is named in the SAME call — either created
 * inline (`source`) or pointed at by id (`sourceId`), and both may be omitted.
 */
export const CreateObservationSchema = z
  .object({
    title: z.string().min(1).max(300),
    body: z.string().min(1),
    impact: z.string().optional(),
    projectTags: z.array(z.string()).optional(),
    source: CreateSourceSchema.optional(),
    sourceId: z.string().optional(),
  })
  .openapi("CreateObservation");

export const UpdateObservationSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    body: z.string().min(1).optional(),
    impact: z.string().optional(),
    status: ObservationStatus.optional(),
    projectTags: z.array(z.string()).optional(),
    sourceId: z.string().nullable().optional(),
  })
  .openapi("UpdateObservation");

/* ------------------------------------------------------------------ *
 * Problem — specific, prioritized, urgent; shapes its solution
 * ------------------------------------------------------------------ */

export const ProblemSchema = z
  .object({
    id: z.string().openapi({ example: "prob_01h..." }),
    workspaceId: z.string(),
    title: z.string().openapi({ example: "Checkout 500s under load" }),
    body: z.string().openapi({ example: "Users hit intermittent 500s during checkout when..." }),
    impact: z.string().nullable().openapi({ description: "The concrete impact this problem calls out" }),
    priority: z.number().openapi({ description: "Relative weight against other problems (higher first)" }),
    urgency: Urgency,
    solutionDirection: z.string().nullable().openapi({ description: "Guidance on how a solution should be structured" }),
    status: ProblemStatus,
    origin: Origin,
    projectTags: ProjectTags,
    createdBy: z.string().nullable(),
    createdAt: z.number().openapi({ description: "epoch ms" }),
    updatedAt: z.number(),
  })
  .openapi("Problem");

export const CreateProblemSchema = z
  .object({
    title: z.string().min(1).max(300),
    body: z.string().min(1),
    impact: z.string().optional(),
    priority: z.number().int().optional(),
    urgency: Urgency.optional(),
    solutionDirection: z.string().optional(),
    projectTags: z.array(z.string()).optional(),
  })
  .openapi("CreateProblem");

/** Partial edits to a problem (human correction). */
export const UpdateProblemSchema = z
  .object({
    title: z.string().min(1).max(300).optional(),
    body: z.string().min(1).optional(),
    impact: z.string().optional(),
    priority: z.number().int().optional(),
    urgency: Urgency.optional(),
    solutionDirection: z.string().optional(),
    status: ProblemStatus.optional(),
    projectTags: z.array(z.string()).optional(),
  })
  .openapi("UpdateProblem");

/* ------------------------------------------------------------------ *
 * Solution — solves an observation or a problem (polymorphic target)
 * ------------------------------------------------------------------ */

export const SolutionSchema = z
  .object({
    id: z.string(),
    body: z.string(),
    status: SolutionStatus,
    origin: SolutionOrigin,
    createdBy: z.string().nullable(),
    createdAt: z.number(),
  })
  .openapi("Solution");

export const CreateSolutionSchema = z
  .object({
    targetKind: SolutionTargetKind,
    targetId: z.string(),
    body: z.string().min(1),
    // This endpoint attaches a human-authored solution, so it defaults to "human".
    origin: SolutionOrigin.optional().default("human"),
  })
  .openapi("CreateSolution");

/** Partial edits to a solution — lets a human correct/accept the AI's answer. */
export const UpdateSolutionSchema = z
  .object({
    body: z.string().min(1).optional(),
    status: SolutionStatus.optional(),
  })
  .openapi("UpdateSolution");

/* ------------------------------------------------------------------ *
 * Edges
 * ------------------------------------------------------------------ */

export const ProblemLinkSchema = z
  .object({
    id: z.string(),
    fromProblemId: z.string(),
    toProblemId: z.string(),
    kind: LinkKind,
    similarity: z.number().nullable(),
    rationale: z.string().nullable(),
    createdBy: Origin,
  })
  .openapi("ProblemLink");

/**
 * Drawing a link between two problems. Deliberate, never inferred (ADR-0024):
 * the caller says which kind of relation it is and why, and there is no
 * similarity score to carry.
 */
export const LinkProblemSchema = z
  .object({
    toProblemId: z.string().min(1),
    kind: LinkKind,
    rationale: z.string().min(1).optional(),
  })
  .openapi("LinkProblem");

/** A linked problem joined with the edge that connects it (for detail view). */
export const LinkedProblemSchema = z
  .object({
    link: ProblemLinkSchema,
    problem: ProblemSchema,
  })
  .openapi("LinkedProblem");

/**
 * The tie between an Observation and a Problem: many-to-many, carrying how
 * relevant the observation is to the problem, why it was drawn, and whether a
 * human or an agent drew it.
 */
export const ObservationProblemEdgeSchema = z
  .object({
    observationId: z.string(),
    problemId: z.string(),
    relevance: z
      .number()
      .nullable()
      .openapi({ description: "How strongly this observation feeds the problem (0–1)" }),
    rationale: z.string().nullable().openapi({ description: "Why the tie was drawn" }),
    createdBy: Origin.openapi({ description: "Who drew the tie" }),
    createdAt: z.number().openapi({ description: "epoch ms" }),
  })
  .openapi("ObservationProblemEdge");

/** Tie an existing Observation to a Problem. */
export const TieObservationSchema = z
  .object({
    observationId: z.string().min(1),
    relevance: z.number().min(0).max(1).optional(),
    rationale: z.string().min(1).optional(),
  })
  .openapi("TieObservation");

/**
 * The record on the other end of a tie, joined with the tie itself: enough to
 * show and rank it, never its body — a Problem's body belongs to its own read.
 */
export const TieRefSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    rationale: z.string().nullable(),
    relevance: z.number().nullable(),
    createdBy: Origin.openapi({ description: "Who drew the tie" }),
  })
  .openapi("TieRef");

/* ------------------------------------------------------------------ *
 * Detail payloads
 * ------------------------------------------------------------------ */

export const ProblemDetailSchema = z
  .object({
    problem: ProblemSchema,
    links: z.array(LinkedProblemSchema),
    solutions: z.array(SolutionSchema),
    /** The Observations that feed this problem. */
    observations: z.array(TieRefSchema),
  })
  .openapi("ProblemDetail");

export const ObservationDetailSchema = z
  .object({
    observation: ObservationSchema,
    /** The Source it names, resolved; null when it has none. */
    source: SourceSchema.nullable(),
    solutions: z.array(SolutionSchema),
    /** The Problems this observation feeds. */
    problems: z.array(TieRefSchema),
  })
  .openapi("ObservationDetail");

/**
 * A Problem as it appears in a list: what you need to identify and rank it, and
 * nothing more. Bodies are deliberately absent — the read that returns
 * everything is the one that later blows an agent's context window. Fetch the
 * problem itself for its body, impact and solution direction.
 */
export const ProblemSummarySchema = ProblemSchema.pick({
  id: true,
  workspaceId: true,
  title: true,
  status: true,
  priority: true,
  urgency: true,
  createdAt: true,
}).openapi("ProblemSummary");

/** A page of problem summaries with the total count for pagination. */
export const ProblemPageSchema = z
  .object({
    items: z.array(ProblemSummarySchema),
    total: z.number().openapi({ description: "total problems matching the filter" }),
  })
  .openapi("ProblemPage");

/** A page of observations with the total count for pagination. */
export const ObservationPageSchema = z
  .object({
    items: z.array(ObservationSchema),
    total: z.number().openapi({ description: "total observations matching the filter" }),
  })
  .openapi("ObservationPage");

/* ------------------------------------------------------------------ *
 * Unified feed — observations and problems interleaved under one offset
 * ------------------------------------------------------------------ */

/**
 * A single entry in the unified feed: an observation or a problem, tagged by
 * `kind`. Lets the list page both streams as one createdAt-ordered sequence
 * instead of paging each independently (which broke ordering across pages).
 */
export const FeedItemSchema = z
  .discriminatedUnion("kind", [
    ObservationSchema.extend({ kind: z.literal("observation") }),
    ProblemSchema.extend({ kind: z.literal("problem") }),
  ])
  .openapi("FeedItem");

/** A page of the unified feed with the combined total for pagination. */
export const ItemPageSchema = z
  .object({
    items: z.array(FeedItemSchema),
    total: z
      .number()
      .openapi({ description: "total observations + problems matching the filter" }),
  })
  .openapi("ItemPage");

/* ------------------------------------------------------------------ *
 * Knowledge graph for a workspace
 * ------------------------------------------------------------------ */

export const GraphNodeSchema = z
  .object({
    id: z.string(),
    type: z.enum(["observation", "problem", "solution"]),
    label: z.string(),
    status: z.string().optional(),
  })
  .openapi("GraphNode");

export const GraphEdgeSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
    kind: z.string().openapi({ description: "link kind, 'solves', or 'synthesizes'" }),
    weight: z.number().nullable(),
  })
  .openapi("GraphEdge");

export const GraphSchema = z
  .object({
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
  })
  .openapi("Graph");

/* ------------------------------------------------------------------ *
 * Agent graph retrieval — bounded, read-only views over the stored graph.
 * Every one of them is confined to the caller's workspace (ADR-0024).
 * ------------------------------------------------------------------ */

/** One edge in a problem's context view, with the stored rationale. */
export const ContextEdgeSchema = z
  .object({
    id: z.string(),
    direction: z.enum(["out", "in"]),
    problemId: z.string().openapi({ description: "the problem at the other end" }),
    title: z.string(),
    kind: LinkKind,
    similarity: z.number().nullable(),
    rationale: z.string().nullable(),
  })
  .openapi("ContextEdge");

export const ContextSolutionSchema = z
  .object({
    id: z.string(),
    body: z.string(),
    status: SolutionStatus,
    origin: SolutionOrigin,
  })
  .openapi("ContextSolution");

export const ProblemContextSchema = z
  .object({
    problem: z.object({
      id: z.string(),
      workspaceId: z.string(),
      title: z.string(),
      body: z.string(),
      status: ProblemStatus,
    }),
    edges: z.array(ContextEdgeSchema),
    solutions: z.array(ContextSolutionSchema),
  })
  .openapi("ProblemContext");

export const NeighborhoodNodeSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    depth: z.number().openapi({ description: "shortest hop distance from the root" }),
  })
  .openapi("NeighborhoodNode");

export const NeighborhoodEdgeSchema = z
  .object({
    id: z.string(),
    fromProblemId: z.string(),
    toProblemId: z.string(),
    kind: LinkKind,
    similarity: z.number().nullable(),
    rationale: z.string().nullable(),
  })
  .openapi("NeighborhoodEdge");

export const NeighborhoodSchema = z
  .object({
    rootId: z.string(),
    nodes: z.array(NeighborhoodNodeSchema),
    edges: z.array(NeighborhoodEdgeSchema),
  })
  .openapi("Neighborhood");


/* ------------------------------------------------------------------ *
 * Query params
 * ------------------------------------------------------------------ */

/** Shared params for the bounded traversal endpoints. */
export const NeighborhoodQuery = z.object({
  hops: z.coerce.number().int().min(1).optional(),
  maxNodes: z.coerce.number().int().min(1).optional(),
});

export const ErrorSchema = z
  .object({
    error: z.string(),
    message: z.string().optional(),
  })
  .openapi("Error");

export const IdParam = z.object({
  id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "prob_01h..." }),
});

/** Both ends of a Problem↔Problem link, addressed in the path. */
export const ProblemLinkParams = z.object({
  id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "prob_01h..." }),
  toProblemId: z
    .string()
    .min(1)
    .openapi({ param: { name: "toProblemId", in: "path" }, example: "prob_02h..." }),
});

/** Both ends of an Observation↔Problem tie, addressed in the path. */
export const EdgeParams = z.object({
  id: z.string().min(1).openapi({ param: { name: "id", in: "path" }, example: "prob_01h..." }),
  observationId: z
    .string()
    .min(1)
    .openapi({ param: { name: "observationId", in: "path" }, example: "obs_01h..." }),
});

export const ListProblemsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional().openapi({ param: { name: "offset", in: "query" } }),
  q: z.string().optional().openapi({ param: { name: "q", in: "query" } }),
  tag: z.string().optional().openapi({ param: { name: "tag", in: "query" }, description: "filter by a project meta tag" }),
  solved: z
    .preprocess(
      (v) => (v === undefined ? undefined : v === "true" || v === true || v === "1"),
      z.boolean().optional(),
    )
    .openapi({ param: { name: "solved", in: "query" } }),
  workspaceId: z.string().optional().openapi({
    param: { name: "workspaceId", in: "query" },
    description: "narrow the all-workspaces list to a single workspace",
  }),
});

/* ------------------------------------------------------------------ *
 * Search — FTS5 over Observations and Problems (ADR-0024)
 * ------------------------------------------------------------------ */

/** Query for the FTS5 search across both searchable kinds. */
export const SearchQuery = z.object({
  q: z.string().openapi({ param: { name: "q", in: "query" }, description: "free text; FTS5 syntax characters are treated as text" }),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional().openapi({ param: { name: "offset", in: "query" } }),
});

/**
 * One hit: enough to identify the record and show why it matched. Deliberately
 * never the full body — a search result is a pointer, and the detail route is
 * how a caller reads the record.
 */
export const SearchResultSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["observation", "problem"]),
    title: z.string(),
    snippet: z.string().openapi({ description: "matching excerpt, with the matched terms marked by [ ]" }),
  })
  .openapi("SearchResult");

/** A page of search hits, ranked most relevant first. */
export const SearchPageSchema = z
  .object({
    items: z.array(SearchResultSchema),
    total: z.number().openapi({ description: "total records matching the query" }),
  })
  .openapi("SearchPage");

export const ListObservationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional().openapi({ param: { name: "offset", in: "query" } }),
  q: z.string().optional().openapi({ param: { name: "q", in: "query" } }),
  tag: z.string().optional().openapi({ param: { name: "tag", in: "query" }, description: "filter by a project meta tag" }),
  status: ObservationStatus.optional().openapi({ param: { name: "status", in: "query" } }),
  solved: z
    .preprocess(
      (v) => (v === undefined ? undefined : v === "true" || v === true || v === "1"),
      z.boolean().optional(),
    )
    .openapi({ param: { name: "solved", in: "query" } }),
  workspaceId: z.string().optional().openapi({
    param: { name: "workspaceId", in: "query" },
    description: "narrow the all-workspaces list to a single workspace",
  }),
});

/** Limit the unified feed to one kind, or interleave both (default). */
export const ItemTypeFilter = z.enum(["all", "observations", "problems"]);

/** Query for the unified observations+problems feed (paginated over the combined set). */
export const ListItemsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional().openapi({ param: { name: "offset", in: "query" } }),
  q: z.string().optional().openapi({ param: { name: "q", in: "query" } }),
  tag: z.string().optional().openapi({ param: { name: "tag", in: "query" }, description: "filter by a project meta tag" }),
  solved: z
    .preprocess(
      (v) => (v === undefined ? undefined : v === "true" || v === true || v === "1"),
      z.boolean().optional(),
    )
    .openapi({ param: { name: "solved", in: "query" } }),
  workspaceId: z.string().optional().openapi({
    param: { name: "workspaceId", in: "query" },
    description: "narrow the all-workspaces feed to a single workspace",
  }),
  type: ItemTypeFilter.optional().openapi({
    param: { name: "type", in: "query" },
    description: "limit the feed to one kind (default: all)",
  }),
});

/** Query for the knowledge-graph view: optional single-workspace focus. */
export const GraphQuery = z.object({
  workspaceId: z.string().optional().openapi({
    param: { name: "workspaceId", in: "query" },
    description: "focus the graph on a single workspace (default: all accessible)",
  }),
});

/** A workspace as surfaced to the picker / filters. */
export const WorkspaceSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
  })
  .openapi("WorkspaceSummary");

export const ListSolutionsQuery = z.object({
  targetKind: SolutionTargetKind.openapi({ param: { name: "targetKind", in: "query" } }),
  targetId: z.string().openapi({ param: { name: "targetId", in: "query" } }),
});

/** Distinct project meta tags in the workspace, for autocomplete/prefill. */
export const ProjectTagsSchema = z
  .object({ tags: z.array(z.string()) })
  .openapi("ProjectTags");

/**
 * An API key in the shared registry. There is no admin role — every user sees
 * and can revoke every key — so this carries the `owner` (who minted it) and
 * `lastRequest` (to spot stale keys). The secret itself is never included; it is
 * shown exactly once, at creation.
 */
export const ApiKeyAdminSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    start: z.string().nullable().openapi({ description: "First chars of the key, for identification" }),
    enabled: z.boolean(),
    createdAt: z.number().openapi({ description: "epoch ms" }),
    lastRequest: z.number().nullable().openapi({ description: "epoch ms of last use; null ⇒ never used" }),
    expiresAt: z.number().nullable().openapi({ description: "epoch ms; null ⇒ never expires" }),
    defaultWorkspaceId: z.string().nullable().openapi({ description: "Workspace this key's writes land in" }),
    allowedWorkspaces: z.array(z.string()).nullable().openapi({ description: "Read scope; null ⇒ all workspaces" }),
    owner: z
      .object({ id: z.string(), name: z.string(), email: z.string() })
      .nullable()
      .openapi({ description: "The user who created the key" }),
  })
  .openapi("ApiKeyAdmin");

/** Acknowledgement for a successful revoke. */
export const DeleteResultSchema = z.object({ success: z.boolean() }).openapi("DeleteResult");

export type Source = z.infer<typeof SourceSchema>;
export type CreateSource = z.infer<typeof CreateSourceSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type CreateObservation = z.infer<typeof CreateObservationSchema>;
export type UpdateObservation = z.infer<typeof UpdateObservationSchema>;
export type ObservationDetail = z.infer<typeof ObservationDetailSchema>;
export type ObservationPage = z.infer<typeof ObservationPageSchema>;
export type FeedItem = z.infer<typeof FeedItemSchema>;
export type ItemPage = z.infer<typeof ItemPageSchema>;
export type Problem = z.infer<typeof ProblemSchema>;
export type CreateProblem = z.infer<typeof CreateProblemSchema>;
export type UpdateProblem = z.infer<typeof UpdateProblemSchema>;
export type Solution = z.infer<typeof SolutionSchema>;
export type CreateSolution = z.infer<typeof CreateSolutionSchema>;
export type UpdateSolution = z.infer<typeof UpdateSolutionSchema>;
export type ProblemLink = z.infer<typeof ProblemLinkSchema>;
export type LinkProblem = z.infer<typeof LinkProblemSchema>;
export type ObservationProblemEdge = z.infer<typeof ObservationProblemEdgeSchema>;
export type TieObservation = z.infer<typeof TieObservationSchema>;
export type ProblemDetail = z.infer<typeof ProblemDetailSchema>;
export type ProblemSummary = z.infer<typeof ProblemSummarySchema>;
export type ProblemPage = z.infer<typeof ProblemPageSchema>;
export type Graph = z.infer<typeof GraphSchema>;
export type ProblemContext = z.infer<typeof ProblemContextSchema>;
export type Neighborhood = z.infer<typeof NeighborhoodSchema>;
export type ProjectTags = z.infer<typeof ProjectTagsSchema>;
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;
export type ApiKeyAdmin = z.infer<typeof ApiKeyAdminSchema>;
