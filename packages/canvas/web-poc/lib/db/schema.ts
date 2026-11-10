import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
  /**
   * Better Auth admin plugin fields (ADR-0014: admin lives inside the app, gated
   * on an admin role). `role` is the gate ("admin" unlocks /admin + create-user);
   * the ban fields ship with the plugin's schema and stay unused until needed.
   */
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp_ms" }),
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
  /** Better Auth admin plugin: set while an admin impersonates this session. */
  impersonatedBy: text("impersonated_by"),
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
    /**
     * The canvas picker's hand-arranged order: a JSON array of canvas ids.
     *
     * One array here rather than a sort column on `canvases`, because the legacy `default`
     * canvas has no registry row — a per-row column could never place it. Null/absent means
     * "never reordered", which reads as `created_at` ascending, so nothing changes for a
     * workspace that has not touched it. Consumers treat it as a HINT: it can name deleted
     * canvases and will not know about newly created ones (shell/src/canvas-order.ts).
     */
    canvasOrder: text("canvas_order"),
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
 * Workspace membership + invitations (#179) — on the REGISTRY
 *
 * Membership belongs to the platform `workspaces` registry above, NOT the
 * dormant Better Auth organization tables (`workspace`/`member`/`invitation`)
 * — the platform workspace is not the Better Auth organization (see
 * worker/middleware.ts). Roles: the owner stays on `workspaces.owner_user_id`;
 * this table holds non-owner members ("member" role — full use, no admin).
 * An invitation is email-bound and single-use: its id IS the invite-link
 * token (crypto-random), status pending|accepted|revoked, expiring.
 * ------------------------------------------------------------------ */
export const workspaceMembers = sqliteTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    uniqueIndex("workspace_members_ws_user_idx").on(t.workspaceId, t.userId),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

export const workspaceInvitations = sqliteTable(
  "workspace_invitations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("pending"),
    inviterUserId: text("inviter_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("workspace_invitations_ws_idx").on(t.workspaceId)],
);

export type WorkspaceMemberRow = typeof workspaceMembers.$inferSelect;
export type WorkspaceInvitationRow = typeof workspaceInvitations.$inferSelect;

/* ------------------------------------------------------------------ *
 * Inbound MCP OAuth provider (ADR-0013 train 3, #177) — Better Auth `mcp` plugin
 *
 * cedarpad as an OAuth provider for outside agents (Claude Code, claude.ai).
 * Column shapes mirror better-auth's oidc-provider schema exactly (its drizzle
 * adapter reads these models by name): dynamically-registered clients, issued
 * access/refresh tokens, and per-user consent records.
 * ------------------------------------------------------------------ */
export const oauthApplication = sqliteTable("oauthApplication", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  icon: text("icon"),
  metadata: text("metadata"),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  redirectUrls: text("redirect_urls").notNull(),
  type: text("type").notNull(),
  disabled: integer("disabled", { mode: "boolean" }).default(false),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const oauthAccessToken = sqliteTable("oauthAccessToken", {
  id: text("id").primaryKey(),
  accessToken: text("access_token").notNull().unique(),
  refreshToken: text("refresh_token").notNull().unique(),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }).notNull(),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }).notNull(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const oauthConsent = sqliteTable("oauthConsent", {
  id: text("id").primaryKey(),
  clientId: text("client_id")
    .notNull()
    .references(() => oauthApplication.clientId, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  scopes: text("scopes").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  consentGiven: integer("consent_given", { mode: "boolean" }).notNull(),
});

/* ------------------------------------------------------------------ *
 * Canvas registry (ADR-0007, PRD #48) — the per-workspace index of canvases
 *
 * A workspace owns many canvases. This table is the edge-queryable INDEX only:
 * which canvases exist, in which workspace, and their names. Canvas *state*
 * lives in R2 (ADR-0001), never here. `ownerRef` is the owner edge — nullable
 * and unused this slice (#52), populated by a later slice.
 * ------------------------------------------------------------------ */
/** Canvas visibility (ADR-0016): workspace-visible (default) or creator-private. */
export const canvasVisibility = ["workspace", "private"] as const;

export const canvases = sqliteTable(
  "canvases",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    ownerRef: text("owner_ref"),
    /** ADR-0016: `private` = only `created_by` sees/opens it (owner: manage-not-read). */
    visibility: text("visibility", { enum: canvasVisibility }).notNull().default("workspace"),
    /** The creating user (ADR-0016). Null (legacy / bridge-created) = permanently workspace-visible. */
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("canvases_workspace_idx").on(t.workspaceId)],
);

export type CanvasRow = typeof canvases.$inferSelect;
export type NewCanvasRow = typeof canvases.$inferInsert;

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

/* ------------------------------------------------------------------ *
 * Canvas share links (canvas ADR-0015, PRD #220) — the guest door's
 * capability rows.
 *
 * A share link is a member-minted, revocable capability granting outsiders
 * access to exactly ONE canvas. `/share/<id>` validates the row and mints a
 * guest session; the edge gate confines that session to the link's canvas.
 * Revocation is a tombstone (`revoked_at`), not a delete — the Share panel
 * can still show history, and a revoked id can never be re-minted live.
 * Plain-text ids, no FKs (ADR-0007 registry convention).
 * ------------------------------------------------------------------ */
export const shareLinks = sqliteTable(
  "share_links",
  {
    id: text("id").primaryKey(),
    canvasId: text("canvas_id").notNull(),
    /** Platform workspace id (registry / `cs_workspace`). Plain text, no FK. */
    workspaceId: text("workspace_id").notNull(),
    createdBy: text("created_by").notNull(),
    /** May guests holding this link start their OWN canvas-scoped conversation?
     * (Member conversations are always view-only to guests regardless.) */
    guestChat: integer("guest_chat", { mode: "boolean" }).notNull().default(false),
    /** May guests holding this link join the canvas's voice huddle? (ADR-0017) */
    guestHuddle: integer("guest_huddle", { mode: "boolean" }).notNull().default(false),
    /* --- #320 guest permissions. Three separate capabilities, never one level: they are
     * different KINDS of risk, so they are granted separately. `shared/guest-capabilities.ts`
     * is the one place these rows are turned into a decision — read it, don't re-derive. */
    /** Use a live component on the canvas — click the button, submit the form. Defaults
     * TRUE (and is backfilled TRUE): a link exists to show someone something, and a
     * component you may watch but not use is a broken invite. */
    guestInteract: integer("guest_interact", { mode: "boolean" }).notNull().default(true),
    /** Edit the canvas DOCUMENT — create, move, delete shapes. Opt-in per mint: flipping
     * it on for links already sitting in someone's inbox would silently convert read
     * access into write access under rules they were never given. */
    guestEdit: integer("guest_edit", { mode: "boolean" }).notNull().default(false),
    /** Author component SOURCE (`PUT /api/components/:module`), own/canvas-scoped tier
     * only. Distinct from `guestEdit` because it is arbitrary JS that hot-reloads into a
     * MEMBER's authenticated browser — accepted, bounded to the invited canvas, opt-in. */
    guestEditSource: integer("guest_edit_source", { mode: "boolean" }).notNull().default(false),
    /** Null = the whole canvas (PRD #220). Set = one placed component: the guest surface
     * narrows to that shape rendered fullscreen, chat fully denied (PRD #221). */
    shapeId: text("shape_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Null = live. Set once on revoke; never cleared. */
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("share_links_canvas_idx").on(t.canvasId)],
);

export type ShareLinkRow = typeof shareLinks.$inferSelect;

/* ------------------------------------------------------------------ *
 * Component Records (ADR-0022) — workspace content as ROWS, not a tar
 *
 * Component source and the data files a Component imports. These used to be
 * a directory tree that was periodically tarred into R2, which meant a failed
 * restore could become a destructive write; on 2026-07-29 that destroyed every
 * own-tier Component in the production workspace. Truth is the row now; the
 * container filesystem is a rendering of it, materialized on demand.
 *
 * `canvas_id` NULL is the workspace SHARED tier; a canvas id is that canvas's
 * OWN tier. The PLATFORM tier is deliberately absent — base Components are
 * deploy-gated image code, never workspace data (ADR-0022 decision 8).
 *
 * Deletion is soft (`deleted_at`), reclaimed only by an explicit purge: one
 * click must never destroy source. Plain text ids, no FKs (ADR-0007).
 * ------------------------------------------------------------------ */
export const recordKind = ["component", "data"] as const;

export const componentRecords = sqliteTable(
  "component_records",
  {
    workspaceId: text("workspace_id").notNull(),
    /** NULL = the workspace shared tier. */
    canvasId: text("canvas_id"),
    /** `KpiCard` for a component, `sales.json` for a data file. */
    name: text("name").notNull(),
    kind: text("kind", { enum: recordKind }).notNull(),
    source: text("source").notNull(),
    /** Monotonic from 1 — the `version` of the history row this write appended. */
    rev: integer("rev").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Better Auth user id of the last writer — nothing recorded WHO before this. */
    updatedBy: text("updated_by"),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.canvasId, t.name] }),
    // SQLite treats NULLs as DISTINCT in a unique index, so the primary key above does not
    // actually constrain the shared tier (`canvas_id IS NULL`) — two rows for the same
    // shared Component would both be accepted and a read would pick one arbitrarily. This
    // partial index is what makes the shared tier's key real.
    uniqueIndex("component_records_shared_name_idx")
      .on(t.workspaceId, t.name)
      .where(sql`canvas_id is null`),
  ],
);

