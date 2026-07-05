import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";

/**
 * Applies SQL migrations from ./migrations. Reads connection info from env so
 * it works against both a local file DB and a remote Turso instance.
 */
async function main() {
  const url = process.env.TURSO_URL ?? "http://127.0.0.1:8081";
  const authToken = process.env.TURSO_KEY;
  const client = createClient(authToken ? { url, authToken } : { url });
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: "./lib/db/migrations" });
  console.log(`Migrations applied to ${url}`);
  client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
