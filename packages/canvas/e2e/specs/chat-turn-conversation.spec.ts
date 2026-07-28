import { createClient } from '@libsql/client';

import { requireLocalD1File } from '../../server/local-d1.ts';
import { expect, test } from '../fixtures/test.ts';

/**
 * A chat turn files its Conversation (ADR-0018 / #262, #266).
 *
 * This is the acceptance test for the whole ADR: the container has no database, so the ONLY
 * way this row can exist is if the turn asked the edge Worker for it over the platform RPC and
 * the edge wrote it into miniflare's D1. Before #266 the same spec passed with the bridge
 * writing the file itself; now the row's existence proves the hop.
 *
 * The spec drives the LIVE dev stack end to end — vite → bun bridge → the real turn pipeline
 * (row-at-start index, settle-time upsert, transcript backup) → the edge Worker. The single
 * stubbed thing is the Claude SDK turn itself (`E2E_MODE`, see server/bridge.ts), because it
 * needs a real OAuth token and a model round-trip.
 */

test('starting a chat turn files its Conversation', async ({ request }) => {
  // The local D1 the EDGE serves the platform data layer from (ADR-0018 / #263), resolved from
  // this worktree's miniflare state dir. Read-only here: the spec is a witness, not a writer.
  const devDbUrl = `file:${requireLocalD1File()}`;

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
