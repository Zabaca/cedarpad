// A chat session as a first-class canvas shape. Each `chat` shape renders one
// conversation (its chatId is the shape id) by subscribing to the cull-safe
// chat-store. Drag the header to move the card; the body (log + input) is
// interactive. Deleting the shape ends the session (App watches for removal).

import { T, type TLBaseShape } from 'tldraw';

import { setActiveChat } from './agent-link';
import { ChatView } from '../shared/ChatView';
import { DOCK_CHAT, isEmbedded, postDockMessage } from '../shared/dock-messages';
import { type EventGuards, InteractiveBoxShapeUtil } from './InteractiveBoxShapeUtil';
import { inChatBody, inChatLog, isInteractiveControl } from './predicates';

// `chatId` overrides which chat the card fronts (the attach flow places a card for a chat
// born elsewhere); '' — the default — means "the shape id IS the chat id", as always.
export type ChatShapeTl = TLBaseShape<'chat', { w: number; h: number; title: string; chatId: string }>;

// Register `chat` as a first-class tldraw shape type (joins the TLShape union).
declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    chat: { w: number; h: number; title: string; chatId: string };
  }
}

/** The chat a card fronts: its `chatId` prop when set (attach flow), else its shape id. */
export const chatIdOf = (shape: ChatShapeTl): string => shape.props.chatId || shape.id;

export class ChatShapeUtil extends InteractiveBoxShapeUtil<'chat', { title: string; chatId: string }> {
  static override type = 'chat' as const;
  static override props = { w: T.number, h: T.number, title: T.string, chatId: T.string };

  override getDefaultProps(): ChatShapeTl['props'] {
    return { w: 380, h: 460, title: 'Chat', chatId: '' };
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

  override onContainerPointerDown = (shape: ChatShapeTl) => setActiveChat(chatIdOf(shape));

  protected override renderContent(shape: ChatShapeTl) {
    const chatId = chatIdOf(shape);
    // The dock gesture (CONTEXT.md "Docked chat"): only when embedded in the Shell —
    // a standalone pad tab has no panel to dock into.
    const onDock = isEmbedded()
      ? () => postDockMessage({ type: DOCK_CHAT, chatId, title: shape.props.title })
      : undefined;
    return <ChatView chatId={chatId} title={shape.props.title} onDock={onDock} />;
  }
}
