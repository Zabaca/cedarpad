import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import { createWorkspace, getWorkspace, listWorkspaces, r2Prefix, sandboxId } from "./workspaces.js";

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
  // Owners must exist — `workspaces.owner_user_id` FK-references `user`.
  for (const id of ["user_a", "owner_1", "owner_2"]) {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
  }
});

describe("workspace registry — create → list → get round-trip", () => {
  it("creates a workspace and reads it back via list and get", async () => {
    const created = await createWorkspace(db, { name: "cedarpad", ownerUserId: "user_a", repo: "Zabaca/cedarpad" });
    expect(created.name).toBe("cedarpad");
    expect(created.repo).toBe("Zabaca/cedarpad");
    expect(created.ownerUserId).toBe("user_a");
    expect(created.id).toBeTruthy();

    const listed = await listWorkspaces(db, "user_a");
    expect(listed.map((w) => w.id)).toContain(created.id);

    const fetched = await getWorkspace(db, created.id, "user_a");
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.name).toBe("cedarpad");
  });

  it("allows a null repo", async () => {
    const created = await createWorkspace(db, { name: "sideproject", ownerUserId: "user_a" });
    expect(created.repo).toBeNull();
  });
});

describe("workspace registry — deterministic runtime coordinate derivation", () => {
  it("derives sandboxId and r2Prefix from a workspace id", async () => {
    const created = await createWorkspace(db, { name: "derivation", ownerUserId: "user_a" });
    expect(sandboxId(created.id)).toBe(`workspace-${created.id}`);
    expect(r2Prefix(created.id)).toBe(`workspaces/${created.id}/`);
    // Records carry the derived coordinates (derived, not stored).
    expect(created.sandboxId).toBe(`workspace-${created.id}`);
    expect(created.r2Prefix).toBe(`workspaces/${created.id}/`);
  });

  it("is a pure function of the id", () => {
    expect(sandboxId("abc")).toBe("workspace-abc");
    expect(r2Prefix("abc")).toBe("workspaces/abc/");
  });
});

describe("workspace registry — per-owner isolation", () => {
  it("list returns only the caller's workspaces", async () => {
    const mine = await createWorkspace(db, { name: "mine", ownerUserId: "owner_1" });
    await createWorkspace(db, { name: "theirs", ownerUserId: "owner_2" });

    const listed = await listWorkspaces(db, "owner_1");
    expect(listed.every((w) => w.ownerUserId === "owner_1")).toBe(true);
    expect(listed.map((w) => w.id)).toContain(mine.id);
  });

  it("get of a workspace owned by another user is denied (returns null)", async () => {
    const theirs = await createWorkspace(db, { name: "secret", ownerUserId: "owner_2" });
    const fetched = await getWorkspace(db, theirs.id, "owner_1");
    expect(fetched).toBeNull();
  });
});
