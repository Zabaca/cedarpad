import { beforeEach, describe, expect, it, vi } from "vitest";
import spec from "../openapi.json" with { type: "json" };

type Recorded = { method: string; url: string };
let calls: Recorded[] = [];

// Both of these must be in place before `api.js` loads: the client reads
// `VITE_API_URL` once at module scope (empty in the browser — relative and
// same-origin — which `fetch` has no origin to resolve here), and openapi-fetch
// captures `globalThis.fetch` when the client is constructed.
vi.stubEnv("VITE_API_URL", "http://notebook.test");
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  calls.push({ method: req.method.toLowerCase(), url: req.url });
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { api } = await import("./api.js");

/**
 * Every control on the read surface reaches the API through `api`, so this is
 * where "no control calls a route that no longer exists" is checkable: drive
 * each method with a stub fetch, record the request it makes, and hold it
 * against `openapi.json` — which is emitted from the server's registered
 * routes, not written here.
 */

const paths = (spec as { paths: Record<string, Record<string, unknown>> }).paths;

/** `/v1/problems/{id}/links` → a matcher for a concrete request path. */
function matchPath(pathname: string): string | undefined {
  return Object.keys(paths).find((template) =>
    new RegExp(`^${template.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(pathname),
  );
}

beforeEach(() => {
  calls = [];
});

/** Run a client call and return the request it made. The stub's `{}` body fails
 * the response schema for most routes; the request is what's under test. */
async function record(call: () => Promise<unknown>): Promise<Recorded> {
  await call().catch(() => undefined);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

const CALLS: [name: string, run: () => Promise<unknown>][] = [
  ["listObservations", () => api.listObservations({ q: "cache" })],
  ["getObservation", () => api.getObservation("obs_1")],
  ["updateObservation", () => api.updateObservation("obs_1", { title: "t" })],
  ["deleteObservation", () => api.deleteObservation("obs_1")],
  ["listSourceObservations", () => api.listSourceObservations("src_1")],
  ["listProblems", () => api.listProblems({})],
  ["getProblem", () => api.getProblem("prob_1")],
  ["updateProblem", () => api.updateProblem("prob_1", { title: "t" })],
  ["deleteProblem", () => api.deleteProblem("prob_1")],
  ["listItems", () => api.listItems({})],
  ["search", () => api.search({ q: "cache" })],
  ["listSolutions", () => api.listSolutions("problem", "prob_1")],
  ["createSolution", () => api.createSolution({ targetKind: "problem", targetId: "prob_1", body: "b" })],
  ["updateSolution", () => api.updateSolution("sol_1", { status: "accepted" })],
  ["getGraph", () => api.getGraph()],
  ["getNeighborhood", () => api.getNeighborhood("prob_1")],
  ["getProblemContext", () => api.getProblemContext("prob_1")],
  ["listWorkspaces", () => api.listWorkspaces()],
  ["activateWorkspace", () => api.activateWorkspace("ws_1")],
  ["listApiKeys", () => api.listApiKeys()],
  ["revokeApiKey", () => api.revokeApiKey("key_1")],
];

describe("api client", () => {
  it("exposes exactly the methods under test", () => {
    expect(Object.keys(api).sort()).toEqual(CALLS.map(([name]) => name).sort());
  });

  it.each(CALLS)("%s calls a route the API still serves", async (_name, run) => {
    const { method, url } = await record(run);
    const template = matchPath(new URL(url).pathname);
    expect(template, `${url} matches no path in openapi.json`).toBeDefined();
    expect(Object.keys(paths[template!]!)).toContain(method);
  });

  it("searches through the FTS5 route", async () => {
    const { url } = await record(() => api.search({ q: "checkout is slow", limit: 10, offset: 20 }));
    const u = new URL(url);
    expect(u.pathname).toBe("/v1/search");
    expect(u.searchParams.get("q")).toBe("checkout is slow");
    expect(u.searchParams.get("limit")).toBe("10");
    expect(u.searchParams.get("offset")).toBe("20");
  });
});
