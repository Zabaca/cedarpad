import type { Database } from "../lib/db/index.js";
import type { AccessScope } from "./access.js";

/**
 * The Cloudflare Email Sending (`send_email`) binding, narrowed to what we send.
 * Structured-object form, not raw MIME. `replyTo`/`html`/`cc` exist upstream; we
 * send plain text only.
 */
export interface SendEmailBinding {
  send(message: { from: string; to: string; subject: string; text?: string }): Promise<unknown>;
}

/** Cloudflare Worker env bindings (from wrangler vars/secrets or .dev.vars). */
export interface Bindings {
  /** The platform data layer on D1 (ADR-0018) — bound in local dev (miniflare's local D1,
   * #263) and in production (#265, cutover #267; the Turso rollback path was retired
   * in #268). */
  PLATFORM_DB: import("@cloudflare/workers-types").D1Database;
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
   * INERT since the passwordless cutover. It gated email/password signup, and there is
   * no password credential any more — what keeps account creation closed now is the
   * allowlist in `sendMagicLink` (see auth.ts). Still declared in wrangler.jsonc and in
   * the generated worker-configuration.d.ts; removing it is a config change, not a code
   * one, so it is left in place rather than half-removed.
   */
  AUTH_DISABLE_SIGNUP?: string;
  /**
   * Cloudflare Email Sending. Optional on purpose: local dev and per-PR preview
   * workers have no binding, and the send seam degrades to a logging no-op there
   * rather than failing the request that asked for the mail.
   */
  EMAIL?: SendEmailBinding;
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
