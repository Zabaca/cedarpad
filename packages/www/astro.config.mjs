import cloudflare from '@astrojs/cloudflare'
import { defineConfig, sessionDrivers } from 'astro/config'

// Worktree-safe (guideline #6): the dev port comes from env. Canvas owns 4510/4511
// and the 4520–4900 worktree band, so www defaults to 4515.
const PORT = Number(process.env.PORT ?? 4515)

export default defineConfig({
  site: 'https://cedarpad.com',
  // Default output stays 'static' — the page is prerendered; only the waitlist
  // endpoint opts out with `export const prerender = false`.
  adapter: cloudflare({
    // No Cloudflare Images binding — the page ships no raster images.
    imageService: 'passthrough',
  }),
  // The site uses no sessions, but the adapter otherwise auto-enables its KV
  // driver and injects an id-less SESSION kv_namespace into the deploy config,
  // which fails `wrangler deploy`. An in-memory driver keeps sessions inert
  // without a KV namespace to provision.
  session: { driver: sessionDrivers.memory() },
  server: { port: PORT },
})
