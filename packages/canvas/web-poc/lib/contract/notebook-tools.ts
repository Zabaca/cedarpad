import { z } from "zod";

/**
 * The Notebook's MCP tool inputs — the single contract (CLAUDE.md §7) shared by every
 * surface that exposes them: the edge MCP server (`worker/mcp-server.ts`), the platform-RPC
 * verb the container calls (`shared/platform-rpc.ts`), and the container's own SDK tool defs
 * (`server/agent.ts`). One shape, parsed on both sides of every hop.
 *
 * Written against plain `zod` rather than the `@hono/zod-openapi` `z` the rest of the
 * contract uses, because these are NOT routes: the MCP SDK takes a raw zod shape
 * (`Schema.shape`) and an OpenAPI-registered schema would only add a name to a document no
 * MCP client reads.
 *
 * **No tool takes a workspace.** Every surface derives it from the caller — the token's user
 * at the edge, the container's own workspace inside a turn — so isolation holds by
 * construction rather than by each tool remembering to pass an argument (ADR-0024).
 */

/** Where an observation came from. Mirrors the API's `SourceKind`. */
export const NotebookSourceKind = z.enum([
  "url",
  "call",
  "document",
  "person",
  "conversation",
  "canvas",
  "repo",
]);

/** A Source named in the same call that records the observation. An identifier or a
 *  description must be present: a Source that says neither what it points at nor what it
 *  was records nothing. */
export const NotebookSourceInput = z.object({
  kind: NotebookSourceKind.describe("What the source is: url | call | document | person | conversation | canvas | repo"),
  identifier: z.string().min(1).optional().describe("The thing pointed at — a URL, a conversation id, a file path"),
  label: z.string().min(1).optional().describe("A short human name for the source"),
  description: z.string().min(1).optional().describe("Carries the source when there is nothing to point at"),
});

export const RecordObservationInput = z.object({
  title: z.string().min(1).max(300).describe("One line: what was noticed"),
  body: z.string().min(1).describe("The observation itself, in full"),
  impact: z.string().min(1).optional().describe("The concrete impact this observation calls out"),
  project_tags: z.array(z.string().min(1)).max(20).optional().describe("Human meta tags, e.g. a project name"),
  source: NotebookSourceInput.optional().describe("Where this came from, created inline. Omit when there is nothing to point at."),
  source_id: z.string().min(1).optional().describe("An existing source id instead of creating one"),
});

export const UpdateObservationInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(300).optional(),
  body: z.string().min(1).optional(),
  impact: z.string().min(1).optional(),
  status: z.enum(["open", "synthesized", "archived"]).optional(),
  project_tags: z.array(z.string().min(1)).max(20).optional(),
});

export const CreateProblemInput = z.object({
  title: z.string().min(1).max(300).describe("One line: the problem, stated specifically"),
  body: z.string().min(1).describe("The problem in full"),
  impact: z.string().min(1).optional().describe("The concrete impact"),
  urgency: z.enum(["low", "medium", "high", "critical"]).optional().describe("Defaults to medium; seeds the sort weight"),
  priority: z.number().int().optional().describe("Explicit sort weight; overrides the one urgency implies"),
  solution_direction: z.string().min(1).optional().describe("Guidance on how a solution should be structured"),
  project_tags: z.array(z.string().min(1)).max(20).optional(),
});

export const TieObservationInput = z.object({
  problem_id: z.string().min(1),
  observation_id: z.string().min(1),
  relevance: z.number().min(0).max(1).optional().describe("How strongly this observation feeds the problem (0–1)"),
  rationale: z.string().min(1).optional().describe("Why the tie was drawn"),
});

export const LinkProblemsInput = z.object({
  from_problem_id: z.string().min(1),
  to_problem_id: z.string().min(1),
  kind: z.enum(["identical", "partial", "related"]),
  rationale: z.string().min(1).optional(),
});

export const RecordSolutionInput = z.object({
  target_kind: z.enum(["observation", "problem"]),
  target_id: z.string().min(1),
  body: z.string().min(1).describe("The solution"),
});

export const SearchNotebookInput = z.object({
  q: z.string().min(1).describe("Free text. FTS5 syntax characters are searched for, never executed."),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

export const ReadRecordInput = z.object({ id: z.string().min(1) });

export const ListProblemsInput = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
  status: z.enum(["open", "investigating", "resolved", "archived"]).optional(),
  tag: z.string().min(1).optional().describe("Filter by a project meta tag"),
});

