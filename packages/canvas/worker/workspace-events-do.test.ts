import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

import { parseJsonc } from '../server/dev-worker-config.ts';
import { NOTIFY_PATH, SUBSCRIBE_PATH } from './workspace-events.ts';
import { WorkspaceEvents, fanOut } from './workspace-events-do.ts';

// The hub's own half. `WebSocketPair` and a real `DurableObjectState` are workerd-only, so
// what is exercised here is everything up to the upgrade — the routing, the contract parse,
// and the fan-out — with a stand-in for the socket list. Same split as
// `canvas-sync-do.test.ts`, and for the same reason.

/** A subscriber socket is only ever written to; that is all this needs. */
function socket() {
  const sent: string[] = [];
  return { sent, ws: { send: (m: string) => sent.push(m) } as unknown as WebSocket };
}

/** The slice of `DurableObjectState` the hub touches. Notably small — because the hub
 *  keeps nothing, the socket list IS its entire state. */
function fakeCtx(sockets: WebSocket[]) {
  return { getWebSockets: () => sockets, acceptWebSocket: () => {} } as unknown as DurableObjectState;
}

const notify = (body: unknown) =>
  new Request(`https://workspace-events/ws_1${NOTIFY_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('fanOut', () => {
  test('every subscriber gets the notice', () => {
    const a = socket();
    const b = socket();
    fanOut([a.ws, b.ws], { topic: 'inbox' });
    expect(a.sent).toEqual(['{"topic":"inbox"}']);
    expect(b.sent).toEqual(['{"topic":"inbox"}']);
  });

  test('a socket that has already gone does not take the others’ notice down with it', () => {
    const dead = {
      send: () => {
        throw new Error('socket closed');
      },
    } as unknown as WebSocket;
    const live = socket();
    expect(() => fanOut([dead, live.ws], { topic: 'inbox' })).not.toThrow();
    expect(live.sent).toHaveLength(1);
  });

  test('no subscribers is not an error — a workspace with no tabs open is the normal case', () => {
    expect(() => fanOut([], { topic: 'inbox' })).not.toThrow();
  });
});

describe('WorkspaceEvents — the per-workspace notifier', () => {
  test('a notice fans out to every attached subscriber and answers 204', async () => {
    const a = socket();
    const b = socket();
    const hub = new WorkspaceEvents(fakeCtx([a.ws, b.ws]), {});
    const res = await hub.fetch(notify({ topic: 'inbox' }));
    expect(res.status).toBe(204);
    expect(a.sent).toEqual(['{"topic":"inbox"}']);
    expect(b.sent).toEqual(['{"topic":"inbox"}']);
  });

  // CLAUDE.md §7: the receiving side parses too. A trusted hop is not a reason to trust
  // a payload, and an unparseable notice must not be forwarded to subscribers verbatim.
  test('an unparseable notice is a 400 and reaches nobody', async () => {
    const a = socket();
    const hub = new WorkspaceEvents(fakeCtx([a.ws]), {});
    expect((await hub.fetch(notify('not json'))).status).toBe(400);
    expect((await hub.fetch(notify({ topic: 'presence' }))).status).toBe(400);
    expect(a.sent).toEqual([]);
  });

  // The constraint the whole design rests on (ADR-0022): the hub holds no inbox state, so
  // a count offered to it is dropped rather than stored and re-broadcast.
  test('a count offered on the notice is stripped, never forwarded', async () => {
    const a = socket();
    const hub = new WorkspaceEvents(fakeCtx([a.ws]), {});
    expect((await hub.fetch(notify({ topic: 'inbox', count: 9 }))).status).toBe(204);
    expect(a.sent).toEqual(['{"topic":"inbox"}']);
  });

  test('subscribe without a websocket upgrade is refused — the only other door is /notify', async () => {
    const hub = new WorkspaceEvents(fakeCtx([]), {});
    const res = await hub.fetch(new Request(`https://workspace-events/ws_1${SUBSCRIBE_PATH}`));
    expect(res.status).toBe(426);
  });

  test('any other path is a 404 — the hub has exactly two doors', async () => {
    const hub = new WorkspaceEvents(fakeCtx([]), {});
    expect((await hub.fetch(new Request('https://workspace-events/ws_1/anything'))).status).toBe(404);
  });

  test('a notice arriving with no subscribers is still a 204 — nobody is watching, nothing to do', async () => {
    const hub = new WorkspaceEvents(fakeCtx([]), {});
    expect((await hub.fetch(notify({ topic: 'inbox' }))).status).toBe(204);
  });
});

// A new DO class is only real once wrangler knows about it — in BOTH blocks. Named
// environments inherit no `durable_objects` and no `migrations`, so a class declared only at
// the top level deploys to production and 500s on preview, and one with a binding but no
// migration entry fails the deploy outright. Both are invisible in review.
describe('the hub is registered with wrangler', () => {
  type Bindings = { class_name: string; name: string }[];
  type Migrations = { tag: string; new_sqlite_classes?: string[] }[];
  const config = parseJsonc(
    readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8'),
  ) as {
    durable_objects: { bindings: Bindings };
    migrations: Migrations;
    env: { preview: { durable_objects: { bindings: Bindings }; migrations: Migrations } };
  };
  const blocks = [
    ['production', config.durable_objects.bindings, config.migrations] as const,
    ['preview', config.env.preview.durable_objects.bindings, config.env.preview.migrations] as const,
  ];

  for (const [where, bindings, migrations] of blocks) {
    test(`${where} binds WorkspaceEvents as WORKSPACE_EVENTS`, () => {
      expect(bindings).toContainEqual({ class_name: 'WorkspaceEvents', name: 'WORKSPACE_EVENTS' });
    });

    test(`${where} introduces WorkspaceEvents in a migration`, () => {
      expect(migrations.flatMap((m) => m.new_sqlite_classes ?? [])).toContain('WorkspaceEvents');
    });
  }

  test('the two blocks declare the same classes — preview is not allowed to drift', () => {
    const names = (bs: Bindings) => bs.map((b) => b.class_name).sort();
    expect(names(config.env.preview.durable_objects.bindings)).toEqual(names(config.durable_objects.bindings));
  });
});
