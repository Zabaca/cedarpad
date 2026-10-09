// The /api/chat/:id/send subscribe-before-send wire contract (425 Too Early).
//
// Importing bridge.ts does NOT bind a port (Bun.serve is guarded behind
// `import.meta.main`), so we drive the exported `handleRequest` directly with a
// Request and assert the response. `setChatTurnDispatcher` swaps in a spy so the
// 2xx path never invokes the real agent SDK and we can assert dispatch happened (or,
// on the 425 path, did NOT). `chatHub` owns the shared subscriber set the guard
// consults — one connected stream carries every chat, so a single fake controller
// represents "a subscriber exists".

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';

import { type CanvasImage, parseCanvasImages, runChat } from './agent.ts';
import { chatHub, handleRequest, onSessionStart, setCanvasRoomOpener, setChatTurnDispatcher } from './bridge.ts';
import { createStore } from '../src/store.ts';
import type { RemoteCanvasStore } from '../src/remote-store.ts';

// #305: canvas writes go to the canvas's Durable-Object-hosted room, so a test that drives
// a canvas route needs a room to drive it against. This is an in-memory stand-in for one —
// per-canvas, persisting for the file's lifetime, exactly as the real room does per canvas.
const fakeRooms = new Map<string, RemoteCanvasStore>();
setCanvasRoomOpener(async (canvasId) => {
  let store = fakeRooms.get(canvasId);
  if (!store) {
    const inner = createStore([]);
    store = { ...inner, flush: async () => {} };
    fakeRooms.set(canvasId, store);
  }
  return store;
});

