import { type Database, schema } from "../lib/db/index.js";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

/*
 * Problems, and the Observations that feed them (ADR-0024), asserted through the
 * ONE seam this package tests at: `buildApp({ db })` over a real D1 (workerd's
 * own, via Miniflare). Nothing here reads a row directly — every fact is
 * established and checked over HTTP.
 */

const WORKSPACE = "ws_prob";

const env = {
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
  BETTER_AUTH_URL: "http://localhost:8787",
  DEV_AUTH_WORKSPACE: WORKSPACE,
} as Record<string, string>;

let testDb: TestD1;
let db: Database;
let app: ReturnType<typeof buildApp>;

async function req(path: string, init: RequestInit = {}) {
  return app.request(
    path,
    {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-dev-workspace": WORKSPACE,
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
    name: "Problems Workspace",
    slug: "problems-workspace",
  });
});

afterAll(() => testDb.dispose());

interface ProblemDetailBody {
  problem: {
    id: string;
    title: string;
    body: string;
    impact: string | null;
    priority: number;
    urgency: "low" | "medium" | "high" | "critical";
    solutionDirection: string | null;
    status: "open" | "investigating" | "resolved" | "archived";
  };
  observations: { id: string; title: string; relevance: number | null; rationale: string | null }[];
}

interface ObservationDetailBody {
  observation: { id: string; title: string };
  problems: { id: string; title: string; relevance: number | null; rationale: string | null }[];
}

/** Record a bare observation and hand back its id. */
async function newObservation(title: string, body = "Something worth noting."): Promise<string> {
  const res = await post("/v1/observations", { title, body });
  return ((await res.json()) as ObservationDetailBody).observation.id;
}

async function newProblem(fields: Record<string, unknown>): Promise<ProblemDetailBody> {
  const res = await post("/v1/problems", fields);
  expect(res.status).toBe(201);
  return (await res.json()) as ProblemDetailBody;
}

