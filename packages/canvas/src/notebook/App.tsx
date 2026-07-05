import {
  AppShell,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Menu,
  SegmentedControl,
  Title,
  useMantineColorScheme,
} from "@mantine/core";
import { Suspense, lazy, useEffect } from "react";
import { ApiKeysView } from "./components/ApiKeysView.js";
import { LibraryView } from "./components/LibraryView.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { signOut, useSession } from "./auth.js";
import { useWorkspaceRealtime } from "./realtime.js";
import { useAppStore } from "./store.js";
import { useWorkspaces } from "./workspaces.js";

// Code-split the knowledge-graph view: it pulls in @xyflow/react (heavy) and is
// only shown on demand, so it loads as a separate chunk when the tab is opened.
const GraphView = lazy(() =>
  import("./components/GraphView.js").then((m) => ({ default: m.GraphView })),
);

const NAV: { value: "library" | "graph"; label: string }[] = [
  { value: "library", label: "Library" },
  { value: "graph", label: "Knowledge Graph" },
];

/** Authenticated shell. Workspace realtime lives here so hook order stays stable. */
function AuthedApp({ email }: { email: string }) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const selectProblem = useAppStore((s) => s.selectProblem);
  const selectObservation = useAppStore((s) => s.selectObservation);
  const scope = useAppStore((s) => s.scopeWorkspaceId);

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
  const { data: workspaces } = useWorkspaces();
  // `auto` follows the OS; Mantine persists the choice in localStorage.
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  // Listen on exactly what's on screen: the scoped workspace, or every
  // accessible workspace when the view is "All workspaces" (scope === null).
  const realtimeIds = scope ? [scope] : (workspaces ?? []).map((w) => w.id);
  useWorkspaceRealtime(realtimeIds);

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group>
            <Title order={3}>Cedarpad</Title>
            <WorkspacePicker />
          </Group>
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
            <Menu position="bottom-end">
              <Menu.Target>
                <Button variant="subtle">{email}</Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item onClick={() => setView("settings")}>API keys</Menu.Item>
                <Menu.Divider />
                <Menu.Label>Theme</Menu.Label>
                <Box px="xs" pb="xs">
                  {/* Not a Menu.Item, so picking a theme doesn't close the menu. */}
                  <SegmentedControl
                    fullWidth
                    size="xs"
                    value={colorScheme}
                    onChange={(v) => setColorScheme(v as "light" | "dark" | "auto")}
                    data={[
                      { label: "Light", value: "light" },
                      { label: "Dark", value: "dark" },
                      { label: "System", value: "auto" },
                    ]}
                  />
                </Box>
                <Menu.Divider />
                <Menu.Item onClick={() => void signOut()}>Sign out</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>
        {/* The view is scoped by `scopeWorkspaceId` (defaults to null = "All
            workspaces"), not the Better Auth active org — so the lists/graph
            render cross-workspace on first load instead of a blank gate. */}
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
 * Notebook's authenticated shell. The HOST (src/App.tsx) owns the auth gate —
 * this only renders once a session exists, so it just reads the email off it.
 */
export function NotebookApp() {
  const { data: session } = useSession();
  return <AuthedApp email={session?.user.email ?? ""} />;
}
