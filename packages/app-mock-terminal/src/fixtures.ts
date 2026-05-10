/* Hardcoded outline fixture for the visual mock.
 * Mirrors the domain language from packages/app/CONTEXT.md:
 *   Content Node, Thread Root, Turn Node, Block Node, Thread.
 *
 * Tree shape rendered:
 *
 *   • Engineering log
 *     • cedarpad design notes
 *       ▼ thread: how does the outline store handle reorder?    [thread-root]
 *         ├─ thread/main  (active)
 *         │    > prompt   "How does the outline store handle reorder?"
 *         │    ⏵ turn     [text, $Read, result, text]
 *         │    > prompt   "and across parents?"  (streaming...)
 *         └─ thread/alt   (branch)
 *              > prompt   "Show me the relevant tests"
 *              ⏵ turn     [text, $Grep, result]
 *     • TODO: write ADR for fractional indices            [completed]
 *   • Reading list
 *     • SQLite WAL internals                              [completed]
 *     • Workflowy data model post
 */

export type NodeKind =
  | "content"
  | "thread-root"
  | "prompt"
  | "turn"
  | "block-text"
  | "block-tool"
  | "block-result";

export type Marker = string;

export interface OutlineNode {
  id: string;
  kind: NodeKind;
  marker: Marker;
  text: string;
  meta?: string;
  completed?: boolean;
  /** Optional pre-rendered output for tool_result rows. */
  resultBlock?: string;
  resultStatus?: "ok" | "err";
  /** When true, emit a blinking caret at the end of the row. */
  streaming?: boolean;
  children?: OutlineNode[];
  /** When set, replaces normal children rendering with a side-by-side split. */
  split?: {
    left: { title: string; badge: string; children: OutlineNode[] };
    right: { title: string; badge: string; children: OutlineNode[] };
  };
}

