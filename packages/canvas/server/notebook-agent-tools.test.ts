import { describe, expect, test } from 'bun:test';

import type { NotebookCall } from '../web-poc/lib/contract/notebook-tools.ts';
import { containerNotebookCaller, createNotebookToolDefs } from './notebook-agent-tools.ts';

// What a container turn (the in-canvas chat) is actually offered for the
// Notebook (ADR-0024 / CEDA-X6OIAO). The tools' BEHAVIOUR lives at its own seam
// (web-poc/worker/notebook-tools.test.ts); this covers the wiring: the names a turn sees, the
// call each one makes, and what a refusal looks like to the agent.

const defs = (call: (c: NotebookCall) => Promise<unknown>) =>
  createNotebookToolDefs(call) as unknown as Array<{
    name: string;
    handler: (args: unknown, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  }>;

describe('the notebook tools a container turn holds', () => {
  test('offers the whole surface — writes and reads — and no tool takes a workspace', () => {
    const tools = defs(async () => ({}));
    expect(tools.map((t) => t.name).sort()).toEqual([
      'notebook_create_problem',
      'notebook_link_problems',
      'notebook_list_problems',
      'notebook_read_observation',
      'notebook_read_problem',
      'notebook_record_observation',
      'notebook_record_solution',
      'notebook_search',
      'notebook_tie_observation',
      'notebook_update_observation',
    ]);
  });

  test('a call carries the tool name and the agent’s arguments, and reports the answer', async () => {
    const calls: NotebookCall[] = [];
    const tools = defs(async (c) => {
      calls.push(c);
      return { id: 'obs_1', source: null };
    });
    const record = tools.find((t) => t.name === 'notebook_record_observation')!;
    const out = await record.handler({ title: 'Noticed', body: 'while working' }, {});

    expect(calls).toEqual([{ tool: 'record_observation', input: { title: 'Noticed', body: 'while working' } }]);
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0]!.text)).toEqual({ id: 'obs_1', source: null });
  });

  test('a refusal reaches the agent as a tool error carrying the reason', async () => {
    const tools = defs(async () => {
      throw new Error('observation not found in this workspace: obs_nope');
    });
    const read = tools.find((t) => t.name === 'notebook_read_observation')!;
    const out = await read.handler({ id: 'obs_nope' }, {});
    expect(out.isError).toBe(true);
    expect(out.content[0]!.text).toContain('observation not found in this workspace: obs_nope');
  });

  test('no edge in front of this process means no caller at all — never a silent no-op', () => {
    expect(containerNotebookCaller({})).toBeNull();
  });
});
