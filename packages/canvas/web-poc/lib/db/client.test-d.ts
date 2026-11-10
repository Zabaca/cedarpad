// Compile-time proof that the platform data layer's `Database` handle is
// driver-agnostic (ADR-0018, slice #260): both the libSQL and the D1 Drizzle
// drivers must satisfy it. Named `.test-d.ts` so `tsc --noEmit` checks it —
// vitest only collects `*.test.ts`, and type assertions have no runtime form.
import type { Client } from "@libsql/client";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import type { Database } from "./client.js";
import * as schema from "./schema.js";

declare const libsqlClient: Client;
declare const d1: D1Database;

drizzleLibsql(libsqlClient, { schema }) satisfies Database;
drizzleD1(d1, { schema }) satisfies Database;
