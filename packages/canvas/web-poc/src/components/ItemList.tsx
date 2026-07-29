import {
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  Pagination,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import { useAppStore } from "../store.js";
import { useWorkspaceNames } from "../workspaces.js";

const obsStatusColor: Record<string, string> = {
  open: "blue",
  synthesized: "grape",
  archived: "gray",
};
const probStatusColor: Record<string, string> = {
  open: "blue",
  investigating: "yellow",
  resolved: "green",
  archived: "gray",
};
const urgencyColor: Record<string, string> = {
  low: "gray",
  medium: "blue",
  high: "orange",
  critical: "red",
};

const PAGE_SIZES = ["10", "20", "50"];

type TypeFilter = "all" | "observations" | "problems";

/**
 * Unified browser for observations and problems. The type filter (All / Observations
 * / Problems) sits on the same row as the "Solved only" switch and defaults to "All",
 * which interleaves both streams newest-first. Observation rows keep their checkbox so
 * a selection can still be synthesized into a problem.
 */
export function ItemList() {
  const qc = useQueryClient();
  const selectedObservationId = useAppStore((s) => s.selectedObservationId);
  const selectedProblemId = useAppStore((s) => s.selectedProblemId);
  const selectObservation = useAppStore((s) => s.selectObservation);
  const selectProblem = useAppStore((s) => s.selectProblem);
  const setView = useAppStore((s) => s.setView);
  const scope = useAppStore((s) => s.scopeWorkspaceId);
  // Selection lives in the store so it survives paging, search, scope changes
  // and view switches — see `synthPicks` there.
  const synthPicks = useAppStore((s) => s.synthPicks);
  const toggleSynthPick = useAppStore((s) => s.toggleSynthPick);
  const clearSynthPicks = useAppStore((s) => s.clearSynthPicks);
  const pickedSet = useMemo(() => new Set(synthPicks), [synthPicks]);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 250);
  const [solvedOnly, setSolvedOnly] = useState(false);
  // Paging lives in the store so the page survives this list unmounting (view
  // switches, synthesize returning to the library) — see `listPage` there.
  const page = useAppStore((s) => s.listPage);
  const setPage = useAppStore((s) => s.setListPage);
  const pageSize = useAppStore((s) => s.listPageSize);
  const setPageSize = useAppStore((s) => s.setListPageSize);
  const syncListFilters = useAppStore((s) => s.syncListFilters);

  const workspaceNames = useWorkspaceNames();

  // Any filter change (incl. the workspace scope) returns to the first page.
  // Re-declaring the same filters on a remount deliberately keeps the page.
  useEffect(
    () => syncListFilters(JSON.stringify([debounced, solvedOnly, pageSize, scope, typeFilter])),
    [syncListFilters, debounced, solvedOnly, pageSize, scope, typeFilter],
  );

  // One unified, server-paged feed: observations and problems interleaved in a
  // single createdAt order, so pagination is consistent across page boundaries.
  const itemsQuery = useQuery({
    queryKey: ["items", { q: debounced, solvedOnly, page, pageSize, workspaceId: scope, typeFilter }],
    queryFn: () =>
      api.listItems({
        q: debounced || undefined,
        solved: solvedOnly || undefined,
        workspaceId: scope ?? undefined,
        type: typeFilter,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
    placeholderData: keepPreviousData,
  });

  const synth = useMutation({
    mutationFn: (ids: string[]) => api.synthesizeProblem({ observationIds: ids }),
    onSuccess: () => {
      clearSynthPicks();
      void qc.invalidateQueries({ queryKey: ["items"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
      // Async: the worker drafts + creates the problem, then publishes
      // `problem.synthesized` → realtime refreshes the list with the new problem.
      notifications.show({
        title: "Synthesizing…",
        message: "The agent is drafting a problem — it'll appear shortly.",
        color: "blue",
      });
      setView("library");
    },
    onError: (err) =>
      notifications.show({ title: "Synthesis failed", message: String(err), color: "red" }),
  });

  const items = itemsQuery.data?.items ?? [];
  const total = itemsQuery.data?.total ?? 0;

  type Row =
    | { kind: "observation"; data: Extract<(typeof items)[number], { kind: "observation" }> }
    | { kind: "problem"; data: Extract<(typeof items)[number], { kind: "problem" }> };
  // Server returns them already interleaved and ordered — keep that order.
  const rows: Row[] = items.map((data) =>
    data.kind === "observation"
      ? { kind: "observation" as const, data }
      : { kind: "problem" as const, data },
  );

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // If the result set shrinks (synthesize consumed observations, a filter narrowed
  // results), don't strand the user on a now-empty page past the end.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const isLoading = itemsQuery.isLoading;
  const isFetching = itemsQuery.isFetching;
  const error = itemsQuery.error;

  return (
    <Stack mt="md" gap="sm">
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <TextInput
          flex={1}
          label="Search"
          placeholder="Title or body…"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
        />
        <Select
          label="Per page"
          data={PAGE_SIZES}
          value={String(pageSize)}
          onChange={(v) => v && setPageSize(Number(v))}
          allowDeselect={false}
          w={90}
        />
      </Group>
      <Group justify="space-between">
        <Group gap="md">
          <SegmentedControl
            size="xs"
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as TypeFilter)}
            data={[
              { label: "All", value: "all" },
              { label: "Observations", value: "observations" },
              { label: "Problems", value: "problems" },
            ]}
          />
          <Switch
            label="Solved only"
            checked={solvedOnly}
            onChange={(e) => setSolvedOnly(e.currentTarget.checked)}
            size="sm"
          />
        </Group>
        <Text size="xs" c="dimmed">
          {total} result{total === 1 ? "" : "s"}
        </Text>
      </Group>
      {synthPicks.length > 0 && (
        <Group justify="space-between">
          <Text size="sm">
            {synthPicks.length} observation{synthPicks.length === 1 ? "" : "s"} selected
            <Text span size="xs" c="dimmed"> (across all pages &amp; searches)</Text>
          </Text>
          <Group gap="xs">
            <Button size="xs" variant="default" onClick={clearSynthPicks}>
              Clear
            </Button>
            <Button size="xs" loading={synth.isPending} onClick={() => synth.mutate(synthPicks)}>
              Synthesize problem
            </Button>
          </Group>
        </Group>
      )}

      {isLoading ? (
        <Loader mt="md" />
      ) : error ? (
        <Text c="red" mt="md">{String(error)}</Text>
      ) : (
        <Stack gap="xs" style={{ opacity: isFetching ? 0.6 : 1 }}>
          {rows.map((row) =>
            row.kind === "observation" ? (
              <Card
                key={`o-${row.data.id}`}
                withBorder
                padding="sm"
                style={{ borderColor: selectedObservationId === row.data.id ? "#228be6" : undefined }}
              >
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Checkbox
                    checked={pickedSet.has(row.data.id)}
                    onChange={() => toggleSynthPick(row.data.id)}
                    aria-label="Select observation"
                    mt={2}
                  />
                  <Stack
                    gap={2}
                    flex={1}
                    style={{ cursor: "pointer" }}
                    onClick={() => selectObservation(row.data.id)}
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Text fw={600} lineClamp={1}>{row.data.title}</Text>
                      <Group gap="xs" wrap="nowrap">
                        <Badge size="xs" variant="dot" color="indigo">
                          {workspaceNames[row.data.workspaceId] ?? "workspace"}
                        </Badge>
                        <Badge size="xs" variant="light" color="teal">observation</Badge>
                        <Badge
                          size="xs"
                          variant="outline"
                          color={row.data.source === "agent" ? "grape" : "gray"}
                        >
                          {row.data.source}
                        </Badge>
                        <Badge size="xs" color={obsStatusColor[row.data.status] ?? "gray"}>
                          {row.data.status}
                        </Badge>
                      </Group>
                    </Group>
                    <Text size="sm" c="dimmed" lineClamp={2}>{row.data.body}</Text>
                    {row.data.projectTags.length > 0 && (
                      <Group gap={4}>
                        {row.data.projectTags.map((t) => (
                          <Badge key={t} size="xs" variant="light" color="cyan">{t}</Badge>
                        ))}
                      </Group>
                    )}
                  </Stack>
                </Group>
              </Card>
            ) : (
              <Card
                key={`p-${row.data.id}`}
                withBorder
                padding="sm"
                onClick={() => selectProblem(row.data.id)}
                style={{
                  cursor: "pointer",
                  borderColor: selectedProblemId === row.data.id ? "#228be6" : undefined,
                }}
              >
                <Group justify="space-between" wrap="nowrap">
                  <Text fw={600} lineClamp={1}>{row.data.title}</Text>
                  <Group gap="xs" wrap="nowrap">
                    <Badge size="xs" variant="dot" color="indigo">
                      {workspaceNames[row.data.workspaceId] ?? "workspace"}
                    </Badge>
                    <Badge size="xs" variant="light" color="orange">problem</Badge>
                    <Badge size="xs" color={urgencyColor[row.data.urgency] ?? "gray"} variant="light">
                      {row.data.urgency}
                    </Badge>
                    <Badge size="xs" color={probStatusColor[row.data.status] ?? "gray"}>
                      {row.data.status}
                    </Badge>
                  </Group>
                </Group>
                <Text size="sm" c="dimmed" lineClamp={2}>{row.data.body}</Text>
                {row.data.projectTags.length > 0 && (
                  <Group gap={4} mt={4}>
                    {row.data.projectTags.map((t) => (
                      <Badge key={t} size="xs" variant="light" color="cyan">{t}</Badge>
                    ))}
                  </Group>
                )}
              </Card>
            ),
          )}
          {rows.length === 0 ? (
            <Text c="dimmed" size="sm">
              {debounced || solvedOnly ? "No matching items." : "Nothing yet — capture an observation or problem."}
            </Text>
          ) : null}
        </Stack>
      )}

      {pageCount > 1 ? (
        <Group justify="center" mt="xs">
          <Pagination total={pageCount} value={page} onChange={setPage} size="sm" />
        </Group>
      ) : null}
    </Stack>
  );
}
