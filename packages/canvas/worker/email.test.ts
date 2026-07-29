import { describe, expect, test } from 'bun:test';
import { createEmailSender } from '../web-poc/worker/email.ts';
import type { SendEmailBinding } from '../web-poc/worker/context.ts';

// The send seam's whole contract is its failure behaviour: it must be a clean no-op
// without a binding and must swallow every send failure, because a magic link that
// fails to send may never fail the request that asked for it.

function fakeBinding(impl?: (msg: unknown) => Promise<unknown>): SendEmailBinding & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    async send(message) {
      sent.push(message);
      return impl ? impl(message) : undefined;
    },
  };
}

describe('createEmailSender', () => {
  test('sends through the binding with the configured sender and returns true', async () => {
    const binding = fakeBinding();
    const send = createEmailSender(binding, { from: 'cedarpad <no-reply@cedarpad.com>' });

    const ok = await send({ to: 'invitee@example.com', subject: 'Sign in', text: 'link' }, '[test]');

    expect(ok).toBe(true);
    expect(binding.sent).toEqual([
      { from: 'cedarpad <no-reply@cedarpad.com>', to: 'invitee@example.com', subject: 'Sign in', text: 'link' },
    ]);
  });

  test('defaults the sender to the APEX — the one domain for inbound and outbound', async () => {
    const binding = fakeBinding();
    // No `from` override: this is the address production actually sends as.
    await createEmailSender(binding)({ to: 'x@example.com', subject: 's', text: 't' }, '[test]');

    const { from } = binding.sent[0] as { from: string };
    // The sender must be on a domain ENABLED for Cloudflare Email Sending, and it must
    // match the domain whose SPF/DKIM/DMARC we maintain. Drifting onto a subdomain (or
    // any unenabled domain) fails the send outright — which, with passwordless auth,
    // locks everyone out. Pin it rather than discover that in production.
    expect(from).toContain('@cedarpad.com');
    expect(from).not.toContain('@mail.cedarpad.com');
  });

  test('is a clean no-op without a binding — nothing sent, returns false', async () => {
    const send = createEmailSender(undefined);

    const ok = await send({ to: 'invitee@example.com', subject: 'Sign in', text: 'link' }, '[test]');

    expect(ok).toBe(false);
  });

  test('swallows a throwing binding and returns false', async () => {
    const binding = fakeBinding(() => Promise.reject(new Error('not entitled')));
    const send = createEmailSender(binding);

    const ok = await send({ to: 'invitee@example.com', subject: 'Sign in', text: 'link' }, '[test]');

    expect(ok).toBe(false);
  });
});
