import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOC_CONFIG, buildApp } from "./index.js";

/**
 * Drift gate: the committed `openapi.json` must match the document generated
 * from the contract. If this fails, the spec is stale — run `bun run openapi:emit`
 * (and regenerate the web client with `bun --filter @cedarpad/web gen:api`).
 */
const SPEC = join(dirname(fileURLToPath(import.meta.url)), "../../../openapi.json");

describe("openapi.json", () => {
  it("is in sync with the contract (run `bun run openapi:emit` to refresh)", () => {
    expect(existsSync(SPEC), `${SPEC} missing — run bun run openapi:emit`).toBe(true);
    const committed = JSON.parse(readFileSync(SPEC, "utf8"));
    const generated = buildApp().getOpenAPIDocument(DOC_CONFIG);
    expect(committed).toEqual(generated);
  });

  it("declares the auth security schemes", () => {
    const doc = buildApp().getOpenAPIDocument(DOC_CONFIG);
    expect(doc.components?.securitySchemes).toMatchObject({
      ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      DevWorkspace: { type: "apiKey", in: "header", name: "x-dev-workspace" },
    });
    // every /v1 path operation carries a security requirement
    const v1Ops = Object.entries(doc.paths ?? {})
      .filter(([p]) => p.startsWith("/v1/"))
      .flatMap(([, item]) => Object.values(item as Record<string, unknown>));
    expect(v1Ops.length).toBeGreaterThan(0);
    for (const op of v1Ops) {
      expect((op as { security?: unknown[] }).security?.length).toBeGreaterThan(0);
    }
  });
});
