import { tool } from "ai";
import { z } from "zod";

/**
 * Provider-agnostic graph-retrieval tools an LLM agent can call mid-reasoning.
 *
 * The tools are pure definitions (description + input schema + execute); the
 * actual queries are injected via {@link GraphToolDeps} so the AI package never
 * takes a dependency on the database. `apps/api` wires the Drizzle-backed
 * implementations in. Every tool is read-only and bounded — no LLM at read
 * time, which keeps reads fast and cheap.
 */

export interface GraphToolDeps {
  searchGraph(input: { query: string; k?: number }): Promise<unknown>;
  getProblemContext(input: { problemId: string }): Promise<unknown>;
  expandNeighborhood(input: {
    problemId: string;
    hops?: number;
    maxNodes?: number;
  }): Promise<unknown>;
  findSolvedNeighbors(input: { problemId: string }): Promise<unknown>;
  getClusterSummary(input: { problemId: string }): Promise<unknown>;
}

export function createGraphTools(deps: GraphToolDeps) {
  return {
    searchGraph: tool({
      description:
        "Semantic search over existing problems. Returns the top matches, each annotated with the kinds of links it already has and whether it has an accepted solution. Use this first to find relevant prior work.",
      inputSchema: z.object({
        query: z.string().describe("natural-language description of the problem to match"),
        k: z.number().int().min(1).max(50).optional().describe("number of results"),
      }),
      execute: (input) => deps.searchGraph(input),
    }),

    getProblemContext: tool({
      description:
        "Fetch one problem with its links (each carrying the stored kind, similarity and rationale) and its attached solutions. Use this to understand WHY two problems relate without re-deriving it.",
      inputSchema: z.object({
        problemId: z.string(),
      }),
      execute: (input) => deps.getProblemContext(input),
    }),

    expandNeighborhood: tool({
      description:
        "Return a bounded multi-hop subgraph around a problem (nodes + edges). Use this to see the surrounding cluster. hops and maxNodes are capped server-side.",
      inputSchema: z.object({
        problemId: z.string(),
        hops: z.number().int().min(1).optional().describe("traversal depth"),
        maxNodes: z.number().int().min(1).optional().describe("max nodes returned"),
      }),
      execute: (input) => deps.expandNeighborhood(input),
    }),

    findSolvedNeighbors: tool({
      description:
        "Find the nearest problems to this one that already have an accepted solution, nearest first. Use this to jump straight to reusable solutions.",
      inputSchema: z.object({
        problemId: z.string(),
      }),
      execute: (input) => deps.findSolvedNeighbors(input),
    }),

    getClusterSummary: tool({
      description:
        "Get a cached natural-language summary of the cluster around a problem (its common theme, which members already have reusable solutions, and the gaps). Cheap to read — computed lazily and cached. Use this for a fast high-level orientation before diving into individual problems.",
      inputSchema: z.object({
        problemId: z.string(),
      }),
      execute: (input) => deps.getClusterSummary(input),
    }),
  };
}

export type GraphTools = ReturnType<typeof createGraphTools>;
