import type { Database } from "../lib/db/index.js";
import type { AccessScope } from "./access.js";

/** Cloudflare Worker env bindings (from wrangler vars/secrets or .dev.vars). */
export interface Bindings {
  /**
   * The platform data layer on D1 (ADR-0018). Bound in LOCAL DEV only for now
   * (miniflare's local D1, #263); when present it wins over TURSO_* below.
   */
  PLATFORM_DB?: import("@cloudflare/workers-types").D1Database;
  TURSO_URL: string;
  TURSO_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  /** Voyage AI embeddings key — the active embedding provider. */
  VOYAGE_API_KEY?: string;
  ABLY_API_KEY?: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL?: string;
  /** Production web origin (e.g. the Pages URL) — trusted for CSRF/Origin checks. */
  WEB_ORIGIN?: string;
  /**
   * When "true", Better Auth email/password signup is disabled (prod is James-only,
   * PRD #49 #15). Unset in dev leaves signup open. Set as an edge Worker var.
   */
  AUTH_DISABLE_SIGNUP?: string;
  /**
   * Dev-only: when set, requests may pass `x-dev-workspace: <workspaceId>` to
   * act as that workspace WITHOUT authentication. Never set this in production.
   */
  DEV_AUTH_WORKSPACE?: string;
  /**
   * Dev/node-only: when set, the agent reasoner is the manual file bridge (an
   * operator or Claude Code answers each LLM call) instead of a hosted model.
   * Path to the bridge working directory. Never set this on Workers/production.
   */
  AI_BRIDGE_DIR?: string;
  /** Optional per-call timeout (ms) for the manual bridge. Defaults to 15 min. */
  AI_BRIDGE_TIMEOUT_MS?: string;
}

/** Per-request values set by middleware. */
export interface Variables {
  db: Database;
  /** Create target — where new records this request makes will land. */
  workspaceId: string;
  userId: string | null;
  /** true when the caller authenticated with an API key (an AI agent). */
  isAgent: boolean;
  /** Which workspaces this principal may read/touch (default: all). */
  accessScope: AccessScope;
}

export type AppEnv = { Bindings: Bindings; Variables: Variables };
