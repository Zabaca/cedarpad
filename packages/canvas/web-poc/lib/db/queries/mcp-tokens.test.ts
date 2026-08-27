import { createClient } from "@libsql/client";
import { migrationStatements } from "../test-d1.js";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import * as schema from "../schema.js";
import { clearToken, listTokens, setToken } from "./mcp-tokens.js";

const client = createClient({ url: ":memory:" });
const db = drizzle(client, { schema });

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
});

describe("workspace MCP tokens — set/clear/list round-trip", () => {
  it("set then list returns the connected server", async () => {
    await setToken(db, "ws_1", "ledgerbot", "tok_a");
    expect(await listTokens(db, "ws_1")).toEqual({ ledgerbot: "tok_a" });
  });

  it("set again replaces the token (no duplicate row)", async () => {
    await setToken(db, "ws_2", "ledgerbot", "tok_old");
    await setToken(db, "ws_2", "ledgerbot", "tok_new");
    expect(await listTokens(db, "ws_2")).toEqual({ ledgerbot: "tok_new" });
  });

  it("clear removes the token — an unconnected workspace lists empty", async () => {
    await setToken(db, "ws_3", "ledgerbot", "tok_c");
    await clearToken(db, "ws_3", "ledgerbot");
    expect(await listTokens(db, "ws_3")).toEqual({});
  });

  it("clearing an already-unset token is a no-op (never throws)", async () => {
    await expect(clearToken(db, "ws_4", "ledgerbot")).resolves.toBeUndefined();
  });

  it("a workspace with no connected servers lists empty", async () => {
    expect(await listTokens(db, "ws_never_connected")).toEqual({});
  });

  it("two workspaces are isolated — one's token never leaks into the other's list", async () => {
    await setToken(db, "ws_5a", "ledgerbot", "tok_5a");
    expect(await listTokens(db, "ws_5b")).toEqual({});
  });
});
