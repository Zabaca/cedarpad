import { describe, expect, test } from 'bun:test';

import type { MartSidecar } from '../shared/mart-contract.ts';
import { buildExternalMcpServers, formatMartListing } from './agent.ts';

// ADR-0013 train 2 (#176): `buildExternalMcpServers` is the container-side half of the registry
// contract — it turns "which registry servers did this request name a token for" into the
// SDK's `mcpServers` shape. A fake registry is injected (the default-parameter test seam) so
// these tests don't depend on LEDGERBOT_MCP_URL / process.env (that gating is pinned in
// server/mcp-registry.test.ts).

const fakeRegistry = { ledgerbot: { url: 'https://ledgerbot.example/mcp', auth: 'bearer' as const } };

describe('buildExternalMcpServers: this turn’s external MCP servers from a registry + tokens', () => {
  test('a registry entry with a matching token becomes an http server with a Bearer header', () => {
    expect(buildExternalMcpServers({ ledgerbot: 'tok_abc' }, fakeRegistry)).toEqual({
      ledgerbot: { type: 'http', url: 'https://ledgerbot.example/mcp', headers: { authorization: 'Bearer tok_abc' } },
    });
  });

  test('no token for a registry entry ⇒ that server is absent entirely (no connection attempt)', () => {
    expect(buildExternalMcpServers({}, fakeRegistry)).toEqual({});
  });

  test('a token for a name NOT in the registry is ignored (the registry — not the token — gates)', () => {
    expect(buildExternalMcpServers({ ledgerbot: 'tok_abc' }, {})).toEqual({});
  });

  test('no mcpTokens at all (dev-agent turns) ⇒ no external servers', () => {
    expect(buildExternalMcpServers(undefined, fakeRegistry)).toEqual({});
  });
});

// The end_turn summary line: a required summary made a question-only needs_human call fail
// schema validation, forcing a visible retry (the doubled end_turn transcript bug).
import { endTurnSummaryLine, sendMessageOp } from './agent.ts';

describe('endTurnSummaryLine: end_turn works without an explicit summary', () => {
  test('an explicit summary wins', () => {
    expect(endTurnSummaryLine('shipped it', 'ignored?')).toBe('shipped it');
  });

  test('question-only (the Stop-gate-nudged path) derives the line from the question', () => {
    expect(endTurnSummaryLine(undefined, 'Should I build cross-chat messaging?')).toBe('Should I build cross-chat messaging?');
  });

  test('a long question is truncated to one Inbox line', () => {
    const q = 'x'.repeat(200);
    expect(endTurnSummaryLine(undefined, q)).toBe(`${'x'.repeat(140)}…`);
  });

  test('neither ⇒ a plain fallback, never a schema failure', () => {
    expect(endTurnSummaryLine(undefined, undefined)).toBe('Turn complete.');
  });
});

// Cross-chat send_message: guard rails around the bridge-bound seam.
import { createStore } from '../src/store.ts';

describe('sendMessageOp: the send_message tool body', () => {
  const chatShape = { id: 'shape:target', type: 'chat', x: 0, y: 0, w: 100, h: 100, color: 'black' } as never;

  test('delivers to another chat card with origin attribution, routed on the sender canvas', () => {
    const store = createStore([chatShape]);
    const calls: unknown[] = [];
    const text = sendMessageOp(store, (id, msg, canvas) => (calls.push([id, msg, canvas]), { ok: true }), { chat_id: 'shape:target', message: 'ping' }, 'shape:origin', 'cv_1');
    expect(calls).toEqual([['shape:target', '[from shape:origin] ping', 'cv_1']]);
    expect(text).toContain('Delivered');
  });

  test('refuses a self-send', () => {
    const store = createStore([chatShape]);
    const text = sendMessageOp(store, () => ({ ok: true }), { chat_id: 'shape:origin', message: 'hi' }, 'shape:origin');
    expect(text).toContain('YOUR OWN chat');
  });

  test('refuses a target that is not a chat card on this canvas', () => {
    const store = createStore([]);
    const text = sendMessageOp(store, () => ({ ok: true }), { chat_id: 'shape:ghost', message: 'hi' }, 'shape:origin');
    expect(text).toContain('No chat card');
  });

  test('surfaces a seam refusal (target turn in flight) to the agent', () => {
    const store = createStore([chatShape]);
    const text = sendMessageOp(store, () => ({ ok: false, error: 'turn in flight' }), { chat_id: 'shape:target', message: 'hi' }, 'shape:origin');
    expect(text).toContain('Not delivered: turn in flight');
  });
});

