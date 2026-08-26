import { migrationStatements } from "../test-migrations.js";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import * as conversations from "./conversations.js";
import { inboxWatermark } from "./inbox-watermark.js";
import { createWorkspace, setInboxReadAt } from "./workspaces.js";

const client = createClient({ url: ":memory:" });
const db = drizzle(client, { schema });

let wsId = "";
let otherId = "";

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  await db.insert(schema.user).values({ id: "owner", name: "owner", email: "owner@example.com" });
  wsId = (await createWorkspace(db, { name: "Watermarked", ownerUserId: "owner" })).id;
  otherId = (await createWorkspace(db, { name: "Elsewhere", ownerUserId: "owner" })).id;
});

/** Every mutation below has to land in a distinct millisecond to be distinguishable —
 *  the watermark is a timestamp, not a counter (see inbox-watermark.ts). */
const tick = () => new Promise((r) => setTimeout(r, 2));

describe("inboxWatermark — the cheap 'has anything changed' probe", () => {
  it("moves when a conversation is created in the workspace", async () => {
    const before = await inboxWatermark(db, wsId);
    await conversations.create(db, { sessionId: "s1", userId: "owner", workspaceId: wsId });
    expect(await inboxWatermark(db, wsId)).not.toBe(before);
  });

  // The column DEFAULT is `unixepoch() * 1000`, which is seconds scaled up — a create that
  // lands in the same second as the previous change would leave the watermark where it was
  // and the new chat would not reach the badge until something else moved. Every writer has
  // to stamp at the resolution the watermark is compared at.
  it("stamps a new conversation's updated_at at full millisecond precision", async () => {
    const before = Date.now();
    const conv = await conversations.create(db, { sessionId: "s_ms", userId: "owner", workspaceId: wsId });
    expect(conv.updatedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("moves when a conversation is closed — a transition that never touches last_activity", async () => {
    const conv = await conversations.create(db, { sessionId: "s2", userId: "owner", workspaceId: wsId });
    await tick();
    const before = await inboxWatermark(db, wsId);
    await conversations.close(db, conv.id);
    expect(await inboxWatermark(db, wsId)).not.toBe(before);
  });

  it("moves when the chat's visibility flips — the other triage act that changes what the badge counts", async () => {
    const conv = await conversations.create(db, { sessionId: "s3", userId: "owner", workspaceId: wsId });
    await tick();
    const before = await inboxWatermark(db, wsId);
    await conversations.setVisibility(db, conv.id, "private");
    expect(await inboxWatermark(db, wsId)).not.toBe(before);
  });

  it("moves when a chat is attached to a canvas — the edge a private canvas hides it by", async () => {
    const conv = await conversations.create(db, { sessionId: "s5", userId: "owner", workspaceId: wsId });
    await tick();
    const before = await inboxWatermark(db, wsId);
    await conversations.attachCanvas(db, conv.id, "cv_somewhere");
    expect(await inboxWatermark(db, wsId)).not.toBe(before);
  });

  it("moves when a dev-agent run's repo edge is stamped", async () => {
    const conv = await conversations.create(db, { sessionId: "s6", userId: "owner", workspaceId: wsId });
    await tick();
    const before = await inboxWatermark(db, wsId);
    await conversations.attachRepo(db, conv.id, "Zabaca/cedarpad");
    expect(await inboxWatermark(db, wsId)).not.toBe(before);
  });

  it("moves when the workspace's shared read mark is stamped", async () => {
    const before = await inboxWatermark(db, wsId);
    await setInboxReadAt(db, wsId, new Date(Date.now() + 60_000));
    expect(await inboxWatermark(db, wsId)).not.toBe(before);
  });

  it("does NOT move for another workspace's conversation", async () => {
    const before = await inboxWatermark(db, wsId);
    await conversations.create(db, { sessionId: "s4", userId: "owner", workspaceId: otherId });
    expect(await inboxWatermark(db, wsId)).toBe(before);
  });

  it("is stable when nothing changes — the whole point of the probe", async () => {
    const first = await inboxWatermark(db, wsId);
    await tick();
    expect(await inboxWatermark(db, wsId)).toBe(first);
  });

  it("answers for a workspace with no conversations and no read mark at all", async () => {
    const empty = await createWorkspace(db, { name: "Empty", ownerUserId: "owner" });
    expect(typeof (await inboxWatermark(db, empty.id))).toBe("string");
  });

  // The whole value of the probe is what it costs. A `max()` that has to SCAN the
  // workspace's conversations reads exactly as many rows as the full list it replaces —
  // it would look cheaper in query count and be no cheaper in rows. The composite
  // (workspace_id, updated_at) index turns it into a seek to one end of one range, which
  // is what makes "one row instead of ~16" true rather than asserted.
  it("resolves the conversations half by an index seek, never a table scan", async () => {
    const plan = await client.execute(
      "explain query plan select max(updated_at) from conversations where workspace_id = 'w'",
    );
    const detail = plan.rows.map((r) => String(r.detail)).join(" | ");
    expect(detail).toContain("conversations_workspace_updated_idx");
    expect(detail).not.toContain("SCAN conversations");
  });

  it("resolves the read-mark half by the workspaces primary key", async () => {
    const plan = await client.execute("explain query plan select inbox_read_at from workspaces where id = 'w'");
    const detail = plan.rows.map((r) => String(r.detail)).join(" | ");
    expect(detail).not.toContain("SCAN workspaces");
  });
});
