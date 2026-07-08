import { describe, expect, test } from 'bun:test';
import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import { orderInbox, transcriptObjectUrl } from './inbox-view.ts';

// Pure decisions the edge Inbox makes: list ordering (waiting_on:human pinned) and the R2
// object-URL derivation. Both are runtime-free so they test without the edge or a container.

const row = (o: Partial<ConversationRow>): ConversationRow =>
  ({
    id: o.id ?? 'c',
    sessionId: o.sessionId ?? 's',
    status: o.status ?? 'open',
    waitingOn: o.waitingOn ?? 'none',
    unread: o.unread ?? false,
    lastActivity: o.lastActivity ?? new Date(0),
    ownerRef: null,
    workspaceId: o.workspaceId ?? 'default',
    userId: o.userId ?? 'u',
    summary: o.summary ?? null,
    lastMessagePreview: o.lastMessagePreview ?? null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }) as ConversationRow;

describe('orderInbox', () => {
  test('pins waiting_on:human to the top, then newest-activity first within each group', () => {
    const rows = [
      row({ id: 'agent-new', waitingOn: 'agent', lastActivity: new Date(500) }),
      row({ id: 'human-old', waitingOn: 'human', lastActivity: new Date(100) }),
      row({ id: 'agent-old', waitingOn: 'agent', lastActivity: new Date(200) }),
      row({ id: 'human-new', waitingOn: 'human', lastActivity: new Date(400) }),
    ];
    expect(orderInbox(rows).map((i) => i.id)).toEqual(['human-new', 'human-old', 'agent-new', 'agent-old']);
  });

  test('normalizes lastActivity to epoch ms and projects the list fields', () => {
    const [item] = orderInbox([
      row({ id: 'x', waitingOn: 'human', unread: true, summary: 'S', lastMessagePreview: 'P', lastActivity: new Date(1234) }),
    ]);
    expect(item).toMatchObject({ id: 'x', waitingOn: 'human', unread: true, summary: 'S', lastMessagePreview: 'P', lastActivity: 1234 });
  });
});

describe('transcriptObjectUrl', () => {
  test('joins endpoint + bucket + the pure transcript key (S3 path-style)', () => {
    expect(transcriptObjectUrl('https://acct.r2.cloudflarestorage.com', 'cedar', 'sess-1')).toBe(
      'https://acct.r2.cloudflarestorage.com/cedar/sessions/sess-1/transcript.jsonl',
    );
  });
  test('tolerates a trailing slash on the endpoint', () => {
    expect(transcriptObjectUrl('https://acct.r2.cloudflarestorage.com/', 'cedar', 'sess-1')).toBe(
      'https://acct.r2.cloudflarestorage.com/cedar/sessions/sess-1/transcript.jsonl',
    );
  });
});
