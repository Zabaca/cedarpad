import { z } from 'zod';
import type { Bindings } from '../web-poc/worker/context.ts';
import type { Database } from '../web-poc/lib/db/index.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { createWorkspace, getWorkspace, listWorkspaces } from '../web-poc/lib/db/queries/workspaces.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE_ID, readWorkspaceCookie } from './shell-routing.ts';

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
 * The Shell's workspace registry API (owner-scoped):
 *   GET  /api/workspaces           → { workspaces: WorkspaceView[] }
 *   POST /api/workspaces {name}     → the created WorkspaceView
 * The legacy `default` workspace is always presented first — it has no registry row
 * but is a real, openable workspace (the prod container).
 */
export async function handleWorkspacesApi(request: Request, env: Env, user: GateUser): Promise<Response> {
  if (request.method === 'GET') {
    const rows = await listWorkspaces(db(env), user.id);
    const workspaces: WorkspaceView[] = [
      { id: DEFAULT_WORKSPACE_ID, name: 'Default' },
      ...rows.map((w) => ({ id: w.id, name: w.name })),
    ];
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
// selector and this handler speak these shapes.
const CreateCanvasInput = z.object({ name: z.string().trim().min(1).max(100) });
const RenameCanvasInput = z.object({ name: z.string().trim().min(1).max(100) });
const CanvasView = z.object({ id: z.string(), name: z.string() });
export type CanvasView = z.infer<typeof CanvasView>;

/**
 * Resolve the active workspace for a canvas-registry call from the `cs_workspace`
 * cookie (set by /w/:id), enforcing ownership. Returns the workspace id to scope by,
 * or null when the selection is an unknown/non-owned workspace (⇒ the caller 404s).
 * The `default` id needs no registry row (the legacy prod workspace).
 */
async function activeWorkspaceId(request: Request, database: Database, user: GateUser): Promise<string | null> {
  const selected = readWorkspaceCookie(request.headers.get('cookie')) ?? DEFAULT_WORKSPACE_ID;
  if (selected === DEFAULT_WORKSPACE_ID) return DEFAULT_WORKSPACE_ID;
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
  const workspaceId = await activeWorkspaceId(request, database, user);
  if (!workspaceId) return Response.json({ error: 'workspace not found' }, { status: 404 });

  if (!canvasId) {
    if (request.method === 'GET') {
      const rows = await canvasRegistry.list(database, workspaceId);
      const canvases: CanvasView[] = rows.map((c) => ({ id: c.id, name: c.name }));
      return Response.json({ workspaceId, canvases });
    }
    if (request.method === 'POST') {
      const parsed = CreateCanvasInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: 'invalid name' }, { status: 400 });
      const row = await canvasRegistry.create(database, { workspaceId, name: parsed.data.name });
      return Response.json({ id: row.id, name: row.name }, { status: 201 });
    }
    return new Response('method not allowed', { status: 405 });
  }

  // Per-canvas mutations: the target must belong to the active workspace.
  const existing = await canvasRegistry.get(database, canvasId);
  if (!existing || existing.workspaceId !== workspaceId) {
    return Response.json({ error: 'canvas not found' }, { status: 404 });
  }
  if (request.method === 'PATCH') {
    const parsed = RenameCanvasInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid name' }, { status: 400 });
    const row = await canvasRegistry.rename(database, canvasId, parsed.data.name);
    if (!row) return Response.json({ error: 'canvas not found' }, { status: 404 });
    return Response.json({ id: row.id, name: row.name });
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
.toggle a{color:#4b6bff;cursor:pointer}
#nameRow{display:none}
</style></head><body>
<div class=card>
  <h1>cedarpad</h1>
  <p class=sub id=sub>Sign in to continue.</p>
  <form id=f>
    <div id=nameRow><label for=name>Name</label><input id=name autocomplete=name></div>
    <label for=email>Email</label><input id=email type=email autocomplete=email required>
    <label for=pw>Password</label><input id=pw type=password autocomplete=current-password required>
    <button id=go type=submit>Log in</button>
    <div class=err id=err></div>
  </form>
  <div class=toggle id=toggle>No account yet? <a id=swap>Sign up</a></div>
</div>
<script>
let signup=false;
const err=document.getElementById('err'),go=document.getElementById('go');
document.getElementById('swap').onclick=()=>{
  signup=!signup;
  document.getElementById('nameRow').style.display=signup?'block':'none';
  document.getElementById('sub').textContent=signup?'Create your account.':'Sign in to continue.';
  go.textContent=signup?'Sign up':'Log in';
  document.getElementById('toggle').innerHTML=signup
    ?'Already have an account? <a id=swap>Log in</a>':'No account yet? <a id=swap>Sign up</a>';
  document.getElementById('swap').onclick=arguments.callee;
  err.textContent='';
};
document.getElementById('f').onsubmit=async(e)=>{
  e.preventDefault();err.textContent='';go.disabled=true;
  const email=document.getElementById('email').value.trim();
  const password=document.getElementById('pw').value;
  const name=document.getElementById('name').value.trim();
  const path=signup?'/api/auth/sign-up/email':'/api/auth/sign-in/email';
  const body=signup?{email,password,name:name||email}:{email,password};
  try{
    const r=await fetch(path,{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(r.ok){location.href='/';return;}
    const d=await r.json().catch(()=>null);
    err.textContent=(d&&(d.message||d.error))||(signup?'Sign up failed':'Sign in failed');
  }catch(_){err.textContent='Something went wrong';}
  go.disabled=false;
};
</script></body></html>`;
