---
name: cedarpad
description: A spatial instrument where one operator and an agent share the same pad — true-neutral chrome, one cedar-ember signal.
colors:
  canvas-void: "oklch(0.16 0 0)"
  surface: "oklch(0.21 0 0)"
  surface-raised: "oklch(0.25 0 0)"
  surface-overlay: "oklch(0.29 0 0)"
  line: "oklch(0.32 0 0)"
  line-strong: "oklch(0.41 0 0)"
  text: "oklch(0.93 0.008 75)"
  text-muted: "oklch(0.69 0.014 65)"
  text-faint: "oklch(0.60 0.014 60)"
  accent: "oklch(0.68 0.145 45)"
  accent-hi: "oklch(0.75 0.14 45)"
  accent-quiet: "oklch(0.45 0.08 45)"
  on-accent: "oklch(0.18 0.012 60)"
  danger: "oklch(0.62 0.18 25)"
  success: "oklch(0.65 0.12 150)"
  warning: "oklch(0.80 0.12 85)"
  shadow-float: "oklch(0.10 0.01 60 / 0.5)"
  shadow-lift: "oklch(0.07 0.01 60 / 0.55)"
typography:
  display:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "clamp(1.75rem, 3vw, 2.5rem)"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  heading:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.005em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.08em"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, monospace"
    fontSize: "0.78rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  "2xl": "32px"
  "3xl": "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    typography: "{typography.body}"
  nav-item:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
    typography: "{typography.body}"
  nav-item-active:
    backgroundColor: "{colors.surface-overlay}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
    typography: "{typography.body}"
  input:
    backgroundColor: "{colors.canvas-void}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    typography: "{typography.body}"
  chat-card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "0px"
  tool-chip:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.sm}"
    padding: "3px 7px"
    typography: "{typography.label}"
---

# Design System: cedarpad

## 1. Overview

**Creative North Star: "The Lit Drafting Table"**

cedarpad is a cedar drafting table under one warm work-light. The surface is a true
graphite that recedes into shadow; the only thing that catches the light is what is
live. Color belongs to the work on the pad (the shapes you draw, the components the
agent builds), never to the frame around it. The chrome is a precise instrument:
flat, quiet, tightly spaced, built from a single achromatic material so the pad's
real color reads true against it. The name is the palette: the one accent is a cedar
ember, and the text it lights is a warm off-white. Personality lives in restraint
and in how fast the surface answers you, not in decoration.

**The neutrals carried hue-60 tint at chroma 0.010–0.018 until 2026-08-03.** They are
now chroma 0, at the same lightnesses. The tint was doing the opposite of its job:
`--surface` rendered `#1d1713`, a brown-grey that read as *faded* rather than as wood
in shadow, and it muddied every color placed on it. Removing chroma moved `--surface`
to `#181818` and changed no lightness, so every contrast ratio in this document still
holds. Warmth is now carried where it is legible — the ember accent and the off-white
text ramp — instead of being smeared thinly across every surface.

This system still rejects the generic dark-tool reflex: no cold steel-blue chrome, no
neon-on-black, no glassmorphism, no glowing gradient accents, no soft pastel cards.
Neutral is not cool — the neutrals are achromatic, and the chromatic voice in the
chrome is a cedar ember, which is what keeps this off the Linear/Figma cool-blue
convention. It also rejects the consumer-rounded, SaaS-cheerful register: this is an
instrument, not a friendly app.

**Key Characteristics:**
- True-neutral dark surfaces (chroma 0), never `#000`.
- A single cedar-ember accent that means one thing: *live / active*.
- Tonal depth, not shadow depth. Lighter surface = closer to you.
- Mono for labels and machine output; sans for human content.
- Tight, varied spacing. The pad is the hierarchy; chrome never competes.

## 2. Colors

An achromatic graphite stack carrying a single cedar signal. The neutrals are chroma
0 — one material, no hue — so nothing in the frame competes with the pad, and a color
placed on a surface reads as itself rather than through a tint.

