// A chat session as a first-class canvas shape. Each `chat` shape renders one
// conversation (its chatId is the shape id) by subscribing to the cull-safe
// chat-store. Drag the header to move the card; the body (log + input) is
// interactive. Deleting the shape ends the session (App watches for removal).

import { T, type TLBaseShape } from 'tldraw';

import { setActiveChat } from './agent-link';
import { ChatView } from '../shared/ChatView';
import { type EventGuards, InteractiveBoxShapeUtil } from './InteractiveBoxShapeUtil';
import { inChatBody, inChatLog, isInteractiveControl } from './predicates';

export type ChatShapeTl = TLBaseShape<'chat', { w: number; h: number; title: string }>;

// Register `chat` as a first-class tldraw shape type (joins the TLShape union).
declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    chat: { w: number; h: number; title: string };
  }
}

export class ChatShapeUtil extends InteractiveBoxShapeUtil<'chat', { title: string }> {
  static override type = 'chat' as const;
  static override props = { w: T.number, h: T.number, title: T.string };

  override getDefaultProps(): ChatShapeTl['props'] {
    return { w: 380, h: 460, title: 'Chat' };
  }

  override cornerRadius = 12;

  // Pointer/keyboard inside the body must reach the chat UI, not tldraw (the header
  // is left un-guarded so it drags the whole card); wheel is only swallowed inside
  // the log so it scrolls the transcript instead of zooming the canvas.
  // Body reaches the chat UI; the header drags the card — EXCEPT interactive
  // controls in the header (the model select) must reach the control, not drag.
  override readonly guards: EventGuards = {
    pointer: (t) => inChatBody(t) || isInteractiveControl(t),
    wheel: inChatLog,
    key: inChatBody,
  };

  override onContainerPointerDown = (shape: ChatShapeTl) => setActiveChat(shape.id);

  protected override renderContent(shape: ChatShapeTl) {
    return <ChatView chatId={shape.id} title={shape.props.title} />;
  }
}
