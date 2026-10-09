import {
  type ComponentCatalogEntry,
  type ComponentHistoryInput,
  ComponentHistoryOutput,
  type ComponentListInput,
  ComponentListOutput,
  type ComponentReadInput,
  ComponentReadOutput,
  type ComponentRestoreInput,
  ComponentRestoreOutput,
  type ComponentTierMoveInput,
  type ComponentVersion,
  type ComponentWriteInput,
  ComponentWriteOutput,
  type DataReadInput,
  DataReadOutput,
  type DataWriteInput,
  DataWriteOutput,
  type NotebookCallInput,
  NotebookCallOutput,
  PLATFORM_RPC_PATH,
  PlatformRpcRequest,
  type SkillListInput,
  SkillListOutput,
  type SkillWriteInput,
  SkillWriteOutput,
  platformRpcToken,
} from '../shared/platform-rpc.ts';

// The container half of the platform RPC (ADR-0018). Since #266 the container holds NO
// platform-data-layer client at all, so this is the only way it writes — and the surface is
// a handful of named verbs; there is no query, exec, or table name to reach for.

/** The operations, as the bridge calls them. Every one THROWS when the edge refuses or is
 *  unreachable — none of them is best-effort. */
export interface PlatformRpc {
  /** Persist a Component as a Record (ADR-0022). THROWS if the edge refuses or is
   *  unreachable — a Component write that cannot be persisted must fail the tool call so
   *  the agent can retry, rather than succeed to disk and evaporate on the next bad boot. */
  componentWrite(input: ComponentWriteInput): Promise<ComponentWriteOutput>;
  /** A Component's stored source, or null when the tier holds no Record. THROWS on a real
   *  store failure, so "absent" and "could not ask" stay distinguishable. */
  componentRead(input: ComponentReadInput): Promise<string | null>;
  /** A Component's version history, newest first — who changed it and when. THROWS like the
   *  other Record verbs: "no history" and "could not ask" must not look the same. */
  componentHistory(input: ComponentHistoryInput): Promise<ComponentVersion[]>;
  /** Make an earlier version current again, returning the NEW revision — or null when the
   *  Component has no such version. The caller names a VERSION, so the old source is read and
   *  re-put at the edge and never travels here. THROWS on a real store failure. */
  componentRestore(input: ComponentRestoreInput): Promise<number | null>;
  /** Every Component the canvas can see — own and shared from Records, the platform tier from
   *  the edge's build-time manifest — each labelled with the tier it RESOLVES in. THROWS like
   *  the other Record verbs: "the library is empty" and "could not ask" must not look alike,
   *  because the first is what makes an agent author a duplicate of everything. */
  componentList(input: ComponentListInput): Promise<ComponentCatalogEntry[]>;
  /** Move a Component from a canvas into the workspace shared library — ONE change of tier
   *  at the edge, so it can never land in both libraries or in neither. */
  componentPromote(input: ComponentTierMoveInput): Promise<ComponentWriteOutput>;
  /** Copy a shared Component into a canvas's own library so it can diverge deliberately. */
  componentAdopt(input: ComponentTierMoveInput): Promise<ComponentWriteOutput>;
  /** Persist a Workspace skill's files as Records (ADR-0022, #361). THROWS, for the same
   *  reason `componentWrite` does: an upload that cannot be persisted must fail its tool call. */
  skillWrite(input: SkillWriteInput): Promise<SkillWriteOutput>;
  /** The workspace's whole skill tree, for materialization before a turn. THROWS on a store
   *  failure — the caller decides whether to degrade, and it does (server/skills.ts). */
  skillList(input: SkillListInput): Promise<SkillListOutput['files']>;
  /** Persist a data file as a Record. THROWS for the same reason `componentWrite` does. */
  dataWrite(input: DataWriteInput): Promise<DataWriteOutput>;
  /** A data file's stored content, or null when the tier holds no Record. */
  dataRead(input: DataReadInput): Promise<string | null>;
  /** Run one Notebook tool at the edge (ADR-0024) and return whatever it answered. THROWS on
   *  a refusal or an outage, carrying the edge's reason — the agent must be able to read
   *  "no such observation" and act on it, and must never be told a write landed when it did
   *  not. */
  notebook(input: NotebookCallInput): Promise<unknown>;
}

