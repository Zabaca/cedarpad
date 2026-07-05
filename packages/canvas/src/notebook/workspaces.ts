import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "./api.js";

/** Every workspace the caller can access (workspaces are a soft grouping, not a tenant boundary). */
export function useWorkspaces() {
  return useQuery({ queryKey: ["workspaces"], queryFn: () => api.listWorkspaces() });
}

/** A `workspaceId → name` lookup for rendering workspace badges on records. */
export function useWorkspaceNames(): Record<string, string> {
  const { data } = useWorkspaces();
  return useMemo(() => Object.fromEntries((data ?? []).map((w) => [w.id, w.name])), [data]);
}
