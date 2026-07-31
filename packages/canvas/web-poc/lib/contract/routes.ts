import { createRoute, z } from "@hono/zod-openapi";
import {
  ApiKeyAdminSchema,
  CreateObservationSchema,
  CreateProblemSchema,
  CreateSolutionSchema,
  ErrorSchema,
  GraphQuery,
  GraphSchema,
  DeleteResultSchema,
  IdParam,
  ItemPageSchema,
  ListItemsQuery,
  ListObservationsQuery,
  ListProblemsQuery,
  ListSolutionsQuery,
  NeighborhoodQuery,
  NeighborhoodSchema,
  ObservationDetailSchema,
  ObservationPageSchema,
  ProblemContextSchema,
  ProblemDetailSchema,
  ProblemPageSchema,
  ProjectTagsSchema,
  SolutionSchema,
  SolvedNeighborSchema,
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
const SourcesTag = ["Sources"];
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
  summary: "Record an observation, naming where it came from in the same call",
  security: SECURITY,
  request: {
    body: { content: { "application/json": { schema: CreateObservationSchema } }, required: true },
  },
  responses: {
    201: json(ObservationDetailSchema, "Observation created, with its resolved Source"),
    404: json(ErrorSchema, "The named source does not exist"),
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
  summary: "Get an observation with its source, solutions and synthesized problems",
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

export const deleteObservationRoute = createRoute({
  method: "delete",
  path: "/v1/observations/{id}",
  tags: ObservationsTag,
  summary: "Delete an observation",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(DeleteResultSchema, "Observation deleted"),
    404: json(ErrorSchema, "Not found"),
  },
});

/* ------------------------------------------------------------------ *
 * Sources — where observations came from
 * ------------------------------------------------------------------ */

export const listSourceObservationsRoute = createRoute({
  method: "get",
  path: "/v1/sources/{id}/observations",
  tags: SourcesTag,
  summary: "List the observations that name this source",
  security: SECURITY,
  request: { params: IdParam, query: ListObservationsQuery },
  responses: {
    200: json(ObservationPageSchema, "A page of the source's observations"),
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
  summary: "Record a problem",
  security: SECURITY,
  request: {
    body: { content: { "application/json": { schema: CreateProblemSchema } }, required: true },
  },
  responses: {
    201: json(ProblemDetailSchema, "Problem created"),
    400: json(ErrorSchema, "Invalid request"),
    401: json(ErrorSchema, "Unauthorized"),
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
  summary: "Get a problem with its links, solutions and source observations",
  security: SECURITY,
  request: { params: IdParam },
  responses: {
    200: json(ProblemDetailSchema, "Problem detail"),
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
  deleteObservation: deleteObservationRoute,
  listSourceObservations: listSourceObservationsRoute,
  createProblem: createProblemRoute,
  listProblems: listProblemsRoute,
  listItems: listItemsRoute,
  getProblem: getProblemRoute,
  updateProblem: updateProblemRoute,
  listSolutions: listSolutionsRoute,
  createSolution: createSolutionRoute,
  updateSolution: updateSolutionRoute,
  getGraph: getGraphRoute,
  getProblemContext: getProblemContextRoute,
  getNeighborhood: getNeighborhoodRoute,
  getSolvedNeighbors: getSolvedNeighborsRoute,
  listProjectTags: listProjectTagsRoute,
  listWorkspaces: listWorkspacesRoute,
  activateWorkspace: activateWorkspaceRoute,
  listApiKeys: listApiKeysRoute,
  revokeApiKey: revokeApiKeyRoute,
} as const;
