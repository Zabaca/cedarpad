import { defineConfig } from './vendor/zbc/src/index'

export default defineConfig({
  project: 'cedarpad',
  // `workspace` is the cedarpad canvas Guest on ryzen-9, converged over the
  // incus remote rather than deployed to Cloudflare. It is a THIRD environment
  // and not part of `production` on purpose: an apply of production must not
  // require ryzen-9 to be reachable, and `bun run apply production www` — the
  // command the release path already runs — would otherwise sweep a VM converge
  // into every page deploy. The workspace joins the release deliberately,
  // as its own step (foundry `remote-guests/10`).
  environments: ['production', 'preview', 'workspace'],
})