export const tree: OutlineNode[] = [
  {
    id: "n-eng",
    kind: "content",
    marker: "•",
    text: "Engineering log",
    children: [
      {
        id: "n-cedar",
        kind: "content",
        marker: "•",
        text: "cedarpad design notes",
        children: [
          {
            id: "n-thread-root",
            kind: "thread-root",
            marker: "▼",
            text: "thread: how does the outline store handle reorder?",
            meta: "(workspace=cedarpad · 2 threads)",
            split: {
              left: {
                title: "thread/main",
                badge: "active",
                children: [
                  {
                    id: "p1",
                    kind: "prompt",
                    marker: ">",
                    text: '"How does the outline store handle reorder across siblings?"',
                    meta: "you · 14:02",
                  },
                  {
                    id: "t1",
                    kind: "turn",
                    marker: "⏵",
                    text: "turn  claude-sonnet-4.7  ·  4 blocks  ·  1.2s",
                    meta: "completed",
                    children: [
                      {
                        id: "b1",
                        kind: "block-text",
                        marker: "│",
                        text:
                          "The store uses fractional indexing on a single `position` column.\nReordering is O(1): pick a key strictly between the two neighbours.",
                      },
                      {
                        id: "b2",
                        kind: "block-tool",
                        marker: "$",
                        text: "Read packages/app/src/outline/store.ts",
                        meta: "tool_use · Read",
                      },
                      {
                        id: "b3",
                        kind: "block-result",
                        marker: "│",
                        text: "tool_result · 248 lines",
                        resultStatus: "ok",
                        resultBlock:
                          "  1  import { createClient } from '@libsql/client';\n  2  import { z } from 'zod';\n  3\n  4  const NodeRow = z.object({\n  5    id: z.string().uuid(),\n  6    parent_id: z.string().uuid().nullable(),\n  7    position: z.string(),  // fractional index\n  8    kind: z.enum(['content','turn','block']),\n  9    content: z.string(),\n …  (240 lines elided)",
                      },
                      {
                        id: "b4",
                        kind: "block-text",
                        marker: "│",
                        text:
                          "Within a parent, `position` is a fractional index (string-encoded base62).\nMoving across parents is just an UPDATE of `parent_id` + a new key — no\ncascading shifts. The `(parent_id, position)` index keeps reads fast.",
                      },
                    ],
                  },
                  {
                    id: "p2",
                    kind: "prompt",
                    marker: ">",
                    text: '"and across parents — is reorder transactional?"',
                    meta: "you · 14:05",
                  },
                  {
                    id: "t2",
                    kind: "turn",
                    marker: "⏵",
                    text: "turn  claude-sonnet-4.7  ·  streaming",
                    meta: "live",
                    streaming: true,
                    children: [
                      {
                        id: "b5",
                        kind: "block-tool",
                        marker: "$",
                        text: "Grep -n 'BEGIN TRANSACTION' packages/app/src",
                        meta: "tool_use · Grep",
                      },
                      {
                        id: "b6",
                        kind: "block-result",
                        marker: "│",
                        text: "tool_result · 3 matches",
                        resultStatus: "ok",
                        resultBlock:
                          "packages/app/src/outline/store.ts:142:    await tx.execute('BEGIN TRANSACTION');\npackages/app/src/outline/store.ts:198:    await tx.execute('BEGIN TRANSACTION');\npackages/app/src/thread/engine.ts:87:     await tx.execute('BEGIN TRANSACTION');",
                      },
                      {
                        id: "b7",
                        kind: "block-text",
                        marker: "│",
                        text: "Yes — `moveNode` wraps the parent_id change and the position update",
                        streaming: true,
                      },
                    ],
                  },
                ],
              },
              right: {
                title: "thread/alt",
                badge: "branch",
                children: [
                  {
                    id: "p3",
                    kind: "prompt",
                    marker: ">",
                    text: '"Show me the relevant tests for moveNode"',
                    meta: "you · 14:07 · branched from b1",
                  },
                  {
                    id: "t3",
                    kind: "turn",
                    marker: "⏵",
                    text: "turn  claude-sonnet-4.7  ·  3 blocks  ·  0.9s",
                    meta: "completed",
                    children: [
                      {
                        id: "b8",
                        kind: "block-text",
                        marker: "│",
                        text:
                          "Looking at the test file for the outline store…",
                      },
                      {
                        id: "b9",
                        kind: "block-tool",
                        marker: "$",
                        text: "Grep -rln 'moveNode' packages/app/src/outline",
                        meta: "tool_use · Grep",
                      },
                      {
                        id: "b10",
                        kind: "block-result",
                        marker: "│",
                        text: "tool_result · 2 files",
                        resultStatus: "ok",
                        resultBlock:
                          "packages/app/src/outline/store.ts\npackages/app/src/outline/store.test.ts",
                      },
                    ],
                  },
                ],
              },
            },
          },
          {
            id: "n-todo-adr",
            kind: "content",
            marker: "•",
            text: "TODO: write ADR for fractional indices",
            meta: "completed",
            completed: true,
          },
          {
            id: "n-todo-bench",
            kind: "content",
            marker: "•",
            text: "TODO: bench reorder under 10k siblings",
          },
        ],
      },
      {
        id: "n-questions",
        kind: "content",
        marker: "•",
        text: "Open questions",
        children: [
          {
            id: "n-q1",
            kind: "content",
            marker: "•",
            text: "When does a Block Node get its own children?",
          },
          {
            id: "n-q2",
            kind: "content",
            marker: "•",
            text: "How do we visualise a cancelled Turn Node?",
          },
        ],
      },
    ],
  },
  {
    id: "n-reading",
    kind: "content",
    marker: "•",
    text: "Reading list",
    children: [
      {
        id: "n-r1",
        kind: "content",
        marker: "•",
        text: "SQLite WAL internals",
        completed: true,
      },
      {
        id: "n-r2",
        kind: "content",
        marker: "•",
        text: "Workflowy data model post",
      },
    ],
  },
];

export interface Workspace {
  name: string;
  path: string;
  threadCount: number;
  lastUsed: string;
  /** Indices into `name` that are "matched" by the fuzzy query — visual only. */
  matchIndices: number[];
}

export const workspaces: Workspace[] = [
  {
    name: "cedarpad",
    path: "~/Projects/zabaca/cedarpad",
    threadCount: 14,
    lastUsed: "now",
    matchIndices: [0, 1, 2],
  },
  {
    name: "ce-skills-lab",
    path: "~/Projects/zabaca/ce-skills-lab",
    threadCount: 3,
    lastUsed: "2h ago",
    matchIndices: [0, 1],
  },
  {
    name: "claude-agent-sdk",
    path: "~/work/anthropic/claude-agent-sdk",
    threadCount: 7,
    lastUsed: "yesterday",
    matchIndices: [0, 1],
  },
  {
    name: "crux",
    path: "~/Projects/zabaca/crux",
    threadCount: 22,
    lastUsed: "3d ago",
    matchIndices: [0],
  },
  {
    name: "outline-experiments",
    path: "~/scratch/outline-experiments",
    threadCount: 2,
    lastUsed: "1w ago",
    matchIndices: [],
  },
];
