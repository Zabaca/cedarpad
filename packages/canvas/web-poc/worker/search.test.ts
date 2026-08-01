import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

/*
 * Search on D1's native FTS5 (ADR-0024), asserted through the ONE seam this
 * package tests at: `buildApp({ db })` over a real D1 (workerd's own, via
 * Miniflare). Nothing here reads the index directly — every fact about what is
 * indexed is established by writing over HTTP and searching over HTTP.
 */

const WORKSPACE = "ws_search";
const OTHER = "ws_search_other";

const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  BETTER_AUTH_URL: "http://localhost:8787",
  DEV_AUTH_WORKSPACE: WORKSPACE,
} as Record<string, string>;

let testDb: TestD1;
let db: Database;
let app: ReturnType<typeof buildApp>;

async function req(path: string, init: RequestInit = {}, workspace = WORKSPACE) {
  return app.request(
    path,
    {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-dev-workspace": workspace,
        ...(init.headers ?? {}),
      },
    },
    env,
  );
}

const post = (path: string, body: unknown, workspace = WORKSPACE) =>
  req(path, { method: "POST", body: JSON.stringify(body) }, workspace);

interface SearchResult {
  id: string;
  kind: "observation" | "problem";
  title: string;
  snippet: string;
}
interface SearchPage {
  items: SearchResult[];
  total: number;
}

const search = async (query: string, workspace = WORKSPACE): Promise<SearchPage> => {
  const res = await req(`/v1/search?${query}`, {}, workspace);
  expect(res.status).toBe(200);
  return (await res.json()) as SearchPage;
};

const observation = async (body: Record<string, unknown>, workspace = WORKSPACE) => {
  const res = await post("/v1/observations", body, workspace);
  expect(res.status).toBe(201);
  return ((await res.json()) as { observation: { id: string } }).observation.id;
};

const problem = async (body: Record<string, unknown>, workspace = WORKSPACE) => {
  const res = await post("/v1/problems", body, workspace);
  expect(res.status).toBe(201);
  return ((await res.json()) as { problem: { id: string } }).problem.id;
};

beforeAll(async () => {
  testDb = await createTestD1();
  db = testDb.db;
  app = buildApp({ db });
  await db.insert(schema.workspace).values([
    { id: WORKSPACE, name: "Search Workspace", slug: "search-workspace" },
    { id: OTHER, name: "Other Workspace", slug: "other-workspace" },
  ]);
});

afterAll(() => testDb.dispose());

describe("GET /v1/search", () => {
  it("returns an empty page over an empty corpus", async () => {
    const page = await search("q=nothing-has-been-written-yet");
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it("finds Observations and Problems in one ranked result set, each with a snippet", async () => {
    const obsId = await observation({
      title: "The CSV export times out",
      body: "A customer waited ninety seconds for an export of last quarter and gave up.",
    });
    const probId = await problem({
      title: "Exports are unusable at scale",
      body: "Export jobs run inline on the request thread, so large exports time out.",
      impact: "Enterprise accounts cannot get their data out",
    });
    await observation({
      title: "The onboarding video autoplays",
      body: "Unrelated to anything about reports.",
    });

    const page = await search("q=export");

    expect(page.total).toBe(2);
    const byId = new Map(page.items.map((i) => [i.id, i]));
    expect(byId.get(obsId)?.kind).toBe("observation");
    expect(byId.get(probId)?.kind).toBe("problem");
    expect(byId.get(obsId)?.title).toBe("The CSV export times out");

    // A snippet, not the body: it marks the match and is shorter than what was stored.
    const snippet = byId.get(probId)!.snippet;
    expect(snippet).toMatch(/export/i);
    expect(snippet).not.toBe(
      "Export jobs run inline on the request thread, so large exports time out.",
    );
  });

  it("ranks the record that is most about the query first", async () => {
    await observation({
      title: "Notes from the pricing call",
      body: "We talked about the roadmap, the team, and briefly about invoices.",
    });
    await observation({
      title: "Invoices are wrong",
      body: "The invoice total, the invoice date and the invoice tax line are all wrong.",
    });

    const page = await search("q=invoice");
    expect(page.items.length).toBeGreaterThanOrEqual(2);
    expect(page.items[0]?.title).toBe("Invoices are wrong");
  });

  it("pages through the hits under one total", async () => {
    for (const n of ["one", "two", "three"]) {
      await observation({ title: `Pagination ${n}`, body: `A record about zeppelins, ${n}.` });
    }

    const first = await search("q=zeppelins&limit=2");
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);

    const second = await search("q=zeppelins&limit=2&offset=2");
    expect(second.total).toBe(3);
    expect(second.items).toHaveLength(1);

    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("reflects a create, an edit and a delete immediately", async () => {
    const id = await observation({
      title: "A draft",
      body: "Everything here is about badgers.",
    });
    expect((await search("q=badgers")).total).toBe(1);

    const patched = await req(`/v1/observations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ body: "Rewritten: it was really about otters." }),
    });
    expect(patched.status).toBe(200);
    expect((await search("q=badgers")).total).toBe(0);
    expect((await search("q=otters")).total).toBe(1);

    const deleted = await req(`/v1/observations/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await search("q=otters")).total).toBe(0);
  });

  it("never returns another workspace's records", async () => {
    await observation(
      { title: "Kept next door", body: "A secret about marmots." },
      OTHER,
    );

    expect((await search("q=marmots", OTHER)).total).toBe(1);
    expect((await search("q=marmots")).items).toEqual([]);
  });

  it("treats FTS5 syntax characters as text, not as a match expression", async () => {
    await observation({
      title: "Quoted trouble",
      body: 'The user typed AND OR NEAR( into the box and it exploded.',
    });

    // Every one of these is valid FTS5 grammar that would error or mean
    // something else if it reached the match expression unescaped.
    for (const q of ['"', 'AND', 'exploded AND', 'NEAR(', 'box*:', '^ - "unclosed']) {
      const res = await req(`/v1/search?q=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
    }

    // …and the words still match as words.
    expect((await search(`q=${encodeURIComponent('"exploded"')}`)).total).toBe(1);
    expect((await search("q=" + encodeURIComponent("*"))).items).toEqual([]);
  });
});
