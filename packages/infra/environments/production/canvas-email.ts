import { cloudflareEmailModule } from '../../modules/cloudflare-email'

/**
 * Cloudflare Email Sending for cedarpad.com — the pipe the canvas worker's `EMAIL`
 * binding sends magic links and workspace invitations over (no vendor key; the
 * binding is the credential).
 *
 * WHY A SEPARATE INSTANCE, NOT PART OF `canvas`: the `cloudflare` module is a
 * wrangler deploy orchestrator, and wrangler has no surface for Email Sending
 * onboarding at all — hence this module, which calls the Cloudflare REST API
 * directly. Deploying canvas provisions its custom domain but has never touched
 * email; the two are different mechanisms.
 *
 * THE APEX, deliberately: cedarpad.com already terminates inbound (Email Routing MX)
 * and will carry the full inbox later, so outbound lives there too — one domain for
 * all mail. `mail.cedarpad.com` was onboarded earlier and is superseded; it can be
 * left enabled and unused, or removed once this is live.
 *
 * ORDERING: `canvas` imports this, so zbc applies it first — the ordering is enforced
 * rather than left to whoever runs the deploy. The dependency is a RUNTIME one (the
 * `send_email` binding names no domain, so a canvas deploy would succeed without this),
 * but auth is passwordless: the first login after a rollout sends a magic link, and a
 * send from a domain that is not yet enabled is a login outage, not a soft failure.
 * The cost of the import is that every canvas deploy re-runs this module's REST calls;
 * they are idempotent (an already-onboarded domain is a no-op log line).
 *
 * INBOUND IS LEFT ALONE (`enableRouting` defaults false): the apex already has routing
 * MX, and taking ownership of catch-all is the inbox work, not this. Flipping
 * `enableRouting` + `catchAll` here is what that step will look like.
 *
 * Deploy just this instance: bunx @zabaca/zbc apply production canvas-email
 *
 * TWO THINGS TO CHECK THE FIRST TIME THIS APPLIES:
 *
 * 1. EXACTLY ONE SPF RECORD AT THE APEX. Onboarding ADDS an SPF record and does not
 *    merge with one already there — and the apex already publishes
 *    `v=spf1 include:_spf.mx.cloudflare.net ~all` for Email Routing. Two SPF records
 *    is a permerror that fails SPF entirely. Verify, and hand-merge if needed:
 *      dig +short TXT cedarpad.com | grep spf
 *    Both records use the same include, so the merged result is that one line.
 *
 * 2. THE API TOKEN'S SCOPES. This module needs more than the deploy token carries:
 *    Zone > Email Routing Rules: Edit, Zone > Zone Settings: Edit, Zone > DNS: Edit,
 *    Account > Email Sending: Edit, Account > Email Routing Addresses: Edit.
 *    A missing scope surfaces as CF error 10000 "Authentication error"; error 10105
 *    means the account is not entitled (Email Sending needs Workers Paid).
 *
 * DMARC: onboarding provisions a record. Keep the apex at `p=none` rather than the
 * `p=reject` that suited a send-only subdomain — the apex is a human address space
 * too, and reject would discard mail from any other sender added later (Gmail alias,
 * CRM, newsletter). Tighten only once every sender is known.
 */
export default cloudflareEmailModule.instance({
  name: 'canvas-email',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    // cedarpad.com zone (looked up via the CF API, 2026-07-29)
    zoneId: '64f220756e063fd23dbd41de8cdd6be4',
    domain: 'cedarpad.com',
    enableSending: true,
  },
})