const sendReq = (chatId: string, body: unknown = { message: 'hi' }): Request =>
  new Request(`http://localhost/api/chat/${encodeURIComponent(chatId)}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const fakeSubscriber = (): ReadableStreamDefaultController =>
  ({ enqueue() {}, close() {}, error() {} }) as unknown as ReadableStreamDefaultController;

describe('/api/chat/:id/send: subscribe-before-send (425)', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; message: string; images: CanvasImage[] }> = [];

  beforeEach(() => {
    chatHub.resetForTests(); // no subscribers by default
    dispatched = [];
    restore = setChatTurnDispatcher((chatId, message, _sessionId, images) => {
      dispatched.push({ chatId, message, images });
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
  });

  test('no subscriber → 425 Too Early with {error,chatId}, and no turn is dispatched', async () => {
    const res = await handleRequest(sendReq('chat_no_sub'));

    expect(res.status).toBe(425);
    expect(await res.json()).toEqual({ error: 'no_subscribers', chatId: 'chat_no_sub' });
    expect(dispatched).toEqual([]); // dispatched nothing
  });

  test('425 fires before the body is even inspected (an otherwise-valid send is still rejected)', async () => {
    const res = await handleRequest(sendReq('chat_valid_body', { message: 'a real, non-empty message' }));

    expect(res.status).toBe(425);
    expect(dispatched).toEqual([]);
  });

  test('x-headless-send bypasses the guard: no subscriber, still 202 and dispatched (#177 MCP sends)', async () => {
    const req = new Request('http://localhost/api/chat/mcp_headless/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-headless-send': '1' },
      body: JSON.stringify({ message: 'from mcp' }),
    });

    const res = await handleRequest(req);

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'mcp_headless', message: 'from mcp', images: [] }]);
  });

  test('with an active subscription → 202 Accepted and the turn IS dispatched', async () => {
    const sub = fakeSubscriber();
    chatHub.subscribe(sub);

    const res = await handleRequest(sendReq('chat_subbed', { message: 'go' }));

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect(dispatched).toEqual([{ chatId: 'chat_subbed', message: 'go', images: [] }]);
  });

  test('pasted images ride the send through to the dispatch (same contract a reply reuses)', async () => {
    chatHub.subscribe(fakeSubscriber());
    const images = [{ media_type: 'image/png', data: 'AAAA' }];

    const res = await handleRequest(sendReq('chat_img', { message: 'see this', images }));

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_img', message: 'see this', images }]);
  });
});

// ADR-0013 train 2 (#176): the workspace's connected external-MCP tokens ride the send as the
// x-mcp-tokens header (server/mcp-registry.ts's shared contract); the bridge decodes it and
// hands it to the dispatched turn — here we pin the header → decode → dispatch wiring.
describe('/api/chat/:id/send: the x-mcp-tokens header reaches the dispatched turn (decoded)', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; mcpTokens?: Record<string, string>; mcpDisallowed?: string[] }> = [];

  beforeEach(() => {
    dispatched = [];
    chatHub.subscribe(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId, _message, _sessionId, _images, _model, _fork, _effort, _canvasId, mcpTokens, mcpDisallowed) => {
      dispatched.push({ chatId, mcpTokens, ...(mcpDisallowed && mcpDisallowed.length > 0 ? { mcpDisallowed } : {}) });
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
  });

  test('a send WITH the header dispatches the turn carrying the decoded tokens', async () => {
    const req = new Request('http://localhost/api/chat/chat_mcp/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-tokens': JSON.stringify({ ledgerbot: 'tok_a' }) },
      body: JSON.stringify({ message: 'ping ledgerbot' }),
    });

    const res = await handleRequest(req);

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_mcp', mcpTokens: { ledgerbot: 'tok_a' } }]);
  });

  test('a send WITHOUT the header dispatches with an empty object (no tokens connected)', async () => {
    const res = await handleRequest(sendReq('chat_plain_mcp'));

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_plain_mcp', mcpTokens: {} }]);
  });

  test('a malformed header decodes to empty — never fails the send', async () => {
    const req = new Request('http://localhost/api/chat/chat_bad_mcp/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mcp-tokens': 'not json' },
      body: JSON.stringify({ message: 'hi' }),
    });

    const res = await handleRequest(req);

    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_bad_mcp', mcpTokens: {} }]);
  });

  test('the chat’s stored MCP selection opts out: disabled servers dropped at the send, disabled tools ride as disallowed names', async () => {
    const cfg = await handleRequest(
      new Request('http://localhost/api/chat/chat_sel/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mcp: { disabledServers: ['ledgerbot'], disabledTools: { fredrin: ['deploy'] } } }),
      }),
    );
    expect(cfg.status).toBe(200);

    const res = await handleRequest(
      new Request('http://localhost/api/chat/chat_sel/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mcp-tokens': JSON.stringify({ ledgerbot: 'tok_a', fredrin: 'tok_f' }) },
        body: JSON.stringify({ message: 'go' }),
      }),
    );
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_sel', mcpTokens: { fredrin: 'tok_f' }, mcpDisallowed: ['mcp__fredrin__deploy'] }]);
  });

  test('a garbage MCP selection on /config is a 400 — nothing stored', async () => {
    const res = await handleRequest(
      new Request('http://localhost/api/chat/chat_sel2/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mcp: { disabledServers: 'ledgerbot' } }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ADR-0011: one turn per chat, enforced at the wire. The client queue only protects the tab
// that started the turn; a headless send (or another tab) needs the server to say no.
describe('/api/chat/:id/send: 409 turn_in_flight while the chat’s turn runs', () => {
  let restore: () => void = () => {};
  let dispatched: string[] = [];

  beforeEach(() => {
    dispatched = [];
    chatHub.subscribe(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId) => {
      dispatched.push(chatId);
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
    chatHub.aborters.delete('chat_busy');
    chatHub.aborters.delete('chat_running');
  });

  test('a send while a turn is in flight → 409 {turn_in_flight}, nothing dispatched', async () => {
    chatHub.aborters.set('chat_busy', new AbortController()); // a live turn holds the chat

    const res = await handleRequest(sendReq('chat_busy'));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'turn_in_flight', chatId: 'chat_busy' });
    expect(dispatched).toEqual([]);
  });

  test('the transcript GET reports in-flight state, so a mid-run opener rehydrates busy', async () => {
    chatHub.aborters.set('chat_running', new AbortController());

    const running = await handleRequest(new Request('http://localhost/api/chat/chat_running/transcript'));
    const idle = await handleRequest(new Request('http://localhost/api/chat/chat_idle/transcript'));

    expect(((await running.json()) as { busy?: boolean }).busy).toBe(true);
    expect(((await idle.json()) as { busy?: boolean }).busy).toBe(false);
  });
});

// The session's id lands at the turn's init event: the bridge binds the chat to the canvas
// it was EXPLICITLY addressed to then (the guest stream filter's binding, #220), and claims
// nothing for an unaddressed turn.
describe('onSessionStart: the chat binds to its canvas when its session starts', () => {
  test('an addressed turn binds the chat to that canvas; an unaddressed one binds nothing', () => {
    onSessionStart('chat_cv', 'sess_cv', 'cv_9');
    onSessionStart('chat_nocv', 'sess_nocv');
    expect(chatHub.canvasOf('chat_cv')).toBe('cv_9');
    expect(chatHub.canvasOf('chat_nocv')).toBeUndefined();
    chatHub.resetForTests();
  });
});

describe('a send has ONE image contract (#123)', () => {
  test('the shared parse feeds the turn', () => {
    // A messy body: one valid image + two malformed entries the shared parse must drop.
    const body = { images: [{ media_type: 'image/png', data: 'AAAA' }, { media_type: 'image/png' }, null] };
    const parsed = parseCanvasImages(body);
    expect(parsed).toEqual([{ media_type: 'image/png', data: 'AAAA' }]);

    // Type-level: the parse output is exactly what the turn accepts.
    const toSend: Parameters<typeof runChat>[4] = parsed;
    expect(toSend).toBe(parsed);
  });
});

// Chat→canvas pairing (slice 1): a send that EXPLICITLY addresses a canvas (x-canvas-id /
// ?canvas — the pad stamps it) dispatches that id; an unaddressed send dispatches undefined
// so the turn routes to the default store WITHOUT claiming a canvas.
describe('/api/chat/:id/send: the explicit canvas reaches the dispatch; absence claims nothing', () => {
  let restore: () => void = () => {};
  let dispatched: Array<{ chatId: string; canvasId?: string }> = [];

  beforeEach(() => {
    dispatched = [];
    chatHub.subscribe(fakeSubscriber());
    restore = setChatTurnDispatcher((chatId, _message, _sessionId, _images, _model, _fork, _effort, canvasId) => {
      dispatched.push({ chatId, canvasId });
    });
  });

  afterEach(() => {
    restore();
    chatHub.resetForTests();
  });

  test('a pad send (x-canvas-id) dispatches that canvas', async () => {
    const req = new Request('http://localhost/api/chat/chat_pad/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-canvas-id': 'cv_123' },
      body: JSON.stringify({ message: 'draw a box' }),
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_pad', canvasId: 'cv_123' }]);
  });

  test('an unaddressed send dispatches undefined — never a defaulted claim', async () => {
    const res = await handleRequest(sendReq('chat_unaddressed'));
    expect(res.status).toBe(202);
    expect(dispatched).toEqual([{ chatId: 'chat_unaddressed', canvasId: undefined }]);
  });
});

// MCP full access: the component library over the wire. The edge MCP tools proxy here —
// the bridge owns the container filesystem (single writer), exactly like the skills route
// below. GET list / GET source / PUT write, canvas-scoped via x-canvas-id (default here).
describe('GET/PUT /api/components — the component library over the wire', () => {
  const MOD = `ZzTestComp${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const componentsRoot = new URL('../src/canvas-default/components/', import.meta.url).pathname; // ADR-0014: default canvas own dir
  afterAll(() => {
    rmSync(`${componentsRoot}${MOD}.tsx`, { force: true });
  });

  const putComponent = (module: string, body: unknown) =>
    handleRequest(
      new Request(`http://localhost/api/components/${encodeURIComponent(module)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('PUT writes the module file; list and read then see it', async () => {
    const source = 'export default function T() { return null; }';
    const res = await putComponent(MOD, { source });
    expect(res.status).toBe(200);
    expect(readFileSync(`${componentsRoot}${MOD}.tsx`, 'utf8')).toBe(source);

    const list = await handleRequest(new Request('http://localhost/api/components'));
    expect(((await list.json()) as { components: string[] }).components).toContain(MOD);

    const read = await handleRequest(new Request(`http://localhost/api/components/${MOD}`));
    expect(read.status).toBe(200);
    expect(((await read.json()) as { source: string }).source).toBe(source);
  });

  test('an invalid module name and an empty source are refused — nothing written', async () => {
    expect((await putComponent('../evil', { source: 'x' })).status).toBe(400);
    expect((await putComponent(MOD, { source: '' })).status).toBe(400);
    expect((await putComponent(MOD, {})).status).toBe(400);
  });

  test('reading a module that does not exist is a 404', async () => {
    const res = await handleRequest(new Request('http://localhost/api/components/ZzNoSuchModule'));
    expect(res.status).toBe(404);
  });
});

