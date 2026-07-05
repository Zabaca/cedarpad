/**
 * Agent eval harness.
 *
 * Runs the real intake pipeline over a small golden fixture and measures the
 * two things the graph design is supposed to get right:
 *   - **link recall** — does a new problem link to the prior problems it should?
 *   - **reuse accuracy** — does it reuse an accepted prior solution exactly when
 *     one exists (and not otherwise)?
 *
 * With no provider keys (the default) the pipeline runs the deterministic
 * hash-embedder + heuristic-reasoner path, so results are stable and CI-safe
 * (see `eval.test.ts`). Pass real keys via `env` to exercise the LLM + graph
 * tool loop instead (see `scripts/eval.ts`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runAgentPipeline } from "../../lib/ai/index.js";
import { type Database, makeDb, schema } from "../../lib/db/index.js";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { createEmbedder, createPipelineDeps, providerModelLabel } from "./agent.js";
import type { Bindings } from "./context.js";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../lib/db/migrations", import.meta.url).href,
);

const WORKSPACE = "ws_eval";

interface ExistingProblem {
  id: string;
  title: string;
  body: string;
  /** When set, an *accepted* solution is attached (reuse is then expected). */
  solution?: string;
}

interface GoldProbe {
  id: string;
  title: string;
  body: string;
  /** Prior problem ids this probe should link to. */
  expectLinkTo: string[];
  /** Whether the probe should reuse an accepted prior solution. */
  expectReuse: boolean;
}

/** Prior problems the agent has already seen (the "memory"). */
export const EXISTING: ExistingProblem[] = [
  {
    id: "eval_e1",
    title: "Connection pool exhausted",
    body: "Database connection pool is exhausted under load causing intermittent 500 errors.",
    solution: "Raise the pool size, add acquire timeouts, and surface pool metrics.",
  },
  {
    id: "eval_e2",
    title: "Checkout latency spikes",
    body: "Checkout endpoint latency spikes during peak traffic and sometimes times out.",
  },
];

/** New problems with known-correct expectations. */
export const PROBES: GoldProbe[] = [
  {
    // Near-duplicate of a problem that HAS an accepted solution → reuse it.
    id: "eval_q1",
    title: "Connection pool exhausted",
    body: "Database connection pool is exhausted under load causing intermittent 500 errors.",
    expectLinkTo: ["eval_e1"],
    expectReuse: true,
  },
  {
    // Near-duplicate of a problem with NO solution → link, but nothing to reuse.
    id: "eval_q2",
    title: "Checkout latency spikes",
    body: "Checkout endpoint latency spikes during peak traffic and sometimes times out.",
    expectLinkTo: ["eval_e2"],
    expectReuse: false,
  },
  {
    // Unrelated → no links, no reuse.
    id: "eval_q3",
    title: "Dark mode preference not saved",
    body: "Toggling dark mode in user settings does not persist after a page reload.",
    expectLinkTo: [],
    expectReuse: false,
  },
];

export interface ProbeOutcome {
  id: string;
  title: string;
  linkedTo: { toProblemId: string; kind: string }[];
  origin: string;
  reused: boolean;
  expectLinkTo: string[];
  expectReuse: boolean;
  /** Fraction of `expectLinkTo` that was actually linked. */
  linkRecall: number;
  reuseCorrect: boolean;
}

export interface EvalReport {
  providerModel: string;
  probes: ProbeOutcome[];
  /** Mean link recall across probes. */
  linkRecall: number;
  /** Fraction of probes whose reuse decision matched expectation. */
  reuseAccuracy: number;
}

/** Fresh in-memory db with the real schema applied. */
export async function setupEvalDb(): Promise<{ db: Database; close: () => void }> {
  const client = createClient({ url: ":memory:" });
  // Apply every migration in order — mirrors what the real migrator does.
  const statements = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8")
        .split("--> statement-breakpoint")
        .map((s) =>
          s
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim(),
        )
        .filter(Boolean),
    );
  for (const stmt of statements) await client.execute(stmt);
  return { db: makeDb(client), close: () => client.close() };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Seed the fixture and run every probe through the pipeline, scoring outcomes. */
export async function runEval(db: Database, env: Bindings): Promise<EvalReport> {
  const embedder = createEmbedder(env);

  await db
    .insert(schema.workspace)
    .values({ id: WORKSPACE, name: "Eval", slug: "eval" })
    .onConflictDoNothing();

  for (const e of EXISTING) {
    await db
      .insert(schema.problems)
      .values({
        id: e.id,
        workspaceId: WORKSPACE,
        title: e.title,
        body: e.body,
        embedding: await embedder.embed(`${e.title}\n\n${e.body}`),
        embeddingModel: embedder.model,
      })
      .onConflictDoNothing();
    if (e.solution) {
      const sid = `${e.id}_sol`;
      await db
        .insert(schema.solutions)
        .values({ id: sid, body: e.solution, origin: "synthesized", status: "accepted" })
        .onConflictDoNothing();
      await db
        .insert(schema.solutionLinks)
        .values({ solutionId: sid, targetKind: "problem", targetId: e.id })
        .onConflictDoNothing();
    }
  }

  const probes: ProbeOutcome[] = [];
  for (const p of PROBES) {
    await db
      .insert(schema.problems)
      .values({ id: p.id, workspaceId: WORKSPACE, title: p.title, body: p.body })
      .onConflictDoNothing();

    const result = await runAgentPipeline(createPipelineDeps(db, env), p.id);

    let origin = "none";
    if (result.solutionId) {
      const rows = await db
        .select({ origin: schema.solutions.origin })
        .from(schema.solutions)
        .where(eq(schema.solutions.id, result.solutionId))
        .limit(1);
      origin = rows[0]?.origin ?? "none";
    }

    const linkedTo = result.links.map((l) => ({ toProblemId: l.toId, kind: l.kind }));
    const linkedIds = new Set(linkedTo.map((l) => l.toProblemId));
    const found = p.expectLinkTo.filter((id) => linkedIds.has(id));
    const linkRecall = p.expectLinkTo.length ? found.length / p.expectLinkTo.length : 1;
    const reused = origin === "reused";

    probes.push({
      id: p.id,
      title: p.title,
      linkedTo,
      origin,
      reused,
      expectLinkTo: p.expectLinkTo,
      expectReuse: p.expectReuse,
      linkRecall,
      reuseCorrect: reused === p.expectReuse,
    });
  }

  return {
    providerModel: providerModelLabel(env),
    probes,
    linkRecall: mean(probes.map((p) => p.linkRecall)),
    reuseAccuracy: probes.filter((p) => p.reuseCorrect).length / probes.length,
  };
}
