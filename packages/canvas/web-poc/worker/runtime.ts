import { makeDb, type Database } from "../lib/db/index.js";
import { createClient } from "@libsql/client/web";
import type { Bindings } from "./context.js";

/** Build a Workers-compatible Drizzle db from env bindings. */
export function createDbForWorker(env: Bindings): Database {
  const client = createClient(
    env.TURSO_KEY
      ? { url: env.TURSO_URL, authToken: env.TURSO_KEY }
      : { url: env.TURSO_URL },
  );
  return makeDb(client);
}
