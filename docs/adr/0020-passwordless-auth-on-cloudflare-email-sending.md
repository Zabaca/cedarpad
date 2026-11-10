# Sign-in is a magic link, sent over Cloudflare Email Sending

Status: accepted (live 2026-07-29, `217bc34`). Supersedes the **invitation mechanism** in
[ADR-0014](./0014-cedarpad-com-domain-topology.md) (the rest of that ADR — domain topology,
waitlist, invitation-only signup as a *policy* — still stands). Vocabulary: root
[CONTEXT.md](../../CONTEXT.md).

The email+password credential is gone. Better Auth's **magic-link plugin is the only way to hold a
session**, and the links go out over **Cloudflare Email Sending** from the `cedarpad.com` apex.
Workspace invitations are no longer a link you copy by hand — issuing one emails a magic link.

## Why

ADR-0014 recorded the invite flow as deliberately manual: *"admin creates the user with a temporary
password and emails them directly — no email-sending infrastructure yet (known upgrade: Resend +
set-password link when invites outgrow copy-paste)."* They outgrew it. Every new user cost a
hand-typed password over a side channel, and the password existed only to be used once.

Two things changed the calculus:

- **Cloudflare Email Sending reached public beta.** The `send_email` binding sends to arbitrary
  recipients on the Workers Paid plan — which the containers already require — so there is no
  vendor account and, crucially, **no API key to store or rotate**. The binding *is* the credential.
- **A magic link is both halves at once.** It authenticates an existing user and creates an invited
  one. Once mail can be sent, the password and the invite-accept form are the same mechanism
  written twice.

Resend was the obvious alternative and is what another Zabaca product uses for exactly this class of
mail (its agent inbox sends replies over Cloudflare but its magic links over Resend). Rejected here
because it reintroduces the secret we would otherwise not have, for a deliverability edge we have no
evidence we need at this volume.

## Decision

1. **Passwordless, with no fallback.** `emailAndPassword: { enabled: false }`. There is no password
   credential on the platform. `AUTH_DISABLE_SIGNUP` no longer gates anything and is inert.

2. **The signup gate is an allowlist in `sendMagicLink`, not `disableSignUp`.** This is the
   security-load-bearing decision. `POST /api/auth/sign-in/magic-link` is a **public** endpoint and
   Better Auth creates the user on *verify*, so leaving signup open would let anyone self-register
   by clicking their own link. But `disableSignUp: true` is too strong in the other direction: an
   invitee has no user row yet, and their first click is precisely what must create it.

   So a link is only ever **delivered** to an address that already holds an account or holds a
   pending invitation. Both outcomes return the same silent ok, so the endpoint never confirms who
   has access. (Pattern taken from another Zabaca product, which allowlists against its operator table.)

3. **Invitations collapse into that one mechanism.** Issuing an invitation writes the row *first* —
   which is what makes the address eligible — then emails a magic link whose `callbackURL` is
   `/invite/<token>`. The invitee lands already signed in and confirms with one button. The
   name/password form, the `InviteSignUp` seam, and account creation inside the accept handler are
   all deleted. A no-session POST to the accept endpoint re-sends to the **bound** address only, so
   it cannot be steered at another address or used to enumerate.

4. **The apex is the sending domain, not a subdomain.** `cedarpad.com` already terminates inbound
   (Email Routing MX) and will carry the full inbox later, so outbound lives there too — one domain
   for all mail rather than sending as `mail.` and receiving at the apex.

   `mail.cedarpad.com` is **not ours and must not be disabled**, despite sharing this zone: it is
   declared by the **zbc** repo (`environments/production/email.ts`) with sending + inbound routing
   and a catch-all into the `zbc-inbox` worker, which sends as `inbox@mail.cedarpad.com`. Two
   projects now provision email in one zone. They do not collide — ours sets `enableRouting: false`
   and owns only apex-scoped records (`_dmarc.cedarpad.com`, `cf-bounce.cedarpad.com`), while zbc
   owns the `*.mail.cedarpad.com` ones — but the zone is a shared surface, so check both instances
   before changing anything zone-wide.

5. **Provisioned as code.** Wrangler has no surface for Email Sending onboarding, so the
   `cloudflare-email` module was ported from another Zabaca product and instantiated as `canvas-email`.
   `canvas` **imports** it, which makes the ordering enforced rather than conventional: the
   `send_email` binding names no domain and would deploy happily without it, but auth is
   passwordless, so a worker sending from an unenabled domain is a **login outage**, not a degraded
   feature.

6. **Send failures never fail the request.** The seam (`web-poc/worker/email.ts`) is a clean no-op
   when the binding is absent — local dev and per-PR previews have none — and logs-and-swallows
   otherwise. It returns a boolean; it never throws.

## Consequences

- **`_dmarc.cedarpad.com` is `p=reject`, and that is a trap for the next sender.** Cloudflare's
  onboarding set it (we would have chosen `p=none`). It is correct today because the worker is the
  only thing sending as `@cedarpad.com` — but the day anything else does (a Gmail alias, a CRM, a
  newsletter tool), its mail is **discarded outright**, not spam-foldered, until its SPF include and
  DKIM key are added. There is no `rua=`, so there are no aggregate reports to notice it by. Adding
  one is cheap and worth doing before the second sender exists.
- **No password means no fallback.** If sending breaks, nobody can sign in. Rollback is redeploying
  the previous worker. This is the accepted cost of (1); it was raised and chosen deliberately.
- **Invitees no longer supply a display name** — it derives from the email's local part, because the
  form that used to collect it is gone.
- **`admin/create-user` still requires a password field** but nothing can sign in with it. It is
  generated, never shown, and the UI now points the new user at the login page. Verified that the
  endpoint still succeeds with `emailAndPassword` disabled.
- **The preview worker has no `EMAIL` binding on purpose** — it shares production's platform D1, so
  a binding there would mail real people. Signing in to preview therefore means reading the link out
  of `wrangler tail`.
- **e2e reads the magic-link token from D1** rather than shimming the send path. Better Auth stores
  the token in `verification` in plain form *before* invoking the send seam, so the fixture drives
  the same two endpoints a real user does with no test-only branch in production code.
- **MCP OAuth (#177) now crosses a mail hop.** Sign-in completes on a later request, so an
  interrupted `/api/auth/mcp/authorize` can no longer be resumed by reading `location.search` on
  return — the continuation is handed to Better Auth as `callbackURL` and survives the round trip.
