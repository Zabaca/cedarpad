import { cloudflareModule } from '../../modules/cloudflare'

/**
 * canvas — tldraw canvas + Claude agent (imported from the ceo repo). A Worker
 * gates access (the shared-secret `cs_gate` cookie) and proxies into a
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
 * CLAUDE_CODE_OAUTH_TOKEN (the agent), GATE_SECRET (the access gate), and four
 * R2 S3 creds R2_BUCKET / R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY.
 *
 * R2 cred coupling: the R2 S3 creds are derived from the CF API token
 * (accessKeyId = token id, secretAccessKey = sha256hex(token value)), so rotating
 * CLOUDFLARE_API_TOKEN invalidates them — recompute and re-`sops set` the four
 * R2_* keys on rotation.
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
  config: {
    workdir: 'packages/canvas',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerSecrets: [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'GATE_SECRET',
      'R2_BUCKET',
      'R2_ENDPOINT',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      // web-poc is mounted into the canvas bridge (one instance), so its secrets ride
      // this container too. Must exist in production/secrets.yaml. (BETTER_AUTH_URL /
      // WEB_ORIGIN are non-secret vars in the package's wrangler.jsonc.)
      'TURSO_URL',
      'TURSO_KEY',
      'VOYAGE_API_KEY',
      'BETTER_AUTH_SECRET',
    ],
    // Single always-warm DO-bound container; the gradual default never drains it,
    // so a redeployed image would silently never take effect. Roll immediately.
    immediateContainerRollout: true,
  },
})
