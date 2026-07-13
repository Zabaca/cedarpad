import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { EMBEDDING_DIMENSIONS } from "../config/index.js";
import { float32Array } from "./vector.js";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
};

/* ------------------------------------------------------------------ *
 * Better Auth — core tables
 * ------------------------------------------------------------------ */

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  /**
   * Optional workspace access allowlist. Null ⇒ access all workspaces (the
   * default — workspaces are human segmentation, not tenant isolation). When set
   * to a non-empty array, the user may access only those workspaces.
   */
  allowedWorkspaces: text("allowed_workspaces", { mode: "json" }).$type<string[]>(),
  ...timestamps,
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  /**
   * Active workspace for this session. Better Auth's organization plugin owns
   * this field internally under the name `activeOrganizationId`; a Better Auth
   * "organization" IS a Cedarpad workspace, so we read it as the active
   * workspace everywhere in our own code.
   */
  activeOrganizationId: text("active_organization_id"),
  ...timestamps,
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  ...timestamps,
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  ...timestamps,
});

/* ------------------------------------------------------------------ *
 * Better Auth — organization plugin, surfaced as the WORKSPACE tenant
 *
 * The organization plugin is the tenant primitive. We map its `organization`
 * model onto the `workspace` table (see `apps/api/src/auth.ts`) and rename the
 * `organizationId` foreign keys to `workspaceId`, so the entire schema speaks
 * "workspace". A workspace is the top-level tenant boundary.
 * ------------------------------------------------------------------ */

