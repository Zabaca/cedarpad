import { describe, expect, it } from "vitest";
import { CreateProblemSchema } from "./schemas.js";
import { routes } from "./routes.js";

describe("CreateProblemSchema", () => {
  it("defaults runAgent to true", () => {
    const parsed = CreateProblemSchema.parse({
      title: "t",
      body: "b",
    });
    expect(parsed.runAgent).toBe(true);
  });

  it("rejects empty title", () => {
    const result = CreateProblemSchema.safeParse({ title: "", body: "b" });
    expect(result.success).toBe(false);
  });
});

describe("routes", () => {
  it("exposes the expected method+path for each endpoint", () => {
    expect(routes.createProblem.method).toBe("post");
    expect(routes.createProblem.path).toBe("/v1/problems");
    expect(routes.getProblem.path).toBe("/v1/problems/{id}");
    expect(routes.createObservation.path).toBe("/v1/observations");
    expect(routes.synthesizeProblem.path).toBe("/v1/problems/synthesize");
    expect(routes.getGraph.path).toBe("/v1/graph");
  });
});