// Mart discovery (list_marts): the agent's ONLY way to learn a mart exists and what columns it
// has. Marts live in R2, never on the container filesystem, so a wrong guess at a mart name
// renders an empty component that reads as "no data yet" — the listing has to carry enough for
// the model to name the mart AND read the right fields.
const sidecar = (over: Partial<MartSidecar> = {}): MartSidecar => ({
  name: 'mart_session_events',
  description: 'One row per assistant turn. Canvas-chat turns only.',
  columns: [
    { name: 'session_id', type: 'VARCHAR', description: 'Claude Code session id.' },
    { name: 'input_tokens', type: 'BIGINT', description: 'Non-cached input tokens.' },
  ],
  generatedAt: '2026-07-27T09:01:05.107Z',
  rowCount: 2465,
  ...over,
});

describe('formatMartListing: what the agent sees when it asks what marts exist', () => {
  test('a mart renders with its columns, types, meanings, and freshness', () => {
    const text = formatMartListing([sidecar()]);
    expect(text).toContain('mart_session_events');
    expect(text).toContain('input_tokens (BIGINT)');
    expect(text).toContain('Non-cached input tokens.');
    expect(text).toContain('2026-07-27T09:01:05.107Z');
    expect(text).toContain('2465 rows');
  });

  test('the description is carried through — a mart may cover less than its name implies', () => {
    expect(formatMartListing([sidecar()])).toContain('Canvas-chat turns only.');
  });

  test('every mart appears, so the agent can pick between them', () => {
    const text = formatMartListing([sidecar(), sidecar({ name: 'mart_runway' })]);
    expect(text).toContain('mart_session_events');
    expect(text).toContain('mart_runway');
  });

  test('no marts ⇒ steers to static data instead of leaving the agent to invent a name', () => {
    const text = formatMartListing([]);
    expect(text).toMatch(/no marts/i);
    expect(text).toContain('data');
  });
});

// #327 step 1: the ids come back in the result, and the tool DESCRIPTION has to say so.
// While ids were sequential an agent could guess the id of a shape it had just drawn.
// Random ids (step 2) remove that, so the only way an agent keeps a handle on its own
// work is to read the ids out of the result — which it will only do if told to.
import { createCanvasTools } from './agent.ts';

describe('the minting tools tell the agent to keep the ids they return (#327)', () => {
  const describeTool = (name: string): string => {
    const def = (createCanvasTools(createStore([])) as Array<{ name: string; description: string }>).find((t) => t.name === name);
    if (!def) throw new Error(`no such canvas tool: ${name}`);
    return def.description;
  };

  test('create_shapes', () => {
    expect(describeTool('create_shapes')).toMatch(/returns the ids? .*keep/is);
  });

  test('place_component', () => {
    expect(describeTool('place_component')).toMatch(/returns the ids? .*keep/is);
  });
});

// #357: the custom-handler feature is gone. It was only ever reachable through the shell —
// no tool authored one — so the prompt was telling the agent it had a capability the
// registered tool surface never gave it. The prompt must not name it, and must not name its
// directory as a place the agent may author in.
import { CANVAS_APPEND } from './agent.ts';

describe('the system prompt does not offer a capability with no tool (#357)', () => {
  test('nothing about custom handlers survives in the prompt', () => {
    expect(CANVAS_APPEND).not.toMatch(/custom handler/i);
    expect(CANVAS_APPEND).not.toContain('server/custom');
    expect(CANVAS_APPEND).not.toContain('/api/custom');
  });

  test('the authoring boundary it shares a paragraph with is intact', () => {
    // The neighbouring rule the removal must not damage: author ONLY through the registered
    // tools, and never edit the core.
    expect(CANVAS_APPEND).toContain('shared/components/');
    expect(CANVAS_APPEND).toMatch(/do NOT modify the CORE/i);
    expect(CANVAS_APPEND).toMatch(/bridge\.ts/);
  });

  test('no canvas tool offers to author a backend handler', () => {
    const tools = createCanvasTools(createStore([])) as Array<{ name: string; description: string }>;
    expect(tools.map((t) => t.name)).not.toContain('write_custom_handler');
    for (const t of tools) expect(t.description).not.toMatch(/custom handler|server\/custom/i);
  });
});

// Records (ADR-0022, #358): a Component's history is only worth keeping if somebody can ask
// for it. `component_history` is that door — the answer to "who last changed this and when",
// which before Records had to be reconstructed from chat transcripts.
import { formatComponentHistory } from './agent.ts';

describe('formatComponentHistory: what the agent sees when it asks what happened to a Component', () => {
  const at = (iso: string) => new Date(iso);

  test('every version renders newest first, with its author and when', () => {
    const text = formatComponentHistory('KpiCard', [
      { version: 2, createdAt: at('2026-07-29T18:00:00.000Z'), createdBy: 'user_james' },
      { version: 1, createdAt: at('2026-07-28T09:30:00.000Z'), createdBy: 'user_sam' },
    ]);
    expect(text).toContain('KpiCard');
    expect(text.indexOf('v2')).toBeLessThan(text.indexOf('v1'));
    expect(text).toContain('user_james');
    expect(text).toContain('user_sam');
    expect(text).toContain('2026-07-29T18:00:00.000Z');
  });

  test('an unattributed version says so rather than inventing an author', () => {
    expect(
      formatComponentHistory('KpiCard', [{ version: 1, createdAt: at('2026-07-29T18:00:00.000Z'), createdBy: null }]),
    ).toContain('unknown');
  });

  test('no history is a plain answer, not an error the agent has to interpret', () => {
    expect(formatComponentHistory('KpiCard', [])).toMatch(/no recorded history/i);
  });
});

