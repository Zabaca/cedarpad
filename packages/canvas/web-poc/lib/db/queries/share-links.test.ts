import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import { createShareLink, getActiveShareLink, listShareLinks, revokeShareLink } from "./share-links.js";

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

describe("share links — the guest door's credential rows (ADR-0015)", () => {
  it("create then getActive returns the link with its canvas scope and permissions", async () => {
    const link = await createShareLink(db, {
      canvasId: "cv_1",
      workspaceId: "ws_1",
      createdBy: "user_1",
      guestChat: false,
    });
    expect(link.id).toBeTruthy();
    const found = await getActiveShareLink(db, link.id);
    expect(found).toMatchObject({
      id: link.id,
      canvasId: "cv_1",
      workspaceId: "ws_1",
      createdBy: "user_1",
      guestChat: false,
    });
  });

  it("an unknown id resolves to null (indistinguishable from revoked, by design)", async () => {
    expect(await getActiveShareLink(db, "sl_nope")).toBeNull();
  });

  it("revoke tombstones the link — getActive stops resolving it, but list still shows it", async () => {
    const link = await createShareLink(db, {
      canvasId: "cv_r",
      workspaceId: "ws_1",
      createdBy: "user_1",
      guestChat: true,
    });
    await revokeShareLink(db, link.id);
    expect(await getActiveShareLink(db, link.id)).toBeNull();
    const listed = await listShareLinks(db, "cv_r");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it("revoking twice keeps the first timestamp (idempotent tombstone)", async () => {
    const link = await createShareLink(db, {
      canvasId: "cv_r2",
      workspaceId: "ws_1",
      createdBy: "user_1",
      guestChat: false,
    });
    await revokeShareLink(db, link.id);
    const [first] = await listShareLinks(db, "cv_r2");
    await new Promise((r) => setTimeout(r, 5));
    await revokeShareLink(db, link.id);
    const [second] = await listShareLinks(db, "cv_r2");
    expect(second?.revokedAt?.getTime()).toBe(first?.revokedAt?.getTime());
  });

  it("list is per-canvas and newest-first", async () => {
    const a = await createShareLink(db, { canvasId: "cv_l", workspaceId: "ws_1", createdBy: "u", guestChat: false });
    await new Promise((r) => setTimeout(r, 5));
    const b = await createShareLink(db, { canvasId: "cv_l", workspaceId: "ws_1", createdBy: "u", guestChat: true });
    await createShareLink(db, { canvasId: "cv_other", workspaceId: "ws_1", createdBy: "u", guestChat: false });
    const listed = await listShareLinks(db, "cv_l");
    expect(listed.map((l) => l.id)).toEqual([b.id, a.id]);
  });
});
