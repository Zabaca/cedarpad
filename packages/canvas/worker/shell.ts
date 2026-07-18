import { z } from 'zod';
import type { Bindings } from '../web-poc/worker/context.ts';
import type { Database } from '../web-poc/lib/db/index.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { createWorkspace, getWorkspace, listWorkspaces } from '../web-poc/lib/db/queries/workspaces.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE_ID, readWorkspaceCookie } from './shell-routing.ts';
import { canvasHiddenFrom, mayFlipCanvas } from './visibility.ts';

// The edge Shell's DB-touching half (ADR-0007, #46): the workspace registry API the
// launcher calls, and the static launcher HTML itself. Served entirely at the edge —
// listing/creating a workspace never wakes a container. The PURE routing/selection
// decisions live in `shell-routing.ts`.

const db = (env: Env) => createDbForWorker(env as unknown as Bindings);

// Single contract for the registry API payloads (CLAUDE.md §7): both the launcher's
// inline client and this handler speak these shapes.
const CreateWorkspaceInput = z.object({ name: z.string().trim().min(1).max(100) });
const WorkspaceView = z.object({ id: z.string(), name: z.string() });
export type WorkspaceView = z.infer<typeof WorkspaceView>;

/**
 * The Shell's workspace registry API (owner-OR-member — #179):
 *   GET  /api/workspaces           → { workspaces: WorkspaceView[] }
 *   POST /api/workspaces {name}     → the created WorkspaceView
 * The legacy `default` workspace has a real seeded row since #179 and appears only
 * for its owner/members (presented first when accessible) — no hardcoded entry.
 */
export async function handleWorkspacesApi(request: Request, env: Env, user: GateUser): Promise<Response> {
  if (request.method === 'GET') {
    const rows = await listWorkspaces(db(env), user.id);
    const workspaces: WorkspaceView[] = [
      ...rows.filter((w) => w.id === DEFAULT_WORKSPACE_ID),
      ...rows.filter((w) => w.id !== DEFAULT_WORKSPACE_ID),
    ].map((w) => ({ id: w.id, name: w.name }));
    return Response.json({ workspaces });
  }
  if (request.method === 'POST') {
    const parsed = CreateWorkspaceInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid name' }, { status: 400 });
    const ws = await createWorkspace(db(env), { name: parsed.data.name, ownerUserId: user.id });
    return Response.json({ id: ws.id, name: ws.name }, { status: 201 });
  }
  return new Response('method not allowed', { status: 405 });
}

// Single contract for the canvas registry API (CLAUDE.md §7). Both the Shell's canvas
// selector and this handler speak these shapes. ADR-0016: `visibility` + `mine` ride on
// every row; `locked` rows (someone else's private canvas) appear ONLY to the workspace
// owner — the manage-not-read list (name + creator, never openable). Selectors must
// exclude locked rows.
const CreateCanvasInput = z.object({ name: z.string().trim().min(1).max(100) });
const PatchCanvasInput = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  visibility: z.enum(['workspace', 'private']).optional(),
});
const CanvasView = z.object({
  id: z.string(),
  name: z.string(),
  visibility: z.enum(['workspace', 'private']),
  mine: z.boolean(),
  locked: z.boolean().optional(),
  createdBy: z.string().nullable().optional(),
});
export type CanvasView = z.infer<typeof CanvasView>;

/**
 * Resolve the active workspace for a request from the `cs_workspace` cookie (set by
 * /w/:id), enforcing access (owner-OR-member — #179; `default` has a seeded row and is
 * checked like any other). Returns the workspace id to scope by, or null when the
 * selection is unknown/inaccessible (⇒ the caller 404s). Shared with the edge Inbox
 * list (worker/inbox.ts), which scopes to the same active workspace as `/api/canvases`.
 */
export async function activeWorkspaceId(request: Request, database: Database, user: GateUser): Promise<string | null> {
  const selected = readWorkspaceCookie(request.headers.get('cookie')) ?? DEFAULT_WORKSPACE_ID;
  const ws = await getWorkspace(database, selected, user.id);
  return ws ? ws.id : null;
}

