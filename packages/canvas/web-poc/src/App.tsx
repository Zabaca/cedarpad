import { AppShell, Button, Center, Group, Loader, SegmentedControl, useMantineColorScheme } from "@mantine/core";
import { Suspense, lazy, useEffect } from "react";
import { ApiKeysView } from "./components/ApiKeysView.js";
import { AuthScreen } from "./components/AuthScreen.js";
import { LibraryView } from "./components/LibraryView.js";
import { useSession } from "./auth.js";
import { useWorkspaceRealtime } from "./realtime.js";
import { useAppStore } from "./store.js";
import { useWorkspaces } from "./workspaces.js";

// Code-split the knowledge-graph view: it pulls in @xyflow/react (heavy) and is
// only shown on demand, so it loads as a separate chunk when the tab is opened.
const GraphView = lazy(() =>
  import("./components/GraphView.js").then((m) => ({ default: m.GraphView })),
);

// Notebook's own sub-nav (PRD #103, slice #107): these are views WITHIN Notebook, not
// shell-level apps, so they live here rather than in the Shell's rail. "API keys" used to
// live in the header's account menu; the header is gone (the Shell's rail is the one
// chrome), so it's folded into this bar instead of inventing a new spot.
const NAV: { value: "library" | "graph" | "settings"; label: string }[] = [
  { value: "library", label: "Library" },
  { value: "graph", label: "Knowledge Graph" },
  { value: "settings", label: "API keys" },
];

/** Authenticated shell. Workspace realtime lives here so hook order stays stable. */
function AuthedApp({ workspaceId }: { workspaceId?: string }) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const selectProblem = useAppStore((s) => s.selectProblem);
  const selectObservation = useAppStore((s) => s.selectObservation);
  const scope = useAppStore((s) => s.scopeWorkspaceId);
  const setScopeWorkspace = useAppStore((s) => s.setScopeWorkspace);

  // Deep link: a shared `…/?problem=<id>` / `?observation=<id>` opens that item
  // in the Library on load (runs once — the copy button in each detail header
  // produces these links).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const problemId = params.get("problem");
    const observationId = params.get("observation");
    if (problemId) {
      setView("library");
      selectProblem(problemId);
    } else if (observationId) {
      setView("library");
      selectObservation(observationId);
    }
  }, [setView, selectProblem, selectObservation]);
  // Follow the host's active workspace (the Shell rail's selection) instead of offering a
  // picker of our own — the rail is the one place a workspace is chosen. No in-Notebook
  // "All workspaces" toggle: single-tenant today, one workspace in practice.
  useEffect(() => {
    if (workspaceId) setScopeWorkspace(workspaceId);
  }, [workspaceId, setScopeWorkspace]);
  const { data: workspaces } = useWorkspaces();
  // `auto` follows the OS; Mantine persists the choice in localStorage.
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  // Listen on exactly what's on screen: the scoped workspace, or every
  // accessible workspace when the view is "All workspaces" (scope === null).
  const realtimeIds = scope ? [scope] : (workspaces ?? []).map((w) => w.id);
  useWorkspaceRealtime(realtimeIds);

  return (
    <AppShell padding="md">
      <AppShell.Main>
        <Group justify="space-between" mb="md">
          <Group>
            {NAV.map((n) => (
              <Button
                key={n.value}
                variant={view === n.value ? "filled" : "subtle"}
                onClick={() => setView(n.value)}
              >
                {n.label}
              </Button>
            ))}
          </Group>
          <SegmentedControl
            size="xs"
            value={colorScheme}
            onChange={(v) => setColorScheme(v as "light" | "dark" | "auto")}
            data={[
              { label: "Light", value: "light" },
              { label: "Dark", value: "dark" },
              { label: "System", value: "auto" },
            ]}
          />
        </Group>
        {view === "library" ? (
          <LibraryView />
        ) : view === "settings" ? (
          <ApiKeysView />
        ) : (
          <Suspense fallback={<Center h="60vh"><Loader /></Center>}>
            <GraphView />
          </Suspense>
        )}
      </AppShell.Main>
    </AppShell>
  );
}

/**
 * `workspaceId`: the Shell's active workspace, threaded down from `WebPocApp`. Under the
 * Shell the session already exists (the Shell itself sits behind the edge auth gate), so
 * `useSession`/`AuthScreen` below is a fast pass-through in that case — they remain for the
 * standalone-load edge case, not as a second auth UI a Shell user would ever see.
 */
export function App({ workspaceId }: { workspaceId?: string }) {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (!session) return <AuthScreen />;
  return <AuthedApp workspaceId={workspaceId} />;
}
