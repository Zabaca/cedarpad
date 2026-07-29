// Rebuild a chat's settled transcript from the SDK's on-disk session JSONL (ADR 0004).
// The SDK already writes the full conversation to ~/.claude/projects/<...>/<sessionId>.jsonl
// for `resume`; ADR 0003 persists it across recycles. We derive the transcript from it
// rather than keeping a second copy. The on-disk record is {type, message, ...} whose
// `message` is the same shape classify reads, so each line passes straight through
// classifySdkMessage in replay mode — no adapter. Subagent (isSidechain) lines are dropped
// so a subagent's internal chatter doesn't render as main-agent text (no parent_tool_use_id
// is written on disk to nest them).

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { type TurnAccum, classifySdkMessage } from './classify.ts';
import { findSessionJsonl } from './session-jsonl.ts';
import type { ChatEvent } from './agent.ts';

/** Fold settled SDK messages into ordered replay ChatEvents. `result` lines fold
 *  cost/sessionId into the accumulator but emit no chip. */
export function projectTranscript(msgs: SDKMessage[]): ChatEvent[] {
  const out: ChatEvent[] = [];
  let acc: TurnAccum = { sessionId: null, costUsd: 0 };
  for (const m of msgs) {
    const { events, acc: next } = classifySdkMessage(m, acc, { replay: true });
    acc = next;
    out.push(...events);
  }
  return out;
}

/** Parse + project a raw session JSONL blob (the on-disk / R2 record) into replay events.
 *  Torn/malformed lines are skipped, subagent (isSidechain) lines dropped. Shared by the
 *  on-disk loader and the R2 read path (transcript-store.ts) so both project identically. */
export function projectJsonl(text: string): ChatEvent[] {
  const msgs: SDKMessage[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: { isSidechain?: boolean } & SDKMessage;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // a torn last line / malformed record is skipped, not fatal
    }
    if (rec.isSidechain) continue; // subagent internals: not the main transcript
    msgs.push(rec);
  }
  return projectTranscript(msgs);
}

/** Load + project a session's transcript. Locates the JSONL via findSessionJsonl (robust to
 *  flat vs cwd-hash nesting); an absent file yields `[]` (not an error). */
export async function loadSessionTranscript(projectsDir: string, sessionId: string): Promise<ChatEvent[]> {
  let text = '';
  for (const path of await findSessionJsonl(projectsDir, sessionId)) {
    text += (text ? '\n' : '') + (await Bun.file(path).text());
  }
  return projectJsonl(text);
}
