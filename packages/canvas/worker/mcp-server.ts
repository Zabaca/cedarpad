import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata, withMcpAuth } from 'better-auth/plugins';
import { Hono } from 'hono';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { edgeAuth } from './auth-gate.ts';
import { coordsForWorkspace } from './inbox-bridge.ts';
import { withMcpTokensHeader } from './mcp-tokens-proxy.ts';
import {
  ListCanvasesInput,
  ListComponentsInput,
  ListInboxInput,
  ReadCanvasInput,
  ReadComponentInput,
  ReadConversationInput,
  ReadTranscriptInput,
  SendMessageInput,
  UploadSkillInput,
  WriteComponentInput,
  buildMcpTools,
} from './mcp-tools.ts';
import { serveWorkspace } from './sandbox-runtime.ts';
import type { Env } from './index.ts';

// The inbound MCP server (ADR-0013 train 3, #177): cedarpad's ONLY programmatic surface.
// Edge-hosted, stateless per request (workers isolate), OAuth on Better Auth — the bearer
// token acts as its human (withMcpAuth answers 401 + WWW-Authenticate so clients discover
// the OAuth flow). Tool logic lives in mcp-tools.ts (pure, tested); this file is wiring:
// token → user, tools → SDK registrations, transport → Response.

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

/** Root OAuth discovery (clients fetch these before they hold any token). */
export function handleOAuthDiscovery(request: Request, env: Env, pathname: string): Promise<Response> {
  const auth = edgeAuth(env);
  return pathname === '/.well-known/oauth-protected-resource'
    ? oAuthProtectedResourceMetadata(auth)(request)
    : oAuthDiscoveryMetadata(auth)(request);
}

/** POST/GET/DELETE /mcp — bearer-authed (never the session cookie), self-gating. */
export function handleMcp(request: Request, env: Env): Promise<Response> {
  return withMcpAuth(edgeAuth(env), async (req, session) => {
    // Every issued token carries the human who consented; a token without one (e.g. a
    // client-credentials grant we never enable) acts as no one.
    if (!session.userId) return new Response('unauthorized', { status: 401 });
    const db = createDbForWorker(env as unknown as Bindings);

    const tools = buildMcpTools({
      db,
      userId: session.userId,
      // The same proxied-send path every chat send takes: x-mcp-tokens attached (train 2),
      // the workspace's coords resolved, the container woken if asleep. Plain chat flavor —
      // no dev-agent token is ever minted here.
      proxySend: async (workspaceId, chatId, message, canvasId) => {
        const target = new Request(`${new URL(req.url).origin}/api/chat/${encodeURIComponent(chatId)}/send`, {
          method: 'POST',
          // x-headless-send: no SSE subscriber exists for an MCP send BY DESIGN (callers
          // poll read_conversation) — the bridge skips its subscribe-before-send 425.
          headers: {
            'content-type': 'application/json',
            'x-headless-send': '1',
            ...(canvasId ? { 'x-canvas-id': canvasId } : {}),
          },
          body: JSON.stringify({ message }),
        });
        return serveWorkspace(await withMcpTokensHeader(target, env, workspaceId), env, coordsForWorkspace(workspaceId));
      },
      // The bridge is the single writer of the skills tree — PUT lands there, the sink
      // persists to skills.tar, and the next chat turn discovers the skill.
      proxySkill: (workspaceId, name, input) => {
        const target = new Request(`${new URL(req.url).origin}/api/skills/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
        return serveWorkspace(target, env, coordsForWorkspace(workspaceId));
      },
      // MCP full access: the generic bridge proxy behind read_canvas / read_transcript /
      // the component tools. Same wake-the-container path as every other bridge call.
      proxyBridge: (workspaceId, path, init) => {
        const target = new Request(`${new URL(req.url).origin}${path}`, {
          method: init?.method ?? 'GET',
          headers: {
            ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(init?.headers ?? {}),
          },
          ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        });
        return serveWorkspace(target, env, coordsForWorkspace(workspaceId));
      },
    });

    const server = new McpServer({ name: 'cedarpad', version: '1.0.0' });
    server.registerTool(
      'list_workspaces',
      { description: "List the workspaces this connection's user owns or is a member of." },
      async () => text(await tools.listWorkspaces()),
    );
    server.registerTool(
      'list_canvases',
      { description: 'List the canvases of one of your workspaces.', inputSchema: ListCanvasesInput.shape },
      async (input) => text(await tools.listCanvases(input)),
    );
    server.registerTool(
      'list_inbox',
      {
        description: "List a workspace's conversations (view: open | all | closed; default open).",
        inputSchema: ListInboxInput.shape,
      },
      async (input) => text(await tools.listInbox(input)),
    );
    server.registerTool(
      'read_conversation',
      {
        description:
          'Poll a conversation by its chat_id (from send_message or list_inbox). status "starting" means the send has not been indexed yet; when waiting_on flips away from "agent", last_message_preview carries the reply.',
        inputSchema: ReadConversationInput.shape,
      },
      async (input) => text(await tools.readConversation(input)),
    );
    server.registerTool(
      'send_message',
      {
        description:
          'Send a message to the workspace agent (async: returns a chat_id immediately — poll read_conversation for the reply). Omit chat_id to start a new conversation; pass one to continue it. Optionally address a canvas_id so the agent works on that canvas.',
        inputSchema: SendMessageInput.shape,
      },
      async (input) => text(await tools.sendMessage(input)),
    );

    server.registerTool(
      'read_transcript',
      {
        description:
          "Read a conversation's FULL settled transcript (every message and tool event), not just the preview read_conversation returns. Wakes the workspace container if asleep.",
        inputSchema: ReadTranscriptInput.shape,
      },
      async (input) => text(await tools.readTranscript(input)),
    );
    server.registerTool(
      'read_canvas',
      {
        description:
          "Read a canvas's full state directly — every shape with id, type, geometry, text, and component data. Omit canvas_id for the workspace's default canvas.",
        inputSchema: ReadCanvasInput.shape,
      },
      async (input) => text(await tools.readCanvas(input)),
    );
    server.registerTool(
      'list_components',
      {
        description:
          "List the reusable React component modules a canvas can place (its own library plus the workspace shared library). Always call this before writing a new component — duplicating an existing one is a mistake.",
        inputSchema: ListComponentsInput.shape,
      },
      async (input) => text(await tools.listComponents(input)),
    );
    server.registerTool(
      'read_component',
      {
        description: "Read a component module's .tsx source (to learn conventions before writing, or to edit).",
        inputSchema: ReadComponentInput.shape,
      },
      async (input) => text(await tools.readComponent(input)),
    );
    server.registerTool(
      'write_component',
      {
        description:
          'Create or overwrite a reusable React component module in a workspace canvas library. Rules: `export default` a React component; it receives the placement `data` as props; imports of react, other components, and "mermaid" are allowed; inline styles + SVG. Placed instances hot-reload. To render a NEW instance on the canvas, ask the agent via send_message to place_component it.',
        inputSchema: WriteComponentInput.shape,
      },
      async (input) => text(await tools.writeComponent(input)),
    );

    server.registerTool(
      'upload_skill',
      {
        description:
          "Install or update a skill in one of your workspaces: a directory of files (SKILL.md + supporting files) the workspace agent discovers on its next turn. Skills are content — they instruct, they can't grant capabilities.",
        inputSchema: UploadSkillInput.shape,
      },
      async (input) => text(await tools.uploadSkill(input)),
    );

    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    const app = new Hono();
    app.all('/mcp', (c) => transport.handleRequest(c));
    const res = await app.fetch(req, env);
    return res;
  })(request);
}