**The one sanctioned exception: the chat card.** A transcript is machine output rendered
as a terminal — `⏺ ⎿ ❯` over a fixed-pitch column — and a terminal carries its own theme
the way a code block carries its own syntax colours. `.chat-card` therefore redeclares the
token names locally (`shared/chat.css`): Tokyo-Night text `#c0caf5` over `#181818`, paths
and commands in `#7dcfff`, a white user row on `#3a3a3a`. Cedar terracotta stays the
*live* accent, so the card still reads as ours. Because the override is on the token names
themselves, every rule inside re-themes without knowing about it and **nothing leaks past
`.chat-card`**. Do not copy this trick anywhere else: it is justified by the surface being
a terminal emulation, not by a preference for those colours.

### Primary
- **Cedar Ember** (`oklch(0.68 0.145 45)`): the only chromatic voice in the chrome.
  Active nav item indicator, focus rings, the primary action, the "agent is acting"
  pulse, selection emphasis. Its rarity is the entire point. **Cedar Ember Hi**
  (`oklch(0.75 0.14 45)`) is the hover/lifted step; **Cedar Quiet**
  (`oklch(0.45 0.08 45)`) is for dim accent lines and inactive-but-accented borders.

### Neutral
- **Canvas Void** (`oklch(0.16 0 0)`): the deepest layer, behind everything;
  also the inset field background (composer, inputs).
- **Surface** (`oklch(0.21 0 0)`): panels and the rail. The default chrome
  plane.
- **Surface Raised** (`oklch(0.25 0 0)`): chat cards, popovers, chips, ghost
  buttons. One step toward the viewer.
- **Surface Overlay** (`oklch(0.29 0 0)`): the highest resting plane, active
  nav row, hovered menu items, the floating composer toolbar.
- **Line** (`oklch(0.32 0 0)`): default 1px borders and dividers.
- **Line Strong** (`oklch(0.41 0 0)`): emphasized separators, card outlines
  that need to read against a busy board.
- **Text** (`oklch(0.93 0.008 75)`): primary text, warm off-white, never `#fff`.
- **Text Muted** (`oklch(0.69 0.014 65)`): secondary text, labels, inactive nav.
- **Text Faint** (`oklch(0.60 0.014 60)`): metadata, timestamps, placeholder text. At
  0.60 it clears WCAG AA against Surface for the small metadata it carries; do not
  drop it lower for any text the user must actually read.

### Tertiary (status only, never decorative)
- **Danger** (`oklch(0.62 0.18 25)`), **Success** (`oklch(0.65 0.12 150)`, cedar
  needle-green), **Warning** (`oklch(0.80 0.12 85)`): reserved for state in the
  chrome (failed tool call, save confirmation, stale warning). Not used as accents.
  Danger sits at hue 25 to stay distinct from Cedar Ember at hue 45.

### Named Rules
**The Cedar-Means-Live Rule.** Cedar Ember covers ≤10% of any view and signals
exactly one concept: active or live. Active nav, focus, primary action,
agent-streaming. Never use it to decorate a heading, a card edge, or an icon at
rest.

**The True-Color Rule.** The chrome is near-achromatic on purpose so the pad's own
colors (the 8 shape colors, full-color components) read true. Never add a
chroma-heavy chrome surface that tints how on-canvas color is perceived.

## 3. Typography

**Display / Body Font:** system sans (`ui-sans-serif, system-ui, -apple-system`).
**Label / Machine Font:** system mono (`ui-monospace, 'SF Mono', 'JetBrains Mono'`).

**Character:** Human content is set in a neutral, fast-loading system sans; anything
the machine emits or labels (section headers, tool calls, metadata, code) is set in
mono. The sans/mono split is the type system's whole personality: it tells you at a
glance whether a human or the instrument is talking. No webfont is loaded by
default, which suits a local instrument; swapping the sans for a licensed technical
grotesque is the single lever if more brand character is ever wanted.

