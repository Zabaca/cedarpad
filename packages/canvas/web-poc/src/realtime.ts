import { workspaceChannel } from "../lib/realtime/index.js";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { config } from "./config.js";

/**
 * Subscribe to every visible workspace's Ably channel and invalidate the relevant
 * queries on any event, so other browser sessions update live. Pass the scoped
 * workspace when one is selected, or all accessible workspace ids in "All
 * workspaces" view — the live updates then match exactly what the lists show.
 * No-ops without an Ably key or when the id set is empty.
 *
 * The `ably` SDK is imported dynamically — it's large and only needed when a
 * realtime key is configured, so it stays out of the initial bundle otherwise.
 */
export function useWorkspaceRealtime(workspaceIds: string[]): void {
  const qc = useQueryClient();
  // Stable primitive dep: the effect re-subscribes only when the *set* of
  // workspaces changes, not on every render that produces a new array.
  const key = [...new Set(workspaceIds)].sort().join(",");
  useEffect(() => {
    if (!config.ablyKey || !key) return;
    const ids = key.split(",");
    let client: import("ably").Realtime | undefined;
    let cancelled = false;

    void (async () => {
      const Ably = await import("ably");
      if (cancelled) return;
      client = new Ably.Realtime({ key: config.ablyKey });
      const invalidate = () => {
        void qc.invalidateQueries({ queryKey: ["items"] });
        void qc.invalidateQueries({ queryKey: ["observations"] });
        void qc.invalidateQueries({ queryKey: ["problems"] });
        void qc.invalidateQueries({ queryKey: ["graph"] });
        void qc.invalidateQueries({ queryKey: ["problem"] });
        void qc.invalidateQueries({ queryKey: ["observation"] });
        void qc.invalidateQueries({ queryKey: ["project-tags"] });
      };
      for (const id of ids) {
        void client.channels.get(workspaceChannel(id)).subscribe(invalidate);
      }
    })();

    return () => {
      cancelled = true;
      client?.close(); // closing the client unsubscribes all its channels
    };
  }, [key, qc]);
}