/** Every write appends one of these. Explicit history, not D1 Time Travel: a time-travel
 *  restore rolls back the WHOLE database, so recovering one Component would also roll back
 *  auth sessions and the canvas registry (ADR-0022 decision 4). */
export const componentRecordVersions = sqliteTable(
  "component_record_versions",
  {
    workspaceId: text("workspace_id").notNull(),
    canvasId: text("canvas_id"),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    source: text("source").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdBy: text("created_by"),
  },
  (t) => [index("component_record_versions_key_idx").on(t.workspaceId, t.canvasId, t.name, t.version)],
);

export type ComponentRecordRow = typeof componentRecords.$inferSelect;
export type ComponentRecordVersionRow = typeof componentRecordVersions.$inferSelect;

/* ------------------------------------------------------------------ *
 * Skill Records (ADR-0022) — Workspace skills as ROWS
 *
 * The second Record family, separate from `component_records` for one
 * reason: a skill is a DIRECTORY (SKILL.md plus arbitrary supporting
 * paths), so its key is TWO-level — the skill, then the path inside it —
 * where a Component's is (workspace, canvas, name).
 *
 * Workspace-scoped, with no canvas: a skill belongs to the workspace, and
 * every chat turn in it discovers the same set. PLATFORM skills are
 * deliberately absent — they are image-baked, deploy-gated code at the
 * container's ~/.claude/skills (ADR-0013), never workspace data.
 * ------------------------------------------------------------------ */
