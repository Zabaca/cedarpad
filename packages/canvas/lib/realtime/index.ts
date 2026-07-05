/** Isomorphic realtime contract shared by the API (publisher) and web (subscriber). */

/** Channel carrying a workspace's live updates (observations, problems, solutions, links). */
export function workspaceChannel(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}

export const EventTypes = {
  ObservationCreated: "observation.created",
  ObservationProcessed: "observation.processed",
  ObservationFailed: "observation.failed",
  ProblemCreated: "problem.created",
  ProblemProcessed: "problem.processed",
  ProblemFailed: "problem.failed",
  ProblemSynthesized: "problem.synthesized",
  SolutionCreated: "solution.created",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export interface RealtimeMessage<T = unknown> {
  type: EventType | string;
  payload?: T;
}
