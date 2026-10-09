import { z } from 'zod';
import {
  BRIDGE_ROUTES,
  CANVAS_ID_HEADER,
  CANVAS_VIEWER_HEADER,
  ComponentName,
  CreateShapesBody,
  DataFileName,
  DeleteShapesBody,
  EditComponentBody,
  PlaceComponentBody,
  CallComponentBody,
  CanvasImageResult,
  type ScreenshotTarget,
  UpdateShapesBody,
  ViewCanvasResult,
  WriteComponentBody,
  WriteDataBody,
} from '../shared/bridge-wire.ts';
import { resolvePageRef } from '../shared/canvas-pages.ts';
import { SkillName, UploadSkillInput as UploadSkillFiles } from '../shared/skills-wire.ts';
import type { CanvasPage } from '../src/shapes.ts';
import type { Database } from '../web-poc/lib/db/index.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import { listVisibleCanvases, resolveCanvas } from './access.ts';
import { componentCatalog } from './component-catalog.ts';
import { d1RecordStore } from './record-store.ts';
import { DEFAULT_CANVAS_ID } from './shell-routing.ts';
import { getWorkspace, listWorkspaces } from '../web-poc/lib/db/queries/workspaces.ts';

// Inbound MCP tool logic (ADR-0013 train 3, #177) — pure, dependency-injected, no MCP SDK
// here (worker/mcp-server.ts wraps these as MCP tools; tests drive them directly). Every
// tool is scoped to the OAuth token's user: workspace access is owner-OR-member via
// `getWorkspace` (#181).

// Single contract for the tool inputs (CLAUDE.md §7); worker/mcp-server.ts registers the
// same schemas with the SDK.
export const ListCanvasesInput = z.object({ workspace_id: z.string().min(1) });
// Same name constraint as the shell's create route (worker/shell.ts CreateCanvasInput).
export const CreateCanvasInput = z.object({ workspace_id: z.string().min(1), name: z.string().trim().min(1).max(100) });
export const UploadSkillInput = z.object({
  workspace_id: z.string().min(1),
  name: SkillName,
  files: UploadSkillFiles.shape.files,
});
// MCP full access: direct canvas reads + the component library.
export const ReadCanvasInput = z.object({
  workspace_id: z.string().min(1),
  canvas_id: z.string().min(1).optional(),
});
/** Reading a canvas may narrow to ONE page. Only `read_canvas` takes this — the other tools
 *  built on `ReadCanvasInput` address a library or a set of ids, neither of which is
 *  page-scoped. */
export const ReadCanvasPageInput = ReadCanvasInput.extend({
  page: z.string().min(1).optional(),
});
export const ListComponentsInput = ReadCanvasInput;
/** `page` takes a NAME as the human says it, or a `page:` id — `resolvePageRef` accepts
 *  both, so the caller never has to know which one it is holding. */
export const SelectPageInput = ReadCanvasInput.extend({ page: z.string().min(1) });
export const ReadImageInput = ReadCanvasInput.extend({ id: z.string().min(1) });
/** Both optional: without either, the PNG is whatever page the answering tab is on. `page`
 *  is a name or id, as for `SelectPageInput`; `ids` renders just those shapes and wins. */
export const ViewCanvasInput = ReadCanvasInput.extend({
  page: z.string().min(1).optional(),
  ids: z.array(z.string().min(1)).min(1).optional(),
});

const DATA_URL = /^data:(image\/[a-z+]+);base64,(.+)$/s;
/** Addressing one module in one canvas — where read/write/edit all start. Not exported: it is
 *  shared structure, not a boundary anything parses against. */
