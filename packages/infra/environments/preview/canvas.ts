import { cloudflareModule } from '../../modules/cloudflare'

/**
 * canvas — PREVIEW. The same package as production (`packages/canvas`: tldraw
 * canvas + Claude agent + the in-tree web-poc), deployed as a SEPARATE worker so
 * it never touches production.
 *
 * Isolation is via a wrangler named environment: `wranglerEnv: 'preview'` makes
 * the module run `wrangler deploy --env preview`, which selects the `env.preview`
 * block in `packages/canvas/wrangler.jsonc` — worker `agent-canvas-preview` on a
 * free `*.workers.dev` URL (no custom domain, so production's poc.cedarpad.com is
 * untouched). Same Cloudflare account as production (accountId below); the worker
 * NAME is what keeps them apart.
 *
 * Requires `packages/infra/environments/preview/secrets.yaml` (SOPS-encrypted)
 * holding CLOUDFLARE_API_TOKEN (deploy) + every key in `workerSecrets` below.
 * Preview has its OWN backing state — do NOT reuse production's:
 *   - R2: a separate bucket `agent-canvas-preview` (R2_BUCKET). R2 is reached via
 *     the S3 API (R2_ENDPOINT + R2_ACCESS_KEY_ID/SECRET), not a wrangler binding,
 *     so "own bucket" is purely these secret values — create the bucket first
 *     (`wrangler r2 bucket create agent-canvas-preview`). Sharing prod's bucket
 *     would mean preview and prod edit the SAME persisted canvas.
 *   - Turso: a separate DB (TURSO_URL/TURSO_KEY) for the mounted web-poc
 *     (`turso db create cedarpad-web-poc-preview` → url + `turso db tokens create`).
 *     Run web-poc migrations against it before use (webpoc:db:migrate with the
 *     preview TURSO_URL/TURSO_KEY).
 * As with production, Docker must be running locally at apply time (the worker is
 * container-backed) on a Workers Paid plan with Containers enabled.
 *
 * Deploy: `bunx @zabaca/zbc apply preview canvas` (or add a --env-aware path to
 * scripts/deploy.sh). After the first deploy, set BETTER_AUTH_URL / WEB_ORIGIN in
 * wrangler.jsonc's `env.preview.vars` to the real workers.dev origin, or auth
 * (Better Auth CSRF/Origin checks) will reject the deployed preview.
 */
export default cloudflareModule.instance({
  // zbc instance id — matches the package + filename, same as production. The
  // ENVIRONMENT (preview) + wranglerEnv is what differentiates the deployed worker.
  name: 'canvas',
  config: {
    workdir: 'packages/canvas',
    accountId: '99a19e584439be0568f33aad0477372b',
    // Selects env.preview in packages/canvas/wrangler.jsonc → agent-canvas-preview.
    wranglerEnv: 'preview',
    // Same secret NAMES as production (web-poc rides the canvas worker), but
    // preview-specific VALUES — R2_* points at the agent-canvas-preview bucket and
    // TURSO_* at the preview DB (see header). All must exist in preview/secrets.yaml.
    // BETTER_AUTH_URL / WEB_ORIGIN are non-secret vars in env.preview, not here.
    workerSecrets: [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'GATE_SECRET',
      'R2_BUCKET',
      'R2_ENDPOINT',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'TURSO_URL',
      'TURSO_KEY',
      'VOYAGE_API_KEY',
      'BETTER_AUTH_SECRET',
    ],
    // Single always-warm DO-bound container; roll immediately so a redeployed
    // image takes effect (see production canvas.ts).
    immediateContainerRollout: true,
  },
})
