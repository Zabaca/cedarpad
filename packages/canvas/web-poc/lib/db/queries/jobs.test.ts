import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import { claimNextAgentJob, enqueueAgentJob } from "./jobs.js";

/** In-memory DB built from the real migrations (mirrors the other query tests). */
const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, "utf8")
        .split("--> statement-breakpoint")
        .map((s) => s.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").trim())
        .filter(Boolean),
    );
}

const client = createClient({ url: ":memory:" });
const db = drizzle(client, { schema });

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
});

describe("claimNextAgentJob priority ordering", () => {
  it("drains highest priority first regardless of enqueue order", async () => {
    // Enqueue low → high → medium so creation order ≠ priority order.
    await enqueueAgentJob(db, { kind: "problem_intake", payload: { targetId: "low" }, workspaceId: "ws", priority: 0 });
    await enqueueAgentJob(db, { kind: "problem_intake", payload: { targetId: "high" }, workspaceId: "ws", priority: 20 });
    await enqueueAgentJob(db, { kind: "problem_intake", payload: { targetId: "med" }, workspaceId: "ws", priority: 10 });

    const a = await claimNextAgentJob(db);
    const b = await claimNextAgentJob(db);
    const c = await claimNextAgentJob(db);

    expect([a?.priority, b?.priority, c?.priority]).toEqual([20, 10, 0]);
    expect([a?.payload.targetId, b?.payload.targetId, c?.payload.targetId]).toEqual(["high", "med", "low"]);
    expect(await claimNextAgentJob(db)).toBeNull();
  });

  it("defaults priority to 0 when omitted (observation/synthesis jobs)", async () => {
    const id = await enqueueAgentJob(db, {
      kind: "observation_intake",
      payload: { targetId: "obs" },
      workspaceId: "ws",
    });
    const [row] = await db.select().from(schema.agentJobs).where(eq(schema.agentJobs.id, id));
    expect(row?.priority).toBe(0);
  });
});
