import { describe, expect, test } from 'bun:test';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { type TurnAccum, classifySdkMessage } from './classify.ts';

// Fixture builders: minimal shapes cast to SDKMessage. classifySdkMessage reads
// only the fields the three live branches touch, so a partial literal is faithful
// to what the SDK delivers without standing up a real query().
const streamDelta = (text: string): SDKMessage =>
  ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }) as unknown as SDKMessage;

const streamToolStart = (name: string): SDKMessage =>
  ({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name } } }) as unknown as SDKMessage;

const assistant = (content: unknown[], usage?: Record<string, number>): SDKMessage =>
  ({ type: 'assistant', message: { role: 'assistant', content, ...(usage ? { usage } : {}) } }) as unknown as SDKMessage;

const result = (subtype: string, extra: Record<string, unknown> = {}): SDKMessage =>
  ({ type: 'result', subtype, ...extra }) as unknown as SDKMessage;

// A subagent message carries parent_tool_use_id (the spawning Task call's id).
const subAssistant = (content: unknown[], parent_tool_use_id: string, usage?: Record<string, number>): SDKMessage =>
  ({ type: 'assistant', parent_tool_use_id, message: { role: 'assistant', content, ...(usage ? { usage } : {}) } }) as unknown as SDKMessage;

// A subagent lifecycle system message (task_started / task_progress / task_notification).
const taskMsg = (subtype: string, extra: Record<string, unknown>): SDKMessage =>
  ({ type: 'system', subtype, ...extra }) as unknown as SDKMessage;

// A user message carrying a tool_result (where a TaskCreate confirmation lands).
const userToolResult = (text: string): SDKMessage =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_x', content: text }] } }) as unknown as SDKMessage;

const fresh = (): TurnAccum => ({ sessionId: null, costUsd: 0 });

