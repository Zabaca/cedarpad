// Hardcoded fixture data for the cedarpad visual mock.
// Mirrors the domain glossary in packages/app/CONTEXT.md:
// Node | Content Node | Thread Root | Turn Node | Block Node | Thread

export type ContentNode = {
  kind: "content";
  id: string;
  text: string;
  /** When true, this Content Node is a Thread Root (a Thread has been started on it). */
  threadRoot?: boolean;
  /** Children may be ContentNodes (outline) or Threads (when threadRoot). */
  children?: ContentNode[];
  /** Threads attached to this node when it is a Thread Root. */
  threads?: Thread[];
  /** Mark "where the cursor is" for the static mock. */
  cursor?: boolean;
};

export type Thread = {
  id: string;
  /** Short human-readable label for the branch (e.g. "main", "alt: redis approach"). */
  label: string;
  nodes: ThreadChild[];
};

export type ThreadChild = ContentNode | TurnNode;

export type TurnNode = {
  kind: "turn";
  id: string;
  /** Display name shown in the turn header. */
  agent: string;
  /** Block children — each rendered as its own visually distinct card. */
  blocks: BlockNode[];
};

export type BlockNode =
  | { kind: "block"; type: "text"; id: string; text: string }
  | {
      kind: "block";
      type: "tool_use";
      id: string;
      tool: string;
      input: Record<string, string>;
    }
  | {
      kind: "block";
      type: "tool_result";
      id: string;
      ofToolUseId: string;
      result: string;
    };

export type Workspace = {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
};

export const WORKSPACES: Workspace[] = [
  {
    id: "ws-cedar",
    name: "cedarpad",
    path: "~/Projects/zabaca/cedarpad",
    lastOpened: "active",
  },
  {
    id: "ws-orchard",
    name: "orchard-api",
    path: "~/Projects/zabaca/orchard-api",
    lastOpened: "2h ago",
  },
  {
    id: "ws-pondlogs",
    name: "pondlogs",
    path: "~/Projects/personal/pondlogs",
    lastOpened: "yesterday",
  },
  {
    id: "ws-talks",
    name: "talks-2026",
    path: "~/Documents/talks-2026",
    lastOpened: "3 days ago",
  },
];

// The outline tree.
// Top-level: a few Workflowy-style Content Nodes; one of them is a Thread Root
// that has two sibling Threads showing what branching produces.
export const OUTLINE: ContentNode[] = [
  {
    kind: "content",
    id: "n-1",
    text: "cedarpad — design notes",
    children: [
      {
        kind: "content",
        id: "n-1-1",
        text: "the killer move is treating Claude Code sessions as a tree",
      },
      {
        kind: "content",
        id: "n-1-2",
        text: "Workflowy + branching = dense thinking, not linear scrollback",
        children: [
          {
            kind: "content",
            id: "n-1-2-1",
            text: "every Block is a node — fork from anywhere, cheap",
            cursor: true,
          },
          {
            kind: "content",
            id: "n-1-2-2",
            text: "compare two continuations side-by-side as siblings",
          },
        ],
      },
    ],
  },
  {
    kind: "content",
    id: "n-2",
    text: "questions for Claude about this repo",
    threadRoot: true,
    children: [],
    threads: [
      {
        id: "t-1",
        label: "main",
        nodes: [
          {
            kind: "content",
            id: "t-1-prompt",
            text: "What's the data model for Threads vs. branching? Look at packages/app/CONTEXT.md and the ADRs.",
          },
          {
            kind: "turn",
            id: "t-1-turn",
            agent: "Claude",
            blocks: [
              {
                kind: "block",
                type: "text",
                id: "b-1",
                text: "I'll look at the domain glossary and the relevant ADRs to answer this.",
              },
              {
                kind: "block",
                type: "tool_use",
                id: "b-2",
                tool: "Read",
                input: { file_path: "packages/app/CONTEXT.md" },
              },
              {
                kind: "block",
                type: "tool_result",
                id: "b-3",
                ofToolUseId: "b-2",
                result:
                  "# App\n\nThe cedarpad application: a Workflowy-style outliner where any outline node can become the root of a Claude conversation...\n\n**Node**, **Content Node**, **Thread Root**, **Turn Node**, **Block Node**, **Thread**.",
              },
              {
                kind: "block",
                type: "tool_use",
                id: "b-4",
                tool: "Grep",
                input: {
                  pattern: "Branch",
                  path: "docs/adr/",
                },
              },
              {
                kind: "block",
                type: "tool_result",
                id: "b-5",
                ofToolUseId: "b-4",
                result:
                  "docs/adr/0005-v1-tauri-libsql-per-repo.md:  - branch verbs: Branch, Retry from here, New thread sibling.",
              },
              {
                kind: "block",
                type: "text",
                id: "b-6",
                text: "Threads live as descendants of a Thread Root. A Thread Root is a Content Node that has had a conversation started on it. Branching creates a sibling Thread under the same Root — so multiple Threads can coexist as parallel continuations of the same starting point. The three branch verbs differ only in what prior context is sent to Claude on the next turn.",
              },
            ],
          },
        ],
      },
      {
        id: "t-2",
        label: "alt: branched from Read result",
        nodes: [
          {
            kind: "content",
            id: "t-2-prompt",
            text: "(Branch from Block b-3) — Given that glossary, what's the smallest schema that captures it in libSQL?",
          },
          {
            kind: "turn",
            id: "t-2-turn",
            agent: "Claude",
            blocks: [
              {
                kind: "block",
                type: "text",
                id: "b2-1",
                text: "Single nodes table: id, parent_id, position, kind (content|turn|block), text, plus a small JSON payload for block-specific fields (tool name, input, result). Threads are an emergent property of the parent_id graph — no separate threads table needed in v1.",
              },
              {
                kind: "block",
                type: "tool_use",
                id: "b2-2",
                tool: "Read",
                input: {
                  file_path: "docs/adr/0005-v1-tauri-libsql-per-repo.md",
                },
              },
              {
                kind: "block",
                type: "tool_result",
                id: "b2-3",
                ofToolUseId: "b2-2",
                result:
                  "...libSQL chosen specifically so v2 can enable Turso embedded replicas...",
              },
            ],
          },
        ],
      },
    ],
  },
  {
    kind: "content",
    id: "n-3",
    text: "follow-ups",
    children: [
      {
        kind: "content",
        id: "n-3-1",
        text: "decide: .cedarpad/db.sqlite (commitable) vs ~/.cedarpad/<hash>/ (private)",
      },
      {
        kind: "content",
        id: "n-3-2",
        text: "Block-level addressability — anchor IDs survive reorder?",
      },
    ],
  },
];

// Keyboard hints displayed in the footer / help overlay.
export type KeyHint = { keys: string[]; label: string };

export const KEY_HINTS: KeyHint[] = [
  { keys: ["Enter"], label: "new sibling" },
  { keys: ["Tab"], label: "nest" },
  { keys: ["Shift", "Tab"], label: "outdent" },
  { keys: ["Cmd", "P"], label: "switch workspace" },
  { keys: ["Cmd", "Enter"], label: "start Thread" },
  { keys: ["Cmd", "B"], label: "Branch from Block" },
  { keys: ["Cmd", "R"], label: "Retry from here" },
  { keys: ["Cmd", "N"], label: "new Thread sibling" },
  { keys: ["Cmd", "."], label: "zoom into Node" },
  { keys: ["Cmd", "K"], label: "search" },
  { keys: ["?"], label: "help" },
];
