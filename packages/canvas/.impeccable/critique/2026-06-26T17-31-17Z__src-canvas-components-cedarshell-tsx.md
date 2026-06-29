---
target: the CedarShell rebuild
total_score: 26
p0_count: 0
p1_count: 2
timestamp: 2026-06-26T17-31-17Z
slug: src-canvas-components-cedarshell-tsx
---
# Critique — CedarShell rebuild

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | Active states clear, but rail uses two idioms (ring vs stripe) for "you are here". |
| 2 | Match system & real world | 3 | Breadcrumb + Z/P glyphs intuitive; nothing misleading. |
| 3 | User control & freedom | 2 | Workspace popover implies modality (panel dim 0.4) but no visible dismiss/escape. |
| 4 | Consistency & standards | 2 | Two active idioms; icon sizes drift (32/38/38/28); radius 9 hardcoded vs token md=10. |
| 5 | Error prevention | 3 | Low surface; nothing destructive one-click. |
| 6 | Recognition over recall | 3 | Tooltips + explicit labels; bare gear/avatar rely on hover. |
| 7 | Flexibility & efficiency | 2 | No keyboard/command surface; switcher is the only fast path. |
| 8 | Aesthetic & minimalist | 4 | The strength: flat-at-rest, accent-scarce, chrome recedes. |
| 9 | Help users with errors | 2 | No error/empty/stale/loading states shown (DESIGN.md specs a Danger frame). |
| 10 | Help & documentation | 2 | Tooltips only; no first-run discovery. |
| **Total** | | **26/40** | **Solid, ships, real gaps.** |

## Anti-Patterns Verdict

**Not AI slop.** ~85% considered, 15% placeholder-reflex. The warm hue-60 ramp, the wired-in sans/mono voice split, and tonal-elevation discipline read as deliberate; the accent is genuinely scarce. The one tell is the canvas faux-content (generic bar-chart card with `[34,58,44,70]` + thinking pill) — the obvious "show a canvas tool with a chart" reflex.

**Deterministic detector:** clean of banned patterns (no gradient text, glass, hero-metric, identical grids). 3 advisory findings, all one root: the Float/Lift shadow tints (`oklch(0.07…)`, `oklch(0.10…)`, lines 99/127/193) are inline literals not promoted to named DESIGN.md color tokens. Converges with the LLM's P2 token-drift point.

## Priority Issues

**[P1] Two active-state idioms for one concept.** Rail Z signals active with a 2px accent *ring*; Canvases icon + all rows use a 2px accent *left stripe*. Forces the user to learn two grammars for "you are here", and the ring is the element closest to a glow-badge reflex. **Fix:** unify on the DESIGN.md §5 idiom — active Z gets the 2px left stripe + overlay fill, drop the ring.

**[P1] Workspace popover separation too weak.** Popover (`overlay` 0.29) over a dimmed panel leans almost entirely on the Lift shadow + 1px `line` to separate; the edge is soft against the busy board. **Fix:** strengthen the popover ring to `line-strong` (0.41) and/or lift the dim less; the shadow is right, the edge is what's soft.

**[P2] Hardcoded radii/sizes drift from tokens.** Radius `9` everywhere vs token `md`=10; rail icon targets 32/38/38/28 with no rhythm. This is the "rushed styles.css we don't preserve" smell creeping back. **Fix:** use `rounded.md`/`rounded.sm`; standardize rail hit-targets to one size (~36px). Also promote the two shadow tints to named tokens (closes the 3 detector advisories).

**[P2] No state coverage + a real accent bug.** Only the happy path is shown. Worse: the canvas thinking pill **hardcodes** `oklch(0.68 0.145 45)` (lines 133-134) instead of the `accent` prop — a re-themed accent leaves a stale cedar pill (correctness, not taste). **Fix:** thread `accent` through the pill; add an empty-canvas and a Danger tool-error frame so the shell demonstrates state.

**[P3] Muted/faint contrast needs an AA check.** `muted` (0.69) on `surface` (0.21) is comfortably AA; `faint` (0.55) on `surface` for counts and the `›` separator is borderline for the 4.5:1 small-text threshold. **Fix:** fine for non-load-bearing metadata; lift faint to ~0.60 for anything the user must read.

## Persona Red Flags

**Power user (James, long sessions):** the two active idioms are a per-session paper-cut; mouse-only nav (no keyboard switch) keeps the chrome present in a tool whose whole thesis is chrome disappearing; the 0.4 panel dim fades the page list mid-glance.

**Over-the-shoulder demo watcher (Layer-3 demo-legibility):** unlabeled rail needs hover to read structure; the `›` breadcrumb separator in `faint` is near-invisible at projector distance.

**Re-theming integrator:** the hardcoded pill literal means a non-default `accent` makes the chrome's "live" signal and the canvas "live" signal disagree.

## Questions to Consider

1. What does the Z-ring earn that a stripe doesn't? If the stripe is your active grammar, the ring is an inconsistency you'll defend as intentional.
2. The 2px cedar left-stripe is the exception you wrote into your own side-stripe ban. Name *why* it's allowed (full-height indicator inside a row, not a card edge) or someone cargo-cults 2px cedar edges onto cards.
3. The canvas faux-content is the only un-designed surface in the file. For a component meant to prove "agent output and chrome share one vocabulary", design it to the system or strip it to one honest empty state.
