# Components resolve in three tiers: canvas own → workspace shared → platform base

Status: accepted. Amends ADR-0007 Option B (per-canvas dirs) and the #55 `@shared` layer.

Every canvas resolves a component module name through three tiers, in order: its **own dir**
(`src/canvas-<id>/components/` — uniform for every canvas, `default` included), the **workspace
shared library** (`shared/components/`, the promote target), and the **platform base**
(`src/canvas-components/` — the image-baked seed library, read-only at runtime). The two
writable tiers persist to R2 (`canvas-components.tar` for all own dirs, `shared-components.tar`
for the shared lib); the platform tier ships with the image and is never flushed.

## Why

Two prod incidents exposed the old layout:

- **Promotion was a delete-with-extra-steps.** `promote_component` MOVES a file from a canvas
  own dir into `shared/components/` — which was in no persistence sink. A container restart
  didn't just lose the promotion; it deleted the component outright. Non-default canvas own
  dirs had the same hole: every component authored off the default canvas lived only until
  the next recycle.
- **The seed library was invisible off the default canvas.** `src/canvas-components/` doubled
  as the default canvas's own dir and the image's seed library, but resolution was own ∪
  shared — so a non-default canvas couldn't see MarkdownCard at all, and its agent re-authored
  a duplicate from scratch, then promoted it (into the unpersisted dir).

## Decision

- **Uniform own dirs.** `ownDir('default')` is `src/canvas-default/components/`, same scheme
  as every canvas. No canvas has a special path.
- **`src/canvas-components/` is the platform tier**: image-baked, resolved by every canvas as
  its final fallback, read-only at runtime. No tool writes there; writing a platform module
  name shadows it into the canvas own dir (own wins resolution). Platform updates ship by
  deploy.
- **Resolution order own → shared → base** everywhere: `server/components.ts`
  (list/read/edit), `src/component-loader.ts` (dynamic-import URL fallbacks).
- **Persistence follows writability.** Two new tars, flushed on the same mtime-guarded
  turn-completion path as before: `shared-components.tar` (`shared/components/`) and
  `canvas-components.tar` (every `src/canvas-<id>/components/`, tarred with src-relative
  paths; restore wipes exactly the canvas dirs and never touches the base or app code).

## Consequences

- Promote is durable; components authored on any canvas survive restarts.
- The legacy `components.tar` is still **restored** at boot (it holds the default workspace's
  historical library, which stays visible through the base tier position) but is never
  flushed again — nothing writes to that dir, so its mtime guard never fires. Known quirk:
  for a workspace with a saved `components.tar`, that restore wipe-and-replaces the platform
  dir, so image updates to seed components don't reach it until the legacy tar is retired.
- Existing placed instances keep working unchanged: a bare module name that used to live in
  `src/canvas-components/` now resolves via the base tier (default canvas) or shared/base
  fallbacks (other canvases).
- The default canvas pays two extra 404s the first time it imports a platform module (own,
  shared, then base) — absorbed by the loader's existing retry/nonce machinery.

## Considered and rejected

- **A separate `src/platform-components/` dir with curated moves.** Cleaner tiers, but forces
  a 60-file curation call and a one-time prod cleanup of the live workspace tar; the existing
  dir already IS the seed library — the actual bug was resolution visibility.
- **Per-canvas tars (`canvases/<id>/components.tar`).** Most granular, but N R2 round-trips on
  the cold-boot path we just spent #138/#141 shrinking, plus dynamic key enumeration at boot.
- **Making the default canvas keep `src/canvas-components/` as its own dir.** Keeps one
  special case forever and leaves "platform" meaning "whatever the default canvas wrote."
