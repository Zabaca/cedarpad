---
target: the CedarShell rebuild
total_score: 27
p0_count: 0
p1_count: 1
timestamp: 2026-06-26T18-08-20Z
slug: src-canvas-components-cedarshell-tsx
---
# Critique — CedarShell rebuild (run 3)

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of system status | 3 | Active section/row/thinking pill clear; Z goes inert in canvases/pages views. |
| 2 | Match real world | 3 | Breadcrumb / menu-check / counts read naturally. |
| 3 | User control & freedom | 2 | Static scaffold: no popover dismiss, breadcrumb-back non-obvious. |
| 4 | Consistency & standards | 3 | Idiom mostly unified; popover fill collision + two `+` treatments. |
| 5 | Error prevention | 3 | Little to err on. |
| 6 | Recognition over recall | 3 | Titled icons, labels, counts present. |
| 7 | Flexibility & efficiency | 2 | No keyboard/quick-switch model expressed. |
| 8 | Aesthetic & minimalist | 4 | Excellent; chrome recedes, accent rationed. |
| 9 | Error recovery | 2 | Nothing modeled (static shell). |
| 10 | Help & documentation | 2 | Tooltips only. |
| **Total** | | **27/40** | **Solid, ships with fixes.** |

## Anti-Patterns Verdict

**Not slop** (third independent reviewer agrees): "this person read a spec." Warm hue-60 ramp, OKLCH throughout, accent genuinely rationed, mono/sans split disciplined, faux content honest. **Detector: clean (`[]`).** Token/accent discipline explicitly passed: radii on the 6/10/14 scale, no hardcoded accent literal in render (only the prop default), no cedar-as-decoration, focus rings present.

## Why the number dipped (29 → 27)

Two real reasons, stated plainly:
1. **A regression I introduced.** When I changed the popover active row to `overlay` to "match," I missed that the popover *ground* is also `overlay` — so the active fill differential vanished (only the stripe + check distinguish it). My fix created a new bug. (P1 below.)
2. **Reviewer variance + static-scaffold ceiling.** Each run is a different blind reviewer. This one graded the interaction axes (control/freedom, flexibility, error recovery) at 2 because a *static mock* structurally can't express keyboard models, dismissal, or recovery. Those points are unwinnable on a scaffold; they only become real on the live `LeftPanel.tsx`.

## Priority Issues

**[P1] Popover active fill is invisible (regression).** Popover ground = `overlay` and active row fill = `overlay` → no differential; only the stripe/check mark it. Breaks the two-part idiom in the one place selection should be clearest. **Fix:** popover ground → `raised` (the spec'd popover plane), active rows stay `overlay`. The differential returns and the menu reads one tone above the panel.

**[P2] Uneven defocus.** On `workspace` view only the panel dims (0.55); rail + canvas stay full-bright → reads as a render glitch, and drops the dimmed panel's text below AA. **Fix:** dim nothing — the Lift shadow + line-strong ring already separate the popover (matches the flat/tonal philosophy).

**[P3] Three create-affordances.** "New canvas" `+` (header icon), "New workspace" `+` (menu row, different glyph color), and `pages` has none. **Fix:** align glyph colors; pick one create idiom per surface.

**[P3] Comment overclaims.** Header says the idiom is "applied identically"; the popover broke it (P1) and Z's resting ground (`raised`) differs from the icon's (`transparent`), so the active delta differs. **Fix:** state the rule precisely — active = stripe + an `overlay` fill one tone above its local ground.

## The two architectural questions worth a human decision

1. **Cedar does double duty.** The active *nav* selection ("you are here," static) wears the same cedar as the agent's *streaming* "thinking" pill (live process). The spec sanctions it, but collapsing "where I am" and "the machine is working now" into one color may weaken the signal you most want unmissable.
2. **Fill-delta vs ground-independent marker.** The two-part idiom degrades the moment the ground is already `overlay`. Should the active marker be ground-independent (the stripe alone, or an inset ring) so it survives on any surface?

## Persona Red Flags

**James (power user):** no quick-switch/keyboard model; mouse-only popover off a 36px button is slow for all-day use. Looks calm, doesn't yet signal *fast*.
**Next engineer extending it:** the comment promises an idiom the popover breaks — they'll copy "stripe + overlay" onto an overlay ground and ship an invisible selection (the latent bug).
**Demo watcher (PRODUCT.md goal):** the half-dimmed panel reads for a frame as a rendering bug, undercutting "the chrome disappears."

## Questions to Consider

1. If Cedar-Means-Live means *live*, should a static "you are here" really share the accent with the agent acting?
2. Is the review bar even right — should it be "did you forget the chrome was there?" rather than "is the popover beautiful?"
