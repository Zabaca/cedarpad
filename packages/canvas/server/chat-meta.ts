// Server-owned per-chat durable state (ADR 0004). The chatId→sessionId link can't be
// derived (the JSONL carries no chatId), so it lives here alongside the per-chat config
// that used to ride in each /send body and each browser's localStorage. One in-memory
// map for the workspace, persisted as one blob via the ADR 0003 sink. Config is not
// data-loss-critical like the canvas, so there's no degraded guard: a load error
// propagates and the caller starts empty.

import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../shared/chat-store.ts';
import type { McpSelection } from './mcp-registry.ts';
import type { BlobStore } from './blob-store.ts';
import type { Persistable } from './persistable.ts';

/** `mcp` is the per-chat opt-out of connected external MCP servers/tools (absent = all on). */
export type ChatMeta = { sessionId: string | null; model: string; effort: string; forkNext: boolean; mcp?: McpSelection };

const defaults = (): ChatMeta => ({ sessionId: null, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT, forkNext: false });

export class ChatMetaStore {
  private map: Record<string, ChatMeta> = {};

  constructor(
    private readonly store: BlobStore,
    private readonly ws: string,
  ) {}

  /** Load the workspace's chat map into memory. Absent → empty; a backend error propagates. */
  async load(): Promise<void> {
    this.map = (await this.store.loadChatMeta(this.ws)) ?? {};
  }

  /** Full record for a chat, filling defaults for one never written. */
  get(chatId: string): ChatMeta {
    return { ...defaults(), ...this.map[chatId] };
  }

  /** Merge a patch over the current record (always stores a full record). In-memory only;
   *  call save() (or let the Persistable sink serialize) to persist. */
  set(chatId: string, patch: Partial<ChatMeta>): void {
    this.map[chatId] = { ...this.get(chatId), ...patch };
  }

  /** Read forkNext and clear it to false (the one-shot fork semantic). */
  consumeFork(chatId: string): boolean {
    const fork = this.get(chatId).forkNext;
    if (fork) this.set(chatId, { forkNext: false });
    return fork;
  }

  /** The whole map, for the Persistable serialize. */
  snapshot(): Record<string, ChatMeta> {
    return this.map;
  }

  async save(): Promise<void> {
    await this.store.saveChatMeta(this.ws, this.map);
  }

  /** Adapter so chatMeta persists through the ADR-0003 PersistSink like sessions/components/
   *  custom — one attempt→record-health→log wrapper, visible at /api/status, instead of the
   *  ad-hoc `save().catch(log)` calls at each mutation site. No guard: config isn't
   *  data-loss-critical like the canvas. */
  persistable(): Persistable<Record<string, ChatMeta>> {
    return { name: 'chatMeta', serialize: () => this.snapshot(), save: () => this.save() };
  }
}
