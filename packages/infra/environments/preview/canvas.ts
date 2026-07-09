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
 * Currently REUSES production's values (secrets.yaml is a copy of production's), so
 * preview shares production's R2 bucket (`agent-canvas`) and Turso DB.
 * ⚠️  This means preview and production read/write the SAME persisted canvas state
 * and the SAME web-poc data — a preview edit can mutate what production serves at
 * poc.cedarpad.com. Give preview its own R2 bucket + Turso DB before using it for
 * anything real. As with production, Docker must be running locally at apply time
 * (the worker is container-backed) on a Workers Paid plan with Containers enabled.
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
    // Same secrets as production (web-poc rides the canvas worker) — currently the
    // SAME values (preview/secrets.yaml copies production/secrets.yaml), so R2_* and
    // TURSO_* point at prod's bucket + DB (see the ⚠️ in the header).
    // BETTER_AUTH_URL / WEB_ORIGIN are non-secret vars in env.preview, not here.
    workerSecrets: [
      'CLAUDE_CODE_OAUTH_TOKEN',
      'R2_BUCKET',
      'R2_ENDPOINT',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'TURSO_URL',
      'TURSO_KEY',
      'VOYAGE_API_KEY',
      'BETTER_AUTH_SECRET',
      // Dev-agent GitHub App auth (#96). The edge mints short-lived, repo-scoped
      // installation tokens from these; the private key stays at the edge and is NEVER
      // forwarded into the container (the RCE boundary, ADR-0008). Provisioned in
      // preview/secrets.yaml.
      'GITHUB_APP_ID',
      'GITHUB_APP_INSTALLATION_ID',
      'GITHUB_APP_PRIVATE_KEY',
    ],
    // Single always-warm DO-bound container; roll immediately so a redeployed
    // image takes effect (see production canvas.ts).
    immediateContainerRollout: true,
  },
})
