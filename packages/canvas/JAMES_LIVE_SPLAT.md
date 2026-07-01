# James — Live 3D Splat (in-canvas)

*What the `SplatViewer` card on the board actually is, and what it took to get there.*

## The one-liner

A recognizable, photoreal-ish **3D head of James that you can orbit live in the browser**, rendered from a single 4 MB `.ply` file — **no GPU, no neural decoder, no server at view time.** Drag to rotate, zoom with the +/− buttons. It is a real cloud of Gaussian splats, not a video or an image sequence.

## The pipeline behind it

```
one front photo of James
  → GAGAvatar (feed-forward, 1 pass on a rented GPU)
      → 3D Gaussian head: ~58k splats, each carrying a 32-dim FEATURE vector (not RGB)
  → per-frame, GAGAvatar's StyleUNet DECODER paints photoreal RGB per view
      (this is where the photorealism lives — but it needs a warm GPU every frame)
  → DISTILLATION: bake that decoder appearance into a single fixed color per splat
  → portable 4 MB .ply  →  served at /james_splat.ply  →  hand-rolled WebGL2 viewer
```

## What we actually solved

**1. Restored the avatar server from the Dockerfile recipe.**
The whole GAGAvatar environment (6 encoded gotchas: conda ToS, SSH submodule, renamed `diff_gaussian_rasterization_32d`, build isolation, the FLAME `yes |` prompt, base-image pinning) was brought back up from scratch in ~10 min on a fresh rented pod. Pods are now all **stopped ($0)**; the result is fully local.

**2. Understood the rendering pipeline.**
GAGAvatar's Gaussians don't store color — they store 32-dim features. A 2D image-to-image **decoder** repaints photoreal RGB *per view*. So "reconstruct" is once; "decode" is every frame and view-dependent. That decoder is the reason a naive splat export looked like a ghost.

**3. Cracked distillation (the hard part).**
To get a *portable* splat we had to bake the decoder's appearance into one fixed color per Gaussian. Three approaches, in order:
- **Crude single-view bake** → ghostly, washed out.
- **Projective multi-view sampling** → mannequin / smeared face. Hand-replicated projection was never pixel-accurate (flip-vote 57.7k vs 61.7k), so colors landed on the wrong splats.
- **Optimization through GAGAvatar's own differentiable rasterizer** → **worked.** Adam, lr 0.03, 220 iters, 6 random views/step, L1 against 27 decoded photoreal targets (9 az × 3 el). Loss converged 0.121 → 0.011. Zero alignment error because we never replicate the projection — we backprop through the real renderer. This is the `optimize_distill.py` winner; the `DistilledProof` card shows its reference-quality output at 3 angles.

**4. Built a dependency-free live viewer.**
`SplatViewer.tsx` is a ~200-line hand-rolled WebGL2 Gaussian rasterizer: PLY parse, covariance → screen-space conic projection (antimatter15 +z-forward convention), depth-sorted alpha blend, drag-orbit + zoom. It works *inside tldraw*, which aggressively captures wheel/pointer events — zoom is wired to buttons because tldraw eats scroll.

## The honest caveats

- **Two quality tiers.** The `DistilledProof` card = GAGAvatar's proper anti-aliased rasterizer (reference quality). The live `SplatViewer` = my self-contained WebGL renderer — lighter, fully interactive, but slightly softer; it lacks proper EWA anti-aliasing so a faint Gaussian-grid texture can show through, tuned out with opacity boost + low-pass dilation.
- **±35° sweet spot.** Colors come from front-ish decoded views, so it holds up well across about ±35° and softens past that. It's one front photo's worth of information.
- **Licensing gate stands.** GAGAvatar is FLAME-derived = **non-commercial**. A shippable Cloner still needs a commercially-licensed head prior.

## Why this matters for Cloner

This is the **portable middle path** between the two extremes:

| | Crude bake | **Distilled splat (this)** | Live decoder |
|---|---|---|---|
| Quality | ghost | recognizable, near-photoreal | photoreal |
| View time cost | none | **none — 4 MB .ply, any viewer** | warm GPU every frame |
| Portable asset | yes | **yes** | no |

It proves the **3DGS identity-lock asset is real and portable** — a single explicit 3D thing you can orbit and drop into a scene, locked by construction, not re-generated per clip. That portability is the whole argument for why 3DGS (Route 2) is the moat versus diffusion talking-heads.

## Files

- `src/canvas-components/SplatViewer.tsx` — the live in-canvas viewer
- `src/canvas-components/DistilledProof.tsx` — reference-quality 3-angle proof
- `public/james_splat.ply` — the portable 4 MB optimized splat (58,536 gaussians)
- `../cloner-avatar/scripts/optimize_distill.py` — the optimization-based distillation (the winner)
- `../cloner-avatar/scripts/pod_bootstrap.sh` — the Dockerfile recipe as a runnable boot script
- `../cloner-avatar/scripts/README.md` — what's in-repo vs what stays in the local `~/cloner-poc` scratch (venv, datasets, the FLAME-derived `.ply` bakes)
