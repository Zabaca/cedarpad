import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1, type TestD1 } from "../lib/db/test-d1.js";
import { buildNotebookTools } from "./notebook-tools.js";

/**
 * The Notebook's MCP surface (CEDA-X6OIAO / ADR-0024), driven at its seam:
 * `buildNotebookTools` is what every surface (edge MCP, platform RPC, the container's own
 * tool defs) wraps, so this is the one place the behaviour is asserted.
 *
 * Real D1 (CEDA-5U8J2H), because FTS5 is what search runs on in production.
 */

let testDb: TestD1;
/** The tools as an agent in workspace A holds them. */
let tools: ReturnType<typeof buildNotebookTools>;
/** The same tools as a DIFFERENT workspace's caller — the isolation counterpart. */
let other: ReturnType<typeof buildNotebookTools>;

beforeAll(async () => {
  testDb = await createTestD1();
  tools = buildNotebookTools({ db: testDb.db, workspaceId: "wsA", userId: "user_1", origin: "agent" });
  other = buildNotebookTools({ db: testDb.db, workspaceId: "wsB", userId: "user_2", origin: "agent" });
});

afterAll(() => testDb.dispose());

describe("record_observation", () => {
  it("records an observation and creates the Source it names, in one call", async () => {
    const recorded = await tools.recordObservation({
      title: "Checkout felt sluggish this morning",
      body: "Two customers on the 9am call said the payment step hangs for ~8s.",
      impact: "Customers abandon at payment",
      source: { kind: "call", identifier: "call_0912", label: "Weekly sync" },
      project_tags: ["Acme"],
    });

    expect(recorded.id).toMatch(/^obs_/);
    expect(recorded.source).toMatchObject({ kind: "call", identifier: "call_0912", label: "Weekly sync" });

    // Read it back through the interface, never the table.
    const read = await tools.readObservation({ id: recorded.id });
    expect(read.observation).toMatchObject({
      title: "Checkout felt sluggish this morning",
      body: "Two customers on the 9am call said the payment step hangs for ~8s.",
      impact: "Customers abandon at payment",
      workspaceId: "wsA",
      // The caller is an agent; `origin` records who produced it (ADR-0024).
      origin: "agent",
      projectTags: ["Acme"],
    });
    expect(read.source?.identifier).toBe("call_0912");
  });

  it("records an observation with no source at all", async () => {
    const recorded = await tools.recordObservation({ title: "A thought", body: "No source to point at." });
    expect(recorded.source).toBeNull();
    expect((await tools.readObservation({ id: recorded.id })).source).toBeNull();
  });

  it("refuses a source_id from another workspace", async () => {
    const mine = await tools.recordObservation({
      title: "Mine",
      body: "with a source",
      source: { kind: "url", identifier: "https://example.com/a" },
    });
    await expect(
      other.recordObservation({ title: "Theirs", body: "borrowing", source_id: mine.source!.id }),
    ).rejects.toThrow(/not found/i);
  });
});

describe("update_observation", () => {
  it("edits an observation the caller recorded", async () => {
    const { id } = await tools.recordObservation({ title: "Draft", body: "first pass" });
    const updated = await tools.updateObservation({ id, body: "second pass", status: "archived" });
    expect(updated.observation).toMatchObject({ title: "Draft", body: "second pass", status: "archived" });
  });

  it("refuses an unknown id rather than reporting an empty success", async () => {
    await expect(tools.updateObservation({ id: "obs_nope", body: "x" })).rejects.toThrow(
      /observation not found in this workspace: obs_nope/,
    );
    await expect(tools.readObservation({ id: "obs_nope" })).rejects.toThrow(/not found/);
  });

  it("refuses another workspace's observation — read and write alike", async () => {
    const { id } = await tools.recordObservation({ title: "wsA only", body: "private" });
    await expect(other.readObservation({ id })).rejects.toThrow(/not found/);
    await expect(other.updateObservation({ id, body: "tampered" })).rejects.toThrow(/not found/);
    // ...and the record is untouched.
    expect((await tools.readObservation({ id })).observation.body).toBe("private");
  });
});

