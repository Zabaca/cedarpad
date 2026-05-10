// Hardcoded fixtures for the visual mock.
// Mirrors the domain in packages/app/CONTEXT.md:
//   Node = the primitive; Content / Thread Root / Turn / Block are kinds.
//   A Thread Root may have multiple sibling Threads (branches).

export type Workspace = {
  id: string;
  name: string;
  path: string;
  lastOpened: string;
};

export const workspaces: Workspace[] = [
  { id: 'ws-1', name: 'cedarpad', path: '~/Projects/zabaca/cedarpad', lastOpened: 'now' },
  { id: 'ws-2', name: 'turso-libsql', path: '~/Projects/turso-libsql', lastOpened: '2h ago' },
  { id: 'ws-3', name: 'flux-engine', path: '~/Code/experiments/flux-engine', lastOpened: 'yesterday' },
  { id: 'ws-4', name: 'site-2026', path: '~/Projects/zabaca/site-2026', lastOpened: '3 days ago' },
];

export type ContentNode = {
  id: string;
  kind: 'content';
  text: string;
  completed?: boolean;
  children: OutlineNode[];
};

export type ThreadRoot = {
  id: string;
  kind: 'thread-root';
  text: string; // the seed prompt / topic
  threads: Thread[]; // sibling Threads under this Root
};

export type OutlineNode = ContentNode | ThreadRoot;

export type Thread = {
  id: string;
  label: string; // short human label for the column header
  status: 'idle' | 'streaming' | 'done' | 'cancelled';
  turns: Turn[];
};

export type Turn = {
  id: string;
  prompt: string; // the human prompt that produced this turn
  blocks: Block[];
};

export type TextBlock = { id: string; kind: 'text'; text: string };
export type ToolUseBlock = {
  id: string;
  kind: 'tool_use';
  tool: 'Read' | 'Grep' | 'Glob';
  input: string;
};
export type ToolResultBlock = {
  id: string;
  kind: 'tool_result';
  tool: 'Read' | 'Grep' | 'Glob';
  output: string;
};
export type Block = TextBlock | ToolUseBlock | ToolResultBlock;

// ----- The outline -----

