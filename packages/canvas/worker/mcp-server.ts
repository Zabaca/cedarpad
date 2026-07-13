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
  ListInboxInput,
  ReadConversationInput,
  SendMessageInput,
  UploadSkillInput,
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
          headers: { 'content-type': 'application/json', ...(canvasId ? { 'x-canvas-id': canvasId } : {}) },
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
