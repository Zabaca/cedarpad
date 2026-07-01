import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiKeyAdminSchema,
  ClusterSummarySchema,
  CreateObservationSchema,
  CreateProblemSchema,
  CreateSolutionSchema,
  ErrorSchema,
  GraphQuery,
  GraphSchema,
  GraphSearchQuery,
  DeleteResultSchema,
  GraphSearchResultSchema,
  IdParam,
  ItemPageSchema,
  JobAckSchema,
  ListItemsQuery,
  ListObservationsQuery,
  ListProblemsQuery,
  ListSolutionsQuery,
  NeighborhoodQuery,
  NeighborhoodSchema,
  ObservationDetailSchema,
  ObservationPageSchema,
  ObservationProblemParam,
  ProblemContextSchema,
  ProblemDetailSchema,
  ProblemPageSchema,
  ProjectTagsSchema,
  SolutionSchema,
  SolvedMatchSchema,
  SolvedNeighborSchema,
  SynthesizeProblemSchema,
  UpdateObservationSchema,
  UpdateProblemSchema,
  UpdateSolutionSchema,
  WorkspaceSummarySchema,
} from "./schemas.js";

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const ObservationsTag = ["Observations"];
const ProblemsTag = ["Problems"];
const SolutionsTag = ["Solutions"];
const GraphTag = ["Graph"];
const MetaTag = ["Meta"];
const WorkspacesTag = ["Workspaces"];
const ApiKeysTag = ["API keys"];

/**
 * Auth for `/v1/*`: either an `x-api-key` (agents) or the dev `x-dev-workspace`
 * header (web during the demo). The `securitySchemes` components are registered
 * on the app in `apps/api`; here we attach the requirement per route so it
 * surfaces in the OpenAPI doc / Swagger UI and the frozen `openapi.json`.
 */
const SECURITY: Record<string, string[]>[] = [{ ApiKeyAuth: [] }, { DevWorkspace: [] }];

/* ------------------------------------------------------------------ *
 * Observations
 * ------------------------------------------------------------------ */

