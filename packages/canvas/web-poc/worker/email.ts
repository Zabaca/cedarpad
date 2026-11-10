import type { SendEmailBinding } from "./context.js";

// The outbound email seam. One place holds the wire envelope (sender identity +
// the `send_email` binding call); callers only build a message and name a log tag.
// Ported in shape from a Resend transport used in another Zabaca product, same contract,
// with Cloudflare Email Sending in place of the Resend fetch.
//
// It lives here, beside the binding type and the Better Auth config that is its
// first consumer, so the canvas edge imports it DOWNWARD like everything else in
// this module.
//
// Cloudflare Email Sending (public beta) sends to ARBITRARY recipients on the
// Workers Paid plan, which is why this can carry magic links to people who have
// never written to us.

/**
 * The verified sender.
 *
 * The APEX is the sending domain, deliberately: the apex already terminates inbound
 * (Email Routing MX) and will carry the full inbox later, so keeping outbound on it
 * too means one domain for all mail rather than sending as `mail.` and receiving at
 * `cedarpad.com`. The earlier `mail.cedarpad.com` onboarding is superseded.
 *
 * THIS ADDRESS IS ONLY VALID ONCE `cedarpad.com` IS ENABLED FOR EMAIL SENDING in the
 * Cloudflare dashboard. Sending from a domain that is not enabled fails — and because
 * auth is passwordless, a failed send is a login outage, not a degraded feature.
 *
 * Two DNS invariants the apex must hold (see the deploy notes):
 *   - EXACTLY ONE SPF TXT record. Onboarding ADDS one rather than editing the routing
 *     record already there; two SPF records is a permerror, which fails SPF entirely.
 *   - A DMARC record. Prefer `p=none` on the apex, not the `p=reject` that suited a
 *     send-only subdomain: the apex is a human address space too, and reject would
 *     discard mail from any other sender you later add (Gmail alias, CRM, newsletter).
 */
const FROM = "cedarpad <no-reply@cedarpad.com>";

/** One outbound email's wire fields. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * The injectable send seam. RESOLVES TO A BOOLEAN — `true` only on a genuine
 * accepted send, `false` on a clean no-op (no binding) or a swallowed failure.
 * NEVER THROWS: a send problem must not fail the request that triggered it.
 */
export type EmailSender = (msg: EmailMessage, tag: string) => Promise<boolean>;

/**
 * Build an {@link EmailSender} bound to a binding + sender identity.
 *   - CLEAN NO-OP when the binding is absent (local dev, per-PR preview workers):
 *     nothing is sent, the body is logged so a developer can still follow the link
 *     it would have carried, and it returns `false`.
 *   - BEST-EFFORT otherwise: a throw is logged (tagged with the call's `tag`) and
 *     swallowed, returning `false`.
 *
 * `from` is injectable for tests; it defaults to {@link FROM}.
 */
export function createEmailSender(
  binding: SendEmailBinding | undefined,
  opts: { from?: string } = {},
): EmailSender {
  const from = opts.from ?? FROM;

  return async (msg, tag) => {
    if (!binding) {
      // No binding → nothing sent. Log the body so local dev can follow the link;
      // this is the ONLY path that prints message text.
      console.log(`${tag} [no EMAIL binding] to=${msg.to}\n${msg.text}`);
      return false;
    }
    try {
      await binding.send({ from, to: msg.to, subject: msg.subject, text: msg.text });
      return true;
    } catch (err) {
      console.error(`${tag} threw`, err);
      return false;
    }
  };
}
