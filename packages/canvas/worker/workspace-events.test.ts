import { describe, expect, test } from 'bun:test';

import { WorkspaceEvent, workspaceEventsName } from '../shared/workspace-events.ts';
import { notifyInboxChanged, subscribeToWorkspace, type WorkspaceEventsHub } from './workspace-events.ts';

// How the edge REACHES a workspace's hub. The addressing is the load-bearing part: a
// notification that lands on the wrong instance — or on a fresh one per isolate — is a
// badge that never updates, and it would fail silently.

interface Call {
  name: string;
  url: string;
  method: string;
  body: string | null;
  upgrade: string | null;
}

function fakeHub(respond: (call: Call) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const calls: Call[] = [];
  const hub = {
    idFromName: (name: string) => ({ name }),
    get: ({ name }: { name: string }) => ({
      fetch: async (request: Request) => {
        const call = {
          name,
          url: request.url,
          method: request.method,
          body: request.body ? await request.text() : null,
          upgrade: request.headers.get('upgrade'),
        };
        calls.push(call);
        return respond(call);
      },
    }),
  } as unknown as WorkspaceEventsHub;
  return { hub, calls };
}

describe('notifyInboxChanged', () => {
  test('addresses the ONE hub instance for the workspace, by name', async () => {
    const { hub, calls } = fakeHub();
    await notifyInboxChanged(hub, 'ws_1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe(workspaceEventsName('ws_1'));
  });

  test('two workspaces are two hubs; two notices for one workspace are one hub', async () => {
    const { hub, calls } = fakeHub();
    await notifyInboxChanged(hub, 'ws_1');
    await notifyInboxChanged(hub, 'ws_2');
    await notifyInboxChanged(hub, 'ws_1');
    expect(new Set(calls.map((c) => c.name)).size).toBe(2);
  });

  test('posts the contract notice, and nothing else — no count crosses this wire', async () => {
    const { hub, calls } = fakeHub();
    await notifyInboxChanged(hub, 'ws_1');
    expect(calls[0]!.method).toBe('POST');
    expect(WorkspaceEvent.parse(JSON.parse(calls[0]!.body!))).toEqual({ topic: 'inbox' });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ topic: 'inbox' });
  });

  // The doorbell must never break the write that rang it. Every call site is a mutation
  // that has already succeeded by the time this runs.
  test('a hub that throws does not reach the caller', async () => {
    const { hub } = fakeHub(() => {
      throw new Error('hub unreachable');
    });
    await expect(notifyInboxChanged(hub, 'ws_1')).resolves.toBeUndefined();
  });

  test('a hub that answers non-2xx does not reach the caller either', async () => {
    const { hub } = fakeHub(() => new Response('nope', { status: 500 }));
    await expect(notifyInboxChanged(hub, 'ws_1')).resolves.toBeUndefined();
  });

  // Local dev's generated config and every unit test run without the binding. A missing
  // hub means no push — the stream's own watermark tick still carries the badge.
  test('no binding at all is a no-op, not a crash', async () => {
    await expect(notifyInboxChanged(undefined, 'ws_1')).resolves.toBeUndefined();
  });
});

describe('subscribeToWorkspace', () => {
  test('asks the workspace’s hub for a websocket and hands back the accepted client end', async () => {
    const client = { accept: () => {}, accepted: true };
    const { hub, calls } = fakeHub(() => ({ status: 101, webSocket: client }) as unknown as Response);
    const ws = await subscribeToWorkspace(hub, 'ws_1');
    expect(ws).toBe(client as never);
    expect(calls[0]!.name).toBe(workspaceEventsName('ws_1'));
    expect(calls[0]!.upgrade).toBe('websocket');
  });

  test('a hub that refuses the upgrade yields null — the caller falls back to its tick', async () => {
    const { hub } = fakeHub(() => new Response('no', { status: 426 }));
    expect(await subscribeToWorkspace(hub, 'ws_1')).toBeNull();
  });

  test('a hub that throws yields null', async () => {
    const { hub } = fakeHub(() => {
      throw new Error('unreachable');
    });
    expect(await subscribeToWorkspace(hub, 'ws_1')).toBeNull();
  });

  test('no binding yields null', async () => {
    expect(await subscribeToWorkspace(undefined, 'ws_1')).toBeNull();
  });
});
