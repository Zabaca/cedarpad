/**
 * Local-dev agent worker — the consumer for the `agent_jobs` queue. Polls the
 * table and runs the matching pipeline (embed/classify/synthesize) at its own
 * pace, so intake (web/API) never blocks.
 *
 * In production this is the Worker's `scheduled` (Cron) handler — see
 * `worker/index.ts` and `wrangler.jsonc` `triggers.crons`. The Vite/workerd dev
 * server does not fire cron triggers, so run this in a separate terminal:
 *
 *   bun run dev:worker            # against the local `turso dev` daemon
 *
 * With `AI_BRIDGE_DIR` set, each reasoner call waits on the manual bridge.
 */
import { createDb } from "../lib/db/index.js";
import type { Bindings } from "../worker/context.js";
import { drainAgentJobs } from "../worker/worker.js";

const url = process.env.TURSO_URL ?? "http://127.0.0.1:8081";
const db = createDb({ url, authToken: process.env.TURSO_KEY });

const env: Bindings = {
  TURSO_URL: url,
  TURSO_KEY: process.env.TURSO_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ABLY_API_KEY: process.env.ABLY_API_KEY,
  BETTER_AUTH_SECRET:
    process.env.BETTER_AUTH_SECRET ?? "dev-secret-at-least-32-characters-long!!",
  AI_BRIDGE_DIR: process.env.AI_BRIDGE_DIR,
  AI_BRIDGE_TIMEOUT_MS: process.env.AI_BRIDGE_TIMEOUT_MS,
};

const pollMs = Number(process.env.WORKER_POLL_MS ?? 1000);
console.log(
  `Agent worker draining agent_jobs at ${url} (poll ${pollMs}ms)` +
    (env.AI_BRIDGE_DIR ? ` · reasoner: MANUAL BRIDGE → ${env.AI_BRIDGE_DIR}` : " · reasoner: heuristic/keyed"),
);

for (;;) {
  try {
    const n = await drainAgentJobs(db, env, { max: 10 });
    if (n > 0) console.log(`processed ${n} job(s)`);
  } catch (err) {
    console.error("worker error", err);
  }
  await new Promise((r) => setTimeout(r, pollMs));
}
