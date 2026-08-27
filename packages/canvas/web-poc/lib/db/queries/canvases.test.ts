import { createClient } from "@libsql/client";
import { migrationStatements } from "../test-d1.js";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import * as canvases from "./canvases.js";

const client = createClient({ url: ":memory:" });
const db = drizzle(client, { schema });

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
});

describe("canvas registry — create → list → get round-trip", () => {
  it("creates a canvas and reads it back via list and get", async () => {
    const created = await canvases.create(db, { workspaceId: "ws_a", name: "Main" });
    expect(created.name).toBe("Main");
    expect(created.workspaceId).toBe("ws_a");
    expect(created.id).toBeTruthy();
    expect(created.ownerRef).toBeNull();

    const listed = await canvases.list(db, "ws_a");
    expect(listed.map((c) => c.id)).toContain(created.id);

    const fetched = await canvases.get(db, created.id);
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.name).toBe("Main");
  });

  it("get of a missing canvas returns null", async () => {
    expect(await canvases.get(db, "cv_missing")).toBeNull();
  });
});

describe("canvas registry — rename", () => {
  it("renames a canvas", async () => {
    const created = await canvases.create(db, { workspaceId: "ws_a", name: "Old" });
    const renamed = await canvases.rename(db, created.id, "New");
    expect(renamed?.name).toBe("New");
    expect((await canvases.get(db, created.id))?.name).toBe("New");
  });
});

describe("canvas registry — delete", () => {
  it("deletes a canvas from the registry", async () => {
    const created = await canvases.create(db, { workspaceId: "ws_a", name: "Doomed" });
    await canvases.delete(db, created.id);
    expect(await canvases.get(db, created.id)).toBeNull();
  });
});

describe("canvas registry — per-workspace isolation", () => {
  it("list is scoped to a workspace: a canvas in A never shows in B's list", async () => {
    const inA = await canvases.create(db, { workspaceId: "ws_scope_a", name: "A" });
    await canvases.create(db, { workspaceId: "ws_scope_b", name: "B" });

    const listA = await canvases.list(db, "ws_scope_a");
    expect(listA.every((c) => c.workspaceId === "ws_scope_a")).toBe(true);
    expect(listA.map((c) => c.id)).toContain(inA.id);

    const listB = await canvases.list(db, "ws_scope_b");
    expect(listB.map((c) => c.id)).not.toContain(inA.id);
  });
});