const ComponentRef = ReadCanvasInput.extend({ module: ComponentName });
export const ReadComponentInput = ComponentRef.extend({
  // A line WINDOW, Claude Code's parameter names: 1-based `offset`, `limit` lines from it.
  // Omitting both reads the whole file — same answer shape either way, just a wider window.
  offset: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
});
// canvas_id is REQUIRED here (unlike the read paths' default-canvas fallback): a write
// silently landing in the default canvas's own dir when the caller meant a specific one
// is invisible until something tries to place/resolve the module there — an omitted
// canvas_id here, followed by place_component on a different canvas, 404s with no hint
// why. Forcing the caller to say which canvas surfaces the mistake immediately.
// Built from ComponentRef, NOT from ReadComponentInput: a write has no line window, and
// inheriting one would advertise `offset`/`limit` on write_component that it then ignores.
export const WriteComponentInput = ComponentRef.extend({ canvas_id: z.string().min(1) }).merge(WriteComponentBody);
/**
 * A CONTENT-anchored edit — the same shape as Claude Code's `Edit`, and the same shape as the
 * in-container `edit_component` tool: one contract over one implementation, reached from two
 * surfaces. It carries the bridge's own body schema, so the edge validates exactly what the
 * container parses (CLAUDE.md §7).
 *
 * Deliberately NOT a line range. A range catches an out-of-BOUNDS mistake and cannot catch an
 * out-of-DATE one: a stale `start_line` is still in bounds and rewrites lines the caller never
 * named. An anchor fails loudly instead, which also makes the match a conflict detector — a
 * concurrent edit elsewhere in the file is harmless, one that touches this text is caught.
 *
 * `canvas_id` is required for the reason `write_component` requires it: this WRITES, and a
 * write that silently lands in the default canvas stays invisible until something later fails
 * to resolve it.
 */
export const EditComponentInput = ComponentRef.extend({ canvas_id: z.string().min(1) }).merge(EditComponentBody);
export const WriteDataInput = ReadCanvasInput.extend({ name: DataFileName }).merge(WriteDataBody);
// Direct canvas mutation: the tool input is the canvas address plus the bridge's own body
// schema (shared/bridge-wire.ts), so the edge validates exactly what the bridge parses.
export const CreateShapesInput = ReadCanvasInput.merge(CreateShapesBody);
export const UpdateShapesInput = ReadCanvasInput.merge(UpdateShapesBody);
export const DeleteShapesInput = ReadCanvasInput.merge(DeleteShapesBody);
export const PlaceComponentInput = ReadCanvasInput.merge(PlaceComponentBody);
export const CallComponentInput = ReadCanvasInput.merge(CallComponentBody);

/**
 * Line addressing for a component's source (read_component's window, edit_component's range).
 *
 * A file ending in a newline splits to a trailing '' — an artifact, not a line: `wc -l` does
 * not count it and neither does anything a human calls "line 7". It is set aside here and put
 * back by `joinLines`, so a read reports the count a person would, and an edit round-trips a
 * file's final newline (or its absence) byte for byte.
 */
function splitLines(source: string): { lines: string[]; trailingNewline: boolean } {
  const parts = source.split('\n');
  const trailingNewline = parts.length > 1 && parts[parts.length - 1] === '';
  return { lines: trailingNewline ? parts.slice(0, -1) : parts, trailingNewline };
}

/** `cat -n`: a right-aligned line number, a tab, the line. The numbers are NOT in the file —
 *  they exist so the range an agent passes to edit_component is one it actually read. */
const numberLines = (lines: string[], offset: number) =>
  lines.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join('\n');

export interface McpToolDeps {
  db: Database;
  /** The OAuth access token's user — the human this connection acts as. */
  userId: string;
  /** Proxy a skill upload to the bridge's PUT /api/skills/:name — the bridge is the single
   * writer of the workspace skills tree (the edge never renders skill files itself). */
  proxySkill: (workspaceId: string, name: string, input: UploadSkillFiles) => Promise<Response>;
  /** Generic bridge proxy (MCP full access): a request into the workspace's container
   * (wakes it if asleep). Wired to serveWorkspace + coordsForWorkspace in mcp-server.ts. */
  proxyBridge: (
    workspaceId: string,
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ) => Promise<Response>;
}

