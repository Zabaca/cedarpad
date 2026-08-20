import { cloudflareModule } from '../../../../vendor/zbc/modules/cloudflare'

/**
 * www — the marketing site at cedarpad.com (ADR-0014). An Astro site on its own
 * Worker, fully decoupled from the app worker: no auth, no platform D1, no container.
 * The one dynamic piece is the waitlist endpoint writing to the
 * `cedarpad-waitlist` D1 database, declared in the package's wrangler.jsonc.
 *
 * The D1 database must exist BEFORE the first apply — `wrangler deploy` only
 * binds an existing database_id:
 *   cd packages/www && bunx wrangler d1 create cedarpad-waitlist
 * then paste the printed uuid into wrangler.jsonc (both the top-level and
 * env.preview blocks) and apply the schema:
 *   bun run db:migrate:remote
 *
 * Requires in production/secrets.yaml: CLOUDFLARE_API_TOKEN (deploy). No worker
 * secrets — the waitlist D1 is a binding, not a credential.
 *
 * Unlike canvas (which builds in its deploy.sh), www uses the module's build
 * hook: `astro build` emits dist/ plus the derived wrangler config that
 * `wrangler deploy` picks up via .wrangler/deploy/config.json.
 */
export default cloudflareModule.instance({
  name: 'www',
  config: {
    workdir: 'packages/www',
    accountId: '99a19e584439be0568f33aad0477372b',
    build: { command: 'bun run build' },
  },
})
