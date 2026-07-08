import { z } from 'zod';
import type { Bindings } from '../web-poc/worker/context.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { createWorkspace, listWorkspaces } from '../web-poc/lib/db/queries/workspaces.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE_ID } from './shell-routing.ts';

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

// The launcher: a self-contained static page (no bundler, inline JS/CSS — the strict
// no-container constraint means it can't pull `/src`). Lists the user's workspaces from
// /api/workspaces, creates one, opens one by navigating to /w/:id (the Worker sets the
// selection cookie and proxies that workspace's container). Top nav establishes the
// Canvas/Notebook/Inbox frame; Notebook/Inbox are placeholders this slice.
export function renderShell(): Response {
  return new Response(SHELL_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const SHELL_HTML = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>cedarpad</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0b0b0c;color:#e7e7ea}
header{display:flex;align-items:center;gap:20px;padding:14px 22px;border-bottom:1px solid #26262b}
header h1{font-size:17px;font-weight:600;margin:0}
nav{display:flex;gap:6px}
nav button{background:none;border:0;color:#9a9aa2;font:inherit;padding:6px 12px;border-radius:7px;cursor:pointer}
nav button.on{background:#26262b;color:#e7e7ea}
nav button:disabled{opacity:.4;cursor:default}
.sp{flex:1}
#out{background:none;border:1px solid #34343b;color:#c9c9d0;padding:6px 12px;border-radius:7px;cursor:pointer}
main{max-width:720px;margin:36px auto;padding:0 22px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.ws{border:1px solid #2c2c33;border-radius:11px;padding:16px;cursor:pointer;background:#141416}
.ws:hover{border-color:#4b6bff}
.ws b{display:block;font-size:15px}
.ws small{color:#8a8a92}
form{display:flex;gap:8px;margin:22px 0}
input{flex:1;background:#141416;border:1px solid #2c2c33;color:#e7e7ea;padding:9px 12px;border-radius:8px;font:inherit}
form button{background:#4b6bff;border:0;color:#fff;padding:9px 16px;border-radius:8px;cursor:pointer;font:inherit}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#8a8a92;margin:0 0 12px}
</style></head><body>
<header>
  <h1>cedarpad</h1>
  <nav>
    <button class=on title="Launcher">Canvas</button>
    <button disabled title="Coming soon">Notebook</button>
    <button disabled title="Coming soon">Inbox</button>
  </nav>
  <span class=sp></span>
  <button id=out>Sign out</button>
</header>
<main>
  <h2>Workspaces</h2>
  <div id=list class=grid>Loading…</div>
  <form id=make><input id=name placeholder="New workspace name" maxlength=100 required><button>Create</button></form>
</main>
<script>
const list=document.getElementById('list');
function open_(id){location.href='/w/'+encodeURIComponent(id);}
async function load(){
  const r=await fetch('/api/workspaces',{credentials:'same-origin'});
  if(!r.ok){list.textContent='Failed to load workspaces.';return;}
  const {workspaces}=await r.json();
  list.innerHTML='';
  for(const w of workspaces){
    const el=document.createElement('div');el.className='ws';
    el.innerHTML='<b></b><small>Open →</small>';el.querySelector('b').textContent=w.name;
    el.onclick=()=>open_(w.id);list.appendChild(el);
  }
}
document.getElementById('make').onsubmit=async(e)=>{
  e.preventDefault();const name=document.getElementById('name').value.trim();if(!name)return;
  const r=await fetch('/api/workspaces',{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json'},body:JSON.stringify({name})});
  if(r.ok){const w=await r.json();open_(w.id);}else{alert('Could not create workspace');}
};
document.getElementById('out').onclick=async()=>{
  await fetch('/api/auth/sign-out',{method:'POST',credentials:'same-origin'}).catch(()=>{});
  location.href='/';
};
load();
</script></body></html>`;