describe("a Problem's life cycle", () => {
  it("records impact, priority, urgency, solution direction and status, and reads them back", async () => {
    const created = await newProblem({
      title: "Checkout 500s under load",
      body: "Intermittent 500s during checkout above roughly 200 concurrent carts.",
      impact: "Customers cannot pay",
      priority: 42,
      urgency: "critical",
      solutionDirection: "Isolate the payment call behind a queue before touching the schema",
    });
    expect(created.problem.impact).toBe("Customers cannot pay");
    expect(created.problem.priority).toBe(42);
    expect(created.problem.urgency).toBe("critical");
    expect(created.problem.solutionDirection).toBe(
      "Isolate the payment call behind a queue before touching the schema",
    );
    expect(created.problem.status).toBe("open");

    const read = await req(`/v1/problems/${created.problem.id}`);
    expect(read.status).toBe(200);
    const fetched = (await read.json()) as ProblemDetailBody;
    expect(fetched.problem.body).toBe(
      "Intermittent 500s during checkout above roughly 200 concurrent carts.",
    );
    expect(fetched.problem.solutionDirection).toBe(created.problem.solutionDirection);
  });

  it("edits a Problem's fields and then deletes it", async () => {
    const created = await newProblem({ title: "Draft problem", body: "To be corrected." });
    const id = created.problem.id;

    const patched = await req(`/v1/problems/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Corrected problem", status: "investigating", urgency: "high" }),
    });
    expect(patched.status).toBe(200);
    const updated = (await patched.json()) as ProblemDetailBody;
    expect(updated.problem.title).toBe("Corrected problem");
    expect(updated.problem.status).toBe("investigating");
    expect(updated.problem.urgency).toBe("high");

    const deleted = await req(`/v1/problems/${id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect((await req(`/v1/problems/${id}`)).status).toBe(404);
  });

  it("404s a delete of a Problem that is not there", async () => {
    expect((await req("/v1/problems/prob_nope", { method: "DELETE" })).status).toBe(404);
  });
});

interface EdgeBody {
  observationId: string;
  problemId: string;
  relevance: number | null;
  rationale: string | null;
  createdBy: "human" | "agent";
}

describe("tying an Observation to a Problem", () => {
  it("carries relevance, rationale and who drew the tie", async () => {
    const obs = await newObservation("The spinner hangs before the card form");
    const problem = await newProblem({
      title: "Checkout is slow above 200 carts",
      body: "The payment call blocks the render.",
    });

    const res = await post(`/v1/problems/${problem.problem.id}/observations`, {
      observationId: obs,
      relevance: 0.9,
      rationale: "Same symptom, same code path",
    });
    expect(res.status).toBe(201);
    const edge = (await res.json()) as EdgeBody;
    expect(edge.observationId).toBe(obs);
    expect(edge.problemId).toBe(problem.problem.id);
    expect(edge.relevance).toBe(0.9);
    expect(edge.rationale).toBe("Same symptom, same code path");
    // The dev-workspace header authenticates an agent (worker/middleware.ts).
    expect(edge.createdBy).toBe("agent");
  });

  it("404s an unknown Observation and an unknown Problem", async () => {
    const problem = await newProblem({ title: "Real problem", body: "Exists." });
    const obs = await newObservation("Real observation");

    expect(
      (await post(`/v1/problems/${problem.problem.id}/observations`, { observationId: "obs_nope" }))
        .status,
    ).toBe(404);
    expect(
      (await post("/v1/problems/prob_nope/observations", { observationId: obs })).status,
    ).toBe(404);
  });
});

describe("listing Problems", () => {
  it("pages priority-then-recency and carries identifiers, titles, status and priority — no bodies", async () => {
    const TAG = "listing-slice";
    const low = await newProblem({
      title: "Low priority",
      body: "A body nobody should get from a list.",
      priority: 1,
      projectTags: [TAG],
    });
    const middle = await newProblem({
      title: "Middle priority, older",
      body: "Another body.",
      priority: 5,
      projectTags: [TAG],
    });
    // `created_at` is whole seconds, so the two equal-priority problems have to
    // be more than a second apart for "then recency" to mean anything.
    await new Promise((r) => setTimeout(r, 1100));
    const newestOfTheTie = await newProblem({
      title: "Middle priority, newer",
      body: "Another body still.",
      priority: 5,
      projectTags: [TAG],
    });
    const high = await newProblem({
      title: "High priority",
      body: "The last body.",
      priority: 9,
      projectTags: [TAG],
    });

    const firstPage = (await (
      await req(`/v1/problems?tag=${TAG}&limit=2`)
    ).json()) as { items: Record<string, unknown>[]; total: number };
    expect(firstPage.total).toBe(4);
    // Priority first; within equal priority, the newer one wins.
    expect(firstPage.items.map((p) => p.id)).toEqual([
      high.problem.id,
      newestOfTheTie.problem.id,
    ]);

    const secondPage = (await (
      await req(`/v1/problems?tag=${TAG}&limit=2&offset=2`)
    ).json()) as { items: Record<string, unknown>[]; total: number };
    expect(secondPage.items.map((p) => p.id)).toEqual([middle.problem.id, low.problem.id]);

    const summary = firstPage.items[0]!;
    expect(summary).toMatchObject({
      id: high.problem.id,
      title: "High priority",
      status: "open",
      priority: 9,
    });
    // The read that returns everything is the one that blows an agent's context
    // window, so a list carries no bodies — nor anything else long-form.
    expect(Object.keys(summary).sort()).toEqual([
      "createdAt",
      "id",
      "priority",
      "status",
      "title",
      "urgency",
      "workspaceId",
    ]);
  });
});

describe("the tie is many-to-many, and reads from both ends", () => {
  it("lets one Observation feed several Problems and one Problem draw on several Observations", async () => {
    const slowSpinner = await newObservation("The spinner hangs for twelve seconds");
    const cardRejected = await newObservation("The card form rejected a valid Amex");

    const slowCheckout = await newProblem({ title: "Checkout is slow", body: "Latency." });
    const lostRevenue = await newProblem({ title: "Carts are abandoned", body: "Revenue." });

    // slowSpinner feeds BOTH problems; lostRevenue also draws on cardRejected.
    await post(`/v1/problems/${slowCheckout.problem.id}/observations`, {
      observationId: slowSpinner,
      relevance: 0.8,
      rationale: "Directly measures the latency",
    });
    await post(`/v1/problems/${lostRevenue.problem.id}/observations`, {
      observationId: slowSpinner,
    });
    await post(`/v1/problems/${lostRevenue.problem.id}/observations`, {
      observationId: cardRejected,
      rationale: "A second reason people give up",
    });

    const problem = (await (
      await req(`/v1/problems/${lostRevenue.problem.id}`)
    ).json()) as ProblemDetailBody;
    expect(problem.observations.map((o) => o.id).sort()).toEqual(
      [slowSpinner, cardRejected].sort(),
    );
    expect(problem.observations.find((o) => o.id === cardRejected)?.rationale).toBe(
      "A second reason people give up",
    );

    const observation = (await (
      await req(`/v1/observations/${slowSpinner}`)
    ).json()) as ObservationDetailBody;
    expect(observation.problems.map((p) => p.id).sort()).toEqual(
      [slowCheckout.problem.id, lostRevenue.problem.id].sort(),
    );
    expect(observation.problems.find((p) => p.id === slowCheckout.problem.id)?.relevance).toBe(0.8);
  });
});

describe("removing ties and Problems", () => {
  it("unties an edge and leaves both ends standing", async () => {
    const obs = await newObservation("Worth keeping either way");
    const problem = await newProblem({ title: "Also worth keeping", body: "Stays." });
    await post(`/v1/problems/${problem.problem.id}/observations`, { observationId: obs });

    const untied = await req(`/v1/problems/${problem.problem.id}/observations/${obs}`, {
      method: "DELETE",
    });
    expect(untied.status).toBe(200);

    const after = (await (
      await req(`/v1/problems/${problem.problem.id}`)
    ).json()) as ProblemDetailBody;
    expect(after.observations).toEqual([]);
    expect((await req(`/v1/observations/${obs}`)).status).toBe(200);

    // Untying what is not tied is a 404, not a silent success.
    expect(
      (await req(`/v1/problems/${problem.problem.id}/observations/${obs}`, { method: "DELETE" }))
        .status,
    ).toBe(404);
  });

  it("drops a deleted Problem's ties and leaves its Observations intact", async () => {
    const obs = await newObservation("Outlives the problem it fed");
    const doomed = await newProblem({ title: "Doomed problem", body: "Will be deleted." });
    const survivor = await newProblem({ title: "Surviving problem", body: "Stays." });
    await post(`/v1/problems/${doomed.problem.id}/observations`, { observationId: obs });
    await post(`/v1/problems/${survivor.problem.id}/observations`, { observationId: obs });

    expect((await req(`/v1/problems/${doomed.problem.id}`, { method: "DELETE" })).status).toBe(200);

    const observation = (await (await req(`/v1/observations/${obs}`)).json()) as ObservationDetailBody;
    expect(observation.observation.id).toBe(obs);
    expect(observation.problems.map((p) => p.id)).toEqual([survivor.problem.id]);
  });
});