// A PATCH is the SAME edit the in-canvas agent's edit_component makes — ONE implementation
// (`editComponent`), reached from two surfaces. Anchored to CONTENT rather than to line
// numbers: the match is what proves the caller is editing the text it believes is there,
// which a line range cannot do once an earlier edit has shifted the numbers under it.
describe('PATCH /api/components/:module — edit by anchor text', () => {
  const MOD = `ZzEditComp${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const componentsRoot = new URL('../src/canvas-default/components/', import.meta.url).pathname;
  afterAll(() => {
    rmSync(`${componentsRoot}${MOD}.tsx`, { force: true });
  });

  const body = (method: string, payload: unknown) =>
    handleRequest(
      new Request(`http://localhost/api/components/${MOD}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
  const write = (source: string) => body('PUT', { source });
  const patch = (payload: unknown) => body('PATCH', payload);
  const onDisk = () => readFileSync(`${componentsRoot}${MOD}.tsx`, 'utf8');

  test('a unique anchor is replaced and nothing else in the file moves', async () => {
    await write('const label = "v1";\nconst other = "keep";\n');

    expect((await patch({ old_string: '"v1"', new_string: '"v2"' })).status).toBe(200);
    expect(onDisk()).toBe('const label = "v2";\nconst other = "keep";\n');
  });

  test('an anchor that is absent, or that occurs twice, is refused — the file is untouched', async () => {
    await write('const a = "x";\nconst b = "x";\n');

    const missing = await patch({ old_string: '"nope"', new_string: '"y"' });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toMatch(/not found/);

    // Ambiguity is a REFUSAL, not a first-match: picking one of two silently edits the
    // occurrence the caller did not mean, and both look identical in a diff review.
    const ambiguous = await patch({ old_string: '"x"', new_string: '"y"' });
    expect(ambiguous.status).toBe(400);
    expect(((await ambiguous.json()) as { error: string }).error).toMatch(/not unique/);

    expect(onDisk()).toBe('const a = "x";\nconst b = "x";\n');
  });

  test('replace_all is how a caller says it meant every occurrence', async () => {
    await write('const a = "x";\nconst b = "x";\n');

    expect((await patch({ old_string: '"x"', new_string: '"y"', replace_all: true })).status).toBe(200);
    expect(onDisk()).toBe('const a = "y";\nconst b = "y";\n');
  });

  test('an anchor with regex punctuation is matched literally, not as a pattern', async () => {
    await write('const cost = price * (1 + rate);\n');

    expect((await patch({ old_string: '(1 + rate)', new_string: '(1 + rate + fee)' })).status).toBe(200);
    expect(onDisk()).toBe('const cost = price * (1 + rate + fee);\n');
  });
});

