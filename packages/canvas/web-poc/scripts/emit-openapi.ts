import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp, DOC_CONFIG } from "../worker/index.js";

/**
 * Emit the committed OpenAPI artifact (repo-root `openapi.json`) from the
 * contract-derived app. The web client is generated from this file and a drift
 * test (`src/openapi.test.ts`) fails CI if it falls out of sync with the
 * contract. Run after any change to `@cedarpad/contract`.
 */
const out = join(dirname(fileURLToPath(import.meta.url)), "../openapi.json");
const doc = buildApp().getOpenAPIDocument(DOC_CONFIG);
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
console.log(`Wrote OpenAPI document → ${out}`);
