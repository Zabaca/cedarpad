import { describe, expect, it } from "vitest";
import { CreateObservationSchema, CreateSourceSchema } from "./schemas.js";
import { routes } from "./routes.js";

describe("CreateObservationSchema", () => {
  it("accepts a title and body with no source", () => {
    const parsed = CreateObservationSchema.parse({ title: "t", body: "b" });
    expect(parsed.source).toBeUndefined();
    expect(parsed.sourceId).toBeUndefined();
  });

  it("rejects an empty title", () => {
    expect(CreateObservationSchema.safeParse({ title: "", body: "b" }).success).toBe(false);
  });
});

describe("CreateSourceSchema", () => {
  it("needs an identifier or a description", () => {
    expect(CreateSourceSchema.safeParse({ kind: "url", identifier: "https://x" }).success).toBe(true);
    expect(CreateSourceSchema.safeParse({ kind: "person", description: "a stranger" }).success).toBe(true);
    expect(CreateSourceSchema.safeParse({ kind: "document" }).success).toBe(false);
  });
});

describe("routes", () => {
  it("exposes the expected method+path for each endpoint", () => {
    expect(routes.createProblem.method).toBe("post");
    expect(routes.createProblem.path).toBe("/v1/problems");
    expect(routes.getProblem.path).toBe("/v1/problems/{id}");
    expect(routes.createObservation.path).toBe("/v1/observations");
    expect(routes.deleteObservation.method).toBe("delete");
    expect(routes.listSourceObservations.path).toBe("/v1/sources/{id}/observations");
    expect(routes.getGraph.path).toBe("/v1/graph");
  });
});