describe('PUT /api/components/data/:name — data files over the wire (write_data parity)', () => {
  const DF = `zz_test_data_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}.json`;
  const componentsRoot = new URL('../src/canvas-default/components/', import.meta.url).pathname; // ADR-0014: default canvas own dir
  afterAll(() => {
    rmSync(`${componentsRoot}${DF}`, { force: true });
  });

  const putData = (name: string, body: unknown) =>
    handleRequest(
      new Request(`http://localhost/api/components/data/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('PUT writes the data file next to the components', async () => {
    const res = await putData(DF, { source: '{"rows": [1]}' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(readFileSync(`${componentsRoot}${DF}`, 'utf8')).toBe('{"rows": [1]}');
  });

  test('an executable extension, bad JSON, and a missing source are refused', async () => {
    expect((await putData('evil.tsx', { source: 'x' })).status).toBe(400);
    expect((await putData(DF, { source: '{nope' })).status).toBe(400);
    expect((await putData(DF, {})).status).toBe(400);
  });
});

// MCP full access: direct canvas mutation over the wire — the same ops the in-canvas
// agent uses (create merges defaults, update merges patches, place stamps the component
// rev), minus the chat-card linking (an external client has no chat card). Isolated on
// a throwaway canvas via ?canvas= so no other test's store is touched.
describe('POST /api/canvas/shapes/{create,update} + /api/components/place — direct mutation', () => {
  const CANVAS = `cv_mcp_ops_${crypto.randomUUID().slice(0, 8)}`;
  const post = (path: string, body: unknown) =>
    handleRequest(
      new Request(`http://localhost${path}?canvas=${CANVAS}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const readShapes = async (): Promise<Array<Record<string, unknown>>> => {
    const res = await handleRequest(new Request(`http://localhost/api/canvas?canvas=${CANVAS}`));
    return ((await res.json()) as { shapes: Array<Record<string, unknown>> }).shapes;
  };

  test('create → update round-trip: defaults filled on create, update merges the patch', async () => {
    const created = await post('/api/canvas/shapes/create', {
      shapes: [{ type: 'rectangle', x: 10, y: 20, text: 'box' }],
    });
    expect(created.status).toBe(200);
    const shape = (await readShapes()).find((s) => s.text === 'box')!;
    expect(shape.type).toBe('rectangle');

    const updated = await post('/api/canvas/shapes/update', { shapes: [{ id: shape.id, text: 'renamed' }] });
    expect(updated.status).toBe(200);
    const after = (await readShapes()).find((s) => s.id === shape.id)!;
    expect(after.text).toBe('renamed');
    expect(after.x).toBe(10); // untouched fields survive the patch
  });

  test('place_component: a component instance lands with module, box, data, and a rev', async () => {
    const placed = await post('/api/components/place', { module: 'ZzTestMod', x: 5, y: 6, data: { n: 1 } });
    expect(placed.status).toBe(200);
    const comp = (await readShapes()).find((s) => s.type === 'component' && s.module === 'ZzTestMod')!;
    expect(comp.data).toEqual({ n: 1 });
    expect(typeof comp.rev).toBe('number');
  });

  // Component commands over the wire: the bridge resolves the instance's module, imports its
  // `commands`, and runs one against the live data. Kanban is the platform pilot.
  test('call_component: runs a platform component command against the instance data', async () => {
    await post('/api/components/place', { module: 'Kanban', x: 0, y: 0, data: { title: 'Ops' } });
    const board = (await readShapes()).find((s) => s.type === 'component' && s.module === 'Kanban')!;
    const called = await post('/api/components/call', { id: board.id, command: 'addCard', args: { column: 'doing', title: 'Ship it' } });
    expect(called.status).toBe(200);
    const after = (await readShapes()).find((s) => s.id === board.id)!;
    const cols = (after.data as { title: string; columns: Array<{ id: string; cards: Array<{ title: string }> }> }).columns;
    expect((after.data as { title: string }).title).toBe('Ops');
    expect(cols.find((c) => c.id === 'doing')?.cards.map((k) => k.title)).toEqual(['Ship it']);
  });

  test('call_component: an unknown command, bad args, or a missing id is a 400 naming the problem', async () => {
    await post('/api/components/place', { module: 'Kanban', x: 0, y: 0 });
    const board = (await readShapes()).find((s) => s.type === 'component' && s.module === 'Kanban')!;
    const unknown = await post('/api/components/call', { id: board.id, command: 'launch', args: {} });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { error: string }).error).toContain('addCard');
    const bad = await post('/api/components/call', { id: board.id, command: 'addCard', args: { column: 'todo' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('title');
    expect((await post('/api/components/call', { command: 'addCard' })).status).toBe(400);
  });

  test('bad inputs are 400s: empty batch, unknown update id, missing module', async () => {
    expect((await post('/api/canvas/shapes/create', { shapes: [] })).status).toBe(400);
    expect((await post('/api/canvas/shapes/update', { shapes: [{ id: 'zz_ghost', text: 'x' }] })).status).toBe(400);
    expect((await post('/api/components/place', { x: 1, y: 2 })).status).toBe(400);
  });

  // #223: `module` now goes through the shared COMPONENT_NAME_RE (shared/bridge-wire.ts),
  // the same rule the edge and server/components.ts already enforce — a module name that
  // could never resolve to a file is rejected here instead of landing an unloadable card.
  // Live data sources are retired (ADR-0017 marts, ADR-0024 Notebook queries). An old caller
  // that still sends one gets a plain placement: the field is dropped at the boundary, never
  // stored and never a 500.
  test('place_component: a dataSource on the request is ignored, never stored', async () => {
    for (const [module, dataSource] of [
      ['ZzTestMod2', { kind: 'notebook', query: 'open_problems' }],
      ['ZzTestMod4', { kind: 'mart', name: 'mart_runway' }],
    ] as const) {
      const placed = await post('/api/components/place', { module, x: 5, y: 6, dataSource });
      expect(placed.status).toBe(200);
      const comp = (await readShapes()).find((s) => s.type === 'component' && s.module === module)!;
      expect('dataSource' in comp).toBe(false);
    }
  });

  // #250: `data` is arbitrary component props — a component whose props include a field NAMED
  // "dataSource" (a natural prop name for a chart) reaches the component as an ordinary prop.
  test('place_component: a `dataSource` key INSIDE `data` is just a prop, never a 500', async () => {
    const value = { kind: 'mart', name: 'mart_session_events' };
    const placed = await post('/api/components/place', { module: 'ZzTestMod2b', x: 5, y: 6, data: { dataSource: value } });
    expect(placed.status).toBe(200);
    const comp = (await readShapes()).find((s) => s.type === 'component' && s.module === 'ZzTestMod2b')!;
    expect(comp.data).toEqual({ dataSource: value }); // reaches the component as an ordinary prop, untouched
  });

  test('place_component: a module name that fails the component-name rule is a 400', async () => {
    for (const module of ['../evil', 'Bad.Name', '9leading', 'has space', '']) {
      expect((await post('/api/components/place', { module, x: 1, y: 2 })).status).toBe(400);
    }
    expect((await readShapes()).some((s) => s.type === 'component' && typeof s.module === 'string' && s.module.includes('evil'))).toBe(false);
  });
});

// #177: the single writer of the workspace skills tree — the edge MCP `upload_skill`
// proxies here. Content only (ADR-0013): plain files under .claude/skills/<name>/,
// path rules enforced server-side, persisted as Records before the files are written (#361).
describe('PUT /api/skills/:name — workspace-skill upload (#177)', () => {
  const SKILL = `zz-test-skill-${crypto.randomUUID().slice(0, 8)}`;
  const skillsRoot = new URL('../workspace-skills/skills/', import.meta.url).pathname;
  afterAll(() => {
    rmSync(`${skillsRoot}${SKILL}`, { recursive: true, force: true });
  });

  const putSkill = (name: string, body: unknown) =>
    handleRequest(
      new Request(`http://localhost/api/skills/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  test('writes the skill files under .claude/skills/<name>/ and reports them', async () => {
    const res = await putSkill(SKILL, {
      files: [
        { path: 'SKILL.md', content: '---\nname: t\n---\nbody' },
        { path: 'data/corpus.yaml', content: 'a: 1' },
      ],
    });
    expect(res.status).toBe(200);
    expect(readFileSync(`${skillsRoot}${SKILL}/SKILL.md`, 'utf8')).toContain('body');
    expect(readFileSync(`${skillsRoot}${SKILL}/data/corpus.yaml`, 'utf8')).toBe('a: 1');
  });

  test('rejects traversal in the skill name and in file paths — nothing written', async () => {
    expect((await putSkill('../evil', { files: [{ path: 'SKILL.md', content: 'x' }] })).status).toBe(400);
    expect((await putSkill(SKILL, { files: [{ path: '../outside.md', content: 'x' }] })).status).toBe(400);
    expect((await putSkill(SKILL, { files: [{ path: '/etc/absolute', content: 'x' }] })).status).toBe(400);
  });

  test('rejects an empty body', async () => {
    expect((await putSkill(SKILL, { files: [] })).status).toBe(400);
  });
});

// #357: the custom-handler feature is gone. It never had an authoring door (no write tool,
// and chat turns drop Write/Edit), so the route only ever served files put there by the
// ungated shell. Its absence must look like every other unknown path — a 404 from the route
// table — not a 502 from a proxy to a process nobody starts.
describe('/api/status: the turn-completion artifacts (#357)', () => {
  // #366 finished the list. `sessions` went in #356 (a Transcript is a File, written per
  // session by the turn that touched it), and the last three tar artifacts —
  // `shared-components`, `canvas-dirs`, `skills` — went with the sinks themselves: their
  // content is Records in D1 now, so there is nothing left to tar and no full-replace write
  // that an empty source tree could turn into a workspace-wide delete.
  //
  // `chatMeta` is the ONE survivor, and deliberately: it is per-chat durable state
  // (`chatId → {sessionId, model, effort}`), not workspace content, and it is a whole-map
  // JSON write rather than a snapshot of a directory. The sink itself stays for it — the
  // health it reports at /api/status is what makes a silent save failure visible.
  test('the tar artifacts are gone; chatMeta is the only sink left', async () => {
    const res = await handleRequest(new Request('http://localhost/api/status'));

    expect(res.status).toBe(200);
    const { artifacts } = (await res.json()) as { artifacts: Array<{ name: string }> };
    expect(artifacts.map((a) => a.name).sort()).toEqual(['chatMeta']);
  });
});

describe('/api/custom/* is not a route (#357)', () => {
  test('a handler path 404s exactly like any other unknown /api path', async () => {
    const removed = await handleRequest(new Request('http://localhost/api/custom/hello'));
    const unknown = await handleRequest(new Request('http://localhost/api/no-such-route'));

    expect(removed.status).toBe(404);
    expect(await removed.json()).toEqual({ error: 'not found: /api/custom/hello' });
    // The neighbour the removal shares code with: the route table's fallthrough still answers.
    expect(unknown.status).toBe(404);
  });
});

// Cross-chat messaging: the bridge-bound seam behind the agent's send_message tool.
import { sendToChat } from './bridge.ts';

describe('sendToChat (agent cross-chat messaging)', () => {
  test('dispatches a turn for the target chat on the sender canvas', () => {
    const dispatched: Array<{ chatId: string; message: string; canvasId?: string }> = [];
    const restore = setChatTurnDispatcher((chatId, message, _sid, _img, _model, _fork, _effort, canvasId) => {
      dispatched.push({ chatId, message, canvasId });
    });
    try {
      const res = sendToChat('shape:other', '[from shape:me] hello', 'cv_route');
      expect(res).toEqual({ ok: true });
      expect(dispatched).toEqual([{ chatId: 'shape:other', message: '[from shape:me] hello', canvasId: 'cv_route' }]);
    } finally {
      restore();
    }
  });

  test('refuses while the target has a turn in flight (one turn per chat)', () => {
    const restore = setChatTurnDispatcher(() => {
      throw new Error('must not dispatch');
    });
    chatHub.aborters.set('shape:busy', new AbortController());
    try {
      const res = sendToChat('shape:busy', 'hi');
      expect(res.ok).toBe(false);
    } finally {
      chatHub.aborters.delete('shape:busy');
      restore();
    }
  });
});
