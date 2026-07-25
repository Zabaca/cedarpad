import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import * as push from "./push-subscriptions.js";

/** In-memory DB built from the real migrations (mirrors conversations.test.ts). */
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

const sub = (endpoint: string) => ({
  endpoint: `https://push.example.com/${endpoint}`,
  keys: { p256dh: `p256_${endpoint}`, auth: `auth_${endpoint}` },
});

describe("push subscription store", () => {
  it("saves a device and lists it back for its user", async () => {
    await push.save(db, "user_save", sub("a"));
    const rows = await push.listForUser(db, "user_save");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: "https://push.example.com/a",
      userId: "user_save",
      p256dh: "p256_a",
      auth: "auth_a",
    });
  });

  it("keeps one row PER DEVICE — a user with two browsers gets two rows", async () => {
    await push.save(db, "user_multi", sub("laptop"));
    await push.save(db, "user_multi", sub("phone"));
    const rows = await push.listForUser(db, "user_multi");
    expect(rows.map((r) => r.endpoint).sort()).toEqual([
      "https://push.example.com/laptop",
      "https://push.example.com/phone",
    ]);
  });

  it("re-subscribing the same endpoint upserts instead of duplicating", async () => {
    await push.save(db, "user_upsert", sub("same"));
    await push.save(db, "user_upsert", {
      endpoint: "https://push.example.com/same",
      keys: { p256dh: "rotated", auth: "rotated-auth" },
    });
    const rows = await push.listForUser(db, "user_upsert");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.p256dh).toBe("rotated");
    expect(rows[0]?.auth).toBe("rotated-auth");
  });

  it("re-subscribing an endpoint under a different user reassigns it (shared device)", async () => {
    await push.save(db, "user_first", sub("shared"));
    await push.save(db, "user_second", sub("shared"));
    expect(await push.listForUser(db, "user_first")).toHaveLength(0);
    expect(await push.listForUser(db, "user_second")).toHaveLength(1);
  });

  it("scopes the list to the user — another user's devices are invisible", async () => {
    await push.save(db, "user_mine", sub("mine"));
    await push.save(db, "user_theirs", sub("theirs"));
    const rows = await push.listForUser(db, "user_mine");
    expect(rows.map((r) => r.endpoint)).toEqual(["https://push.example.com/mine"]);
  });

  it("removes a device by endpoint, and removing an unknown endpoint is a no-op", async () => {
    await push.save(db, "user_rm", sub("rm"));
    await push.remove(db, "user_rm", "https://push.example.com/rm");
    expect(await push.listForUser(db, "user_rm")).toHaveLength(0);
    await expect(push.remove(db, "user_rm", "https://push.example.com/never")).resolves.toBeUndefined();
  });

  it("remove is user-scoped — you cannot unsubscribe someone else's device", async () => {
    await push.save(db, "user_victim", sub("victim-phone"));
    await push.remove(db, "user_attacker", "https://push.example.com/victim-phone");
    expect(await push.listForUser(db, "user_victim")).toHaveLength(1);
  });
});
