import { defineConfig } from "drizzle-kit";

// Drizzle owns the schema + migrations. Generate with `bun run db:generate`
// (never hand-edit ./lib/db/migrations or meta/_journal.json). Defaults to the
// local `turso dev` daemon; prod reads TURSO_URL/TURSO_KEY from env.
export default defineConfig({
  dialect: "turso",
  schema: "./lib/db/schema.ts",
  out: "./lib/db/migrations",
  dbCredentials: {
    url: process.env.TURSO_URL ?? "http://127.0.0.1:8081",
    authToken: process.env.TURSO_KEY,
  },
});
