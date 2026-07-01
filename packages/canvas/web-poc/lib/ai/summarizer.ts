import { generateText, type LanguageModel } from "ai";

/** One member problem of a cluster, with its accepted/attached solutions. */
export interface ClusterMember {
  problemId: string;
  title: string;
  /** Hop distance from the cluster root (0 = the root problem). */
  depth: number;
  solutions: { body: string; status: string; origin: string }[];
}

/** The compressed, LLM-free cluster context handed to the summarizer. */
export interface ClusterContext {
  rootProblemId: string;
  rootTitle: string;
  members: ClusterMember[];
}

const SUMMARY_SYSTEM = `You summarize a CLUSTER of related software problems and their solutions for an engineer triaging a new, similar problem.
Write 3-6 sentences covering: the common theme tying the cluster together, which problems already have accepted solutions worth reusing, and any gaps still unsolved.
Be concrete and reference problem titles. Do not invent solutions that are not present.`;

export interface ClusterSummarizer {
  summarize(cluster: ClusterContext): Promise<string>;
}

/** Provider-agnostic cluster summarizer backed by an AI SDK language model. */
export function createClusterSummarizer(model: LanguageModel): ClusterSummarizer {
  return {
    async summarize(cluster) {
      const { text } = await generateText({
        model,
        system: SUMMARY_SYSTEM,
        prompt: JSON.stringify({
          root: cluster.rootTitle,
          members: cluster.members.map((m) => ({
            title: m.title,
            depth: m.depth,
            solutions: m.solutions.map((s) => ({ status: s.status, origin: s.origin, body: s.body })),
          })),
        }),
      });
      return text.trim();
    },
  };
}

/**
 * Deterministic, token-free cluster summary. Used when no provider key is set so
 * the Tier 3 endpoint/tool still work offline (matching the rest of the system).
 */
export function templateClusterSummary(cluster: ClusterContext): string {
  const members = cluster.members;
  const solved = members.filter((m) => m.solutions.some((s) => s.status === "accepted"));
  const unsolved = members.filter((m) => !m.solutions.some((s) => s.status === "accepted"));

  const lines = [
    `Cluster around "${cluster.rootTitle}" with ${members.length} related problem(s).`,
  ];
  if (solved.length) {
    lines.push(
      `${solved.length} already have an accepted solution to reuse: ${solved
        .map((m) => `"${m.title}"`)
        .join(", ")}.`,
    );
  }
  if (unsolved.length) {
    lines.push(
      `${unsolved.length} still unsolved: ${unsolved.map((m) => `"${m.title}"`).join(", ")}.`,
    );
  }
  return lines.join(" ");
}
