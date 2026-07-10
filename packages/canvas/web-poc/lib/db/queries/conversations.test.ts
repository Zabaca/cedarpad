import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import * as conversations from "./conversations.js";

/** In-memory DB built from the real migrations (mirrors workspaces.test.ts). */
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

const seed = (over: Partial<Parameters<typeof conversations.create>[1]> = {}) =>
  conversations.create(db, {
    sessionId: `sess_${crypto.randomUUID()}`,
    userId: "user_a",
    workspaceId: "ws_a",
    ...over,
  });

describe("conversation store — create → get round-trip", () => {
  it("creates a conversation with sensible defaults and reads it back", async () => {
    const created = await seed({ summary: "hello", lastMessagePreview: "hi there" });
    expect(created.id).toBeTruthy();
    expect(created.status).toBe("open");
    expect(created.waitingOn).toBe("none");
    expect(created.unread).toBe(false);
    expect(created.ownerRef).toBeNull();
    expect(created.summary).toBe("hello");
    expect(created.lastMessagePreview).toBe("hi there");
    expect(created.lastActivity).toBeInstanceOf(Date);

    const fetched = await conversations.get(db, created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it("get of a missing conversation returns null", async () => {
    expect(await conversations.get(db, "conv_missing")).toBeNull();
  });
});

describe("conversation store — state transitions", () => {
  it("promote → open + waiting_on:human + unread, touches last_activity", async () => {
    const c = await seed();
    const before = c.lastActivity.getTime();
    await new Promise((r) => setTimeout(r, 2));
    const promoted = await conversations.promote(db, c.id);
    expect(promoted?.status).toBe("open");
    expect(promoted?.waitingOn).toBe("human");
    expect(promoted?.unread).toBe(true);
    expect(promoted!.lastActivity.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("reply → waiting_on:agent + clears unread", async () => {
    const c = await seed();
    await conversations.promote(db, c.id);
    const replied = await conversations.reply(db, c.id);
    expect(replied?.waitingOn).toBe("agent");
    expect(replied?.unread).toBe(false);
  });

  it("markActivity → unread + touches last_activity, leaves axes untouched", async () => {
    const c = await seed();
    await conversations.reply(db, c.id); // waiting_on:agent
    const active = await conversations.markActivity(db, c.id);
    expect(active?.unread).toBe(true);
    expect(active?.waitingOn).toBe("agent");
    expect(active?.status).toBe("open");
  });

  it("close → status:closed, reopen → status:open", async () => {
    const c = await seed();
    const closed = await conversations.close(db, c.id);
    expect(closed?.status).toBe("closed");
    const reopened = await conversations.reopen(db, c.id);
    expect(reopened?.status).toBe("open");
  });

  it("markRead → clears unread only, leaves last_activity untouched (reading isn't activity)", async () => {
    const c = await seed();
    await conversations.markActivity(db, c.id); // unread:true, bumps last_activity
    const active = await conversations.get(db, c.id);
    const before = active!.lastActivity.getTime();
    await new Promise((r) => setTimeout(r, 2));
    const read = await conversations.markRead(db, c.id);
    expect(read?.unread).toBe(false);
    expect(read?.lastActivity.getTime()).toBe(before);
  });

  it("close clears waiting_on (archiving resolves the ask)", async () => {
    const c = await seed();
    await conversations.promote(db, c.id); // waiting_on:human
    const closed = await conversations.close(db, c.id);
    expect(closed?.status).toBe("closed");
    expect(closed?.waitingOn).toBe("none");
  });

  it("transitions on a missing conversation return null", async () => {
    expect(await conversations.promote(db, "conv_missing")).toBeNull();
    expect(await conversations.close(db, "conv_missing")).toBeNull();
  });
});

describe("conversation store — list filtering, sort, scoping", () => {
  it("filters by status", async () => {
    const u = "user_status";
    const open = await conversations.create(db, { sessionId: "s1", userId: u, workspaceId: "ws_a" });
    const other = await conversations.create(db, { sessionId: "s2", userId: u, workspaceId: "ws_a" });
    await conversations.close(db, other.id);

    const openList = await conversations.list(db, u, { status: "open" });
    expect(openList.map((c) => c.id)).toContain(open.id);
    expect(openList.map((c) => c.id)).not.toContain(other.id);

    const closedList = await conversations.list(db, u, { status: "closed" });
    expect(closedList.map((c) => c.id)).toEqual([other.id]);
  });

  it("filters by workspaceId", async () => {
    const u = "user_ws";
    const inA = await conversations.create(db, { sessionId: "s1", userId: u, workspaceId: "ws_x" });
    await conversations.create(db, { sessionId: "s2", userId: u, workspaceId: "ws_y" });

    const listX = await conversations.list(db, u, { workspaceId: "ws_x" });
    expect(listX.every((c) => c.workspaceId === "ws_x")).toBe(true);
    expect(listX.map((c) => c.id)).toContain(inA.id);
  });

  it("filters by waiting_on: the 'needs me' view shows only promoted (waiting_on:human) rows", async () => {
    const u = "user_waiting";
    // A plain session (waiting_on defaults to 'none' — a session that exists, nothing pending).
    const idle = await conversations.create(db, { sessionId: "s_idle", userId: u, workspaceId: "ws_a" });
    // An ask_human promotion (waiting_on:human — needs attention).
    const promoted = await conversations.create(db, { sessionId: "s_ask", userId: u, workspaceId: "ws_a" });
    await conversations.promote(db, promoted.id);

    const needsMe = await conversations.list(db, u, { waitingOn: "human" });
    expect(needsMe.map((c) => c.id)).toEqual([promoted.id]);

    // The unified index (no waitingOn filter) shows BOTH — every session, promoted or not.
    const all = await conversations.list(db, u);
    expect(all.map((c) => c.id)).toEqual(expect.arrayContaining([idle.id, promoted.id]));
  });

  it("sorts by last_activity desc", async () => {
    const u = "user_sort";
    const first = await conversations.create(db, { sessionId: "s1", userId: u, workspaceId: "ws_a" });
    await new Promise((r) => setTimeout(r, 2));
    const second = await conversations.create(db, { sessionId: "s2", userId: u, workspaceId: "ws_a" });
    await new Promise((r) => setTimeout(r, 2));
    // Bump `first` to the most recent activity.
    await conversations.markActivity(db, first.id);

    const listed = await conversations.list(db, u);
    expect(listed.map((c) => c.id)).toEqual([first.id, second.id]);
  });

  it("is user-scoped: list returns only the caller's conversations", async () => {
    const mine = await conversations.create(db, { sessionId: "sm", userId: "owner_1", workspaceId: "ws_a" });
    await conversations.create(db, { sessionId: "st", userId: "owner_2", workspaceId: "ws_a" });

    const listed = await conversations.list(db, "owner_1");
    expect(listed.every((c) => c.userId === "owner_1")).toBe(true);
    expect(listed.map((c) => c.id)).toContain(mine.id);
  });
});
