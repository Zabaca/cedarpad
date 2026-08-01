import { Box, Stack } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useAppStore } from "../store.js";
import { ItemList } from "./ItemList.js";
import { ObservationDetail } from "./ObservationDetail.js";
import { ProblemDetail } from "./ProblemDetail.js";
import { ResizableSplit } from "./ResizableSplit.js";

// Fill the viewport below the 60px header and the AppShell's md padding (top+bottom).
const PANE_H = "calc(100dvh - 60px - 2 * var(--mantine-spacing-md))";

/** Unified browser: observations and problems in one filterable list, with the detail
 * panel following whichever item kind was last selected. On desktop the two panes are
 * split by a draggable divider (drag / double-click to reset / ←→); on narrow screens
 * they stack and scroll with the page. */
export function LibraryView() {
  const selectedKind = useAppStore((s) => s.selectedKind);
  const selectedObservationId = useAppStore((s) => s.selectedObservationId);
  const selectedProblemId = useAppStore((s) => s.selectedProblemId);

  const isDesktop = useMediaQuery("(min-width: 62em)");
  const paneScroll = isDesktop ? { h: "100%", style: { overflowY: "auto" as const } } : {};

  const listContent = (
    <Stack gap="sm" {...paneScroll}>
      <ItemList />
    </Stack>
  );

  const detailContent = (
    <Box {...paneScroll}>
      {selectedKind === "problem" && selectedProblemId ? (
        <ProblemDetail id={selectedProblemId} />
      ) : selectedKind === "observation" && selectedObservationId ? (
        <ObservationDetail id={selectedObservationId} />
      ) : null}
    </Box>
  );

  // Narrow screens: stack the panes, no divider.
  if (!isDesktop) {
    return (
      <Stack gap="md">
        {listContent}
        {detailContent}
      </Stack>
    );
  }

  return (
    <ResizableSplit
      storageKey="cedarpad:libraryListPct"
      defaultPct={42}
      minPct={25}
      maxPct={70}
      height={PANE_H}
      left={listContent}
      right={detailContent}
    />
  );
}