describe('classifySdkMessage', () => {
  test('delta with text → one delta event, text passes through', () => {
    const { events, acc } = classifySdkMessage(streamDelta('hello'), fresh());
    expect(events).toEqual([{ kind: 'delta', text: 'hello' }]);
    expect(acc).toEqual({ sessionId: null, costUsd: 0 });
  });

  test('empty-text delta → no events', () => {
    const { events } = classifySdkMessage(streamDelta(''), fresh());
    expect(events).toEqual([]);
  });

  test('tool start → one tool_start, mcp__canvas__ prefix stripped', () => {
    const { events } = classifySdkMessage(streamToolStart('mcp__canvas__foo'), fresh());
    expect(events).toEqual([{ kind: 'tool_start', name: 'foo' }]);
  });

  test('assistant with two tool_use blocks (+ interleaved text) → two tool events in order; text emits nothing', () => {
    const m = assistant([
      { type: 'tool_use', name: 'mcp__canvas__create_shapes', input: { a: 1 } },
      { type: 'text', text: 'thinking out loud' },
      { type: 'tool_use', name: 'mcp__canvas__align_shapes', input: { b: 2 } },
    ]);
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([
      { kind: 'tool', name: 'create_shapes', input: { a: 1 } },
      { kind: 'tool', name: 'align_shapes', input: { b: 2 } },
    ]);
  });

  test('thinking_tokens system msg → thinking event with the running estimate', () => {
    const m = { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1240, estimated_tokens_delta: 40 } as unknown as SDKMessage;
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'thinking', thinkingTokens: 1240 }]);
  });

  test('tool_progress msg → tool_progress event with rounded elapsed seconds', () => {
    const m = { type: 'tool_progress', tool_name: 'Bash', tool_use_id: 'tu_1', elapsed_time_seconds: 12.6 } as unknown as SDKMessage;
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'tool_progress', name: 'Bash', elapsed: 13 }]);
  });

  test('result success → acc folds session + cost, no error, no events', () => {
    const { events, acc } = classifySdkMessage(result('success', { session_id: 's1', total_cost_usd: 0.42 }), fresh());
    expect(events).toEqual([]);
    expect(acc).toEqual({ sessionId: 's1', costUsd: 0.42 });
  });

  test('result non-success → acc.error verbatim', () => {
    const { acc } = classifySdkMessage(result('error_max_turns', { session_id: 's1', total_cost_usd: 0 }), fresh());
    expect(acc.error).toBe('agent stopped: error_max_turns');
  });

  test('contextPct = LAST assistant call input tokens ÷ model window (NOT the summed modelUsage)', () => {
    // The last assistant call: 2 + 100k cache-read + 0 = ~100k of a 1M window = 10%.
    let acc = classifySdkMessage(
      assistant([{ type: 'text', text: 'early' }], { input_tokens: 5, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 }),
      fresh(),
    ).acc;
    acc = classifySdkMessage(
      assistant([{ type: 'text', text: 'latest' }], { input_tokens: 2, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 }),
      acc,
    ).acc;
    expect(acc.ctxTokens).toBe(100_002); // latest call wins, not the earlier one
    // modelUsage token counts are CUMULATIVE (sum across round-trips) and must be ignored
    // for occupancy — only its contextWindow (a fixed property) is used.
    const modelUsage = { 'claude-opus-4-8': { inputTokens: 9_000_000, cacheReadInputTokens: 50_000_000, cacheCreationInputTokens: 0, contextWindow: 1_000_000 } };
    const done = classifySdkMessage(result('success', { total_cost_usd: 0.1, modelUsage }), acc).acc;
    expect(done.contextPct).toBe(10); // 100k / 1M, not clamped-to-100 from the summed counts
  });

  test('result success with no modelUsage or no assistant usage → no contextPct (no throw)', () => {
    const { acc } = classifySdkMessage(result('success', { total_cost_usd: 0.1 }), fresh());
    expect(acc.contextPct).toBeUndefined();
  });

  test('result missing session_id → prior acc.sessionId survives (?? semantics)', () => {
    const prior: TurnAccum = { sessionId: 'prev', costUsd: 0 };
    const { acc } = classifySdkMessage(result('success', { total_cost_usd: 0.1 }), prior);
    expect(acc.sessionId).toBe('prev');
    expect(acc.costUsd).toBe(0.1);
  });

  test('unknown SDK type → events empty, acc unchanged (deep equal)', () => {
    const before = fresh();
    const { events, acc } = classifySdkMessage({ type: 'system', subtype: 'init' } as unknown as SDKMessage, before);
    expect(events).toEqual([]);
    expect(acc).toEqual(before);
  });

  test('unknown stream_event subtype → events empty, acc unchanged', () => {
    const before = fresh();
    const m = { type: 'stream_event', event: { type: 'message_stop' } } as unknown as SDKMessage;
    const { events, acc } = classifySdkMessage(m, before);
    expect(events).toEqual([]);
    expect(acc).toEqual(before);
  });

  test('accumulator threading: fold a turn sequence, assert event order + final acc', () => {
    const seq: SDKMessage[] = [
      streamDelta('hi '),
      streamToolStart('mcp__canvas__create_shapes'),
      assistant([{ type: 'tool_use', name: 'mcp__canvas__create_shapes', input: { n: 1 } }]),
      result('success', { session_id: 'sess', total_cost_usd: 0.03 }),
    ];
    let acc: TurnAccum = fresh();
    const out: unknown[] = [];
    for (const m of seq) {
      const r = classifySdkMessage(m, acc);
      acc = r.acc;
      out.push(...r.events);
    }
    expect(out).toEqual([
      { kind: 'delta', text: 'hi ' },
      { kind: 'tool_start', name: 'create_shapes' },
      { kind: 'tool', name: 'create_shapes', input: { n: 1 } },
    ]);
    expect(acc).toEqual({ sessionId: 'sess', costUsd: 0.03 });
  });

  test('subagent tool_use → tool event tagged with parentId + the tool_use id', () => {
    const m = subAssistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'tu_9' }], 'task_parent_1');
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'tool', name: 'Bash', input: { command: 'ls' }, id: 'tu_9', parentId: 'task_parent_1' }]);
  });

  test('subagent assistant usage does NOT move the context meter (main-agent only)', () => {
    const prior: TurnAccum = { sessionId: null, costUsd: 0, ctxTokens: 1234 };
    const m = subAssistant([{ type: 'text', text: 'sub' }], 'task_parent_1', { input_tokens: 999, cache_read_input_tokens: 500_000, cache_creation_input_tokens: 0 });
    const { acc } = classifySdkMessage(m, prior);
    expect(acc.ctxTokens).toBe(1234); // a subagent's huge context must not redefine the meter
  });

  test('task_started (subagent, with tool_use_id) → tray event keyed by task_id + inline link', () => {
    const m = taskMsg('task_started', { task_id: 't1', tool_use_id: 'tu_9', subagent_type: 'code-reviewer', description: 'review the diff' });
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'task', taskId: 't1', status: 'running', title: 'code-reviewer', taskType: 'subagent', detail: 'review the diff', toolUseId: 'tu_9' }]);
  });

  test('task_started (shell, no tool_use_id) → still a tray event (no inline link)', () => {
    const m = taskMsg('task_started', { task_id: 't2', task_type: 'shell', description: 'npm run build' });
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'task', taskId: 't2', status: 'running', title: 'shell', taskType: 'shell', detail: 'npm run build' }]);
  });

  test('task_progress → running + summary, keyed by task_id', () => {
    const m = taskMsg('task_progress', { task_id: 't1', tool_use_id: 'tu_9', subagent_type: 'code-reviewer', summary: 'Analyzing auth' });
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'task', taskId: 't1', status: 'running', taskType: 'subagent', title: 'code-reviewer', summary: 'Analyzing auth', toolUseId: 'tu_9' }]);
  });

  test('task_notification → final status + summary', () => {
    const m = taskMsg('task_notification', { task_id: 't1', tool_use_id: 'tu_9', status: 'completed', summary: 'Done', output_file: '/x' });
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'task', taskId: 't1', status: 'completed', summary: 'Done', toolUseId: 'tu_9' }]);
  });

  test('task_updated → status/detail patch keyed by task_id only (error becomes detail)', () => {
    const m = taskMsg('task_updated', { task_id: 't2', patch: { status: 'failed', error: 'boom' } });
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'task', taskId: 't2', status: 'failed', detail: 'error: boom' }]);
  });

  // --- TODO list (TaskCreate / TaskUpdate) → plan panel, not transcript chips ---

  test('TaskCreate tool_use emits NO chip (the todo is created from its result)', () => {
    const m = assistant([{ type: 'tool_use', name: 'TaskCreate', input: { subject: 'X', description: 'Y' }, id: 'tu_1' }]);
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([]);
  });

  test('TaskCreate result → a pending todo carrying the assigned id + subject', () => {
    const m = userToolResult('Task #3 created successfully: Calibrate the flux capacitor');
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'todo', todoId: '3', subject: 'Calibrate the flux capacitor', todoStatus: 'pending' }]);
  });

  test('TaskUpdate → a todo status event, and NO chip', () => {
    const m = assistant([{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' }, id: 'tu_2' }]);
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'todo', todoId: '2', todoStatus: 'completed' }]);
  });

  test('suppression is scoped: a non-Task tool still emits its chip', () => {
    const m = assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'tu_3' }]);
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([{ kind: 'tool', name: 'Bash', input: { command: 'ls' }, id: 'tu_3' }]);
  });

  test('a plain tool_result (not a TaskCreate confirmation) → no todo', () => {
    const m = userToolResult('51 shape(s): [ ... ]');
    const { events } = classifySdkMessage(m, fresh());
    expect(events).toEqual([]);
  });
});

