import { cloudflareModule } from '../../../../vendor/zbc/modules/cloudflare'

/**
 * www (preview) — deploys the marketing site as a SEPARATE worker
 * `cedarpad-www-preview` on a free *.workers.dev URL (wrangler.jsonc
 * env.preview), so it never touches production's cedarpad.com. Shares the
 * production `cedarpad-waitlist` D1 (same database_id), matching how canvas
 * preview shares production's platform D1.
 *
 * CLOUDFLARE_ENV=preview on the build is LOAD-BEARING: the Astro adapter flattens
 * wrangler config at build time into dist/server/wrangler.json, and `wrangler
 * deploy --env preview` follows that derived config — a plain build bakes the
 * production config (cedarpad.com apex route) and the --env flag is silently
 * ignored. The env var is what stamps targetEnvironment: "preview".
 *
 * Deploy: bunx @zabaca/zbc apply preview www
 */
export default cloudflareModule.instance({
  name: 'www',
  config: {
    workdir: 'packages/www',
    accountId: '99a19e584439be0568f33aad0477372b',
    build: { command: 'CLOUDFLARE_ENV=preview bun run build' },
    wranglerEnv: 'preview',
  },
})
