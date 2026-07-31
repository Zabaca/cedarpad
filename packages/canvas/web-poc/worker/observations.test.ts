import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

/*
 * The Observation, its Source and its Origin (ADR-0024), asserted through the
 * ONE seam this package tests at: `buildApp({ db })` over a real D1 (workerd's
 * own, via Miniflare). Nothing here reads a row directly — every fact is
 * established and checked over HTTP.
 */

const WORKSPACE = "ws_obs";

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

const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  testDb = await createTestD1();
  db = testDb.db;
  app = buildApp({ db });
  await db.insert(schema.workspace).values({
    id: WORKSPACE,
    name: "Observations Workspace",
    slug: "observations-workspace",
  });
});

afterAll(() => testDb.dispose());

interface ObservationDetailBody {
  observation: {
    id: string;
    title: string;
    body: string;
    impact: string | null;
    origin: "human" | "agent";
    sourceId: string | null;
  };
  source: {
    id: string;
    kind: string;
    identifier: string | null;
    label: string | null;
    description: string | null;
  } | null;
}

describe("POST /v1/observations", () => {
  it("records a title, body and impact, and reads all of it back", async () => {
    const res = await post("/v1/observations", {
      title: "Checkout felt sluggish this morning",
      body: "Two people mentioned the spinner hanging before the card form appeared.",
      impact: "Customers abandon the cart",
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ObservationDetailBody;
    expect(created.observation.title).toBe("Checkout felt sluggish this morning");
    expect(created.observation.impact).toBe("Customers abandon the cart");
    expect(created.source).toBeNull();
    expect(created.observation.sourceId).toBeNull();

    const read = await req(`/v1/observations/${created.observation.id}`);
    expect(read.status).toBe(200);
    const fetched = (await read.json()) as ObservationDetailBody;
    expect(fetched.observation.body).toBe(
      "Two people mentioned the spinner hanging before the card form appeared.",
    );
    expect(fetched.observation.impact).toBe("Customers abandon the cart");
  });

  it("creates the Source in the same call and returns it", async () => {
    const res = await post("/v1/observations", {
      title: "They want the export as CSV",
      body: "Raised twice on the same call.",
      source: {
        kind: "call",
        identifier: "gcal_2026_07_30_acme",
        label: "Acme weekly sync",
      },
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as ObservationDetailBody;
    expect(created.source?.kind).toBe("call");
    expect(created.source?.identifier).toBe("gcal_2026_07_30_acme");
    expect(created.source?.label).toBe("Acme weekly sync");
    expect(created.observation.sourceId).toBe(created.source?.id);
  });

  it("accepts a Source with no identifier but a description, and refuses one with neither", async () => {
    const described = await post("/v1/observations", {
      title: "Someone at the meetup said onboarding is confusing",
      body: "No way to point at who or where — just the remark.",
      source: { kind: "person", description: "A stranger at the July meetup" },
    });
    expect(described.status).toBe(201);
    const ok = (await described.json()) as ObservationDetailBody;
    expect(ok.source?.identifier).toBeNull();
    expect(ok.source?.description).toBe("A stranger at the July meetup");

    const empty = await post("/v1/observations", {
      title: "Nothing to point at",
      body: "And nothing said about it either.",
      source: { kind: "document" },
    });
    expect(empty.status).toBe(400);
  });

  it("records `origin` as the caller's kind", async () => {
    // The dev-workspace header authenticates an agent (worker/middleware.ts).
    const res = await post("/v1/observations", {
      title: "Recorded during a run",
      body: "An agent noticed this while working.",
    });
    const created = (await res.json()) as ObservationDetailBody;
    expect(created.observation.origin).toBe("agent");
  });
});

describe("a Source and its Observations", () => {
  it("lets several Observations name one Source, and lists that Source's Observations", async () => {
    const first = (await (
      await post("/v1/observations", {
        title: "The report totals are wrong",
        body: "Off by one day at the month boundary.",
        source: { kind: "url", identifier: "https://example.test/report" },
      })
    ).json()) as ObservationDetailBody;
    const sourceId = first.source!.id;

    const second = (await (
      await post("/v1/observations", {
        title: "The same report is slow to load",
        body: "Twelve seconds on the same page.",
        sourceId,
      })
    ).json()) as ObservationDetailBody;
    expect(second.observation.sourceId).toBe(sourceId);
    expect(second.source?.id).toBe(sourceId);

    const listed = await req(`/v1/sources/${sourceId}/observations`);
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { items: { id: string }[]; total: number };
    expect(page.total).toBe(2);
    expect(page.items.map((i) => i.id).sort()).toEqual(
      [first.observation.id, second.observation.id].sort(),
    );
  });

  it("404s an unknown Source id on create", async () => {
    const res = await post("/v1/observations", {
      title: "Points at nothing",
      body: "The source id does not exist.",
      sourceId: "src_nope",
    });
    expect(res.status).toBe(404);
  });
});

describe("editing and removing an Observation", () => {
  it("updates a field and deletes the record", async () => {
    const created = (await (
      await post("/v1/observations", {
        title: "Draft wording",
        body: "To be corrected.",
      })
    ).json()) as ObservationDetailBody;
    const id = created.observation.id;

    const patched = await req(`/v1/observations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Corrected wording" }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as ObservationDetailBody).observation.title).toBe(
      "Corrected wording",
    );

    const deleted = await req(`/v1/observations/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await req(`/v1/observations/${id}`)).status).toBe(404);
  });
});

describe("the LLM pipeline routes are gone", () => {
  it("404s synthesize and both reprocess endpoints", async () => {
    const created = (await (
      await post("/v1/observations", { title: "Still here", body: "The store works." })
    ).json()) as ObservationDetailBody;

    expect((await post("/v1/problems/synthesize", { observationIds: ["x"] })).status).toBe(404);
    expect((await post(`/v1/observations/${created.observation.id}/reprocess`, {})).status).toBe(
      404,
    );
    expect((await post("/v1/problems/prob_any/reprocess", {})).status).toBe(404);
  });
});
