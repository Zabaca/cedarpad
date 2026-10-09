import { StreamableHTTPTransport } from '@hono/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata, withMcpAuth } from 'better-auth/plugins';
import { Hono } from 'hono';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { edgeAuth } from './auth-gate.ts';
import { coordsForWorkspace } from './sandbox-resolver.ts';
import {
  CreateCanvasInput,
  CreateShapesInput,
  DeleteShapesInput,
  EditComponentInput,
  ListCanvasesInput,
  ListComponentsInput,
  SelectPageInput,
  PlaceComponentInput,
  CallComponentInput,
  ReadCanvasPageInput,
  ReadComponentInput,
  ReadImageInput,
  UpdateShapesInput,
  UploadSkillInput,
  ViewCanvasInput,
  WriteComponentInput,
  WriteDataInput,
  buildMcpTools,
} from './mcp-tools.ts';
import { serveWorkspace } from './sandbox-runtime.ts';
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
      // MCP full access: the generic bridge proxy behind read_canvas and the component
      // tools. Same wake-the-container path as every other bridge call.
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
      'create_canvas',
      {
        description: 'Create a new (empty) canvas in one of your workspaces. Returns its id for the other canvas tools.',
        inputSchema: CreateCanvasInput.shape,
      },
      async (input) => text(await tools.createCanvas(input)),
    );
    server.registerTool(
      'read_canvas',
      {
        description:
          "Read a canvas's shapes — id, type, geometry, text, and component data — plus `pages`, the canvas's pages in order. Omit canvas_id for the workspace's default canvas. A canvas can have MORE THAN ONE PAGE and this reads all of them by default; pass `page` (an id from `pages`) to read just one. Do that whenever the canvas is large — an unfiltered read of a busy canvas can exceed the response limit. An image shape's `src` is an asset URL that needs a browser login; call read_image with the shape id to see it.",
        inputSchema: ReadCanvasPageInput.shape,
      },
      async (input) => text(await tools.readCanvas(input)),
    );
    server.registerTool(
      'read_image',
      {
        description:
          'Look at an image shape on a canvas (a screenshot or photo someone pasted or dropped) at full resolution. Pass the image shape id from read_canvas. Better than view_canvas for reading a specific screenshot, since view_canvas renders a whole page small.',
        inputSchema: ReadImageInput.shape,
      },
      async (input) => {
        const img = await tools.readImage(input);
        return { content: [{ type: 'image' as const, data: img.data, mimeType: img.mimeType }] };
      },
    );
    server.registerTool(
      'view_canvas',
      {
        description:
          "Look at a PNG of a canvas page, or of specific shapes — for layout, spacing, and how shapes relate visually. An open browser tab on the canvas renders it, so it only works while someone has the canvas open; otherwise use read_canvas. Pass `ids` (shape ids from read_canvas) to render just those shapes — a frame brings everything inside it — which is how to read a busy area, since a whole page is shrunk to fit 2000px. Or pass `page` (a name or an id from read_canvas's `pages`) to pick a page; with neither you get whatever page the answering tab is on. CAVEAT: this is a tldraw export that redraws shapes cleanly, not a capture of anyone's screen, so a component can look fine here and still be broken for a human.",
        inputSchema: ViewCanvasInput.shape,
      },
      async (input) => {
        const img = await tools.viewCanvas(input);
        if (!img) {
          return text({ error: 'No browser tab answered: nobody has this canvas open, or the page is empty, or none of the ids exist on it. Use read_canvas instead.' });
        }
        return { content: [{ type: 'image' as const, data: img.data, mimeType: img.mimeType }] };
      },
    );
    server.registerTool(
      'select_page',
      {
        description:
          "Ask YOUR OWN open tabs on this canvas to switch to a page — takes the page name as the human says it, or a page: id. This changes only what you are looking at: it does not modify the canvas, and it does not move anyone else's screen. `asked` counts the views the request reached, NOT views confirmed changed, so report it as asking rather than as done; asked: 0 means you have no tab open on this canvas and nobody saw anything at all.",
        inputSchema: SelectPageInput.shape,
      },
      async (input) => text(await tools.selectPage(input)),
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
        description:
          "Read a component module's .tsx source — to learn the conventions before writing one, or to get the exact text to hand edit_component. The source always comes back `cat -n` style, `<line number><tab><the line>`; the numbers are a reading aid and are NOT in the file, so strip the prefix before using a line as an edit anchor. `lines` is the file's true length, so you can always tell whether you read all of it. Pass `offset` (the 1-based first line) and/or `limit` (how many lines) to read only a window of a long file; with neither you get the whole thing.",
        inputSchema: ReadComponentInput.shape,
      },
      async (input) => text(await tools.readComponent(input)),
    );
    server.registerTool(
      'write_component',
      {
        description:
          'Create or overwrite a reusable React component module in a workspace canvas library. Rules: `export default` a React component; it receives the placement `data` as props; imports of react, other components, "mermaid", and "flint-chart/vegalite" + "vega"/"vega-lite" are allowed; inline styles + SVG. For a chart, place the platform `ChartCard` (it takes a Flint spec) rather than drawing one. Placed instances hot-reload; use place_component to render a new instance on a canvas. To change PART of a module that already exists, use edit_component instead — it takes the snippet to replace, so you never re-send the rest of the file.',
        inputSchema: WriteComponentInput.shape,
      },
      async (input) => text(await tools.writeComponent(input)),
    );

    server.registerTool(
      'edit_component',
      {
        description:
          'Change part of an existing component module WITHOUT re-sending the rest of it — use this, not write_component, for any small adjustment. It replaces `old_string` with `new_string`. read_component first and copy the exact text, stripping the `<number><tab>` prefix the read adds. `old_string` must occur EXACTLY ONCE: if it does not, the edit is refused rather than applied to whichever occurrence came first, so include enough surrounding lines to make it unique — or pass `replace_all` to change every occurrence, which is what you want for a rename. An empty `new_string` deletes the text. A refusal means the file is not what you think it is, so re-read rather than retrying. Placed instances hot-reload just as they do after write_component.',
        inputSchema: EditComponentInput.shape,
      },
      async (input) => text(await tools.editComponent(input)),
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
      'call_component',
      {
        description:
          "Run one of a placed component's declared COMMANDS — a named, typed edit the component exports as `commands` (read_component shows them and their zod `args`). The command runs against the instance's data as it is NOW, so it never overwrites someone's concurrent edit, and its args are checked. Prefer it over re-sending the whole `data` via place_component whenever the component exports commands.",
        inputSchema: CallComponentInput.shape,
      },
      async (input) => text(await tools.callComponent(input)),
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
