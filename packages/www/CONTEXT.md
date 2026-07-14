# www — marketing site (cedarpad.com)

> **Status: built** (ADR-0014; homepage + waitlist shipped 2026-07-14).

The public marketing site at **`cedarpad.com`**: an **Astro** site on its own Cloudflare
Worker (`custom_domain: cedarpad.com`), deployed by its own infra instance
(`packages/infra/environments/{production,preview}/www.ts`). Fully decoupled from the app
worker — no auth, no Turso, no container. The homepage is prerendered (static); the one
server route is the waitlist endpoint.

**Waitlist**: the one dynamic piece. Signup to the product is invitation-only, so the
landing page's CTA is a waitlist form → an Astro server endpoint (`POST /api/waitlist`)
→ a **D1 database** (`cedarpad-waitlist`; `waitlist` table, `email UNIQUE, created_at`,
migrations in `migrations/`). The payload crosses the boundary through the zod contract
in `src/lib/waitlist.ts` (guideline #7) — both the form script and the endpoint import
and parse it. A **duplicate email returns `joined`**, deliberately: it's the expected
second-visit behavior of `email UNIQUE`, and collapsing it avoids confirming who is on
the list. The form works without JS (native POST → 303 → prerendered `/waitlist/<state>`
pages); JS upgrades it to fetch + inline states. The same D1 is bound to the app worker
so `/admin` shows the list; invites themselves are manual (admin creates the user,
ADR-0014).

**Deploy**: `bunx @zabaca/zbc apply production www` (the zbc module runs `bun run build`
then `wrangler deploy`). One-time setup: `wrangler d1 create cedarpad-waitlist`, paste
the uuid into both `d1_databases` blocks in `wrangler.jsonc`, then
`bun run db:migrate:remote`. Worktree-safe dev: the port comes from `PORT` (default
4515); local D1 lives in the package's own `.wrangler/state`.

_Avoid_: putting app functionality, auth, or API surface here — anything that needs a
user belongs at `app.cedarpad.com`.
