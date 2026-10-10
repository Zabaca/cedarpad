# cedarpad.com domain topology: marketing at root, app at app., admin inside the app

Status: accepted (design, grill session 2026-07-13). Graduates the product off `poc.cedarpad.com`.
The **invitation mechanism** below (manual invites, temporary passwords, "no email-sending
infrastructure yet") was superseded on 2026-07-29 by
[ADR-0020](./0020-passwordless-auth-on-cloudflare-email-sending.md): invites are now emailed magic
links, and there are no passwords. Invitation-only signup as a *policy* is unchanged; only the
mechanism moved. Everything else here still stands.

The `cedarpad.com` zone splits into two workers: a new **marketing site** (`packages/www`, Astro on a Cloudflare Worker, `custom_domain: cedarpad.com`) and the existing **canvas app worker moved to `app.cedarpad.com`** (`BETTER_AUTH_URL`/`WEB_ORIGIN` flipped in one deploy — a hard cutover). `poc.cedarpad.com` stays routed to the app worker, which 301s that host to `app.` _(dropped 2026-10-09: nothing depended on it any more)_; existing browser sessions are invalidated (cookies are per-host) and that one-time logout is accepted. Auth is email/password only, so there are no OAuth callback URLs to re-register — only our own MCP pairings and dev-agent origin config need updating.

**Signup is invitation-only.** The marketing page carries a waitlist form: an Astro server endpoint on the www worker writing to a **D1 database** (one `waitlist` table, `email UNIQUE`). D1 over a Durable Object because the data is independent rows with zero coordination — `UNIQUE` handles the only conflict, and `wrangler d1 execute` / the dashboard console make reading the list free; a DO would need hand-written RPC for both sides. Invites are **manual**: admin creates the user with a temporary password and emails them directly — no email-sending infrastructure yet (known upgrade: Resend + set-password link when invites outgrow copy-paste).

**There is no `admin.cedarpad.com`.** _(Superseded 2026-10-09 by [ADR-0026](./0026-the-admin-surface-is-its-own-host-behind-cloudflare-access.md): the operator view now lives at `admin.cedarpad.com` behind Cloudflare Access.)_ Admin lives at `app.cedarpad.com/admin` inside the app worker, gated on an admin role via the Better Auth **admin plugin** (users, auth-sessions, ban, create-user). The www worker's waitlist D1 is *also bound to the app worker* so admin gets a waitlist tab. A separate admin worker was rejected: it would need its own auth origin (or `.cedarpad.com`-wide cookies, widening the session blast radius), duplicate DB bindings, and a second deploy — all for a single-admin tool.

**Admin scope is deliberately shallow**: read-only inventory of workspaces / canvases / chats (counts, last-activity) plus the minimal operator verbs (delete workspace), and **no transcript viewing** — "the operator cannot read your chats by default" is cheap to promise now and expensive to retrofit; transcripts live in the sandbox/R2, so omitting them also keeps admin a pure DB read. Admin UI says **"chats"**, never "sessions", per the canvas glossary (auth sessions are a different thing the admin plugin also lists).

## Considered and rejected

- **Everything on one domain** (marketing at `/`, app behind login): couples marketing iteration to the app's deploy/auth/DB surface.
- **App stays at `poc.cedarpad.com`**: least work, but "poc" in the URL undercuts the graduation.
- **Waitlist in a third-party form or in the app's API**: external dependency for a trivially small list; the app-API route couples marketing to the app worker.
- **`admin.cedarpad.com`** (separate worker or host-switched same worker): see above.
