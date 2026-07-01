---
target: the CedarShell rebuild
total_score: 29
p0_count: 0
p1_count: 1
timestamp: 2026-06-26T18-00-57Z
slug: src-canvas-components-cedarshell-tsx
---
# Critique — CedarShell rebuild (post-polish, run 2)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | Active section clear; breadcrumb reads non-interactive. |
| 2 | Match real world | 3 | Breadcrumb / switcher / list map to mental models well. |
| 3 | User control & freedom | 2 | No visible dismiss on the workspace popover; view frozen via useState. |
| 4 | Consistency & standards | 3 | One idiom mostly applied; two row radii (8 vs 10); popover active fill diverges. |
| 5 | Error prevention | 3 | Little to err on; the failed-frame is hinted not rendered. |
| 6 | Recognition over recall | 4 | Everything visible: titled icons, breadcrumb, counts, active state. |
| 7 | Flexibility & efficiency | 3 | Focus rings correct; no shortcuts (reasonable for chrome). |
| 8 | Aesthetic & minimalist | 4 | Genuinely restrained; chrome recedes, canvas is the star. |
| 9 | Help with errors | 2 | "Failed component" promised in comment isn't styled as Danger. |
| 10 | Help & documentation | 2 | None; fine for single-operator, scored honestly. |
| **Total** | | **29/40** | **Good — ships, a few real fixes.** |

## Anti-Patterns Verdict

**Not AI slop, and not by accident** (confirmed by a second, independent reviewer). Warm hue-60 ramp is a real material decision; OKLCH throughout; no glow/gradient/glass/neon; mono/sans split is load-bearing. Only faintly generic moves are the radial-dot canvas and the stock gear icon — honest conventions, not slop. **Detector: clean (`[]`)** — the promoted shadow tokens closed all prior advisories.

## Priority Issues

**[P1] The "ONE active idiom" is actually three.** Rail Z + Canvases use a `Stripe` at `left:-8` (outside the button, floating in the rail gutter); list rows draw their own stripe at `left:4` (inside the row); the **workspace popover active row uses `raised` fill + a check, no stripe**. Three geometries/markers, while the comment + DESIGN.md claim "used identically." **Fix:** one `Stripe` with one offset that hugs the control edge; make the popover active row use `overlay` fill to match (keep the check as a secondary marker, and say menus use the check convention).

**[P2] The faux error frame lies — stale comment + dead token.** The Canvas comment still promises "a failed component frame (Danger ring, mono)", but after the swap the `tam_card` renders with a normal `line` ring; `C.danger` is now unused. A scaffold that claims a state it doesn't show fails the honest-scaffold test. **Fix:** either strike the "failed component" half of the comment (we deliberately removed the scary error card), or render one genuine Danger frame. Remove the dead `danger` token if unused.

**[P3] Skeleton/thinking content nearly invisible.** Chat-card skeleton bars are `raised` (0.25) on `surface` (0.21) — ~0.04L apart, may vanish on a bright external monitor, undercutting "see live state at a glance." **Fix:** bump bars to `overlay` (0.29)/`line-strong` for ~0.08L separation. (Faint counts at 0.60 are spec-sanctioned, leave them.)

**[P3] Off-scale radii.** Tokens are sm:6 / md:10 / lg:14, but rows use `8` and the popover + faux cards use `12` — neither is on the scale. **Fix:** rows → 6 or 10; popover + cards → 14 (per DESIGN.md "14px for cards"). Remove all 8/12 literals.

**[P3] `useState(view)` fakes statefulness.** `const [v] = useState(view)` freezes the prop; a parent re-rendering with a new `view` is ignored, and there's no setter. **Fix:** `const v = view` (honest: it's a static scaffold), or wire it to the prop.

## Persona Red Flags

**James (operator, large display):** low-contrast skeleton may disappear on a bright monitor; frozen `view` means rail/breadcrumb won't move if this becomes live chrome.
**Demo watcher (named in PRODUCT.md):** the popover active workspace uses a different fill (raised) than every other active row (overlay) — reads on camera as "two selection systems," breaking "one surface, one vocabulary."
**Design-system auditor:** the comment asserts an idiom + an error state the code doesn't fully deliver — comments that overstate the implementation pass a skim and fail a diff.

## Questions to Consider

1. If the active idiom is truly one stripe + overlay, why does the popover get a check + a different fill? Deliberate menu convention (then stop claiming "identical") or drift?
2. The scaffold promises a Danger frame but renders a healthy card. In a tool whose value is showing live agent state honestly, is a scaffold that lies about state the right thing to place?
3. The warmth dodges the cool-blue reflex, but the dot-grid + icon rail + breadcrumb + dropdown are exact Figma/Linear furniture. What would make the structure feel cedar, not just the hue?
