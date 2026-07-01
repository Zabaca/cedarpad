// Pure classification of raw Claude Agent SDK messages into the typed ChatEvent
// stream the bridge broadcasts. Lifted out of runChat() (server/agent.ts) so the
// translation can be fixture-tested without an API key or a live SDK query. This
// module depends only on SDK *types* and ChatEvent — no query(), no MCP server,
// no env, no store.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ChatEvent } from './agent.ts';
import type { TaskStatus, TodoStatus } from '../shared/chat-wire.ts';

/** The per-turn accumulator runChat threads across messages and folds into the final `done`.
 *  `ctxTokens` tracks the LAST assistant call's input-side tokens = the live context size. */
export type TurnAccum = { sessionId: string | null; costUsd: number; error?: string; contextPct?: number; ctxTokens?: number };

/** Input-side tokens of one API call = its prompt size = the whole conversation so far.
 *  The LAST call's value is the current context occupancy. (modelUsage on the result is
 *  NO good for this — it SUMS across every agentic round-trip in the turn, so a research
 *  turn easily "exceeds" the window. The per-assistant usage is per-call, which is right.) */
function ctxTokensOf(u: { input_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): number | undefined {
  if (!u) return undefined;
  return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

/** The model's context window (a fixed property, NOT a sum) from modelUsage. Picks the
 *  entry that dominated token usage — the main conversation model ctxTokens came from. */
type MU = { inputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; contextWindow: number };
function mainContextWindow(modelUsage: Record<string, MU> | undefined): number | undefined {
  const main = Object.values(modelUsage ?? {}).sort(
    (a, b) => b.inputTokens + b.cacheReadInputTokens - (a.inputTokens + a.cacheReadInputTokens),
  )[0];
  return main?.contextWindow || undefined;
}

const shortToolName = (n: string) => n.replace(/^mcp__canvas__/, '');

/** The spawning Task tool_use id when this message is from a subagent (else undefined),
 *  so the UI can nest subagent events under their Task chip. */
function parentOf(m: SDKMessage): string | undefined {
  return (m as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
}

/**
 * Classify one SDK message against the running accumulator, returning the
 * ChatEvents it produces (often none) and the next accumulator. Pure: no
 * mutation of `acc` — a new accumulator is returned when a `result` updates it.
 */
/** `replay: true` rebuilds the settled transcript from the on-disk session JSONL: it
 *  additionally emits the assistant text block (the live path drops it because it already
 *  streamed as deltas) and the user's own message text (the live client adds those locally).
 *  Live/default mode is unchanged. ADR 0004. */
export function classifySdkMessage(m: SDKMessage, acc: TurnAccum, opts?: { replay?: boolean }): { events: ChatEvent[]; acc: TurnAccum } {
  if (m.type === 'stream_event') {
    // Raw Anthropic streaming events: text token deltas + tool-call starts.
    const parentId = parentOf(m);
    const ev = m.event as { type: string; delta?: { type: string; text?: string }; content_block?: { type: string; name?: string } };
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      return { events: [{ kind: 'delta', text: ev.delta.text, ...(parentId ? { parentId } : {}) }], acc };
    }
    if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use' && ev.content_block.name) {
      return { events: [{ kind: 'tool_start', name: shortToolName(ev.content_block.name), ...(parentId ? { parentId } : {}) }], acc };
    }
    return { events: [], acc };
  }

  if (m.type === 'assistant') {
    // Text already streamed via deltas; here we surface completed tool calls with
    // their full input so the chip can show detail (e.g. ×5). Non-tool_use blocks
    // are ignored to preserve the streamed-vs-completed dedup contract.
    const parentId = parentOf(m);
    const events: ChatEvent[] = [];
    for (const block of m.message.content) {
      // Replay surfaces the settled assistant text (live mode drops it: it streamed as deltas),
      // interleaved with tool chips in content-block order.
      if (opts?.replay && block.type === 'text' && (block as { text?: string }).text) {
        events.push({ kind: 'delta', text: (block as { text: string }).text, ...(parentId ? { parentId } : {}) });
        continue;
      }
      if (block.type !== 'tool_use') continue;
      // TODO-list tools surface in the plan panel, not as transcript chips.
      if (block.name === 'TaskCreate') continue; // the todo is created from its result (carries the id)
      if (block.name === 'TaskUpdate') {
        const inp = (block.input ?? {}) as { taskId?: string; status?: TodoStatus; subject?: string };
        if (inp.taskId) events.push({ kind: 'todo', todoId: inp.taskId, ...(inp.status ? { todoStatus: inp.status } : {}), ...(inp.subject ? { subject: inp.subject } : {}) });
        continue;
      }
      events.push({ kind: 'tool', name: shortToolName(block.name), input: block.input, id: block.id, ...(parentId ? { parentId } : {}) });
    }
    // Track the latest call's context size; the result folds it into contextPct. Only
    // the MAIN agent's calls count — a subagent's usage would mis-report the meter.
    const ctxTokens = parentId ? acc.ctxTokens : ctxTokensOf(m.message.usage) ?? acc.ctxTokens;
    return { events, acc: ctxTokens === acc.ctxTokens ? acc : { ...acc, ctxTokens } };
  }

  if (m.type === 'user') {
    // The only thing we mine from tool_results is the TaskCreate confirmation, which is
    // where a new todo's id is assigned: "Task #N created successfully: <subject>".
    const events: ChatEvent[] = [];
    const content = (m as { message?: { content?: unknown } }).message?.content;
    // Replay surfaces the human's own prompt text (the live client adds those bubbles itself).
    // A user prompt is a string or text block(s); tool_result-bearing user messages are agent
    // feedback, not human text, and only get the TaskCreate mining below.
    if (opts?.replay && typeof content === 'string' && content) {
      events.push({ kind: 'delta', text: content, role: 'user' });
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: string; content?: unknown; text?: string };
        if (opts?.replay && b.type === 'text' && b.text) {
          events.push({ kind: 'delta', text: b.text, role: 'user' });
          continue;
        }
        if (b.type !== 'tool_result') continue;
        const c = b.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof (x as { text?: unknown }).text === 'string' ? (x as { text: string }).text : '')).join('') : '';
        const mm = /Task #(\d+) created successfully: (.+)/.exec(text);
        if (mm?.[1] && mm[2]) events.push({ kind: 'todo', todoId: mm[1], subject: mm[2].trim(), todoStatus: 'pending' });
      }
    }
    return { events, acc };
  }

  if (m.type === 'tool_progress') {
    // A still-running tool reports its elapsed seconds (long Bash, etc.) -> live "running X · 12s".
    const t = m as unknown as { tool_name: string; elapsed_time_seconds: number };
    const parentId = parentOf(m);
    return { events: [{ kind: 'tool_progress', name: shortToolName(t.tool_name), elapsed: Math.round(t.elapsed_time_seconds), ...(parentId ? { parentId } : {}) }], acc };
  }

  if (m.type === 'system') {
    // Live thinking-token estimate during the redacted-thinking phase: the one moving signal
    // while Opus reasons silently (it omits the raw CoT). Drives the "thinking · ~N tokens" pill.
    if ((m as { subtype?: string }).subtype === 'thinking_tokens') {
      const t = m as unknown as { estimated_tokens: number };
      const parentId = parentOf(m);
      return { events: [{ kind: 'thinking', thinkingTokens: t.estimated_tokens, ...(parentId ? { parentId } : {}) }], acc };
    }
    // Background-task lifecycle for ALL types (shell | subagent | monitor | workflow), keyed
    // by task_id for the jobs tray. tool_use_id (when present) also decorates the chip inline.
    const sub = (m as { subtype?: string }).subtype;
    if (sub === 'task_started') {
      const t = m as unknown as { task_id: string; tool_use_id?: string; description?: string; subagent_type?: string; task_type?: string; workflow_name?: string };
      const taskType = t.task_type ?? (t.subagent_type ? 'subagent' : t.workflow_name ? 'workflow' : undefined);
      const title = t.subagent_type ?? t.workflow_name ?? taskType ?? 'task';
      return { events: [{ kind: 'task', taskId: t.task_id, status: 'running', title, ...(taskType ? { taskType } : {}), ...(t.description ? { detail: t.description } : {}), ...(t.tool_use_id ? { toolUseId: t.tool_use_id } : {}) }], acc };
    }
    if (sub === 'task_progress') {
      const t = m as unknown as { task_id: string; tool_use_id?: string; subagent_type?: string; summary?: string };
      return { events: [{ kind: 'task', taskId: t.task_id, status: 'running', ...(t.subagent_type ? { taskType: 'subagent', title: t.subagent_type } : {}), ...(t.summary ? { summary: t.summary } : {}), ...(t.tool_use_id ? { toolUseId: t.tool_use_id } : {}) }], acc };
    }
    if (sub === 'task_notification') {
      const t = m as unknown as { task_id: string; tool_use_id?: string; status: 'completed' | 'failed' | 'stopped'; summary?: string };
      return { events: [{ kind: 'task', taskId: t.task_id, status: t.status, ...(t.summary ? { summary: t.summary } : {}), ...(t.tool_use_id ? { toolUseId: t.tool_use_id } : {}) }], acc };
    }
    if (sub === 'task_updated') {
      const t = m as unknown as { task_id: string; patch?: { status?: TaskStatus; description?: string; error?: string } };
      const detail = t.patch?.error ? `error: ${t.patch.error}` : t.patch?.description;
      return { events: [{ kind: 'task', taskId: t.task_id, ...(t.patch?.status ? { status: t.patch.status } : {}), ...(detail ? { detail } : {}) }], acc };
    }
    return { events: [], acc };
  }

  if (m.type === 'result') {
    const next: TurnAccum = {
      sessionId: m.session_id ?? acc.sessionId,
      costUsd: m.total_cost_usd ?? 0,
      ...(acc.error !== undefined ? { error: acc.error } : {}),
    };
    if (m.subtype === 'success') {
      const win = mainContextWindow(m.modelUsage as Record<string, MU> | undefined);
      if (win && acc.ctxTokens) next.contextPct = Math.min(100, Math.round((acc.ctxTokens / win) * 100));
    }
    if (m.subtype !== 'success') next.error = `agent stopped: ${m.subtype}`;
    return { events: [], acc: next };
  }

  // Any other SDK message type (and any unknown stream_event subtype above) is a no-op.
  return { events: [], acc };
}