/**
 * The whole surface as one discriminated union — what the container sends over the platform
 * RPC. Named verbs, fully enumerated: there is no query, table or filter anywhere in it, so
 * it stays behavioural exactly as the rest of that contract is.
 */
export const NotebookCall = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("record_observation"), input: RecordObservationInput }),
  z.object({ tool: z.literal("update_observation"), input: UpdateObservationInput }),
  z.object({ tool: z.literal("create_problem"), input: CreateProblemInput }),
  z.object({ tool: z.literal("tie_observation"), input: TieObservationInput }),
  z.object({ tool: z.literal("link_problems"), input: LinkProblemsInput }),
  z.object({ tool: z.literal("record_solution"), input: RecordSolutionInput }),
  z.object({ tool: z.literal("search"), input: SearchNotebookInput }),
  z.object({ tool: z.literal("read_observation"), input: ReadRecordInput }),
  z.object({ tool: z.literal("read_problem"), input: ReadRecordInput }),
  z.object({ tool: z.literal("list_problems"), input: ListProblemsInput }),
]);
export type NotebookCall = z.infer<typeof NotebookCall>;
export type NotebookToolName = NotebookCall["tool"];

/**
 * How each tool is ADVERTISED — the MCP name, the schema, and the sentence the agent reads
 * when deciding whether to call it. One list, so the edge MCP server and the container's own
 * tool defs offer the same surface with the same words rather than two drifting copies.
 *
 * The names are `notebook_`-prefixed because an agent holds these alongside the canvas tools
 * and its own built-ins: `search` alone would be ambiguous the moment it matters.
 */
export const NOTEBOOK_TOOL_SPECS = [
  {
    name: "notebook_record_observation",
    tool: "record_observation",
    schema: RecordObservationInput,
    description:
      "Record an observation in the workspace Notebook — something you noticed while working that is worth keeping. Name where it came from with `source` (a URL, a call, a document, a conversation) in the same call; omit it when there is nothing to point at. Returns the observation's id.",
  },
  {
    name: "notebook_update_observation",
    tool: "update_observation",
    schema: UpdateObservationInput,
    description: "Edit an observation already in the Notebook: its title, body, impact, status or tags.",
  },
  {
    name: "notebook_create_problem",
    tool: "create_problem",
    schema: CreateProblemInput,
    description:
      "Record a problem: specific, prioritized, stated so a solution can be shaped against it. Observations feed problems — tie them with notebook_tie_observation. Returns the problem's id.",
  },
  {
    name: "notebook_tie_observation",
    tool: "tie_observation",
    schema: TieObservationInput,
    description:
      "Tie an observation to a problem it feeds, recording how strongly (relevance 0–1) and why. Tying the same pair again restates the tie.",
  },
  {
    name: "notebook_link_problems",
    tool: "link_problems",
    schema: LinkProblemsInput,
    description:
      "Link two problems — identical, partial or related — with a rationale. Links are deliberate: nothing infers them for you.",
  },
  {
    name: "notebook_record_solution",
    tool: "record_solution",
    schema: RecordSolutionInput,
    description: "Attach a solution to an observation or a problem.",
  },
  {
    name: "notebook_search",
    tool: "search",
    schema: SearchNotebookInput,
    description:
      "Search the workspace Notebook (full text, ranked). Returns POINTERS — id, kind, title and the matching excerpt — never bodies; read the full record with notebook_read_observation / notebook_read_problem. Paginated: pass limit/offset. Start here before recording something the workspace may already know.",
  },
  {
    name: "notebook_read_observation",
    tool: "read_observation",
    schema: ReadRecordInput,
    description: "Read one observation in full, with its source, its solutions and the problems it feeds.",
  },
  {
    name: "notebook_read_problem",
    tool: "read_problem",
    schema: ReadRecordInput,
    description: "Read one problem in full, with its linked problems, its solutions and the observations that feed it.",
  },
  {
    name: "notebook_list_problems",
    tool: "list_problems",
    schema: ListProblemsInput,
    description:
      "List the workspace's problems, highest priority first. Identifiers and one line each, never bodies; paginated (limit/offset), and filterable by status or project tag.",
  },
] as const satisfies ReadonlyArray<{
  name: string;
  tool: NotebookToolName;
  schema: z.ZodObject<z.ZodRawShape>;
  description: string;
}>;