### Hierarchy
- **Display** (600, `clamp(1.75rem, 3vw, 2.5rem)`, lh 1.05): empty states and
  first-run moments only. Rare.
- **Heading** (600, 1.375rem, lh 1.2): a panel's primary title.
- **Title** (600, 1.0625rem, lh 1.3): chat card title, section heading, dialog
  title.
- **Body** (400, 0.875rem, lh 1.55): messages and all reading content. Cap measure
  at 65-75ch in any wide container.
- **Label** (mono, 500, 0.6875rem, `letter-spacing 0.08em`, UPPERCASE): nav section
  labels (`PAGES`, `CANVASES`), group headers, the smallest metadata.
- **Mono** (mono, 400, 0.78rem, lh 1.5): tool-call chips, code, machine data.

### Named Rules
**The Who-Is-Talking Rule.** Mono is the machine's voice (labels, tools, code,
data); sans is the human's (titles, messages, prose). Don't set body prose in mono
or section labels in sans.

## 4. Elevation

Depth is tonal, not cast. A surface is "closer" because it is one step lighter
(Canvas Void to Surface to Surface Raised to Surface Overlay), not because it has a
heavy drop shadow. Shadows appear only on things that genuinely float above the
infinite pad, and they are soft and structural, never a glow.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 1px 2px {colors.shadow-float}, 0 0 0 1px {colors.line}`):
  chat cards and component frames resting on the board. The hairline ring does the
  separating work; the shadow is barely there.
- **Lift** (`box-shadow: 0 8px 24px {colors.shadow-lift}`): popovers, menus, the
  new-chat control, dialogs. Pair Lift with a `{colors.line-strong}` ring (not
  `line`) so a floating surface reads as clearly above a busy board. Only while
  floating above peers.

### Named Rules
**The Flat-At-Rest Rule.** Chrome planes are flat and separated by tone and a 1px
line. A shadow is a response to floating above the pad, not a default decoration. If
two chrome surfaces both cast shadows against each other, one is wrong.

**The No-Glow Rule.** Cedar Ember never glows. Active state is a solid edge, a fill,
or a 2px inner ring, never a blurred halo.

## 5. Components

### Buttons
- **Shape:** gently squared (10px / `{rounded.md}`).
- **Primary:** Cedar Ember fill, Canvas-Void-dark text (`on-accent`), padding 8px
  14px. Used once per context for the single most important action.
- **Ghost (default):** Surface Raised background, Text color, 1px Line border. Hover
  lifts background to Surface Overlay.
- **Icon:** transparent at rest, Surface Raised on hover, 8px square padding, Text
  Muted icon that goes Text on hover.
- **Focus:** 2px Cedar Ember ring, offset 2px, on every button. Never remove it.

### Inputs / Composer
- **Style:** Canvas Void (inset) background, 1px Line border, 10px radius, Text
  color, Text Faint placeholder.
- **Focus:** border shifts to Cedar Ember + a 1px inner Cedar line. No glow.
- **The composer** (chat input) is the signature input: a Canvas-Void field inside
  the Surface chat card, with the send affordance going Cedar Ember only when there
  is text to send.

### Cards / Containers (chat card, component frame)
- **Corner Style:** 14px (`{rounded.lg}`) for cards, 10px for inner elements.
- **Background:** Surface. The card header may sit on Surface Raised to read as a
  drag handle.
- **Shadow Strategy:** Float (see Elevation). Hairline ring + whisper shadow.
- **Border:** the Float ring is the border; no second border.
- **Internal Padding:** 16px (`{spacing.lg}`) for content, 12px for dense rows.
- **Component error frame:** a failed custom component renders a Danger-edged
  Surface Raised card with mono error text. It never glows and never crashes the
  board.

### Navigation (the rail + panel, the Shell)
- **Rail:** a narrow Surface column. Icons are Text Muted at rest, Text on hover.
  The active section is marked by a 2px Cedar Ember left indicator and a Surface
  Overlay row, not by a colored icon.
- **Panel:** breadcrumb header (`Canvases › Cloner POC`), a mono UPPERCASE section
  label (`PAGES`), then rows. The active row uses `nav-item-active` (Surface Overlay
  + Text); inactive rows are `nav-item` (Text Muted) and hover to Surface Raised.
- **Workspace switcher / page list** share these exact row tokens.

### Messages (chat)
- **Agent message:** plain, on the card's Surface, full-width, Body sans. Tool calls
  render as `tool-chip`: a Surface Raised mono chip (`READ_CANVAS`, `CREATE_SHAPES`)
  that can carry an elapsed-time suffix. While the agent is streaming, a single Cedar
  Ember thinking pill is the only accent on screen.
- **User message:** a Surface Raised block (or a faint Cedar-Quiet left edge at 1px,
  not more) so authorship is legible without a loud bubble.

### Tool-Call Chip (signature component)
A small mono UPPERCASE chip naming a tool the agent invoked, in Surface Raised /
Text Muted, 6px radius, with an optional Text-Faint elapsed time. This is the
instrument's heartbeat made visible; keep it small and quiet.

### Logo (decided 2026-07-14, from the CedarpadLogos/CedarpadLogoTest studies)
- **Mark: the pad + spark** — a rounded-square pad outline (48×48 viewBox:
  `rect x=5 y=5 w=38 h=38 rx=11`, stroke-width 4, Text Muted) with a single Cedar
  Ember dot in the upper-right (`circle cx=30.5 cy=17.5 r=5.5`). The pad is the
  chrome's voice (quiet, neutral); the ember dot is the one live spark.
- **Wordmark: the split** — `cedar` in Text, `pad` in Cedar Ember, same weight
  (600), no gap. The wordmark carries the accent so the mark stays quiet; together
  they still read as one signal, not decoration.
- Reference implementation: `packages/www/src/components/Logo.astro` and
  `packages/www/public/favicon.svg`.

## 6. Do's and Don'ts

### Do:
- **Do** build the chrome from the achromatic neutral ramp (chroma 0) and treat
  Cedar Ember as a ≤10% signal that means *live*.
- **Do** convey depth by stepping the surface one tone lighter (Void → Surface →
  Raised → Overlay), and reserve shadows for things floating above the pad.
- **Do** set machine output (labels, tool chips, code, metadata) in mono and human
  content (titles, messages) in sans.
- **Do** keep a visible 2px Cedar Ember focus ring on every interactive control, and
  honor `prefers-reduced-motion`.
- **Do** vary spacing for rhythm using the 4px-based scale; let the pad be the
  loudest thing on screen.

### Don't:
- **Don't** use `#000` or `#fff`; the surface ramp bottoms out at `oklch(0.16 0 0)`
  and the text ramp tops out at a warm off-white. Don't re-tint the surface ramp
  either — chroma 0 is the point (see the 2026-08-03 note above).
- **Don't** fall back to the cool dark-tool cliché (steel-blue chrome, cyan accent,
  neon-on-black, glassmorphism, glowing or gradient accents). Cedar Ember never
  glows.
- **Don't** use Cedar Ember to decorate (heading color, icon fill, card edge at
  rest). It is reserved for active/live state only.
- **Don't** use side-stripe accents wider than 1px, gradient text, the hero-metric
  template, or identical card grids. **The one sanctioned exception:** the 2px Cedar
  Ember bar that marks the *active* nav row, rail item, or page (the single "you are
  here" indicator). It is allowed only as an active-state marker on the selected
  item, never as a decorative edge on a card, callout, message, or any element at
  rest. If a cedar stripe appears on something that is not the current selection,
  it is wrong.
- **Don't** ship the consumer-rounded, SaaS-cheerful look (big pills, pastel cards,
  emoji-warm empty states). This is an instrument.
- **Don't** preserve the rushed `styles.css` values; conform them to this spec.
