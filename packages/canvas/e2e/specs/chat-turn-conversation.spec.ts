import { createClient } from '@libsql/client';

import { localDevDbUrl } from '../../server/local-d1.ts';
import { expect, test } from '../fixtures/test.ts';

/**
 * A chat turn files its Conversation (ADR-0018 / #262).
 *
 * The acceptance this guards is behavioural, not structural: starting a turn must still result
 * in a Conversation appearing in the Inbox, whether the row is written by the container's own
 * platform-data-layer client (today, and in local dev) or asked for over the platform RPC's
 * `conversation.start` operation (in the container, where WEB_ORIGIN points at the edge).
 *
 * The spec drives the LIVE dev stack end to end — vite → bun bridge → the real turn pipeline
 * (row-at-start index, settle-time upsert, transcript backup). The single stubbed thing is the
 * Claude SDK turn itself (`E2E_MODE`, see server/bridge.ts), because it needs a real OAuth
 * token and a model round-trip.
 *
 * SCOPE NOTE, as in open-conversation.spec.ts: the harness starts vite + the bridge only, not
 * the edge Worker, and there is no auth fixture — so with no WEB_ORIGIN the bridge takes its
 * local path. Both legs of the RPC hop itself are covered by unit tests instead
 * (worker/platform-rpc.test.ts, server/platform-rpc-client.test.ts), and standing up
 * `wrangler dev` in the harness is ADR-0018 slice #263.
 */

test('starting a chat turn files its Conversation', async ({ request }) => {
  // The same local D1 the bridge and the edge Worker share (ADR-0018 / #263), resolved from
  // this worktree's miniflare state dir.
  const devDbUrl = localDevDbUrl();

  const chatId = `e2e-chat-${Date.now()}`;
  const message = `first message ${chatId}`;

  // `x-headless-send` is the subscriber-less send the MCP surface uses (#177): no SSE client
  // needed, so a request-only spec can start a real turn.
  const res = await request.post(`/api/chat/${chatId}/send`, {
    headers: { 'x-headless-send': '1' },
    data: { message },
  });
  expect(res.status()).toBe(202);

  // The turn is fire-and-forget: poll the platform data layer until its row lands.
  const client = createClient({ url: devDbUrl });
  await expect
    .poll(
      async () => {
        try {
          const rows = await client.execute({
            sql: 'select summary from conversations where owner_ref = ?',
            args: [chatId],
          });
          return rows.rows[0]?.summary ?? null;
        } catch {
          // SQLITE_BUSY: the bridge is mid-write on the same file — just poll again.
          return null;
        }
      },
      { timeout: 15_000, message: 'the chat turn never filed its Conversation' },
    )
    .toBe(message);
});
