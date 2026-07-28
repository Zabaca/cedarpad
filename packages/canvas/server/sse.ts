// The one SSE frame encoder. Both planes emit the same wire forms — the chat multiplexer
// (server/bridge.ts) and each canvas's screenshot channel (server/screenshot-channel.ts) — so the encoding
// lives here once instead of being re-declared per module.

const enc = new TextEncoder();

/** A default-event frame: `data: <json>\n\n`. */
export const sseData = (data: unknown): Uint8Array => enc.encode(`data: ${JSON.stringify(data)}\n\n`);

/** A named-event frame: `event: <name>\ndata: <json>\n\n`. */
export const sseEvent = (name: string, data: unknown): Uint8Array => enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

/** A comment frame: `: <text>\n\n` — opens/flushes a stream and keeps it alive (no event fires). */
export const sseComment = (text: string): Uint8Array => enc.encode(`: ${text}\n\n`);
