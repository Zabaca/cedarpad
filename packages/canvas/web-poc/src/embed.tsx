import { MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";
import { Notifications } from "@mantine/notifications";
import "@mantine/notifications/styles.css";
import "@xyflow/react/dist/style.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App.js";

// web-poc's full UI as an embeddable component: everything main.tsx does EXCEPT
// createRoot. The canvas host mounts this into its own React tree (one React 19)
// instead of an iframe, so web-poc's providers (Mantine, React Query) and its
// global CSS live inside the host bundle. See main.tsx for the standalone root.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});

export function WebPocApp() {
  return (
    <MantineProvider defaultColorScheme="auto">
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </MantineProvider>
  );
}
