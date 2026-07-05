import { configuration } from "../lib/config/index.js";
import {
  type Database,
  getClusterMembership,
  readClusterSummary,
  writeClusterSummary,
} from "../lib/db/index.js";
import {
  type ClusterContext,
  createChatModel,
  createClusterSummarizer,
  templateClusterSummary,
} from "../lib/ai/index.js";
import type { ClusterSummary } from "../lib/contract/index.js";
import type { Bindings } from "./context.js";

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const ms = (d: Date | number): number => (d instanceof Date ? d.getTime() : d);

/** Chat model when the active provider has a key, else null (heuristic path). */
function chatModelOrNull(env: Bindings) {
  const { ai } = configuration;
  const hasKey =
    (ai.provider === "anthropic" && env.ANTHROPIC_API_KEY) ||
    (ai.provider === "openai" && env.OPENAI_API_KEY);
  if (!hasKey) return null;
  return createChatModel(ai, {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: env.OPENAI_API_KEY,
  });
}

/**
 * Tier 3 cached cluster summary for a problem. Resolves the cluster from stored
 * rows (no LLM), serves a cached summary while membership is unchanged and
 * within TTL, otherwise regenerates: via the LLM when a key is present, else a
 * deterministic templated summary so the endpoint works offline. Returns `null`
 * when the problem does not exist.
 */
export async function getClusterSummary(
  db: Database,
  env: Bindings,
  problemId: string,
): Promise<ClusterSummary | null> {
  const g = configuration.graph;
  const membership = await getClusterMembership(db, {
    rootId: problemId,
    hops: g.defaultHops,
    maxNodes: g.maxNodes,
    maxMembers: g.summary.maxMembers,
  });
  if (!membership) return null;

  const context: ClusterContext = {
    rootProblemId: membership.rootProblemId,
    rootTitle: membership.rootTitle,
    members: membership.members,
  };
  const memberCount = membership.members.length;

  // Tier 3 disabled: still answer, but with the free templated summary, uncached.
  if (!g.summary.enabled) {
    return {
      rootProblemId: problemId,
      summary: templateClusterSummary(context),
      memberCount,
      model: "disabled",
      createdAt: Date.now(),
      cached: false,
    };
  }

  const cached = await readClusterSummary(db, problemId);
  const fresh =
    cached != null &&
    cached.membershipHash === membership.membershipHash &&
    Date.now() - ms(cached.createdAt) < g.summary.ttlMs;
  if (cached && fresh) {
    return {
      rootProblemId: problemId,
      summary: cached.summary,
      memberCount: cached.memberCount,
      model: cached.model,
      createdAt: ms(cached.createdAt),
      cached: true,
    };
  }

  const model = chatModelOrNull(env);
  const summary = model
    ? await createClusterSummarizer(model).summarize(context)
    : templateClusterSummary(context);
  const modelLabel = model ? `${configuration.ai.provider}:${configuration.ai.chatModel}` : "heuristic";

  await writeClusterSummary(db, {
    id: newId("cs"),
    rootProblemId: problemId,
    membershipHash: membership.membershipHash,
    summary,
    memberCount,
    model: modelLabel,
  });
  const row = await readClusterSummary(db, problemId);

  return {
    rootProblemId: problemId,
    summary,
    memberCount,
    model: modelLabel,
    createdAt: row ? ms(row.createdAt) : Date.now(),
    cached: false,
  };
}
