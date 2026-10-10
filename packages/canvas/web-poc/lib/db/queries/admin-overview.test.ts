import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import { adminOverview } from "./admin-overview.js";

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

const SESSION_TOKEN = "sess-token-SECRET";
const MCP_TOKEN = "mcp-token-SECRET";

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  await db.insert(schema.user).values([
    { id: "u_owner", name: "Owner", email: "owner@example.com", role: "admin" },
    { id: "u_member", name: "Member", email: "member@example.com" },
  ]);
  await db.insert(schema.session).values([
    { id: "s1", userId: "u_owner", token: SESSION_TOKEN, expiresAt: new Date(2_000_000_000_000), ipAddress: "10.0.0.1", userAgent: "UA", updatedAt: new Date(1_000) },
    { id: "s2", userId: "u_owner", token: "other", expiresAt: new Date(2_000_000_000_000), updatedAt: new Date(5_000) },
  ]);
  await db.insert(schema.workspaces).values({ id: "ws_1", name: "One", ownerUserId: "u_owner" });
  await db.insert(schema.workspaceMembers).values({ id: "m1", workspaceId: "ws_1", userId: "u_member" });
  await db.insert(schema.canvases).values([
    { id: "cv_1", workspaceId: "ws_1", name: "a" },
    { id: "cv_2", workspaceId: "ws_1", name: "b" },
  ]);
  await db.insert(schema.workspaceMcpTokens).values({ workspaceId: "ws_1", mcpName: "fredrin", token: MCP_TOKEN });
});

describe("adminOverview — the admin host's read (ADR-0026)", () => {
  it("lists users with their latest session as last seen", async () => {
    const o = await adminOverview(db);
    const owner = o.users.find((u) => u.id === "u_owner");
    expect(owner).toMatchObject({ email: "owner@example.com", role: "admin", banned: false });
    expect(owner?.lastSeen?.getTime()).toBe(5_000);
    expect(o.users.find((u) => u.id === "u_member")?.lastSeen).toBeNull();
  });

  it("counts each workspace's members and canvases", async () => {
    const o = await adminOverview(db);
    expect(o.workspaces.find((w) => w.id === "ws_1")).toMatchObject({
      ownerUserId: "u_owner",
      memberUserIds: ["u_member"],
      canvases: 2,
      components: 0,
      skillFiles: 0,
    });
  });

  it("never returns a session token, an MCP token, an IP or a user agent", async () => {
    const text = JSON.stringify(await adminOverview(db));
    for (const secret of [SESSION_TOKEN, MCP_TOKEN, "10.0.0.1", "UA"]) expect(text).not.toContain(secret);
    expect(text).toContain("fredrin");
  });
});
