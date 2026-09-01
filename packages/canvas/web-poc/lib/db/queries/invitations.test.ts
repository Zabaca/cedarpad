import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  listPendingInvitations,
  revokeWorkspaceInvitation,
} from "./invitations.js";
import { createWorkspace, getWorkspace } from "./workspaces.js";

import { migrationStatements } from "../test-migrations.js";

const client = createClient({ url: ":memory:" });
const db = drizzle(client, { schema });

const NOW = 1_800_000_000_000; // fixed clock — expiry is tested, never wall-time

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const id of ["owner_1", "invitee_1", "wrong_1"]) {
    await db.insert(schema.user).values({ id, name: id, email: `${id}@example.com` });
  }
});

const freshWorkspace = () => createWorkspace(db, { name: `ws-${crypto.randomUUID()}`, ownerUserId: "owner_1" });

describe("workspace invitations (#179) — email-bound, single-use, expiring", () => {
  it("create → accept as the invited email adds membership and consumes the invitation", async () => {
    const ws = await freshWorkspace();
    const inv = await createWorkspaceInvitation(db, {
      workspaceId: ws.id,
      email: "Invitee_1@Example.com", // case-insensitive binding
      inviterUserId: "owner_1",
      nowMs: NOW,
    });
    expect(inv.status).toBe("pending");
    expect(inv.expiresAt.getTime()).toBeGreaterThan(NOW);

    const res = await acceptWorkspaceInvitation(db, {
      token: inv.id,
      userId: "invitee_1",
      email: "invitee_1@example.com",
      nowMs: NOW + 1000,
    });
    expect(res).toEqual({ ok: true, workspaceId: ws.id });
    expect((await getWorkspace(db, ws.id, "invitee_1"))?.id).toBe(ws.id);

    // single-use: a second accept fails even for the same person
    const again = await acceptWorkspaceInvitation(db, {
      token: inv.id,
      userId: "invitee_1",
      email: "invitee_1@example.com",
      nowMs: NOW + 2000,
    });
    expect(again.ok).toBe(false);
  });

  it("rejects a different email than the invitation was bound to", async () => {
    const ws = await freshWorkspace();
    const inv = await createWorkspaceInvitation(db, { workspaceId: ws.id, email: "invitee_1@example.com", inviterUserId: "owner_1", nowMs: NOW });

    const res = await acceptWorkspaceInvitation(db, { token: inv.id, userId: "wrong_1", email: "wrong_1@example.com", nowMs: NOW + 1000 });
    expect(res).toEqual({ ok: false, reason: "email_mismatch" });
    expect(await getWorkspace(db, ws.id, "wrong_1")).toBeNull();
  });

  it("rejects an expired invitation", async () => {
    const ws = await freshWorkspace();
    const inv = await createWorkspaceInvitation(db, { workspaceId: ws.id, email: "invitee_1@example.com", inviterUserId: "owner_1", nowMs: NOW });

    const res = await acceptWorkspaceInvitation(db, {
      token: inv.id,
      userId: "invitee_1",
      email: "invitee_1@example.com",
      nowMs: inv.expiresAt.getTime() + 1,
    });
    expect(res).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an unknown token", async () => {
    const res = await acceptWorkspaceInvitation(db, { token: "wi_nope", userId: "invitee_1", email: "invitee_1@example.com", nowMs: NOW });
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("a revoked invitation cannot be accepted and leaves the pending list", async () => {
    const ws = await freshWorkspace();
    const inv = await createWorkspaceInvitation(db, { workspaceId: ws.id, email: "invitee_1@example.com", inviterUserId: "owner_1", nowMs: NOW });
    expect((await listPendingInvitations(db, ws.id, NOW)).map((i) => i.id)).toContain(inv.id);

    expect(await revokeWorkspaceInvitation(db, { token: inv.id, workspaceId: ws.id })).toBe(true);
    expect(await listPendingInvitations(db, ws.id, NOW)).toHaveLength(0);

    const res = await acceptWorkspaceInvitation(db, { token: inv.id, userId: "invitee_1", email: "invitee_1@example.com", nowMs: NOW + 1000 });
    expect(res.ok).toBe(false);
  });

  it("the pending list excludes expired invitations", async () => {
    const ws = await freshWorkspace();
    const inv = await createWorkspaceInvitation(db, { workspaceId: ws.id, email: "invitee_1@example.com", inviterUserId: "owner_1", nowMs: NOW });
    expect(await listPendingInvitations(db, ws.id, inv.expiresAt.getTime() + 1)).toHaveLength(0);
  });
});