/**
 * The Canvas app's registry API, scoped to the active workspace (from `cs_workspace`):
 *   GET    /api/canvases            → { workspaceId, canvases: CanvasView[] }
 *   POST   /api/canvases {name}      → the created CanvasView (201)
 *   PATCH  /api/canvases/:id {name}  → the renamed CanvasView
 *   DELETE /api/canvases/:id         → 204
 * Mutations verify the target canvas belongs to the active workspace (never cross-
 * workspace). Mirrors handleWorkspacesApi — served at the edge, so listing/creating a
 * canvas never wakes a container.
 */
export async function handleCanvasesApi(
  request: Request,
  database: Database,
  user: GateUser,
  canvasId?: string,
): Promise<Response> {
  const selected = readWorkspaceCookie(request.headers.get('cookie')) ?? DEFAULT_WORKSPACE_ID;
  const activeWs = await getWorkspace(database, selected, user.id);
  const workspaceId = activeWs ? activeWs.id : null;
  const isOwner = !!activeWs && activeWs.ownerUserId === user.id;

  // ADR-0016 projection: visible rows carry visibility + mine; the workspace owner
  // additionally sees others' private rows as `locked` (manage-not-read — never openable).
  const view = (c: { id: string; name: string; visibility: 'workspace' | 'private'; createdBy: string | null }): CanvasView => {
    const hidden = canvasHiddenFrom(c, user.id);
    return {
      id: c.id,
      name: c.name,
      visibility: c.visibility,
      mine: c.createdBy === user.id,
      ...(hidden ? { locked: true, createdBy: c.createdBy } : {}),
    };
  };

  if (!canvasId) {
    if (request.method === 'GET') {
      // Canvas pairing: the Inbox attach panel lists the CONVERSATION's workspace, which may
      // differ from the rail's cs_workspace cookie — an explicit ?workspace= wins for the
      // read, ownership-checked exactly like the cookie. Mutations below never honor it.
      const named = new URL(request.url).searchParams.get('workspace');
      const listWorkspaceId = named
        ? named === DEFAULT_WORKSPACE_ID || (await getWorkspace(database, named, user.id))
          ? named
          : null
        : workspaceId;
      if (!listWorkspaceId) return Response.json({ error: 'workspace not found' }, { status: 404 });
      // Owner-ness for the LIST is judged against the listed workspace (it may differ
      // from the cookie's), so the manage-not-read rows show in the right place.
      const listWs = await getWorkspace(database, listWorkspaceId, user.id);
      const listOwner = !!listWs && listWs.ownerUserId === user.id;
      const rows = await canvasRegistry.list(database, listWorkspaceId);
      const canvases: CanvasView[] = rows
        .filter((c) => !canvasHiddenFrom(c, user.id) || listOwner)
        .map(view);
      return Response.json({ workspaceId: listWorkspaceId, canvases });
    }
    if (!workspaceId) return Response.json({ error: 'workspace not found' }, { status: 404 });
    if (request.method === 'POST') {
      const parsed = CreateCanvasInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: 'invalid name' }, { status: 400 });
      const row = await canvasRegistry.create(database, { workspaceId, name: parsed.data.name, createdBy: user.id });
      return Response.json(view(row), { status: 201 });
    }
    return new Response('method not allowed', { status: 405 });
  }

  // Per-canvas mutations: the target must belong to the active workspace. A private
  // canvas is 404 (same as missing) to everyone but its creator — except the workspace
  // owner, who may manage it (visibility→workspace, delete) without reading it.
  const existing = await canvasRegistry.get(database, canvasId);
  if (!existing || existing.workspaceId !== workspaceId) {
    return Response.json({ error: 'canvas not found' }, { status: 404 });
  }
  const hidden = canvasHiddenFrom(existing, user.id);
  if (hidden && !isOwner) return Response.json({ error: 'canvas not found' }, { status: 404 });

  if (request.method === 'PATCH') {
    const parsed = PatchCanvasInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success || (!parsed.data.name && !parsed.data.visibility)) {
      return Response.json({ error: 'invalid body' }, { status: 400 });
    }
    if (parsed.data.visibility && parsed.data.visibility !== existing.visibility) {
      if (!mayFlipCanvas(existing, user.id, isOwner, parsed.data.visibility)) {
        return Response.json({ error: 'only the creator can change visibility' }, { status: 403 });
      }
      const flipped = await canvasRegistry.setVisibility(database, canvasId, parsed.data.visibility);
      if (!flipped) return Response.json({ error: 'canvas not found' }, { status: 404 });
      existing.visibility = flipped.visibility;
    }
    if (parsed.data.name) {
      // Renaming a private canvas is reading-adjacent: creator only (the owner's
      // manage powers are force-publish + delete, not editing).
      if (hidden) return Response.json({ error: 'only the creator can rename' }, { status: 403 });
      const row = await canvasRegistry.rename(database, canvasId, parsed.data.name);
      if (!row) return Response.json({ error: 'canvas not found' }, { status: 404 });
      return Response.json(view(row));
    }
    return Response.json(view({ ...existing }));
  }
  if (request.method === 'DELETE') {
    await canvasRegistry.delete(database, canvasId);
    return new Response(null, { status: 204 });
  }
  return new Response('method not allowed', { status: 405 });
}

