# Accessing the Notebook API (internal + remote)

How Notebook's HTTP API (`/v1/*`, Better Auth `/api/auth/*`) is reached inside
`@cedarpad/canvas`. Covers the internal canvas↔notebook path, the auth model,
remote access, and the "should canvas hold an API key" question.

## Where the API lives

There is **no standalone notebook endpoint**. The API is exposed only through
the **canvas Worker origin**:

- **preview:** `https://agent-canvas-preview.james-99a.workers.dev`
- **prod:** `https://poc.cedarpad.com`

The Worker gates **nothing user-facing** — there is no cs_gate cookie. Auth is
in-app: Better Auth login for humans, `x-api-key` for programmatic callers.
(`GATE_SECRET` survives only as the `x-ops-key` header on the worker's
`/__recycle` + `/__bootlog` deploy-ops endpoints.)

## Internal communication (canvas ↔ notebook)

Notebook is **part of the package, mounted in one process** — not a separate
service. There is no RPC between "canvas" and "notebook".

**Frontend seam — direct React mount.** Notebook's UI is `NotebookApp`
(`src/notebook/App.tsx`), lazy-imported by the host `src/App.tsx` into the same
React 19 tree (the host also owns the login gate). Its data client
(`src/notebook/api.ts`, `openapi-fetch`) uses `baseUrl: ""` — same-origin
relative requests to `/v1/*` and `/api/auth/*`.

**Backend seam — in-process dispatch.** Those requests reach the canvas
**bridge** (`server/bridge.ts`), which matches the path and calls
`notebookApp.fetch(req, notebookEnv)` — a direct in-process invocation of the
notebook Hono app (`server/notebook/index.ts` `buildApp`), **no network hop**.
Notebook queries its own libSQL/Turso DB (the single `@libsql/client` the bridge
built and injected via `makeDb`). Canvas's own state is separate (R2).

Request flow for a `/v1/...` call:

```
# dev
notebook client (baseUrl "")  ->  localhost:4510/v1/...  (vite dev server)
    └─ vite proxy ('/v1' -> CANVAS_BRIDGE)  ->  localhost:4511  (bridge, bun)
        └─ bridge: path.startsWith('/v1/')  ->  notebookApp.fetch(req, notebookEnv)   # in-process
            └─ notebook Hono app  ->  libSQL/Turso

# prod (one Cloudflare instance)
browser  ->  canvas Worker (poc.cedarpad.com)  ->  sandbox preview-proxy  ->  container vite :4510
    └─ vite proxy ('/v1' -> bridge :4511)  ->  bridge (bun)
        └─ notebookApp.fetch(req, notebookEnv)  ->  notebook Hono app  ->  remote Turso
```

> **Ordering constraint:** in `bridge.ts` the `/v1` + `/api/auth/*` branch **must
> precede** canvas's own `/api/*` routes — `/api/auth/*` shares the `/api`
> namespace, so canvas's `/api/*` handlers (and the canvas session gate) would
> otherwise shadow Better Auth.

## The auth model — who needs which credential

| Surface | Credential | Enforced by |
|---|---|---|
| App UI (canvas + notebook) | Better Auth **session cookie** (login) | frontend `Gate` (`src/App.tsx`) + the bridge's canvas-API gate |
| Canvas `/api/*` (sync, SSE, chat, capture, custom) | session cookie — or `x-internal-key` for in-stack callers | bridge (`server/bridge.ts`, 60s cached `getSession`) |
| Notebook `/v1/*` | session cookie **or** `x-api-key` | `authMiddleware` (`server/notebook/middleware.ts`) |
| `/api/auth/*` (login) | public (that's the point) | Better Auth; **signup disabled in prod** (`AUTH_DISABLE_SIGNUP=1`) |
| `/api/health`, `/api/status`, `/health` | open | — (liveness/ops-health only) |
| `/__recycle`, `/__bootlog` | `x-ops-key: <GATE_SECRET>` header | worker (`worker/index.ts`) — deploy tooling only |

On `/v1/*`, `authMiddleware` runs `auth.api.getSession(headers)`; the Better
Auth **apiKey** plugin (`enableSessionForAPIKeys: true`,
`server/notebook/auth.ts`) makes both a session cookie and an `x-api-key`
resolve through that one call:

- Human session → scope from the user's allowlist, target = active workspace.
- `x-api-key` → agent (`isAgent=true`), scope from the key's
  `metadata.allowedWorkspaces`, target = `metadata.defaultWorkspaceId`.
- Local dev only: `DEV_AUTH_WORKSPACE` env + `x-dev-workspace` header — full
  access, no auth. **Never set on preview/prod.**

API keys are **owned by a user** (`referenceId → user_id`) and created in the
UI (Notebook → user menu → API keys), scoped per workspace via key metadata.

## Remote / programmatic access

One credential — the API key. No gate cookie, no second secret:

```bash
curl -X POST https://poc.cedarpad.com/v1/observations \
  -H "x-api-key: <your-api-key>" \
  -H "content-type: application/json" \
  -d '{"title":"...","body":"..."}'
```

(`x-api-key` uses the API-key path, so it does **not** need the browser
`Origin`/CSRF header that interactive `/api/auth` login requires.)

**Security posture:** login and `/v1` are internet-facing. Signup is disabled in
production, keys are scoped + revocable, and the canvas API (which fronts the
container agent) requires a session. Adding a new prod user means temporarily
lifting `AUTH_DISABLE_SIGNUP` (vars-only redeploy) or seeding directly.

## Canvas → `/v1` (service-to-service): API key or not?

**Default: don't wire this.** Canvas does **not** call `/v1` server-side today —
the only caller is the notebook UI (user session) — and it shouldn't gain a
standing service credential speculatively (YAGNI; every key is attack surface +
rotation burden). If a concrete need for autonomous canvas→notebook writes
appears, avoid three things regardless: a **network** self-call to `/v1` (loop
in-process instead), a **shared service key for writes that are really the
user's** (forward the session), and a bespoke **trust bypass**. A scoped,
revocable API key is the least-bad option *when autonomous, system-attributed
writes are genuinely required* — not before.

Canvas and notebook are **one process sharing one DB handle**, so an API key is
not needed for *transport* — only for **identity + workspace scope**:

- **Fixed service/agent identity** (writes attributed to "the canvas agent") →
  an **API key is the idiomatic choice** (what the apiKey plugin is for).
- **The logged-in user's identity** → forward the user's session, don't use a
  shared key.

If using a service key, **call it in-process** — don't make a network self-call:

```ts
// canvas server code — no network hop, still runs authMiddleware
await notebookApp.fetch(new Request('http://internal/v1/observations', {
  method: 'POST',
  headers: { 'x-api-key': env.NOTEBOOK_SERVICE_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ title, body }),
}), notebookEnv)
```

## Related: custom handlers → canvas API

Agent-authored custom handlers (`server/custom/*`, run by the extension server)
are a different process, so their calls to the core `/api/canvas` are real HTTP —
they authenticate with `x-internal-key: CANVAS_INTERNAL_KEY` (both env vars are
in the handler's process env; the key is minted per boot by `scripts/dev.ts`).
