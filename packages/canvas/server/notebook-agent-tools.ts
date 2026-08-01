import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

import { NOTEBOOK_TOOL_SPECS, type NotebookCall } from '../web-poc/lib/contract/notebook-tools.ts';
import { loadWebPocEnv, platformRpcFromEnv } from './platform-rpc-env.ts';

// The Notebook, as an agent INSIDE the container holds it (ADR-0024). The in-canvas chat and
// the dev-agent are the agents the Notebook exists for — "an agent records what it notices
// while working with a human or running a workflow" — so they get the same ten tools the
// remote MCP surface offers, from the same spec list and with the same descriptions.
//
// A separate MCP server rather than more tools on `canvas`: these are a different surface
// (they touch no canvas, need no store settle) and a turn can be given one without the other.

/** Runs one named Notebook call and answers with whatever the tool returned. */
export type NotebookCaller = (call: NotebookCall) => Promise<unknown>;

/**
 * The env-wired caller, or **null when there is no edge in front of this process** — local
 * dev without the Worker, and the unit suite. An explicit state, exactly as it is for the
 * Component and skill stores: with no edge there is no Notebook, and the turn simply has no
 * notebook tools rather than tools that quietly do nothing.
 */
export function containerNotebookCaller(env = loadWebPocEnv()): NotebookCaller | null {
  const rpc = platformRpcFromEnv(env);
  if (!rpc) return null;
  // The container's identity, derived as every other container-side write derives it
  // (worker/container-env.ts). `userId` is ATTRIBUTION — the edge decides permission itself.
  // 'default' is the legacy/prod workspace id (worker/shell-routing.ts DEFAULT_WORKSPACE_ID).
  const workspaceId = env.CANVAS_WORKSPACE || 'default';
  const userId = env.CANVAS_USER || null;
  return (call) => rpc.notebook({ workspaceId, userId, call });
}

/** The tool defs, for the SDK. Exported so the suite can inspect what a turn is offered. */
export function createNotebookToolDefs(callNotebook: NotebookCaller) {
  return NOTEBOOK_TOOL_SPECS.map((spec) =>
    tool(spec.name, spec.description, spec.schema.shape, async (input: unknown) => {
      try {
        const result = await callNotebook({ tool: spec.tool, input } as NotebookCall);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        // The refusal reaches the agent as the tool's own error, carrying the edge's reason:
        // "there is no such observation" is something it can act on, where a silent empty
        // success is something it would build on and never learn from.
        return { content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true };
      }
    }),
  );
}

/** The `notebook` MCP server for a turn, or null when this process has no edge. */
export function createNotebookMcpServer(callNotebook = containerNotebookCaller()) {
  if (!callNotebook) return null;
  return createSdkMcpServer({ name: 'notebook', version: '0.1.0', tools: createNotebookToolDefs(callNotebook) });
}
