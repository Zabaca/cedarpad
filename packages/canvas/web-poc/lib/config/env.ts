import { z } from "zod";

/**
 * Runtime secrets/bindings. On Cloudflare Workers these arrive via the `env`
 * binding object; in Node (tests, migrations) via `process.env`. Pass the
 * source explicitly so the same validator works in both worlds.
 */
export const envSchema = z.object({
  // AI providers (only the active one is required at runtime)
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // Embeddings (Voyage — the active embedding provider)
  VOYAGE_API_KEY: z.string().optional(),

  // Realtime
  ABLY_API_KEY: z.string().optional(),

  // Auth
  BETTER_AUTH_SECRET: z.string().min(1),
  BETTER_AUTH_URL: z.string().url().optional(),

  // Dev/node-only: manual agent bridge (operator/Claude answers each LLM call).
  AI_BRIDGE_DIR: z.string().optional(),
  AI_BRIDGE_TIMEOUT_MS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, unknown>): Env {
  return envSchema.parse(source);
}