// The edge login page (ADR-0007, #47 cutover). With `cs_gate` gone, the edge Better Auth
// gate is the sole gate: any unauthenticated request to a non-public route is DENIED here
// and served this page instead of the container. It is self-contained static HTML (the
// no-container constraint — it can't pull `/src`) that posts email/password to the PUBLIC
// Better Auth endpoints (`/api/auth/*`, served at the edge), so a user signs in without a
// container ever waking. On success the session cookie is set and it reloads to `/`.
// Served with 401 so the deny is machine-legible (matches the pre-cutover gate status).
export function renderLogin(): Response {
  return new Response(LOGIN_HTML, {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const LOGIN_HTML = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>cedarpad</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0b0b0c;color:#e7e7ea;display:grid;place-content:center;min-height:100vh}
.card{width:340px;border:1px solid #2c2c33;border-radius:12px;padding:24px;background:#141416}
h1{font-size:18px;font-weight:600;margin:0 0 4px}
p.sub{color:#8a8a92;margin:0 0 18px;font-size:13px}
label{display:block;font-size:12px;color:#8a8a92;margin:12px 0 4px}
input{width:100%;background:#0b0b0c;border:1px solid #2c2c33;color:#e7e7ea;padding:9px 12px;border-radius:8px;font:inherit}
button{width:100%;margin-top:18px;background:#4b6bff;border:0;color:#fff;padding:10px 16px;border-radius:8px;cursor:pointer;font:inherit}
button:disabled{opacity:.5;cursor:default}
.err{color:#ff6b6b;font-size:13px;margin-top:12px;min-height:16px}
.toggle{margin-top:16px;text-align:center;font-size:13px;color:#8a8a92}
</style></head><body>
<div class=card>
  <h1>cedarpad</h1>
  <p class=sub id=sub>Sign in to continue.</p>
  <form id=f>
    <label for=email>Email</label><input id=email type=email autocomplete=email required>
    <label for=pw>Password</label><input id=pw type=password autocomplete=current-password required>
    <button id=go type=submit>Log in</button>
    <div class=err id=err></div>
  </form>
  <div class=toggle>Accounts are created by invitation.</div>
</div>
<script>
// #179: no public signup — AUTH_DISABLE_SIGNUP stays on and the ONLY account-creation
// door is the /invite/<token> accept flow, so the old Sign-up toggle (dead in prod,
// server-rejected) is gone.
const err=document.getElementById('err'),go=document.getElementById('go');
document.getElementById('f').onsubmit=async(e)=>{
  e.preventDefault();err.textContent='';go.disabled=true;
  const email=document.getElementById('email').value.trim();
  const password=document.getElementById('pw').value;
  try{
    const r=await fetch('/api/auth/sign-in/email',{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},body:JSON.stringify({email,password})});
    if(r.ok){
      // #177: an interrupted OAuth authorize (/api/auth/mcp/authorize with no session)
      // redirected HERE with its query intact — continue it instead of landing on '/'.
      const q=new URLSearchParams(location.search);
      location.href=(q.has('client_id')&&q.has('redirect_uri')&&q.has('response_type'))
        ?'/api/auth/mcp/authorize'+location.search:'/';
      return;
    }
    const d=await r.json().catch(()=>null);
    err.textContent=(d&&(d.message||d.error))||'Sign in failed';
  }catch(_){err.textContent='Something went wrong';}
  go.disabled=false;
};
</script></body></html>`;
