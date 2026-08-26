import { migrationStatements } from "../test-migrations.js";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import { createShareLink, getActiveShareLink, listShareLinks, revokeShareLink } from "./share-links.js";

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

  // #320: guest permissions are three per-link booleans. Defaults matter as much as the
  // columns: a link minted with no opinion lets its holder USE the components it shows
  // (that is what the invite is for), and never lets them edit the canvas or author
  // executable source. Existing links are backfilled the same way by the migration.
  it("defaults: interact ON, both edit capabilities OFF", async () => {
    const link = await createShareLink(db, {
      canvasId: "cv_caps",
      workspaceId: "ws_1",
      createdBy: "user_1",
      guestChat: false,
    });
    expect(link).toMatchObject({ guestInteract: true, guestEdit: false, guestEditSource: false });
    expect(await getActiveShareLink(db, link.id)).toMatchObject({
      guestInteract: true,
      guestEdit: false,
      guestEditSource: false,
    });
  });

  it("each capability is settable per mint, including turning interact off", async () => {
    const link = await createShareLink(db, {
      canvasId: "cv_caps2",
      workspaceId: "ws_1",
      createdBy: "user_1",
      guestChat: false,
      guestInteract: false,
      guestEdit: true,
      guestEditSource: true,
    });
    expect(await getActiveShareLink(db, link.id)).toMatchObject({
      guestInteract: false,
      guestEdit: true,
      guestEditSource: true,
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
