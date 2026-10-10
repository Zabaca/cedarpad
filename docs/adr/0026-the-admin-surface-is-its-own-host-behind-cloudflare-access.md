# The admin surface is its own host behind Cloudflare Access

Status: **accepted** (2026-10-09). Supersedes the admin clause of
[ADR-0014](./0014-cedarpad-com-domain-topology.md) ("There is no `admin.cedarpad.com`").
Vocabulary: root [CONTEXT.md](../../CONTEXT.md).

## Decision

The operator view lives at **`admin.cedarpad.com`**, served by the same `agent-canvas`
Worker, behind a **Cloudflare Zero Trust (Access) application** that admits one address,
`james@zabaca.com`. Both the application and its policy are declared in zbc
(`packages/infra/environments/production/admin-access.ts`, with its own minted credential
`admin-access-token.ts`), copied from games' `railmid-access`, which runs on the same
account and team (`zabaca.cloudflareaccess.com`).

The Worker **verifies the Access assertion itself** (`worker/access-jwt.ts`, ported from
games): RS256 against the team's published keys, `iss`, `aud`, `exp`, `nbf`. The team domain
and audience tag reach the Worker as secrets from the access instance's outputs. Missing
config, a missing assertion or any verification failure is a refusal. This matters because
the same Worker also answers on `app.cedarpad.com` and (preview) `workers.dev`, where
Access is not in front of it.

The page (`worker/admin-page.ts`) is server-rendered and read-only: users (last seen from
sessions), workspaces (owner, members, canvas/component/skill counts), where each
workspace's container runs and its last boot, share links and MCP tokens. It is one D1 read
whose query names every column (`web-poc/lib/db/queries/admin-overview.ts`), so no session
token, MCP token, OAuth secret, IP or user agent can reach the markup. ADR-0014's "no
transcript viewing" still holds.

## Why not ADR-0014's `app.cedarpad.com/admin`

ADR-0014 rejected a separate admin host because it "would need its own auth origin (or
`.cedarpad.com`-wide cookies)". That cost belonged to Better Auth; under Access the admin
page reads no Better Auth session at all. A host of its own lets Access gate the whole
hostname without a path rule on the product host, keeps the product's cookies and sign-in
out of play, and keeps the admin page out of reach of anything a canvas component can
script on `app.`.

Every other zabaca admin surface (railmid, zabaca-web, qom, leeandco) protects a PATH on a
public host. This one is a deliberate exception, for the reason above.

## Consequences

- The route `admin.cedarpad.com` is declared at the **top level** of `wrangler.jsonc` only.
  `env.preview` keeps `routes: []`; a preview deploy that inherited routes once moved
  production's domains onto the preview Worker.
- Applying `production canvas` now applies `admin-access-token` and `admin-access` first
  (imports). Minting the token needs `CLOUDFLARE_ROOT_TOKEN` in
  `production/secrets.yaml`.
- The existing role-gated `/api/admin/waitlist` (Settings) is unchanged.
- Revoking access is deleting an address from `emails` and applying.
