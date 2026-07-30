import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata, withMcpAuth } from 'better-auth/plugins';
import { Hono } from 'hono';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { edgeAuth } from './auth-gate.ts';
import { coordsForWorkspace } from './inbox-bridge.ts';
import { withMcpTokensHeader } from './mcp-tokens-proxy.ts';
import { triggerDevAgentRun } from './dev-agent.ts';
import { kickWarehouseMaterialize } from './warehouse-dispatch.ts';
import { mintDevAgentGitToken } from './github-app.ts';
import { resolveDevAgentRepo } from './github-connection.ts';
import { discoverJobs } from './repo-jobs.ts';
import { DEFAULT_WORKSPACE_ID } from './shell-routing.ts';
import { notifyInboxChanged } from './workspace-events.ts';
import {
  AssignConversationInput,
  CreateCanvasInput,
  CreateShapesInput,
  DeleteShapesInput,
  ListCanvasesInput,
  ListComponentsInput,
  ListInboxInput,
  PlaceComponentInput,
  ReadCanvasPageInput,
  ReadComponentInput,
  ReadConversationInput,
  ReadTranscriptInput,
  RunDevAgentInput,
  SendMessageInput,
  UpdateShapesInput,
  UploadSkillInput,
  WriteComponentInput,
  WriteDataInput,
  buildMcpTools,
} from './mcp-tools.ts';
import { serveWorkspace, warehouseExec } from './sandbox-runtime.ts';
import type { Env } from './index.ts';
import { CANVAS_ID_HEADER, DATA_MAX_BYTES, HEADLESS_SEND_HEADER } from '../shared/bridge-wire.ts';

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
      // #383: an MCP write reaches the badge the same way an Inbox click does.
      notify: (workspaceId) => notifyInboxChanged(env.WORKSPACE_EVENTS, workspaceId),
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
            [HEADLESS_SEND_HEADER]: '1',
            // Shared-inbox assignment: an MCP send is the token user's act — the bridge
            // assigns the Conversation to them at birth / claims-if-unassigned on a reply.
            'x-inbox-assign': session.userId,
            ...(canvasId ? { [CANVAS_ID_HEADER]: canvasId } : {}),
          },
          body: JSON.stringify({ message }),
        });
        return serveWorkspace(await withMcpTokensHeader(target, env, workspaceId), env, coordsForWorkspace(workspaceId));
      },
      // The bridge is the single writer of the skills tree — PUT lands there, `writeSkill`
      // persists the Records (#361) before the files, and the next chat turn discovers it.
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
      // Manual dev-agent trigger (mirrors the /api/jobs/dev-agent/run wiring in
      // worker/index.ts — not imported from there, that would be an import cycle):
      // resolve the default workspace's repo connection, mint the per-turn git token,
      // proxy the kick to the warm bridge. Repo resolution is best-effort like the route's.
      // A `target: warehouse` job routes to kickWarehouseMaterialize instead (#248) — the
      // MCP surface gets the same "Run now" parity as the HTTP route: it's the SAME shared
      // triggerDevAgentRun core with the SAME OAuth-token-acts-as-a-human authorization, so
      // excluding it here would be a second, undocumented gate rather than a deliberate one.
      // A materialize run is exactly the on-demand debugging need #248 exists for, and MCP
      // is cedarpad's one programmatic surface — an agent using it to prove the pipeline
      // works is the intended use, not an escalation.
      kickDevAgent: (body) =>
        triggerDevAgentRun(
          env,
          {
            mint: mintDevAgentGitToken,
            serve: serveWorkspace,
            resolveRepo: async (e, requested) => {
              try {
                return await resolveDevAgentRepo(e, createDbForWorker(e as unknown as Bindings), DEFAULT_WORKSPACE_ID, requested);
              } catch (err: unknown) {
                console.error(`[dev-agent] repo resolution failed — kicking token-less: ${String(err)}`);
                return null;
              }
            },
            discover: (e) =>
              discoverJobs(e, createDbForWorker(e as unknown as Bindings), DEFAULT_WORKSPACE_ID, {
                nowSec: Math.floor(Date.now() / 1000),
              }),
            kickWarehouse: () => kickWarehouseMaterialize(env, { exec: warehouseExec }),
          },
          body,
          // A run_dev_agent call is the token user's explicit act — assign the run to them.
          session.userId,
        ),
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
      'create_canvas',
      {
        description: 'Create a new (empty) canvas in one of your workspaces. Returns its id for the other canvas tools.',
        inputSchema: CreateCanvasInput.shape,
      },
      async (input) => text(await tools.createCanvas(input)),
    );
    server.registerTool(
      'list_inbox',
      {
        description:
          "List a workspace's conversations — the WHOLE workspace's shared index (view: open | all | closed; default open). Optional assigned filter: a member's user id, or 'unassigned' for the unclaimed queue.",
        inputSchema: ListInboxInput.shape,
      },
      async (input) => text(await tools.listInbox(input)),
    );
    server.registerTool(
      'assign_conversation',
      {
        description:
          "Assign a conversation to a workspace member (advisory — a coordination signal, not a lock), or pass user_id: null to unassign. Any member may assign anyone; replying to an unassigned conversation auto-assigns the replier.",
        inputSchema: AssignConversationInput.shape,
      },
      async (input) => text(await tools.assignConversation(input)),
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
          "Read a canvas's shapes — id, type, geometry, text, and component data — plus `pages`, the canvas's pages in order. Omit canvas_id for the workspace's default canvas. A canvas can have MORE THAN ONE PAGE and this reads all of them by default; pass `page` (an id from `pages`) to read just one. Do that whenever the canvas is large — an unfiltered read of a busy canvas can exceed the response limit.",
        inputSchema: ReadCanvasPageInput.shape,
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
          'Create or overwrite a reusable React component module in a workspace canvas library. Rules: `export default` a React component; it receives the placement `data` as props; imports of react, other components, and "mermaid" are allowed; inline styles + SVG. Placed instances hot-reload; use place_component to render a new instance on a canvas.',
        inputSchema: WriteComponentInput.shape,
      },
      async (input) => text(await tools.writeComponent(input)),
    );

    server.registerTool(
      'write_data',
      {
        description:
          `Create or overwrite a data file NEXT TO the components (same dir), so a component can \`import data from "./sales.json"\`. Extensions: .json/.csv/.txt/.md only (max ${DATA_MAX_BYTES} bytes); code goes through write_component. Overwriting reloads placed instances so importers pick up the new data.`,
        inputSchema: WriteDataInput.shape,
      },
      async (input) => text(await tools.writeData(input)),
    );

    server.registerTool(
      'create_shapes',
      {
        description:
          'Create primitive shapes on a canvas (types: rectangle, ellipse, text, note, arrow; page coordinates, visible area roughly x 0..1000 y 0..700). Fields per shape: type (required), x, y, w, h, text, color; arrows take x1/y1/x2/y2 or startShapeId/endShapeId to bind to shapes. Each shape may also take `page` (an id from read_canvas\'s `pages`) to put it on a page other than the first — omit it for the first page. Call read_canvas first to see what exists and where the free space is. Returns the id of every shape it created — ids are opaque and unguessable, so KEEP them if you intend to update, delete, or bind an arrow to these shapes later.',
        inputSchema: CreateShapesInput.shape,
      },
      async (input) => text(await tools.createShapes(input)),
    );
    server.registerTool(
      'update_shapes',
      {
        description:
          'Update existing shapes by id (move, resize, recolor, relabel). Only the fields you pass change; everything else is preserved.',
        inputSchema: UpdateShapesInput.shape,
      },
      async (input) => text(await tools.updateShapes(input)),
    );
    server.registerTool(
      'delete_shapes',
      { description: 'Delete shapes from a canvas by id.', inputSchema: DeleteShapesInput.shape },
      async (input) => text(await tools.deleteShapes(input)),
    );
    server.registerTool(
      'place_component',
      {
        description:
          'Render an instance of a component module on a canvas at (x, y), sized w×h (default 360×260), with `data` passed to it as props. Pass `page` (an id from read_canvas\'s `pages`) to place it on a page other than the first. Returns the id of the instance it placed — ids are opaque and unguessable, so KEEP it if you intend to move or re-data that instance later. Pass an existing component shape id to move/retarget/re-data that instance instead.',
        inputSchema: PlaceComponentInput.shape,
      },
      async (input) => text(await tools.placeComponent(input)),
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

    server.registerTool(
      'run_dev_agent',
      {
        description:
          'Trigger a dev-agent run now (same as the Jobs "Run now" button). Requires `job`: the name of a job defined in .claude/jobs/ on a selected repo\'s default branch (its prompt is read off that branch — you cannot supply a prompt). Optional `repo` disambiguates the job name across selected repos. Runs single-flight: a trigger while one is running joins it. Returns the run\'s chatId; follow it via read_conversation/read_transcript.',
        inputSchema: RunDevAgentInput.shape,
      },
      async (input) => text(await tools.runDevAgent(input)),
    );

    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    const app = new Hono();
    app.all('/mcp', (c) => transport.handleRequest(c));
    const res = await app.fetch(req, env);
    return res;
  })(request);
}