export const outline: OutlineNode[] = [
  {
    id: 'n-welcome',
    kind: 'content',
    text: 'cedarpad — repo Q&A, but the conversation is a tree.',
    children: [
      {
        id: 'n-prd',
        kind: 'content',
        text: 'Read PRD and ADRs',
        completed: true,
        children: [
          {
            id: 'n-prd-1',
            kind: 'content',
            text: 'PRD: outliner + per-node Claude Code threads',
            completed: true,
            children: [],
          },
          {
            id: 'n-prd-2',
            kind: 'content',
            text: 'ADR-0004: Claude Code SDK as transport',
            completed: true,
            children: [],
          },
          {
            id: 'n-prd-3',
            kind: 'content',
            text: 'ADR-0005: v1 Tauri + libSQL per-repo',
            completed: false,
            children: [],
          },
        ],
      },
      {
        id: 'n-questions',
        kind: 'content',
        text: 'Open questions about the codebase',
        children: [
          // The Thread Root — the hero of variant B.
          {
            id: 'n-tr-1',
            kind: 'thread-root',
            text: 'How does the Thread engine slice history for the three branch verbs?',
            threads: [
              {
                id: 't-1a',
                label: 'main exploration',
                status: 'done',
                turns: [
                  {
                    id: 'tu-1a-1',
                    prompt: 'How does the Thread engine slice history for the three branch verbs?',
                    blocks: [
                      {
                        id: 'b-1a-1-t1',
                        kind: 'text',
                        text:
                          'Looking at the Thread engine, all three branch verbs (Branch / Retry from here / New thread sibling) reduce to one operation: "create a new subtree from a slice of conversation history."',
                      },
                      {
                        id: 'b-1a-1-tu1',
                        kind: 'tool_use',
                        tool: 'Grep',
                        input: '"branch\\(" packages/app/src/thread',
                      },
                      {
                        id: 'b-1a-1-tr1',
                        kind: 'tool_result',
                        tool: 'Grep',
                        output:
                          'thread/engine.ts:47: branch(sourceBlockId, mode) {\nthread/engine.ts:62:   const slice = this.sliceHistory(sourceBlockId, mode);',
                      },
                      {
                        id: 'b-1a-1-tu2',
                        kind: 'tool_use',
                        tool: 'Read',
                        input: 'thread/engine.ts:40-90',
                      },
                      {
                        id: 'b-1a-1-tr2',
                        kind: 'tool_result',
                        tool: 'Read',
                        output:
                          'sliceHistory(blockId, mode):\n  if mode === "branch" → history through and including blockId\n  if mode === "retry" → history before blockId (exclusive)\n  if mode === "new-sibling" → empty []',
                      },
                      {
                        id: 'b-1a-1-t2',
                        kind: 'text',
                        text:
                          'So Branch is inclusive, Retry is exclusive, and New thread sibling is empty. The three public methods are thin wrappers over this single primitive.',
                      },
                    ],
                  },
                  {
                    id: 'tu-1a-2',
                    prompt: 'And how does each variant get rendered as a sibling subtree?',
                    blocks: [
                      {
                        id: 'b-1a-2-t1',
                        kind: 'text',
                        text:
                          'Each branch becomes a new Thread (subtree) directly under the same Thread Root. So if you Branch three times you get three sibling Threads — each fully independent, each with its own Turn Nodes.',
                      },
                    ],
                  },
                ],
              },
              {
                id: 't-1b',
                label: 'what if Branch were exclusive?',
                status: 'streaming',
                turns: [
                  {
                    id: 'tu-1b-1',
                    prompt: 'What if Branch were exclusive of the source Block — like Retry but with a different name?',
                    blocks: [
                      {
                        id: 'b-1b-1-t1',
                        kind: 'text',
                        text:
                          'If Branch and Retry were both exclusive, the only difference would be intent — and that collapses into a single verb.',
                      },
                      {
                        id: 'b-1b-1-tu1',
                        kind: 'tool_use',
                        tool: 'Read',
                        input: 'packages/app/CONTEXT.md',
                      },
                      {
                        id: 'b-1b-1-tr1',
                        kind: 'tool_result',
                        tool: 'Read',
                        output:
                          'Branch — Fork the conversation at this point with full history *including* this Node.\nRetry from here — Fork with full history *up to but excluding* this Node.',
                      },
                      {
                        id: 'b-1b-1-t2',
                        kind: 'text',
                        text:
                          'The doc is explicit: Branch is inclusive, Retry is exclusive. They model two different intents. Collapsing them would lose the "what if Claude had continued differently from here" framing — Branch keeps the Block in context so Claude has something to react to.',
                      },
                    ],
                  },
                ],
              },
              {
                id: 't-1c',
                label: 'edge: branch from a Turn Node',
                status: 'done',
                turns: [
                  {
                    id: 'tu-1c-1',
                    prompt: 'What does Branch do if the source is a Turn Node, not a Block Node?',
                    blocks: [
                      {
                        id: 'b-1c-1-t1',
                        kind: 'text',
                        text:
                          'Branching from a Turn Node treats the entire turn as a single unit — history includes all prior turns plus this turn in full. Effectively the same as branching from the last Block of that turn.',
                      },
                      {
                        id: 'b-1c-1-tu1',
                        kind: 'tool_use',
                        tool: 'Grep',
                        input: '"kind === \'turn\'" packages/app/src/thread',
                      },
                      {
                        id: 'b-1c-1-tr1',
                        kind: 'tool_result',
                        tool: 'Grep',
                        output: 'engine.ts:74:   if (source.kind === "turn") return source.lastBlockId;',
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            id: 'n-q-2',
            kind: 'content',
            text: 'Where does the Outline store live in v1?',
            children: [],
          },
          {
            id: 'n-q-3',
            kind: 'content',
            text: 'How does streaming append Block Nodes incrementally?',
            children: [],
          },
        ],
      },
      {
        id: 'n-ideas',
        kind: 'content',
        text: 'Ideas to explore later',
        children: [
          { id: 'n-i-1', kind: 'content', text: 'Side-by-side diff between two sibling Threads', children: [] },
          { id: 'n-i-2', kind: 'content', text: 'Mini-map of all forks across the workspace', children: [] },
          { id: 'n-i-3', kind: 'content', text: 'Promote a Block back to a Content Node', children: [] },
        ],
      },
    ],
  },
];

// ----- Branch graph mini-map data -----

export type GraphNode = {
  id: string;
  label: string;
  kind: 'root' | 'thread' | 'turn';
  active?: boolean; // is this the focused branch
  children: GraphNode[];
};

export const branchGraph: GraphNode = {
  id: 'n-tr-1',
  label: 'Thread engine: history slicing',
  kind: 'root',
  children: [
    {
      id: 't-1a',
      label: 'main exploration',
      kind: 'thread',
      active: true,
      children: [
        { id: 'tu-1a-1', label: 'turn 1', kind: 'turn', children: [] },
        { id: 'tu-1a-2', label: 'turn 2', kind: 'turn', children: [] },
      ],
    },
    {
      id: 't-1b',
      label: 'what if Branch were exclusive?',
      kind: 'thread',
      children: [{ id: 'tu-1b-1', label: 'turn 1', kind: 'turn', children: [] }],
    },
    {
      id: 't-1c',
      label: 'edge: branch from a Turn Node',
      kind: 'thread',
      children: [{ id: 'tu-1c-1', label: 'turn 1', kind: 'turn', children: [] }],
    },
  ],
};
