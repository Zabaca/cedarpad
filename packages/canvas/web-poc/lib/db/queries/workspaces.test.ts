import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import {
  addWorkspaceMember,
  createWorkspace,
  getWorkspace,
  listWorkspaceMembers,
  listWorkspaces,
  r2Prefix,
  sandboxId,
  transferWorkspaceOwnership,
} from "./workspaces.js";

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
  for (const id of ["user_a", "owner_1", "owner_2", "member_1", "stranger_1"]) {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
  }
});

describe("workspace registry — create → list → get round-trip", () => {
  it("creates a workspace and reads it back via list and get", async () => {
    const created = await createWorkspace(db, { name: "cedarpad", ownerUserId: "user_a" });
    expect(created.name).toBe("cedarpad");
    expect(created.ownerUserId).toBe("user_a");
    expect(created.id).toBeTruthy();

    const listed = await listWorkspaces(db, "user_a");
    expect(listed.map((w) => w.id)).toContain(created.id);

    const fetched = await getWorkspace(db, created.id, "user_a");
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.name).toBe("cedarpad");
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

describe("workspace membership (#179) — access is owner-OR-member", () => {
  it("an added member can get the workspace; a stranger still cannot", async () => {
    const ws = await createWorkspace(db, { name: "shared", ownerUserId: "owner_1" });
    await addWorkspaceMember(db, { workspaceId: ws.id, userId: "member_1" });

    const asMember = await getWorkspace(db, ws.id, "member_1");
    expect(asMember?.id).toBe(ws.id);
    expect(await getWorkspace(db, ws.id, "stranger_1")).toBeNull();
  });

  it("list includes workspaces the caller is a member of, alongside owned ones", async () => {
    const own = await createWorkspace(db, { name: "member1-own", ownerUserId: "member_1" });
    const shared = await createWorkspace(db, { name: "shared-2", ownerUserId: "owner_2" });
    await addWorkspaceMember(db, { workspaceId: shared.id, userId: "member_1" });

    const ids = (await listWorkspaces(db, "member_1")).map((w) => w.id);
    expect(ids).toContain(own.id);
    expect(ids).toContain(shared.id);
    // and membership never leaks the other direction
    expect((await listWorkspaces(db, "owner_2")).map((w) => w.id)).not.toContain(own.id);
  });

  it("adding the same member twice is idempotent (no duplicate rows, list stays clean)", async () => {
    const ws = await createWorkspace(db, { name: "idem", ownerUserId: "owner_1" });
    await addWorkspaceMember(db, { workspaceId: ws.id, userId: "member_1" });
    await addWorkspaceMember(db, { workspaceId: ws.id, userId: "member_1" });

    const ids = (await listWorkspaces(db, "member_1")).map((w) => w.id).filter((id) => id === ws.id);
    expect(ids).toHaveLength(1);
  });
});

describe("transferWorkspaceOwnership — role change IS ownership transfer (single owner model)", () => {
  it("swaps owner_user_id and roster roles when the target is a member", async () => {
    const ws = await createWorkspace(db, { name: "transfer-1", ownerUserId: "owner_1" });
    await addWorkspaceMember(db, { workspaceId: ws.id, userId: "member_1" });

    const ok = await transferWorkspaceOwnership(db, { workspaceId: ws.id, toUserId: "member_1" });
    expect(ok).toBe(true);

    const fetched = await getWorkspace(db, ws.id, "member_1");
    expect(fetched?.ownerUserId).toBe("member_1");

    const roster = await listWorkspaceMembers(db, ws.id);
    expect(roster).toEqual([
      { userId: "member_1", name: "member_1", email: "member_1@example.com", role: "owner" },
      { userId: "owner_1", name: "owner_1", email: "owner_1@example.com", role: "member" },
    ]);
  });

  it("returns false when the target isn't a member", async () => {
    const ws = await createWorkspace(db, { name: "transfer-2", ownerUserId: "owner_1" });
    const ok = await transferWorkspaceOwnership(db, { workspaceId: ws.id, toUserId: "stranger_1" });
    expect(ok).toBe(false);
    expect((await getWorkspace(db, ws.id, "owner_1"))?.ownerUserId).toBe("owner_1");
  });
});