export const workspace = sqliteTable("workspace", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const member = sqliteTable("member", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const invitation = sqliteTable("invitation", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role"),
  status: text("status").notNull().default("pending"),
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

/* ------------------------------------------------------------------ *
 * Better Auth — apiKey plugin (agent access)
 * ------------------------------------------------------------------ */

export const apikey = sqliteTable("apikey", {
  id: text("id").primaryKey(),
  name: text("name"),
  start: text("start"),
  prefix: text("prefix"),
  key: text("key").notNull(),
  /**
   * Better Auth apiKey "configuration" id. The plugin (≥1.6) tags every key with
   * this (default "default") and filters by it on list/verify — a required column.
   */
  configId: text("config_id").notNull().default("default"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  refillInterval: integer("refill_interval"),
  refillAmount: integer("refill_amount"),
  lastRefillAt: integer("last_refill_at", { mode: "timestamp_ms" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }).notNull().default(true),
  rateLimitTimeWindow: integer("rate_limit_time_window"),
  rateLimitMax: integer("rate_limit_max"),
  requestCount: integer("request_count").notNull().default(0),
  remaining: integer("remaining"),
  lastRequest: integer("last_request", { mode: "timestamp_ms" }),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  permissions: text("permissions"),
  /** Workspace this key acts on behalf of — used to scope agent requests. */
  metadata: text("metadata"),
  ...timestamps,
});

/* ------------------------------------------------------------------ *
 * Domain
 *
 *   platform workspace → observations → problems → solutions
 *
 * Observations are the entry layer: loose, workspace-local records of
 * something worth noting. Many observations synthesize into a problem
 * (many-to-many) — the specific, prioritized, urgent item a pile of
 * observations points to. Solutions attach polymorphically, so an observation
 * or a problem can each carry one. `workspace_id` is the PLATFORM workspace
 * (the `workspaces` registry / `cs_workspace`, ADR-0007), NOT the Better Auth
 * organization — a plain text column with no FK (the legacy `default` workspace
 * has no registry row). Records are isolated per workspace: a workspace's search
 * (#57) never returns another's. (The graph's original cross-workspace
 * solution-reuse was intentionally dropped; a future opt-in may reintroduce it.)
 * "Project" is a weightless human meta tag stored inline on
 * observations/problems and is deliberately excluded from every embedding and
 * LLM input.
 * ------------------------------------------------------------------ */

export const sourceKind = ["human", "agent"] as const;
/** Tags array, stored as JSON. Meta-only — never fed to embeddings or the LLM. */
const projectTags = () =>
  text("project_tags", { mode: "json" }).$type<string[]>().notNull().default([]);

/**
 * An observation: a loose record of something worth noting. It may lead
 * nowhere, or pile up with similar observations until a problem emerges. An
 * observation does not need a solution (but it can have one).
 */
export const observationStatus = ["open", "synthesized", "archived"] as const;

export const observations = sqliteTable(
  "observations",
  {
    id: text("id").primaryKey(),
    // Platform workspace id (registry / `cs_workspace`). Plain text, no FK: the
    // legacy `default` workspace has no registry row. (ADR-0007, #57.)
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /**
     * The concrete impact this observation calls out (optional). Folded into the
     * embedding so observations that share an impact cluster together — which
     * helps them synthesize into a problem faster.
     */
    impact: text("impact"),
    status: text("status", { enum: observationStatus }).notNull().default("open"),
    source: text("source", { enum: sourceKind }).notNull().default("human"),
    projectTags: projectTags(),
    createdBy: text("created_by"),
    embedding: float32Array("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    ...timestamps,
  },
  (t) => [
    index("observations_workspace_idx").on(t.workspaceId),
    // Similarity uses an exact `vector_distance_cos` scan (see queries/similar.ts),
    // not an ANN index: at this corpus size brute force gives perfect recall with
    // none of the libsql_vector_idx storage/write blow-up (~40× the row data).
  ],
);

/**
 * A problem: distinct from an observation in that it is specific, calls out an
 * impact, carries weight against other problems (priority) and urgency, and
 * describes how its solution should be structured (`solutionDirection`). A
 * problem is expected to be resolved with a solution.
 */
export const problemStatus = ["open", "investigating", "resolved", "archived"] as const;
export const urgencyLevels = ["low", "medium", "high", "critical"] as const;

export const problems = sqliteTable(
  "problems",
  {
    id: text("id").primaryKey(),
    // Platform workspace id (registry / `cs_workspace`). Plain text, no FK: the
    // legacy `default` workspace has no registry row. (ADR-0007, #57.)
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** The concrete impact this problem calls out. */
    impact: text("impact"),
    /** Relative weight against other problems — higher sorts first. */
    priority: integer("priority").notNull().default(0),
    urgency: text("urgency", { enum: urgencyLevels }).notNull().default("medium"),
    /** Guidance on how a solution should be structured. */
    solutionDirection: text("solution_direction"),
    status: text("status", { enum: problemStatus }).notNull().default("open"),
    source: text("source", { enum: sourceKind }).notNull().default("human"),
    projectTags: projectTags(),
    createdBy: text("created_by"),
    embedding: float32Array("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    ...timestamps,
  },
  (t) => [
    index("problems_workspace_idx").on(t.workspaceId),
    // Exact `vector_distance_cos` scan instead of an ANN index — see observations.
  ],
);

/**
 * Synthesis edge: which observations a problem was synthesized from. Many
 * observations can synthesize one problem, and an observation can feed several
 * problems — so this is a many-to-many join.
 */
export const observationProblems = sqliteTable(
  "observation_problems",
  {
    observationId: text("observation_id")
      .notNull()
      .references(() => observations.id, { onDelete: "cascade" }),
    problemId: text("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    relevance: real("relevance"),
    rationale: text("rationale"),
    createdBy: text("created_by", { enum: sourceKind }).notNull().default("agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    primaryKey({ columns: [t.observationId, t.problemId] }),
    index("observation_problems_problem_idx").on(t.problemId),
  ],
);

/**
 * A human's "this observation is NOT the same as that solved problem" signal.
 * Suppresses a read-time cross-kind match (see `findSolvedProblemsForObservation`)
 * so a false positive stops being surfaced. Negative feedback only — it never
 * changes the observation's status or attaches a solution.
 */
export const observationSolvedMatchDismissals = sqliteTable(
  "observation_solved_match_dismissals",
  {
    observationId: text("observation_id")
      .notNull()
      .references(() => observations.id, { onDelete: "cascade" }),
    problemId: text("problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    primaryKey({ columns: [t.observationId, t.problemId] }),
    index("observation_solved_match_dismissals_problem_idx").on(t.problemId),
  ],
);

export const linkKind = ["identical", "partial", "related"] as const;

/** Directed similarity edge between two observations (used for clustering). */
export const observationLinks = sqliteTable(
  "observation_links",
  {
    id: text("id").primaryKey(),
    fromObservationId: text("from_observation_id")
      .notNull()
      .references(() => observations.id, { onDelete: "cascade" }),
    toObservationId: text("to_observation_id")
      .notNull()
      .references(() => observations.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: linkKind }).notNull(),
    similarity: real("similarity"),
    rationale: text("rationale"),
    createdBy: text("created_by", { enum: sourceKind }).notNull().default("agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("observation_links_from_idx").on(t.fromObservationId),
    index("observation_links_to_idx").on(t.toObservationId),
  ],
);

/** Directed similarity edge between two problems. */
export const problemLinks = sqliteTable(
  "problem_links",
  {
    id: text("id").primaryKey(),
    fromProblemId: text("from_problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    toProblemId: text("to_problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: linkKind }).notNull(),
    similarity: real("similarity"),
    rationale: text("rationale"),
    createdBy: text("created_by", { enum: sourceKind }).notNull().default("agent"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    index("problem_links_from_idx").on(t.fromProblemId),
    index("problem_links_to_idx").on(t.toProblemId),
  ],
);

export const solutionOrigin = ["reused", "synthesized", "research", "human"] as const;
export const solutionStatus = ["draft", "accepted", "rejected"] as const;
/** What a solution attaches to (polymorphic target). */
export const solutionTargetKind = ["observation", "problem"] as const;

export const solutions = sqliteTable("solutions", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
  status: text("status", { enum: solutionStatus }).notNull().default("draft"),
  origin: text("origin", { enum: solutionOrigin }).notNull(),
  createdBy: text("created_by"),
  embedding: float32Array("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
  ...timestamps,
});

/**
 * Polymorphic attachment: a solution can apply to many targets, and a target
 * (observation or problem) can have many solutions. `targetKind` discriminates;
 * `targetId` is the observation/problem id. Because the target is polymorphic
 * there is no DB-level cascade — callers clean up links when a target is
 * deleted (see `apps/api/src/data.ts`).
 */
export const solutionLinks = sqliteTable(
  "solution_links",
  {
    solutionId: text("solution_id")
      .notNull()
      .references(() => solutions.id, { onDelete: "cascade" }),
    targetKind: text("target_kind", { enum: solutionTargetKind }).notNull(),
    targetId: text("target_id").notNull(),
    relevance: real("relevance"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    primaryKey({ columns: [t.solutionId, t.targetKind, t.targetId] }),
    index("solution_links_target_idx").on(t.targetKind, t.targetId),
  ],
);

export const agentRunStatus = ["running", "completed", "failed"] as const;
/** What an agent pass did: embed/link an observation or problem, or synthesize a problem. */
export const agentRunKind = ["observation_intake", "problem_intake", "synthesis"] as const;

/** Audit trail of one agent pass over an observation or problem. */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: agentRunKind }).notNull(),
    targetKind: text("target_kind", { enum: solutionTargetKind }).notNull(),
    targetId: text("target_id").notNull(),
    status: text("status", { enum: agentRunStatus }).notNull().default("running"),
    steps: text("steps", { mode: "json" }).$type<unknown[]>(),
    providerModel: text("provider_model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("agent_runs_target_idx").on(t.targetKind, t.targetId)],
);

export const agentJobStatus = ["queued", "running", "done", "failed"] as const;
export const agentJobKind = ["observation_intake", "problem_intake", "synthesis"] as const;

/**
 * Async work queue. Intake / reprocess / synthesis enqueue a job here and return
 * immediately; a worker (dev: a bun loop; prod: a Cron/Queue/Workflow consumer)
 * claims `queued` jobs and runs the matching pipeline. Decoupled from `agent_runs`
 * (which stays the audit log the pipeline itself writes) so intake never blocks.
 */
export const agentJobs = sqliteTable(
  "agent_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: agentJobKind }).notNull(),
    status: text("status", { enum: agentJobStatus }).notNull().default("queued"),
    /**
     * Kind-specific input. intake/reprocess: `{ targetId }`. synthesis:
     * `{ workspaceId, observationIds, hint, createdBy, projectTags }`.
     */
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    /** Filled on completion (e.g. synthesis stores `{ problemId }`). */
    result: text("result", { mode: "json" }).$type<Record<string, unknown>>(),
    workspaceId: text("workspace_id").notNull(),
    /**
     * Higher drains first (then oldest-first). Seeded from the target problem's
     * priority at enqueue time so urgent problems jump the queue; observation /
     * synthesis jobs default to 0.
     */
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("agent_jobs_status_idx").on(t.status, t.createdAt)],
);

/**
 * Tier 3 cached community summaries. One row per cluster root problem. The
 * `membershipHash` (hash of the cluster's sorted member ids) is the cache key:
 * a summary is reused only while membership is unchanged, otherwise recomputed.
 */
export const clusterSummaries = sqliteTable(
  "cluster_summaries",
  {
    id: text("id").primaryKey(),
    rootProblemId: text("root_problem_id")
      .notNull()
      .references(() => problems.id, { onDelete: "cascade" }),
    membershipHash: text("membership_hash").notNull(),
    summary: text("summary").notNull(),
    memberCount: integer("member_count").notNull().default(0),
    model: text("model"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("cluster_summaries_root_idx").on(t.rootProblemId)],
);

/* ------------------------------------------------------------------ *
 * Workspace registry (ADR-0007) — the platform's index of workspaces
 *
 * Distinct from the Better Auth `workspace` (organization) table above: this is
 * the workspace-platform registry — the single source of truth for which
 * runtime workspaces exist and (via the registry module) their DERIVED runtime
 * coordinates (`sandboxId = workspace-<id>`, `r2Prefix = workspaces/<id>/`).
 * Those are derived, not stored. Owned per-user (`owner_user_id`).
 * ------------------------------------------------------------------ */
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    repo: text("repo"),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("workspaces_owner_idx").on(t.ownerUserId)],
);

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;

/* ------------------------------------------------------------------ *
 * Canvas registry (ADR-0007, PRD #48) — the per-workspace index of canvases
 *
 * A workspace owns many canvases. This table is the edge-queryable INDEX only:
 * which canvases exist, in which workspace, and their names. Canvas *state*
 * lives in R2 (ADR-0001), never here. `ownerRef` is the owner edge — nullable
 * and unused this slice (#52), populated by a later slice.
 * ------------------------------------------------------------------ */
export const canvases = sqliteTable(
  "canvases",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    ownerRef: text("owner_ref"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("canvases_workspace_idx").on(t.workspaceId)],
);

export type CanvasRow = typeof canvases.$inferSelect;
export type NewCanvasRow = typeof canvases.$inferInsert;

/* ------------------------------------------------------------------ *
 * Conversation store (PRD #50, Inbox) — the user-scoped attention inbox
 *
 * A Conversation = a Claude Agent SDK Session (`session_id` + transcript) plus
 * inbox state. The transcript itself lives in the SDK JSONL / R2 (#60), never
 * here; this table holds the coordinating metadata so the inbox list is fast.
 * The **Inbox is user-scoped** (`user_id`): one inbox per user aggregating
 * Conversations across all their workspaces, each tagged with its platform
 * `workspace_id` (plain text, no FK — same as the notebook/canvas registries,
 * ADR-0007). `owner_ref` is the nullable canvas owner edge.
 *
 * Two-axis state model:
 *  - `status`:     open | closed  — closed = archived, filtered from default view.
 *  - `waiting_on`: human | agent | none — `human` = needs attention.
 *  - `unread`:     new agent activity since the user last looked.
 * ------------------------------------------------------------------ */
export const conversationStatus = ["open", "closed"] as const;
export const conversationWaitingOn = ["human", "agent", "none"] as const;
/** Session type: what KIND of session this Conversation coordinates. `dev-agent` sessions
 * live in the workspace they run in (default) — the kind, not a fake workspace, carries
 * dev-agent-ness (token mint, run flavor, badge). */
export const conversationKind = ["chat", "dev-agent"] as const;

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    /** The Claude Agent SDK sessionId this Conversation coordinates. */
    sessionId: text("session_id").notNull(),
    status: text("status", { enum: conversationStatus }).notNull().default("open"),
    waitingOn: text("waiting_on", { enum: conversationWaitingOn }).notNull().default("none"),
    kind: text("kind", { enum: conversationKind }).notNull().default("chat"),
    unread: integer("unread", { mode: "boolean" }).notNull().default(false),
    /** Last activity, epoch ms — the default inbox sort key. */
    lastActivity: integer("last_activity", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Nullable canvas owner edge (the owner pointer; canvas lives in its registry). */
    ownerRef: text("owner_ref"),
    /** Nullable chat→canvas edge: the canvas this chat's card lives on (at most one). */
    canvasId: text("canvas_id"),
    /** Platform workspace id (registry / `cs_workspace`). Plain text, no FK. */
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    summary: text("summary"),
    /** Denormalized last-message preview so the inbox list renders without the transcript. */
    lastMessagePreview: text("last_message_preview"),
    ...timestamps,
  },
  (t) => [
    index("conversations_user_idx").on(t.userId),
    index("conversations_status_idx").on(t.status),
    index("conversations_last_activity_idx").on(t.lastActivity),
  ],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;

/* ------------------------------------------------------------------ *
 * External MCP tokens (ADR-0013 train 2, #176) — per-workspace owner consent
 *
 * Enablement of an approved remote MCP server (the code-side registry,
 * `server/mcp-registry.ts`) is a pasted per-workspace bearer token, stored HERE
 * at the edge only. It rides as a header on the proxied `/send` for that
 * workspace and is used for exactly one turn's `mcpServers` option — the
 * container and R2 never store it (the ADR-0008 dev-agent git-token pattern).
 * One row per (workspace, server name); deleting the row is "disconnect".
 * ------------------------------------------------------------------ */
export const workspaceMcpTokens = sqliteTable(
  "workspace_mcp_tokens",
  {
    /** Platform workspace id (registry / `cs_workspace`). Plain text, no FK — same as
     * `conversations.workspace_id` (the legacy `default` workspace has no registry row). */
    workspaceId: text("workspace_id").notNull(),
    /** The registry entry's name (`server/mcp-registry.ts`), e.g. `ledgerbot`. */
    mcpName: text("mcp_name").notNull(),
    token: text("token").notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.mcpName] })],
);

export type WorkspaceMcpTokenRow = typeof workspaceMcpTokens.$inferSelect;
export type NewWorkspaceMcpTokenRow = typeof workspaceMcpTokens.$inferInsert;

export type Workspace = typeof workspace.$inferSelect;
export type Observation = typeof observations.$inferSelect;
export type NewObservation = typeof observations.$inferInsert;
export type Problem = typeof problems.$inferSelect;
export type NewProblem = typeof problems.$inferInsert;
export type Solution = typeof solutions.$inferSelect;
export type SolutionLink = typeof solutionLinks.$inferSelect;
export type ObservationProblem = typeof observationProblems.$inferSelect;
export type ObservationSolvedMatchDismissal =
  typeof observationSolvedMatchDismissals.$inferSelect;
export type ProblemLink = typeof problemLinks.$inferSelect;
export type ObservationLink = typeof observationLinks.$inferSelect;
export type AgentRun = typeof agentRuns.$inferSelect;
export type AgentJob = typeof agentJobs.$inferSelect;
export type ClusterSummary = typeof clusterSummaries.$inferSelect;