export function buildMcpTools(deps: McpToolDeps) {
  const requireWorkspace = async (workspaceId: string) => {
    const ws = await getWorkspace(deps.db, workspaceId, deps.userId);
    if (!ws) throw new Error(`workspace not found: ${workspaceId}`);
    return ws;
  };

  /** The x-canvas-id header for a request into a workspace: absent = the default canvas;
   * a named canvas must be registered to THAT workspace (never a cross-workspace id).
   * ADR-0016: a private canvas that isn't the token user's is the same error as a
   * missing one — this is the choke point every canvas tool funnels through. */
  const canvasHeader = async (workspaceId: string, canvasId?: string): Promise<Record<string, string>> => {
    if (!canvasId) return {};
    if (!(await resolveCanvas(deps.db, workspaceId, canvasId, deps.userId))) {
      throw new Error(`canvas not found in workspace: ${canvasId}`);
    }
    return { [CANVAS_ID_HEADER]: canvasId };
  };

  /** Proxy + parse: a non-2xx bridge answer becomes a thrown error the MCP layer surfaces. */
  const bridgeJson = async (
    workspaceId: string,
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<unknown> => {
    const res = await deps.proxyBridge(workspaceId, path, init);
    if (!res.ok) throw new Error(`bridge ${init?.method ?? 'GET'} ${path} failed (${res.status}): ${await res.text().catch(() => '')}`);
    return res.json();
  };

  return {
    async listWorkspaces() {
      const rows = await listWorkspaces(deps.db, deps.userId);
      return {
        workspaces: rows.map((w) => ({
          id: w.id,
          name: w.name,
          role: w.ownerUserId === deps.userId ? ('owner' as const) : ('member' as const),
        })),
      };
    },

    async listCanvases(input: z.infer<typeof ListCanvasesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      // ADR-0016: the token user sees workspace-visible canvases plus their own private ones.
      const rows = await listVisibleCanvases(deps.db, ws.id, deps.userId);
      return { canvases: rows.map((c) => ({ id: c.id, name: c.name, visibility: c.visibility })) };
    },

    async createCanvas(input: z.infer<typeof CreateCanvasInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const row = await canvasRegistry.create(deps.db, { workspaceId: ws.id, name: input.name, createdBy: deps.userId });
      return { id: row.id, name: row.name, workspace_id: ws.id };
    },

    /** Read a canvas's full state (every shape) directly — no agent turn needed. */
    async readCanvas(input: z.infer<typeof ReadCanvasPageInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      // The filter runs at the BRIDGE, not here: narrowing after the fact would still drag
      // the whole canvas across this hop, and the hop is what the response limit measures.
      const path = input.page ? `${BRIDGE_ROUTES.canvas}?page=${encodeURIComponent(input.page)}` : BRIDGE_ROUTES.canvas;
      return bridgeJson(ws.id, path, { headers });
    },

    /**
     * Ask the TOKEN USER's own open tabs on this canvas to switch to a page. Presentation
     * only: the document does not change, and nobody else's screen moves — a canvas is a
     * shared surface, and yanking a colleague's view because someone else's agent asked is
     * an act they never consented to.
     *
     * `asked` counts the views the request REACHED, not the views that changed: the leg is
     * fire-and-forget and a browser still declines a page it has not synced yet. 0 is the
     * certain fact — that user has no tab open here (or is on a different canvas) — and it
     * is reported rather than swallowed.
     */
    async selectPage(input: z.infer<typeof SelectPageInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const state = (await bridgeJson(ws.id, BRIDGE_ROUTES.canvas, { headers })) as { pages?: CanvasPage[] };
      // Resolve HERE, at the edge: the bridge takes an id only, so a name never reaches a
      // layer whose job is structure rather than naming.
      const pageId = resolvePageRef(state.pages ?? [], input.page);
      const res = (await bridgeJson(ws.id, BRIDGE_ROUTES.selectPage, {
        method: 'POST',
        // The viewer is the OAuth token's user — this proxy is a synthetic request the edge
        // builds, so worker/index.ts's browser-path stamping never ran for it.
        headers: { ...headers, [CANVAS_VIEWER_HEADER]: deps.userId },
        body: { pageId },
      })) as { asked: number };
      return { page_id: pageId, asked: res.asked };
    },

    /** One image shape's pixels — what the in-canvas agent's `read_image` returns. An image's
     *  `src` in read_canvas is an asset URL behind a browser login, so this is the only way
     *  an outside agent sees a pasted screenshot. */
    async readImage(input: z.infer<typeof ReadImageInput>): Promise<CanvasImageResult> {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const path = `${BRIDGE_ROUTES.canvasImage}?id=${encodeURIComponent(input.id)}`;
      return CanvasImageResult.parse(await bridgeJson(ws.id, path, { headers }));
    },

    /**
     * A PNG of a canvas page or of named shapes, rendered by an open browser tab — anyone's,
     * since a picture of the canvas is a question about the canvas, not about a person. Null
     * when no tab answered (or the target is empty): there is no headless renderer behind this.
     *
     * `ids` are NOT checked here, unlike the in-canvas agent's: that would mean reading the
     * whole canvas, which on a busy one is the very response limit this tool works around.
     */
    async viewCanvas(input: z.infer<typeof ViewCanvasInput>): Promise<CanvasImageResult | null> {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      let target: ScreenshotTarget = {};
      if (input.ids) {
        target = { ids: input.ids };
      } else if (input.page) {
        const state = (await bridgeJson(ws.id, BRIDGE_ROUTES.canvas, { headers })) as { pages?: CanvasPage[] };
        target = { pageId: resolvePageRef(state.pages ?? [], input.page) };
      }
      const { url } = ViewCanvasResult.parse(
        await bridgeJson(ws.id, BRIDGE_ROUTES.canvasView, { method: 'POST', headers, body: target }),
      );
      if (!url) return null;
      const m = DATA_URL.exec(url);
      if (!m) throw new Error('canvas screenshot came back in an unexpected format');
      return { data: m[2] as string, mimeType: m[1] as string };
    },

    // The component library over the wire: the same list/read/write the in-canvas agent
    // has, proxied to the bridge (the single writer of the container filesystem) — except
    // the LISTING, which is answered here at the edge (ADR-0022, #363). Own and shared are
    // Records the edge owns and the platform tier is a manifest bundled with this worker, so
    // an outside agent browsing the library never wakes (or bills) a container.
    async listComponents(input: z.infer<typeof ListComponentsInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      // The same access choke point every canvas tool funnels through — it just yields the
      // canvas id rather than a header now, because there is no request to stamp it onto.
      await canvasHeader(ws.id, input.canvas_id);
      const details = await componentCatalog(d1RecordStore(deps.db), {
        workspaceId: ws.id,
        canvasId: input.canvas_id ?? DEFAULT_CANVAS_ID,
      });
      return { components: details.map((d) => d.name), details };
    },

    async readComponent(input: z.infer<typeof ReadComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const res = (await bridgeJson(ws.id, `${BRIDGE_ROUTES.components}/${encodeURIComponent(input.module)}`, { headers })) as {
        module: string;
        source: string;
      };
      // ALWAYS numbered, window or no window. Claude Code's Read has one output shape for the
      // same reason: a reader that never has to work out which mode it is looking at never
      // pastes a line number into an anchor — and `lines` on every answer is how it tells a
      // complete file from a page of one.
      //
      // The window is applied HERE rather than at the bridge: the source has already crossed
      // the hop by the time anyone could slice it, so a bridge-side window would save nothing
      // — what it costs is a second contract to keep in step with this one.
      const { lines } = splitLines(res.source);
      const offset = input.offset ?? 1;
      // Overrunning the END is ordinary paging and clamps. STARTING past the end does not:
      // an empty window is indistinguishable from an empty file, and an agent that believes
      // the file is empty writes over it. Report the length instead.
      if (offset > lines.length) {
        throw new Error(`read_component ${res.module}: offset ${offset} is past the end of the file (${lines.length} lines)`);
      }
      const shown = lines.slice(offset - 1, input.limit === undefined ? undefined : offset - 1 + input.limit);
      // `limit` reports how many lines actually came back — what was asked for, unless the
      // window ran off the end, which is how a caller tells paging from the last page.
      return { module: res.module, offset, limit: shown.length, lines: lines.length, source: numberLines(shown, offset) };
    },

    async writeComponent(input: z.infer<typeof WriteComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, `${BRIDGE_ROUTES.components}/${encodeURIComponent(input.module)}`, {
        method: 'PUT',
        headers,
        body: { source: input.source },
      });
    },

    /**
     * One hop. The container reads and rewrites the file in the process that owns it, so the
     * edge neither fetches the source nor splices it — and the window in which another writer
     * could slip between a read and a write shrinks from a network round trip to in-process.
     * The matching rules, and the errors that explain them, are the container's existing ones.
     */
    async editComponent(input: z.infer<typeof EditComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, `${BRIDGE_ROUTES.components}/${encodeURIComponent(input.module)}`, {
        method: 'PATCH',
        headers,
        body: {
          old_string: input.old_string,
          new_string: input.new_string,
          // Sent only when asked for: an explicit `replace_all: false` on every call would
          // read as a decision the caller made, when it is just the default.
          ...(input.replace_all ? { replace_all: true } : {}),
        },
      });
    },

    async writeData(input: z.infer<typeof WriteDataInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, `${BRIDGE_ROUTES.components}/data/${encodeURIComponent(input.name)}`, {
        method: 'PUT',
        headers,
        body: { source: input.source },
      });
    },

    // Direct canvas mutation: the same ops the in-canvas agent's tools call, proxied to
    // the bridge (no chat-card linking — an external client has no chat card).
    async createShapes(input: z.infer<typeof CreateShapesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, BRIDGE_ROUTES.shapesCreate, { method: 'POST', headers, body: { shapes: input.shapes } });
    },

    async updateShapes(input: z.infer<typeof UpdateShapesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, BRIDGE_ROUTES.shapesUpdate, { method: 'POST', headers, body: { shapes: input.shapes } });
    },

    async deleteShapes(input: z.infer<typeof DeleteShapesInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      return bridgeJson(ws.id, BRIDGE_ROUTES.deleteShapes, { method: 'POST', headers, body: { ids: input.ids } });
    },

    async placeComponent(input: z.infer<typeof PlaceComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const { workspace_id: _ws, canvas_id: _cv, ...placement } = input;
      return bridgeJson(ws.id, BRIDGE_ROUTES.componentsPlace, { method: 'POST', headers, body: placement });
    },

    async callComponent(input: z.infer<typeof CallComponentInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const headers = await canvasHeader(ws.id, input.canvas_id);
      const { id, command, args } = input;
      return bridgeJson(ws.id, BRIDGE_ROUTES.componentsCall, { method: 'POST', headers, body: { id, command, args } });
    },

    /** Skills are workspace CONTENT (ADR-0013): any member may add one — the same actor
     * could ask the chat agent to write the identical files. Available to the next turn. */
    async uploadSkill(input: z.infer<typeof UploadSkillInput>) {
      const ws = await requireWorkspace(input.workspace_id);
      const res = await deps.proxySkill(ws.id, input.name, { files: input.files });
      if (!res.ok) throw new Error(`skill upload failed (${res.status}): ${await res.text().catch(() => '')}`);
      return { skill: input.name, files: input.files.length, workspace_id: ws.id };
    },
  };
}

export type McpTools = ReturnType<typeof buildMcpTools>;
