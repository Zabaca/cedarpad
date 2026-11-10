import { cloudflareModule } from '../../../../vendor/zbc/modules/cloudflare'
import canvasEmail from './canvas-email'
import adminAccess from './admin-access'

/**
 * canvas — tldraw canvas + Claude agent (imported from the ceo repo). A Worker
 * gates access (edge Better Auth — ADR-0007) and proxies into each workspace's
 * CanvasContainer (a Durable Object on the `durable_object` container policy) running
 * the vite + bridge dev stack. Entry host app.cedarpad.com, declared as a
 * `custom_domain` in the package's wrangler.jsonc (wrangler provisions the DNS record +
 * cert on deploy).
 *
 * The worker NAME stays `agent-canvas` so deploying from here updates the same
 * Cloudflare worker in place (same account 99a1…4372b that owns the cedarpad.com
 * zone + R2 bucket) — no new worker, no domain re-bind, no R2 migration.
 *
 * Requires in the environment's secrets.yaml: CLOUDFLARE_API_TOKEN (deploy),
 * CLAUDE_CODE_OAUTH_TOKEN (the agent) and four
 * R2 S3 creds R2_BUCKET / R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.
 *
 * R2 cred coupling: the R2 S3 creds are derived from the CF API token
 * (accessKeyId = token id, secretAccessKey = sha256hex(token value)), so rotating
 * CLOUDFLARE_API_TOKEN invalidates them — recompute and re-`sops set` the four
 * R2_* keys on rotation.
 *
 * Platform data layer (ADR-0018, #265): D1 `cedarpad-platform`, bound as PLATFORM_DB in
 * the package's wrangler.jsonc. Created once, out of band, the same way the waitlist D1
 * was (see www.ts) — the cloudflare module is a wrangler deploy orchestrator and does not
 * provision databases:
 *
 *   sops exec-env packages/infra/environments/production/secrets.yaml \
 *     'cd packages/canvas && CLOUDFLARE_ACCOUNT_ID=<accountId> \
 *        ./node_modules/.bin/wrangler d1 create cedarpad-platform'
 *
 * then paste the printed database_id into wrangler.jsonc (top level AND the preview env —
 * named environments inherit nothing). Schema migrations are applied by
 * `scripts/deploy.sh` before each deploy. D1 is the platform data layer's store; the
 * Turso rollback path was retired in #268.
 *
 * Build: the Shell SPA (`bun run build` → shell/dist, the `assets` directory) runs before
 * the deploy; wrangler bundles the Worker and builds the container image from the
 * package's Dockerfile (Docker must be running locally at apply time, on a Workers Paid
 * plan with Containers enabled).
 */
export default cloudflareModule.instance({
  // zbc instance id (matches the package + filename). The deployed Cloudflare WORKER
  // name is independent — it stays `agent-canvas` (set in the package's wrangler.jsonc)
  // so this updates the existing worker in place. (web-poc does the same: instance
  // `web-poc` deploys worker `cedarpad-web-poc`.)
  name: 'canvas',
  // Email Sending must be onboarded BEFORE this worker rolls out. The dependency is a
  // runtime one, not a build one — the `send_email` binding names no domain, so the
  // deploy itself would succeed either way — but auth is passwordless, so the first
  // login after a rollout sends a magic link, and a send from a domain that is not yet
  // enabled is a login outage rather than a degraded feature. The import makes zbc
  // apply canvas-email first instead of leaving the order to whoever runs the deploy.
  //
  // admin-access is imported for its outputs: the Worker verifies every admin.cedarpad.com
  // request's Access assertion against that application's team domain and audience tag
  // (ADR-0026, worker/access-jwt.ts), so both arrive as secrets below rather than being
  // hand-copied.
  imports: [canvasEmail, adminAccess],
  config: {
    workdir: 'packages/canvas',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerSecrets: [
      // Reaching the self-hosted workspace, an sbx sandbox (worker/self-hosted.ts, ADR-0028).
      // WS_SUPERVISOR_TOKEN is the bearer its supervisor demands on /__boot;
      // the CF_ACCESS pair is the Cloudflare Access service token that lets this
      // Worker through the two gates on the sandbox's addresses (declared in Home). All three must be
      // present or selfHostedTarget() returns null and the workspace falls back
      // to its Cloudflare Container — a half-configured target 403s every
      // request, so "not fully configured" deliberately means "not in effect".
      'WS_SUPERVISOR_TOKEN',
      'CF_ACCESS_CLIENT_ID',
      'CF_ACCESS_CLIENT_SECRET',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'R2_BUCKET',
      'R2_ENDPOINT',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      // The platform data layer's Better Auth secret. Must exist in production/secrets.yaml.
      // (BETTER_AUTH_URL / WEB_ORIGIN are non-secret vars in the package's wrangler.jsonc.)
      'BETTER_AUTH_SECRET',
      // Huddles (ADR-0017): LiveKit Cloud signing keys, edge-only — the container gets
      // short-lived minted room tokens, never these. Provisioned in production/secrets.yaml.
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      // fredrin MCP bearer (ADR-0013 train 2) — edge-only; rides each chat send as the
      // x-mcp-tokens header, never container env.
      'FREDRIN_KEY',
      // One FREDRIN_<LABEL>_KEY per extra Fredrin project → the `fredrin-<label>` connection.
      'FREDRIN_CEDARPAD_KEY',
      // The admin host's Access application (ADR-0026). Not secret in themselves, but pushed
      // as secrets (games' railmid.ts does the same) so they persist across deploys that do
      // not go through zbc: either missing makes admin.cedarpad.com refuse everything.
      { name: 'ACCESS_TEAM_DOMAIN', from: 'admin-access', output: 'teamDomain' },
      { name: 'ACCESS_AUD', from: 'admin-access', output: 'aud' },
    ],
    // The Shell SPA build wrangler's `assets` binding uploads. No container rollout flag:
    // under the `durable_object` policy there are no rollouts — a running container takes
    // a new image on its next request, through the DO's boot fingerprint.
    build: { command: 'bun run build' },
  },
})