describe('component_history is a registered canvas tool', () => {
  test('the agent can ask a Component what happened to it', () => {
    const tools = createCanvasTools(createStore([])) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain('component_history');
  });
});

// Records (ADR-0022, #362): history is only recovery if something can act on it.
import { formatComponentRestore } from './agent.ts';

describe('formatComponentRestore: what the agent is told after putting a Component back', () => {
  test('it names both the version restored FROM and the new revision the restore created', () => {
    const text = formatComponentRestore('KpiCard', 1, 3);
    expect(text).toContain('KpiCard');
    expect(text).toContain('v1');
    expect(text).toContain('v3');
  });

  test('it says the history was appended to, not rewound — so the restore is known to be undoable', () => {
    // The agent must not report a restore as if it erased the versions after it. If it thinks
    // recovery is destructive it will hesitate to use it, which is how a five-minute fix
    // becomes an incident again.
    const text = formatComponentRestore('KpiCard', 1, 3);
    expect(text).toMatch(/v2/);
    expect(text).toMatch(/nothing was (erased|lost)|still there|undo/i);
  });
});

describe('restore_component is a registered canvas tool', () => {
  test('recovery is available through the same door as every other Component action', () => {
    const tools = createCanvasTools(createStore([])) as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain('restore_component');
  });
});

// Pages. The canvas has had them since #344, but the agent could only write to one by id —
// with no way to learn an id, and no way to act on the human's word for it. These two ops
// are that door, and the interesting behaviour is entirely in how they REFUSE.
import { selectPageOp } from './agent.ts';
import type { CanvasPage } from '../src/shapes.ts';

/** A store that knows about pages — `createStore` deliberately does not (it is the pure
 *  in-memory shape store; pages exist only in the room). */
const pagedStore = (pages: CanvasPage[]) =>
  ({ getState: () => ({ version: 1, shapes: [], pages }) }) as never;

const TWO: CanvasPage[] = [
  { id: 'page:page', name: 'Page 1' },
  { id: 'page:two', name: 'Roadmap' },
];

describe('selectPageOp: the select_page tool body', () => {
  test('resolves the human\'s word for the page and moves them', () => {
    const moved: string[] = [];
    const { text, isError } = selectPageOp(pagedStore(TWO), (p) => (moved.push(p), 1), 'roadmap');
    expect(moved).toEqual(['page:two']);
    expect(isError).toBeUndefined();
    // The reassurance is load-bearing: the agent must not report this as a canvas edit.
    expect(text).toMatch(/unchanged/);
    expect(text).toMatch(/nobody else/i);
    // ...and it must not claim the view CHANGED. The channel reports delivery, and the
    // browser still declines a page it has not synced, so "asked" is the honest verb.
    expect(text).toMatch(/asked/i);
    expect(text).not.toMatch(/^Switched/);
  });

  test('an unresolvable name is an ERROR and never reaches the channel', () => {
    let called = false;
    const { text, isError } = selectPageOp(pagedStore(TWO), () => ((called = true), 1), 'Sprint 12');
    expect(isError).toBe(true);
    expect(called).toBe(false);
    expect(text).toContain('"Roadmap"'); // the alternatives, so the agent can recover
  });

  // The two failures are DIFFERENT and must stay distinguishable: "I could not find that
  // page" is the agent's problem to fix, "nobody was looking" is the human's to know about.
  test('nobody moved is reported plainly, and is not an error', () => {
    const { text, isError } = selectPageOp(pagedStore(TWO), () => 0, 'Roadmap');
    expect(isError).toBeUndefined();
    expect(text).toMatch(/nothing moved/i);
  });
});

describe('select_page is seam-gated', () => {
  const names = (tools: unknown) => (tools as Array<{ name: string }>).map((t) => t.name);

  // No bound viewer ⇒ no tool at all. The alternative — offering it and moving everyone —
  // is the outcome the whole viewer-threading exists to avoid.
  test('without the seam the agent is not offered select_page', () => {
    expect(names(createCanvasTools(createStore([])))).not.toContain('select_page');
  });

  test('with the seam bound it appears', () => {
    const tools = names(
      createCanvasTools(createStore([]), undefined, undefined, 'default', undefined, undefined, undefined, undefined, undefined, undefined, () => 1),
    );
    expect(tools).toContain('select_page');
  });
});