export const createObservationRoute = createRoute({
  method: "post",
  path: "/v1/observations",
  tags: ObservationsTag,
  summary: "Record an observation (optionally embeds + links similar observations)",
  security: SECURITY,
  request: {
    body: { content: { "application/json": { schema: CreateObservationSchema } }, required: true },
  },
  responses: {
    201: json(ObservationDetailSchema, "Observation created; includes any similar observations"),
    400: json(ErrorSchema, "Invalid request"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

export const listObservationsRoute = createRoute({
  method: "get",
  path: "/v1/observations",
  tags: ObservationsTag,
  summary: "List observations in the workspace (paginated, searchable)",
  security: SECURITY,
  request: { query: ListObservationsQuery },
  responses: {
    200: json(ObservationPageSchema, "A page of observations with the total count"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

export const getObservationRoute = createRoute({
  method: "get",
  path: "/v1/observations/{id}",
  tags: ObservationsTag,
  summary: "Get an observation with its links, solutions and synthesized problems",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(ObservationDetailSchema, "Observation detail"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const updateObservationRoute = createRoute({
  method: "patch",
  path: "/v1/observations/{id}",
  tags: ObservationsTag,
  summary: "Edit an observation's title, body, status or tags",
  security: SECURITY,
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateObservationSchema } }, required: true },
  },
  responses: {
    200: json(ObservationDetailSchema, "Updated observation detail"),
    400: json(ErrorSchema, "Invalid request"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const reprocessObservationRoute = createRoute({
  method: "post",
  path: "/v1/observations/{id}/reprocess",
  tags: ObservationsTag,
  summary: "Re-embed an observation and refresh its similarity links",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(ObservationDetailSchema, "Reprocessed observation detail"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const getObservationSolvedMatchesRoute = createRoute({
  method: "get",
  path: "/v1/observations/{id}/solved-matches",
  tags: ObservationsTag,
  summary: "Solved problems that resemble this observation (read-time hint; excludes dismissed)",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(z.array(SolvedMatchSchema), "Matching solved problems, most similar first"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const dismissObservationSolvedMatchRoute = createRoute({
  method: "post",
  path: "/v1/observations/{id}/solved-matches/{problemId}/dismiss",
  tags: ObservationsTag,
  summary: "Mark a solved-problem match as a false positive; returns the remaining matches",
  security: SECURITY,
  request: { params: ObservationProblemParam },
  responses: {
    200: json(z.array(SolvedMatchSchema), "Remaining matches after the dismissal"),
    404: json(ErrorSchema, "Not found"),
  },
});

/* ------------------------------------------------------------------ *
 * Problems
 * ------------------------------------------------------------------ */

export const createProblemRoute = createRoute({
  method: "post",
  path: "/v1/problems",
  tags: ProblemsTag,
  summary: "Intake a problem (optionally runs the AI agent pipeline)",
  security: SECURITY,
  request: {
    body: { content: { "application/json": { schema: CreateProblemSchema } }, required: true },
  },
  responses: {
    201: json(ProblemDetailSchema, "Problem created; includes agent-found links + solutions"),
    400: json(ErrorSchema, "Invalid request"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

export const synthesizeProblemRoute = createRoute({
  method: "post",
  path: "/v1/problems/synthesize",
  tags: ProblemsTag,
  summary: "Synthesize a problem from observations (async; agent drafts in a worker)",
  security: SECURITY,
  request: {
    body: { content: { "application/json": { schema: SynthesizeProblemSchema } }, required: true },
  },
  responses: {
    202: json(JobAckSchema, "Synthesis enqueued; the problem is published when ready"),
    400: json(ErrorSchema, "Invalid request"),
    404: json(ErrorSchema, "An observation was not found in the workspace"),
  },
});

export const listProblemsRoute = createRoute({
  method: "get",
  path: "/v1/problems",
  tags: ProblemsTag,
  summary: "List problems in the workspace (paginated, searchable)",
  security: SECURITY,
  request: { query: ListProblemsQuery },
  responses: {
    200: json(ProblemPageSchema, "A page of problems with the total count"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

export const listItemsRoute = createRoute({
  method: "get",
  path: "/v1/items",
  tags: ObservationsTag,
  summary: "Unified feed of observations and problems, interleaved newest-first under one offset",
  security: SECURITY,
  request: { query: ListItemsQuery },
  responses: {
    200: json(ItemPageSchema, "A page of the interleaved feed with the combined total"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

export const getProblemRoute = createRoute({
  method: "get",
  path: "/v1/problems/{id}",
  tags: ProblemsTag,
  summary: "Get a problem with its links, solutions, source observations and latest run",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(ProblemDetailSchema, "Problem detail"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const reprocessProblemRoute = createRoute({
  method: "post",
  path: "/v1/problems/{id}/reprocess",
  tags: ProblemsTag,
  summary: "Re-run the AI agent pipeline for a problem",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(ProblemDetailSchema, "Reprocessed problem detail"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const updateProblemRoute = createRoute({
  method: "patch",
  path: "/v1/problems/{id}",
  tags: ProblemsTag,
  summary: "Edit a problem's fields (title, body, impact, priority, urgency, status, tags)",
  security: SECURITY,
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateProblemSchema } }, required: true },
  },
  responses: {
    200: json(ProblemDetailSchema, "Updated problem detail"),
    400: json(ErrorSchema, "Invalid request"),
    404: json(ErrorSchema, "Not found"),
  },
});

/* ------------------------------------------------------------------ *
 * Solutions (polymorphic: attach to an observation or a problem)
 * ------------------------------------------------------------------ */

export const listSolutionsRoute = createRoute({
  method: "get",
  path: "/v1/solutions",
  tags: SolutionsTag,
  summary: "List solutions for an observation or problem",
  security: SECURITY,
  request: { query: ListSolutionsQuery },
  responses: {
    200: json(z.array(SolutionSchema), "Solutions"),
  },
});

export const createSolutionRoute = createRoute({
  method: "post",
  path: "/v1/solutions",
  tags: SolutionsTag,
  summary: "Attach a (human-authored) solution to an observation or problem",
  security: SECURITY,
  request: {
    body: { content: { "application/json": { schema: CreateSolutionSchema } }, required: true },
  },
  responses: {
    201: json(SolutionSchema, "Solution created"),
    400: json(ErrorSchema, "Invalid request"),
    404: json(ErrorSchema, "Target not found in workspace"),
  },
});

export const updateSolutionRoute = createRoute({
  method: "patch",
  path: "/v1/solutions/{id}",
  tags: SolutionsTag,
  summary: "Edit a solution's body or status (human correction / accept)",
  security: SECURITY,
  request: {
    params: IdParam,
    body: { content: { "application/json": { schema: UpdateSolutionSchema } }, required: true },
  },
  responses: {
    200: json(SolutionSchema, "Updated solution"),
    400: json(ErrorSchema, "Invalid request"),
    404: json(ErrorSchema, "Solution not found in workspace"),
  },
});

/* ------------------------------------------------------------------ *
 * Knowledge graph + agent retrieval
 * ------------------------------------------------------------------ */

export const getGraphRoute = createRoute({
  method: "get",
  path: "/v1/graph",
  tags: GraphTag,
  summary: "Knowledge graph (observations + problems + solutions + edges); all workspaces or one",
  security: SECURITY,
  request: { query: GraphQuery },
  responses: {
    200: json(GraphSchema, "Graph"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

export const searchGraphRoute = createRoute({
  method: "get",
  path: "/v1/graph/search",
  tags: GraphTag,
  summary: "Semantic search over problems, annotated with link/solution signals",
  security: SECURITY,
  request: { query: GraphSearchQuery },
  responses: {
    200: json(z.array(GraphSearchResultSchema), "Ranked problems with graph annotations"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

export const getProblemContextRoute = createRoute({
  method: "get",
  path: "/v1/problems/{id}/context",
  tags: GraphTag,
  summary: "A problem with its edges (kind/similarity/rationale) and solutions",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(ProblemContextSchema, "Problem context"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const getNeighborhoodRoute = createRoute({
  method: "get",
  path: "/v1/problems/{id}/neighborhood",
  tags: GraphTag,
  summary: "Bounded multi-hop subgraph around a problem",
  security: SECURITY,
  request: { params: IdParam, query: NeighborhoodQuery },
  responses: {
    200: json(NeighborhoodSchema, "Bounded subgraph"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const getSolvedNeighborsRoute = createRoute({
  method: "get",
  path: "/v1/problems/{id}/solved-neighbors",
  tags: GraphTag,
  summary: "Nearest neighbours that already have an accepted solution",
  security: SECURITY,
  request: { params: IdParam, query: NeighborhoodQuery },
  responses: {
    200: json(z.array(SolvedNeighborSchema), "Solved neighbours, nearest first"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const getClusterSummaryRoute = createRoute({
  method: "get",
  path: "/v1/problems/{id}/cluster-summary",
  tags: GraphTag,
  summary: "Cached natural-language summary of a problem's cluster (Tier 3)",
  security: SECURITY,
  request: { params: IdParam, query: NeighborhoodQuery },
  responses: {
    200: json(ClusterSummarySchema, "Cluster summary (cached or freshly computed)"),
    404: json(ErrorSchema, "Not found"),
  },
});

/* ------------------------------------------------------------------ *
 * Meta
 * ------------------------------------------------------------------ */

export const listProjectTagsRoute = createRoute({
  method: "get",
  path: "/v1/project-tags",
  tags: MetaTag,
  summary: "Distinct 'Project' meta tags used in the workspace (for autocomplete)",
  security: SECURITY,
  responses: {
    200: json(ProjectTagsSchema, "Distinct project tags"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

/* ------------------------------------------------------------------ *
 * Workspaces — a soft grouping label, not an isolation boundary.
 * ------------------------------------------------------------------ */

export const listWorkspacesRoute = createRoute({
  method: "get",
  path: "/v1/workspaces",
  tags: WorkspacesTag,
  summary: "List every workspace (for the picker and filters)",
  security: SECURITY,
  responses: {
    200: json(z.array(WorkspaceSummarySchema), "Workspaces"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

export const activateWorkspaceRoute = createRoute({
  method: "post",
  path: "/v1/workspaces/{id}/activate",
  tags: WorkspacesTag,
  summary: "Make a workspace the caller's active one (auto-enrolls membership)",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(WorkspaceSummarySchema, "Activated workspace"),
    404: json(ErrorSchema, "Not found"),
  },
});

/* ------------------------------------------------------------------ *
 * API keys — a shared registry. No admin role: any authenticated user
 * can list and revoke any key. Creation stays on the Better Auth client
 * (it mints + returns the one-time secret); these cover the shared
 * management surface that Better Auth's per-user endpoints can't.
 * ------------------------------------------------------------------ */

export const listApiKeysRoute = createRoute({
  method: "get",
  path: "/v1/api-keys",
  tags: ApiKeysTag,
  summary: "List every API key in the shared registry (owner + last-used, no secret)",
  security: SECURITY,
  responses: {
    200: json(z.array(ApiKeyAdminSchema), "All API keys, newest first"),
    401: json(ErrorSchema, "Unauthorized"),
  },
});

export const revokeApiKeyRoute = createRoute({
  method: "delete",
  path: "/v1/api-keys/{id}",
  tags: ApiKeysTag,
  summary: "Revoke any API key by id (shared registry; no admin role required)",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(DeleteResultSchema, "Key revoked"),
    404: json(ErrorSchema, "Not found"),
  },
});

export const routes = {
  createObservation: createObservationRoute,
  listObservations: listObservationsRoute,
  getObservation: getObservationRoute,
  updateObservation: updateObservationRoute,
  reprocessObservation: reprocessObservationRoute,
  getObservationSolvedMatches: getObservationSolvedMatchesRoute,
  dismissObservationSolvedMatch: dismissObservationSolvedMatchRoute,
  createProblem: createProblemRoute,
  synthesizeProblem: synthesizeProblemRoute,
  listProblems: listProblemsRoute,
  listItems: listItemsRoute,
  getProblem: getProblemRoute,
  updateProblem: updateProblemRoute,
  reprocessProblem: reprocessProblemRoute,
  listSolutions: listSolutionsRoute,
  createSolution: createSolutionRoute,
  updateSolution: updateSolutionRoute,
  getGraph: getGraphRoute,
  searchGraph: searchGraphRoute,
  getProblemContext: getProblemContextRoute,
  getNeighborhood: getNeighborhoodRoute,
  getSolvedNeighbors: getSolvedNeighborsRoute,
  getClusterSummary: getClusterSummaryRoute,
  listProjectTags: listProjectTagsRoute,
  listWorkspaces: listWorkspacesRoute,
  activateWorkspace: activateWorkspaceRoute,
  listApiKeys: listApiKeysRoute,
  revokeApiKey: revokeApiKeyRoute,
} as const;
