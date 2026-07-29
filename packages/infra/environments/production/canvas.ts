import { cloudflareModule } from '../../modules/cloudflare'
import canvasEmail from './canvas-email'

/**
 * canvas — tldraw canvas + Claude agent (imported from the ceo repo). A Worker
 * gates access (edge Better Auth — ADR-0007) and proxies into a
 * Durable-Object-owned Container running the vite + bridge dev stack. Branded
 * entry host poc.cedarpad.com, declared as a `custom_domain` in the package's
 * wrangler.jsonc (wrangler provisions the DNS record + cert on deploy). Canvas
 * state, the code overlay, and Claude session transcripts persist to R2 bucket
 * `agent-canvas` and restore on boot.
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
 * `scripts/deploy.sh` before each rollout. D1 is the platform data layer's store; the
 * Turso rollback path was retired in #268.
 *
 * No build step: the worker is bundled by wrangler and the container is built from
 * the package's Dockerfile (Docker must be running locally at apply time, on a
 * Workers Paid plan with Containers enabled).
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
  imports: [canvasEmail],
  config: {
    workdir: 'packages/canvas',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerSecrets: [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'R2_BUCKET',
      'R2_ENDPOINT',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      // web-poc is mounted into the canvas bridge (one instance), so its secrets ride
      // this container too. Must exist in production/secrets.yaml. (BETTER_AUTH_URL /
      // WEB_ORIGIN are non-secret vars in the package's wrangler.jsonc.)
      'VOYAGE_API_KEY',
      'BETTER_AUTH_SECRET',
      // Dev-agent GitHub App auth (#96). The EDGE mints short-lived, repo-scoped
      // installation tokens from these; the private key stays at the edge and is NEVER
      // forwarded into the container (containerEnv) — the container is the RCE boundary
      // (ADR-0008), so only the ~1h minted token ever reaches it. Provisioned in
      // production/secrets.yaml.
      'GITHUB_APP_ID',
      'GITHUB_APP_INSTALLATION_ID',
      'GITHUB_APP_PRIVATE_KEY',
      // Huddles (ADR-0017): LiveKit Cloud signing keys, edge-only — the container gets
      // short-lived minted room tokens, never these. Provisioned in production/secrets.yaml.
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      // Per-repo PAT sealing key (ADR-0016, worker/secret-box.ts) — edge-only; the
      // container sees opened tokens transiently per turn/fetch, never this key.
      'REPO_TOKEN_KEY',
      // fredrin MCP bearer (ADR-0013 train 2) — edge-only; rides each chat send as the
      // x-mcp-tokens header, never container env.
      'FREDRIN_KEY',
      // Web push VAPID keypair (#87). Unlike the secrets above, the PRIVATE half IS
      // forwarded into the container (worker/container-env.ts): the `notify` seam that
      // signs and sends lives in the bridge, not at the edge. Deliberate, narrow exception
      // to the ADR-0008 edge-only rule — the capability it grants is "send a notification
      // to an endpoint already in push_subscriptions", and it reads nothing. VAPID_SUBJECT
      // is the RFC 8292 contact the push service may reach us at.
      'VAPID_PUBLIC_KEY',
      'VAPID_PRIVATE_KEY',
      'VAPID_SUBJECT',
    ],
    // Single always-warm DO-bound container; the gradual default never drains it,
    // so a redeployed image would silently never take effect. Roll immediately.
    immediateContainerRollout: true,
  },
})
