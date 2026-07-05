/**
 * Seed a local/Turso db with a demo workspace, a couple of observations and
 * problems (with embeddings) so the intake flow has something to match against.
 *
 * Run (after `bun --filter @cedarpad/db migrate`):
 *   TURSO_URL="file:local.db" bun apps/api/scripts/seed.ts
 *
 * Then start the API with DEV_AUTH_WORKSPACE=ws_demo and POST using the header
 * `x-dev-workspace: ws_demo` (no full auth needed for the demo).
 */
import { createHashEmbedder } from "../../lib/ai/index.js";
import { configuration } from "../../lib/config/index.js";
import { createDb, schema } from "../../lib/db/index.js";
import { and, eq } from "drizzle-orm";
import { createAuth } from "../../server/notebook/auth.js";
import type { Bindings } from "../../server/notebook/context.js";

const url = process.env.TURSO_URL ?? "http://127.0.0.1:8081";
const db = createDb({ url, authToken: process.env.TURSO_KEY });
const embedder = createHashEmbedder(configuration.ai.embeddingDimensions);

const WORKSPACE = "ws_demo";
const DEMO_EMAIL = "demo@cedarpad.dev";
const DEMO_PASSWORD = "demodemo123";

/**
 * Create (idempotently) a demo user via Better Auth — so the password is hashed
 * the same way the login route expects — and link them to the demo workspace as
 * owner, so `demo@cedarpad.dev` can log in and immediately see the seeded data.
 */
async function seedDemoUser(): Promise<void> {
  const env = {
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ?? "dev-secret-at-least-32-characters-long!!",
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:8787",
  } as Bindings;
  const auth = createAuth(db, env);

  let userId: string | undefined = (
    await db.select({ id: schema.user.id }).from(schema.user).where(eq(schema.user.email, DEMO_EMAIL)).limit(1)
  )[0]?.id;

  if (!userId) {
    const res = await auth.api.signUpEmail({
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: "Demo User" },
    });
    userId = res.user.id;
  }

  const member = (
    await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.userId, userId), eq(schema.member.workspaceId, WORKSPACE)))
      .limit(1)
  )[0];
  if (!member) {
    await db.insert(schema.member).values({
      id: `member_${crypto.randomUUID()}`,
      workspaceId: WORKSPACE,
      userId,
      role: "owner",
    });
  }
}

async function embed(title: string, body: string, impact?: string) {
  const base = `${title}\n\n${body}`;
  return embedder.embed(impact ? `${base}\n\n${impact}` : base);
}

async function main() {
  await db
    .insert(schema.workspace)
    .values({ id: WORKSPACE, name: "Demo Workspace", slug: "demo-workspace" })
    .onConflictDoNothing();

  // `SEED_USER_ONLY=1` seeds just the demo login (workspace + owner), no content.
  if (process.env.SEED_USER_ONLY !== "1") {
  // A couple of loose observations.
  const observations = [
    {
      id: "obs_demo_1",
      title: "Checkout felt slow this morning",
      body: "A teammate mentioned the checkout page hung for a few seconds during standup.",
      projectTags: ["Checkout"],
    },
    {
      id: "obs_demo_2",
      title: "Saw a 500 on payment confirm",
      body: "One-off 500 error when confirming a payment; could not reproduce immediately.",
      projectTags: ["Checkout"],
    },
  ];
  for (const o of observations) {
    await db
      .insert(schema.observations)
      .values({
        id: o.id,
        workspaceId: WORKSPACE,
        title: o.title,
        body: o.body,
        projectTags: o.projectTags,
        embedding: await embed(o.title, o.body),
        embeddingModel: embedder.model,
      })
      .onConflictDoNothing();
  }

  // A couple of distinct problems.
  const problems = [
    {
      id: "prob_demo_1",
      title: "Connection pool exhausted under load",
      body: "Database connection pool is exhausted under load causing intermittent 500s.",
      impact: "Checkout fails for ~2% of users at peak, lost revenue.",
      priority: 80,
      urgency: "high" as const,
      solutionDirection: "Tune pool sizing + add acquire timeouts + surface pool metrics.",
      projectTags: ["Platform Reliability"],
    },
    {
      id: "prob_demo_2",
      title: "Slow checkout endpoint at peak traffic",
      body: "Checkout endpoint latency spikes during peak traffic, occasionally timing out.",
      impact: "Elevated checkout latency degrades conversion during peak hours.",
      priority: 50,
      urgency: "medium" as const,
      projectTags: ["Checkout"],
    },
  ];
  for (const p of problems) {
    await db
      .insert(schema.problems)
      .values({
        id: p.id,
        workspaceId: WORKSPACE,
        title: p.title,
        body: p.body,
        impact: p.impact,
        priority: p.priority,
        urgency: p.urgency,
        solutionDirection: p.solutionDirection,
        projectTags: p.projectTags,
        embedding: await embed(p.title, p.body, p.impact),
        embeddingModel: embedder.model,
      })
      .onConflictDoNothing();
  }

  await db
    .insert(schema.solutions)
    .values({
      id: "sol_demo_1",
      body: "Raise the pool size, add acquire timeouts, and surface pool metrics.",
      origin: "synthesized",
      status: "accepted",
    })
    .onConflictDoNothing();
  await db
    .insert(schema.solutionLinks)
    .values({ solutionId: "sol_demo_1", targetKind: "problem", targetId: "prob_demo_1" })
    .onConflictDoNothing();

  console.log(
    `Seeded workspace=${WORKSPACE} with ${observations.length} observations and ${problems.length} problems into ${url}`,
  );
  }

  await seedDemoUser();

  console.log(`Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
