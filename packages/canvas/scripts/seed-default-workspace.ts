// #179 one-off, idempotent: give the legacy `default` workspace a REAL registry row so
// the access checks (owner-OR-member; no bypass) can govern it. Run BEFORE deploying the
// bypass removal — a deployed check with no row fails closed (default 404s for everyone).
//
// Usage (against prod Turso, from packages/canvas):
//   TURSO_URL=... TURSO_KEY=... bun scripts/seed-default-workspace.ts <owner-email>
// TURSO_URL/TURSO_KEY are the same env names the worker uses (web-poc/worker/runtime.ts);
// take the values from the SOPS-encrypted production secrets — never persist them.

import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { tursoHttpUrl } from '../web-poc/worker/runtime.ts';

const email = process.argv[2];
if (!email) {
  console.error('usage: bun scripts/seed-default-workspace.ts <owner-email>');
  process.exit(1);
}
const url = process.env.TURSO_URL;
if (!url) {
  console.error('TURSO_URL is not set');
  process.exit(1);
}

const client = createClient(
  process.env.TURSO_KEY ? { url: tursoHttpUrl(url), authToken: process.env.TURSO_KEY } : { url: tursoHttpUrl(url) },
);
const db = drizzle(client, { schema });

const [owner] = await db.select().from(schema.user).where(eq(schema.user.email, email)).limit(1);
if (!owner) {
  console.error(`no user with email ${email}`);
  process.exit(1);
}

const [existing] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, 'default')).limit(1);
if (existing) {
  console.log(`default workspace row already exists (owner ${existing.ownerUserId}) — nothing to do`);
  process.exit(0);
}

await db.insert(schema.workspaces).values({ id: 'default', name: 'Default', ownerUserId: owner.id });
console.log(`seeded: workspace 'default' owned by ${owner.id} (${email})`);
