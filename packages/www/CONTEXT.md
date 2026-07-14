# www — marketing site (cedarpad.com)

> **Status: decided, not yet built** (ADR-0014, grill session 2026-07-13).

The public marketing site at **`cedarpad.com`**: an **Astro** site on its own Cloudflare
Worker (`custom_domain: cedarpad.com`), deployed by its own infra instance. Fully
decoupled from the app worker — no auth, no Turso, no container.

**Waitlist**: the one dynamic piece. Signup to the product is invitation-only, so the
landing page's CTA is a waitlist form → an Astro server endpoint → a **D1 database**
(`waitlist` table, `email UNIQUE, created_at`). The payload crosses the boundary through
a zod schema (guideline #7). The same D1 is bound to the app worker so `/admin` shows the
list; invites themselves are manual (admin creates the user, ADR-0014).

_Avoid_: putting app functionality, auth, or API surface here — anything that needs a
user belongs at `app.cedarpad.com`.