describe("problems, their observations, their links and their solutions", () => {
  it("creates a problem, ties an observation, links a second problem and records a solution", async () => {
    const obs = await tools.recordObservation({
      title: "Payment step hangs",
      body: "Reported on the 9am call",
    });
    const prob = await tools.createProblem({
      title: "Checkout 500s under load",
      body: "Intermittent 500s during checkout above ~200 rps.",
      urgency: "high",
      impact: "Lost revenue at peak",
    });
    expect(prob.id).toMatch(/^prob_/);

    await tools.tieObservation({
      problem_id: prob.id,
      observation_id: obs.id,
      relevance: 0.9,
      rationale: "Same symptom, same hour",
    });
    const related = await tools.createProblem({ title: "Connection pool exhausted", body: "Pool caps at 10." });
    await tools.linkProblems({
      from_problem_id: prob.id,
      to_problem_id: related.id,
      kind: "partial",
      rationale: "The pool is one cause of the 500s",
    });
    await tools.recordSolution({ target_kind: "problem", target_id: prob.id, body: "Raise the pool to 50 and queue." });

    const detail = await tools.readProblem({ id: prob.id });
    // `urgency: high` seeds priority 20 (contract's URGENCY_PRIORITY).
    expect(detail.problem).toMatchObject({ title: "Checkout 500s under load", urgency: "high", priority: 20, origin: "agent" });
    expect(detail.observations).toEqual([
      { id: obs.id, title: "Payment step hangs", relevance: 0.9, rationale: "Same symptom, same hour", createdBy: "agent" },
    ]);
    expect(detail.links.map((l) => [l.problem.id, l.link.kind])).toEqual([[related.id, "partial"]]);
    expect(detail.solutions.map((s) => s.body)).toEqual(["Raise the pool to 50 and queue."]);

    // The tie is visible from the observation's side too.
    expect((await tools.readObservation({ id: obs.id })).problems.map((p) => p.id)).toEqual([prob.id]);
  });

  it("refuses to tie, link or solve across a workspace boundary, or against an unknown id", async () => {
    const mine = await tools.createProblem({ title: "Mine", body: "in wsA" });
    const theirs = await other.createProblem({ title: "Theirs", body: "in wsB" });
    const obs = await tools.recordObservation({ title: "Mine", body: "in wsA" });

    await expect(other.tieObservation({ problem_id: theirs.id, observation_id: obs.id })).rejects.toThrow(/not found/);
    await expect(tools.linkProblems({ from_problem_id: mine.id, to_problem_id: theirs.id, kind: "related" })).rejects.toThrow(
      /not found/,
    );
    await expect(tools.recordSolution({ target_kind: "problem", target_id: theirs.id, body: "x" })).rejects.toThrow(
      /not found/,
    );
    await expect(tools.recordSolution({ target_kind: "observation", target_id: "obs_nope", body: "x" })).rejects.toThrow(
      /not found/,
    );
    await expect(tools.readProblem({ id: theirs.id })).rejects.toThrow(/not found/);
  });
});

describe("search", () => {
  /** Its own workspace, so the corpus under test is exactly what this block wrote. */
  let ws: ReturnType<typeof buildNotebookTools>;

  beforeAll(async () => {
    ws = buildNotebookTools({ db: testDb.db, workspaceId: "wsSearch", userId: "user_1", origin: "agent" });
    await ws.recordObservation({ title: "Zephyr latency", body: "The zephyr endpoint took 8 seconds." });
    await ws.createProblem({ title: "Zephyr timeouts", body: "Zephyr calls exceed the gateway timeout." });
    await ws.recordObservation({ title: "Unrelated", body: "Nothing to do with it." });
  });

  it("returns ranked hits — identifiers, a title and a snippet, never bodies", async () => {
    const page = await ws.search({ q: "zephyr" });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((i) => i.kind).sort()).toEqual(["observation", "problem"]);
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(["id", "kind", "snippet", "title"]);
      expect(item.snippet).toMatch(/\[/); // the matched term is marked
    }
  });

  it("paginates", async () => {
    const first = await ws.search({ q: "zephyr", limit: 1 });
    const second = await ws.search({ q: "zephyr", limit: 1, offset: 1 });
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(first.total).toBe(2);
    expect(first.items[0]!.id).not.toBe(second.items[0]!.id);
  });

  it("treats FTS5 syntax as text, and never crosses a workspace", async () => {
    // `*` is an FTS5 prefix operator; quoted, it is just a character in the term.
    expect((await ws.search({ q: "zephyr*" })).total).toBe(2);
    // `AND` is an FTS5 operator; searched as text it matches nothing, rather than
    // combining "zephyr" with an empty right-hand side (which is a syntax error).
    expect((await ws.search({ q: "zephyr AND" })).total).toBe(0);
    expect((await other.search({ q: "zephyr" })).total).toBe(0);
  });
});

describe("list_problems", () => {
  let ws: ReturnType<typeof buildNotebookTools>;

  beforeAll(async () => {
    ws = buildNotebookTools({ db: testDb.db, workspaceId: "wsList", userId: "user_1", origin: "agent" });
    await ws.createProblem({ title: "Low one", body: "body one", urgency: "low" });
    await ws.createProblem({ title: "Critical one", body: "body two", urgency: "critical" });
    await ws.createProblem({ title: "Medium one", body: "body three", urgency: "medium", project_tags: ["Acme"] });
  });

  it("lists identifiers and one line, highest priority first — never bodies", async () => {
    const page = await ws.listProblems({});
    expect(page.total).toBe(3);
    expect(page.items.map((p) => p.title)).toEqual(["Critical one", "Medium one", "Low one"]);
    expect(Object.keys(page.items[0]!).sort()).toEqual([
      "createdAt",
      "id",
      "priority",
      "status",
      "title",
      "urgency",
    ]);
  });

  it("paginates and filters, and shows nothing from another workspace", async () => {
    expect((await ws.listProblems({ limit: 1, offset: 1 })).items.map((p) => p.title)).toEqual(["Medium one"]);
    expect((await ws.listProblems({ tag: "Acme" })).items.map((p) => p.title)).toEqual(["Medium one"]);
    expect((await ws.listProblems({ status: "resolved" })).total).toBe(0);
    expect((await other.listProblems({})).items.map((p) => p.title)).not.toContain("Critical one");
  });
});
