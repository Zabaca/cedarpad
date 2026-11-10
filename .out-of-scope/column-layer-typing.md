# Column-Layer Typing (ORM / Query Builder)

This project does not use an ORM or typed query builder (Drizzle, Kysely, etc.)
over `@libsql/client`, and does not currently invest in compile-time typing
for the SQL column layer.

## Why this is out of scope (for now)

CLAUDE.md §7 ("Single Contract for FE/BE") is fully realized for the
**JSON-in-libSQL** layer: `NodeMetadataSchema` and friends in
`packages/app/src/contract.ts` encode on write and `parse()` on read, so a
stale shape fails loudly and renames are mechanical.

It is not realized for the raw SQL column layer in
`modules/outline/outlineStore.ts` — column names in `SELECT`/`INSERT`
strings aren't compile-checked against `schema.sql`, and `rowToNode()`
casts `Record<string, unknown>` without a typed link back to the query.

The bet: the `nodes` table is small (~6 columns), and the part of the
schema that actually changes shape often — `metadata` — is already
protected by the zod contract. Adding an ORM or query builder now would be
solving a problem that hasn't shown up: no second/third table has landed,
no v2 embedded-replicas work has started, and no column rename has yet
touched more than a couple of call sites.

## Revisit trigger

Reconsider (Drizzle vs Kysely vs a hand-rolled typed wrapper vs a
schema-snapshot lint test) when any of these actually happens:

- A second or third table is added (sessions, branches index, sync state)
- v2 embedded-replicas work begins touching more columns
- A column rename PR needs to touch more than ~3 call sites

## Prior requests

- #33 — "Close column-layer drift gap (raw SQL vs zod-typed JSON metadata)"
