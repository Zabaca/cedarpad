// Pure, DOM-only event-target predicates shared by the interactive canvas shapes
// (ComponentShape, ChatShape). Each takes the event target and answers a yes/no
// question about where in the shape's DOM the event originated. They are pure
// (no side effects, no React/tldraw types) so they unit-test under jsdom and so
// the InteractiveBoxShapeUtil base can consume them as `(Element | null) => boolean`.

// Controls whose clicks should reach the component rather than tldraw. A pointer
// event on one of these is swallowed so the editor doesn't start a select/drag
// gesture; anywhere else it bubbles to tldraw and selects/drags the shape.
const INTERACTIVE_CONTROL = 'button,input,textarea,select,a,label,[contenteditable=true],[role="button"]';

/** True when `target` is, or is inside, an interactive control. */
export function isInteractiveControl(target: Element | null): boolean {
  return !!target?.closest?.(INTERACTIVE_CONTROL);
}

/** True when `target` is inside a chat card's interactive body. */
export function inChatBody(target: Element | null): boolean {
  return !!target?.closest?.('.chat-card-body');
}

/** True when `target` is inside a chat card's scrollable log. */
export function inChatLog(target: Element | null): boolean {
  return !!target?.closest?.('.chat-log');
}
