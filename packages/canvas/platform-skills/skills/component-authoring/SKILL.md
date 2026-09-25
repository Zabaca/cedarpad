---
name: component-authoring
description: What a canvas component can and cannot do, and how it talks to you. Use before writing or editing a component, when a human asks whether a component can have actions, buttons, commands or methods, when wiring a component to call back into the chat, or when a click, scroll or saved value inside a card does not behave.
---

# Canvas components

A component is a React file (`write_component`) rendered inside a card on the canvas
(`place_component`). This is the whole contract between it, the canvas and you.

## What a component receives as props

| Prop | What it is |
| --- | --- |
| everything in `data` | The placement's `data`, spread as props. Set by `place_component` / `set_component_data`. |
| `setData(patch)` | Persist the component's own state. **Merges** `patch` into `data`; syncs to everyone on the canvas and survives reload. Keys set to `undefined` are dropped. Plain `useState` is per-tab and lost on reload. |
| `sendToAgent(message)` | Post `message` into a chat as a turn — see below. Async; **throws** when there is no chat to reply to. |
| `currentUser` | `{ id, name?, email?, color, kind: 'user' \| 'guest' }` of the person looking at it — `undefined` until resolved. |
| `setDisplayName(name)` | Ask-once naming for a guest; a no-op for signed-in users. |
| `rows`, `mart` | Only when placed with a `data_source`: the live rows (and mart metadata). `[]`/`null` while loading. |

## Actions, commands, methods — what is possible

A component cannot register tools. Three channels exist:

- **Component → you: `sendToAgent(message)`.** The only way a component makes something
  happen outside itself. The message becomes a normal chat turn — a user bubble in the chat,
  a reply streamed back — in the chat that **placed** it (the arrow from that chat card), or
  the focused chat when nothing placed it. If that chat is mid-turn the message queues and
  runs next. So a component "action" is a button that sends a message:

  ```tsx
  <button onClick={() => sendToAgent(`[TaskBoard] approve task ${task.id}`).catch(() => setErr('No chat attached'))}>
    Approve
  </button>
  ```

  Give the messages a stable, recognizable shape (a `[ComponentName]` prefix, an id) so the
  receiving turn knows what was asked, and handle the failure — no attached or focused chat
  is a normal state.

- **You → component, preferred: `call_component(id, command, args)`.** When a component
  exports `commands` (see below), run one of them. `read_component` shows the commands and
  their `args` schemas. The command runs against the instance's data **as it is now**, so a
  card someone dragged a second ago survives your edit; bad args come back as an error
  instead of being written.

- **You → component, raw: data.** `set_component_data` to feed props, `write_data` for a file
  the component imports (`import rows from "./sales.json"`), a `data_source` to bind a live
  mart, or `edit_component` to change the code itself. Use `set_component_data` for a
  component with no commands, or to replace its content wholesale.

Decide which state is whose. State the **component** owns (a selection, a toggle, a draft)
goes through `setData`; state **you** own (the content you are showing) goes through
`set_component_data`.

**`set_component_data` REPLACES `data`; `setData` merges.** Writing new props wipes anything
the component saved with `setData` unless you carry it over: `read_canvas` first, then send
the full object back with your change applied. If the component has commands, use
`call_component` instead and none of this applies.

## Declaring commands

Declare commands when the data will be edited again and again — boards, lists, trackers,
checklists. Skip them for a display-only card. Export them from the component's own file,
next to the default export:

```tsx
import { z } from 'zod';

export const commands = {
  addItem: {
    args: z.object({ text: z.string().min(1) }),
    run: (data, a) => ({ ...data, items: [...(data.items ?? []), { id: crypto.randomUUID(), text: a.text }] }),
  },
};

export default function Checklist({ items = [], setData }) {
  // The UI calls the SAME reducer, so a button and call_component follow one set of rules.
  const add = (text) => setData(commands.addItem.run({ items }, { text }));
  …
}
```

Rules:

- **`run(data, args)` is pure.** It gets the current `data` and the parsed args and returns
  the next `data`. No fetch, no DOM, no React, no `setData` inside it.
- **Return the whole data object**, spreading what you did not change (`{ ...data, … }`).
- **Throw an `Error` with a useful message** for a bad reference (an unknown id). The
  message reaches the caller.
- **No top-level `window` or `document`** in a file that exports commands. The server
  imports the file to run the reducers, and there is no DOM there. Touch the DOM inside the
  component or an effect.
- Name commands as verbs over the domain (`addCard`, `moveCard`), and give ids and names
  in `args` a `.describe()`, so the schema reads as documentation.
- `read_component Kanban` is a worked example.

## Rules that bite

**Clicks.** A card sits inside the canvas, which claims the pointer for select/drag. A press
only reaches the component on a real `button`, `a`, `input`, `textarea`, `select`, `label`,
`[contenteditable=true]` or `[role="button"]` element. A plain `<div onClick>` **never
fires**, while hover still works — so "hover works" proves nothing. Don't put
`role="button"` on a big container: the card's background must stay draggable.

**Scrolling.** Mouse-wheel scrolling inside the card works. Never use
`element.scrollIntoView()` — the canvas is CSS-scaled and it scrolls the wrong thing.
Scroll your own container: `container.scrollTo({ top: el.offsetTop - 8 })`, with the
container `position: 'relative'`.

**Layout.** Fill the card: root `width: '100%', height: '100%', boxSizing: 'border-box'`.
The user resizes cards. The **top-right corner is reserved** for the card's fullscreen
button — put your own controls on the left.

**Colors.** The canvas is dark. Use the tokens — `var(--text)`, `var(--muted)`,
`var(--faint)`; `var(--surface)`/`var(--raised)`/`var(--overlay)`; `var(--line)`;
`var(--accent)`; `var(--success)`/`var(--danger)`/`var(--warning)` — never a hard-coded
text hex, or the component is near-invisible.

**Errors and loading** are handled by the card. Don't build your own error boundary or
loading state for the module itself.

## Composition and data

- Small components compose: a leaf that takes props, a container that imports it
  (`import Row from "./Row"`). `read_component MarkdownCard` is a plain leaf to copy.
- For a chart, place the platform `ChartCard` rather than drawing one (see the
  `chart-authoring` skill).
- Available imports are listed on `write_component`. Nothing else can be installed.
- Components don't talk to each other directly — share state through a common container,
  or through you.
