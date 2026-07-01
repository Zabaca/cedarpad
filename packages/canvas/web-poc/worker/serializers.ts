import type { schema } from "../lib/db/index.js";
import type {
  ApiKeyAdmin,
  Observation,
  ObservationLink,
  Problem,
  ProblemLink,
  Solution,
} from "../lib/contract/index.js";

type ObservationRow = typeof schema.observations.$inferSelect;
type ProblemRow = typeof schema.problems.$inferSelect;
type SolutionRow = typeof schema.solutions.$inferSelect;
type ProblemLinkRow = typeof schema.problemLinks.$inferSelect;
type ObservationLinkRow = typeof schema.observationLinks.$inferSelect;
type RunRow = typeof schema.agentRuns.$inferSelect;

const ms = (d: Date | number): number => (d instanceof Date ? d.getTime() : d);

export function serializeObservation(o: ObservationRow): Observation {
  return {
    id: o.id,
    workspaceId: o.workspaceId,
    title: o.title,
    body: o.body,
    impact: o.impact ?? null,
    status: o.status,
    source: o.source,
    projectTags: o.projectTags ?? [],
    createdBy: o.createdBy ?? null,
    embeddingModel: o.embeddingModel ?? null,
    createdAt: ms(o.createdAt),
    updatedAt: ms(o.updatedAt),
  };
}

export function serializeProblem(p: ProblemRow): Problem {
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    title: p.title,
    body: p.body,
    impact: p.impact ?? null,
    priority: p.priority,
    urgency: p.urgency,
    solutionDirection: p.solutionDirection ?? null,
    status: p.status,
    source: p.source,
    projectTags: p.projectTags ?? [],
    createdBy: p.createdBy ?? null,
    embeddingModel: p.embeddingModel ?? null,
    createdAt: ms(p.createdAt),
    updatedAt: ms(p.updatedAt),
  };
}

export function serializeSolution(s: SolutionRow): Solution {
  return {
    id: s.id,
    body: s.body,
    status: s.status,
    origin: s.origin,
    createdBy: s.createdBy ?? null,
    createdAt: ms(s.createdAt),
  };
}

/** Row shape for {@link serializeApiKey} — the key joined to its owner. */
interface ApiKeyRow {
  id: string;
  name: string | null;
  start: string | null;
  enabled: boolean;
  createdAt: Date | number;
  lastRequest: Date | number | null;
  expiresAt: Date | number | null;
  /** JSON-encoded `{ defaultWorkspaceId?, allowedWorkspaces? }`. */
  metadata: string | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
}

/**
 * Serialize an API key for the shared registry. The secret (`key`) is never
 * selected, so it can't leak here. Workspace scoping lives in the JSON
 * `metadata` blob — flattened to top-level fields for the client.
 */
export function serializeApiKey(row: ApiKeyRow): ApiKeyAdmin {
  let meta: { defaultWorkspaceId?: string; allowedWorkspaces?: string[] } = {};
  if (row.metadata) {
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      meta = {};
    }
  }
  return {
    id: row.id,
    name: row.name ?? null,
    start: row.start ?? null,
    enabled: row.enabled,
    createdAt: ms(row.createdAt),
    lastRequest: row.lastRequest == null ? null : ms(row.lastRequest),
    expiresAt: row.expiresAt == null ? null : ms(row.expiresAt),
    defaultWorkspaceId: meta.defaultWorkspaceId ?? null,
    allowedWorkspaces: meta.allowedWorkspaces ?? null,
    owner: row.ownerId
      ? { id: row.ownerId, name: row.ownerName ?? "", email: row.ownerEmail ?? "" }
      : null,
  };
}

export function serializeProblemLink(l: ProblemLinkRow): ProblemLink {
  return {
    id: l.id,
    fromProblemId: l.fromProblemId,
    toProblemId: l.toProblemId,
    kind: l.kind,
    similarity: l.similarity ?? null,
    rationale: l.rationale ?? null,
    createdBy: l.createdBy,
  };
}

export function serializeObservationLink(l: ObservationLinkRow): ObservationLink {
  return {
    id: l.id,
    fromObservationId: l.fromObservationId,
    toObservationId: l.toObservationId,
    kind: l.kind,
    similarity: l.similarity ?? null,
    rationale: l.rationale ?? null,
    createdBy: l.createdBy,
  };
}

export function serializeRun(r: RunRow) {
  return {
    id: r.id,
    kind: r.kind,
    targetKind: r.targetKind,
    targetId: r.targetId,
    status: r.status,
    providerModel: r.providerModel ?? null,
    tokensIn: r.tokensIn ?? null,
    tokensOut: r.tokensOut ?? null,
    createdAt: ms(r.createdAt),
  };
}