export interface PlatformRpcConfig {
  /** The edge origin (PLATFORM_RPC_ORIGIN, injected by worker/container-env.ts). Unset outside
   * a container, which is what makes "no edge in front of me" an explicit state. */
  origin: string | undefined;
  /** The shared trust root the bearer is derived from (BETTER_AUTH_SECRET). */
  secret: string | undefined;
  /** Test seam. Just the call signature — `typeof fetch` would also demand Bun's `preconnect`. */
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * The client, or **null when unconfigured**. A bridge with no edge
 * origin (local dev: vite + bridge, no Worker) keeps using its own platform-data-layer client;
 * ADR-0018 slice #263 puts the edge into local dev, and slice #266 removes that client for good.
 */
export function platformRpc(config: PlatformRpcConfig): PlatformRpc | null {
  const origin = config.origin?.replace(/\/$/, '');
  const secret = config.secret;
  if (!origin || !secret) return null;
  const doFetch = config.fetchImpl ?? fetch;

  // A failure PROPAGATES (ADR-0022). Component source is the thing the 2026-07-29 outage
  // destroyed; "logged, carry on" is exactly the fail-open that turned a failed read into a
  // destructive write.
  const strictFetch = async (body: PlatformRpcRequest): Promise<Response> =>
    await doFetch(`${origin}${PLATFORM_RPC_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await platformRpcToken(secret)}` },
      body: JSON.stringify(PlatformRpcRequest.parse(body)),
    });

  /** Carry the edge's reason when it gave one: "a shared component X already exists" is
   *  something the agent can act on, where a bare status code is something it can only
   *  report. The wrapper stays, so "the store refused" is never mistaken for a local bug. */
  const refused = async (body: PlatformRpcRequest, res: Response): Promise<Error> => {
    const reason = await res
      .json()
      .then((b) => (b as { error?: string })?.error)
      .catch(() => null);
    return new Error(`the workspace store refused this write (${body.op}: ${res.status}${reason ? ` — ${reason}` : ''})`);
  };

  const callStrict = async (body: PlatformRpcRequest): Promise<unknown> => {
    const res = await strictFetch(body);
    if (!res.ok) throw await refused(body, res);
    return await res.json();
  };

  return {
    componentWrite: async (input) => ComponentWriteOutput.parse(await callStrict({ op: 'component.write', input })),
    componentRead: async (input) => ComponentReadOutput.parse(await callStrict({ op: 'component.read', input })).source,
    componentHistory: async (input) =>
      ComponentHistoryOutput.parse(await callStrict({ op: 'component.history', input })).versions,
    componentRestore: async (input) => {
      const body = { op: 'component.restore', input } as const;
      const res = await strictFetch(body);
      // "There is no v7" is an ANSWER — the caller named a version it may have guessed at —
      // and must not look like "the store is down", which the caller should retry.
      if (res.status === 404) return null;
      if (!res.ok) throw await refused(body, res);
      return ComponentRestoreOutput.parse(await res.json()).rev;
    },
    componentList: async (input) => ComponentListOutput.parse(await callStrict({ op: 'component.list', input })).components,
    componentPromote: async (input) => ComponentWriteOutput.parse(await callStrict({ op: 'component.promote', input })),
    componentAdopt: async (input) => ComponentWriteOutput.parse(await callStrict({ op: 'component.adopt', input })),
    skillWrite: async (input) => SkillWriteOutput.parse(await callStrict({ op: 'skill.write', input })),
    skillList: async (input) => SkillListOutput.parse(await callStrict({ op: 'skill.list', input })).files,
    dataWrite: async (input) => DataWriteOutput.parse(await callStrict({ op: 'data.write', input })),
    dataRead: async (input) => DataReadOutput.parse(await callStrict({ op: 'data.read', input })).source,
    notebook: async (input) => NotebookCallOutput.parse(await callStrict({ op: 'notebook.call', input })).result,
  };
}