// Replay mode: rebuilding the settled transcript from the on-disk session JSONL. The
// live path drops assistant text (it already streamed as deltas) and never carries the
// user's own message text (the client adds it locally); replay must surface both so a
// fresh tab/device renders the full transcript. ADR 0004.
const userText = (text: string): SDKMessage =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) as unknown as SDKMessage;

describe('classifySdkMessage replay mode', () => {
  test('S1 replay emits a delta for the assistant text block; default/live mode still drops it', () => {
    const m = assistant([{ type: 'text', text: 'the settled answer' }]);
    expect(classifySdkMessage(m, fresh()).events).toEqual([]); // live: dropped (streamed as deltas)
    expect(classifySdkMessage(m, fresh(), { replay: true }).events).toEqual([{ kind: 'delta', text: 'the settled answer' }]);
  });

  test('S2 replay emits tool events for tool_use blocks, in content-block order with text', () => {
    const m = assistant([
      { type: 'tool_use', name: 'mcp__canvas__create_shapes', input: { a: 1 }, id: 'tu_1' },
      { type: 'text', text: 'between' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' }, id: 'tu_2' },
    ]);
    expect(classifySdkMessage(m, fresh(), { replay: true }).events).toEqual([
      { kind: 'tool', name: 'create_shapes', input: { a: 1 }, id: 'tu_1' },
      { kind: 'delta', text: 'between' },
      { kind: 'tool', name: 'Bash', input: { command: 'ls' }, id: 'tu_2' },
    ]);
  });

  test('S2b replay emits the user prompt text as a role:user delta (text blocks)', () => {
    expect(classifySdkMessage(userText('hello agent'), fresh(), { replay: true }).events).toEqual([
      { kind: 'delta', text: 'hello agent', role: 'user' },
    ]);
  });

  test('S2c replay still mines a TaskCreate tool_result for a todo (not a user delta)', () => {
    const m = userToolResult('Task #7 created successfully: ship it');
    expect(classifySdkMessage(m, fresh(), { replay: true }).events).toEqual([
      { kind: 'todo', todoId: '7', subject: 'ship it', todoStatus: 'pending' },
    ]);
  });
});
