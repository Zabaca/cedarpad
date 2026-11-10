# Product

## Register

product

## Users

James and the agents he runs. cedarpad is a single-operator spatial workspace:
a local tldraw canvas with an in-canvas Claude agent that draws on it and reads
from it. The human sketches by hand and issues instructions; the agent creates,
edits, and arranges shapes and authors live React components alongside. Context of
use is a focused building session, often long, often on a large display, in a
"thinking out loud on a board" mode. There is no consumer audience and no public
deploy: it runs locally because the agent needs a real Claude credential. The product name is
cedarpad.

## Product Purpose

Give one operator a canvas where direct manipulation and an agent share the exact
same surface and state, so sketching, instructing, and generating are one motion
instead of three tools. Success is that the chrome disappears: the canvas and what
is on it are the only things you notice, and switching between drawing yourself and
asking the agent feels seamless. cedarpad is a Layer-3 product POC, so it also has to be
demo-legible to someone watching over a shoulder.

## Brand Personality

Precise, fast, quiet-confident. A builder's instrument, not a friendly app. The
voice is terse and exact (tool labels, not marketing). Personality lives in
restraint and responsiveness, not decoration. Three words: precise, spatial, calm.

## Anti-references

- Consumer-rounded, SaaS-cheerful UI (big pills, soft pastel cards, emoji-warm
  empty states). This is an instrument.
- Generic dark-tool reflex: pure-black background, neon-on-black, glassmorphism,
  glowing gradient accents. Dark here must be a tinted, considered dark, not the
  "developer tool = black + neon" cliche.
- The current rushed chrome (`styles.css`, the panels) is NOT a reference. It was
  built fast to function. We set the system first, then conform it; we do not
  preserve it.
- Identical card grids and the hero-metric template. The canvas is the hierarchy;
  chrome should not compete with it.

## Design Principles

- **Set the system, then polish to it.** The visual system is designed forward and
  is the source of truth. Existing code conforms to the system; the system is never
  reverse-engineered from rushed code.
- **The canvas is the star; chrome recedes.** Every chrome decision is judged by
  whether it gets out of the way of the board. Chrome earns its visual weight.
- **Spatial-native, direct-manipulation first.** The product is a surface you act
  on, not a set of screens you navigate. UI serves manipulation of shapes.
- **One surface, one vocabulary.** The human's hand, the agent's shapes, and the
  app chrome eventually share one design language, so agent output and app UI do
  not read as two different products.
- **Committed restraint.** One considered accent, a tight token set, real
  hierarchy through scale and elevation rather than color noise.

## Accessibility & Inclusion

Single-operator tool, so no broad audience matrix, but hold a real floor: WCAG AA
contrast for all text and controls against the (tinted dark) surfaces, visible
keyboard focus on every interactive control, and honor `prefers-reduced-motion`
(motion is functional feedback, never required to understand state). Accent must
remain distinguishable for common color-vision deficiencies (do not encode meaning
in hue alone).
