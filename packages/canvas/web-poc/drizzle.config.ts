import { defineConfig } from "drizzle-kit";

// Drizzle owns the schema (ADR-0018: D1 is the platform data layer's store).
// Generate with `bun run webpoc:db:generate` (never hand-edit
// ./lib/db/migrations or meta/_journal.json); apply with
// `bun run webpoc:db:migrate:local` (wrangler d1 migrations apply).
export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
});