export const skillFiles = sqliteTable(
  "skill_files",
  {
    workspaceId: text("workspace_id").notNull(),
    /** The skill dir name — `.claude/skills/<skill>/`. */
    skill: text("skill").notNull(),
    /** The relative path inside it: `SKILL.md`, `data/corpus.yaml`. */
    path: text("path").notNull(),
    content: text("content").notNull(),
    /** Monotonic from 1 — the `version` of the history row this write appended. */
    rev: integer("rev").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedBy: text("updated_by"),
    /** Soft delete, as with Components: reclaiming rows is an explicit purge, never an
     *  upload's side effect. No door writes this yet — `upload_skill` MERGES files, which
     *  is the contract it has always had (#177) — so removal arrives with its own tool. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.skill, t.path] })],
);

/** Every skill-file write appends one of these — the same explicit history Components get,
 *  for the same reason: a re-upload is a full replace, and without a version row a bad
 *  SKILL.md is as final as a delete (ADR-0022 decision 4). */
export const skillFileVersions = sqliteTable(
  "skill_file_versions",
  {
    workspaceId: text("workspace_id").notNull(),
    skill: text("skill").notNull(),
    path: text("path").notNull(),
    version: integer("version").notNull(),
    content: text("content").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    createdBy: text("created_by"),
  },
  (t) => [index("skill_file_versions_key_idx").on(t.workspaceId, t.skill, t.path, t.version)],
);

export type SkillFileRow = typeof skillFiles.$inferSelect;
export type SkillFileVersionRow = typeof skillFileVersions.$inferSelect;

export type Workspace = typeof workspace.$inferSelect;
