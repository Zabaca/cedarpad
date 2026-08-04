import {
  Badge,
  Card,
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
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
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
 * The read surface's index: what agents have recorded, browsable and searchable.
 *
 * Two modes, because they answer different questions. With an empty search box
 * this is the unified feed — observations and problems interleaved newest-first,
 * filterable by kind and by "has an accepted solution". Type anything and it
 * becomes ranked FTS5 search (`GET /v1/search`, ADR-0024): hits ordered by
 * relevance, each carrying the matched excerpt. A hit is a pointer to a record
 * rather than a row of it, so the feed's filters don't apply to it and are
 * hidden while it shows.
 */
export function ItemList() {
  const selectedObservationId = useAppStore((s) => s.selectedObservationId);
  const selectedProblemId = useAppStore((s) => s.selectedProblemId);
  const selectObservation = useAppStore((s) => s.selectObservation);
  const selectProblem = useAppStore((s) => s.selectProblem);
  const scope = useAppStore((s) => s.scopeWorkspaceId);

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 250);
  const [solvedOnly, setSolvedOnly] = useState(false);
  // Paging lives in the store so the page survives this list unmounting (view
  // switches) — see `listPage` there.
  const page = useAppStore((s) => s.listPage);
  const setPage = useAppStore((s) => s.setListPage);
  const pageSize = useAppStore((s) => s.listPageSize);
  const setPageSize = useAppStore((s) => s.setListPageSize);
  const syncListFilters = useAppStore((s) => s.syncListFilters);

  const workspaceNames = useWorkspaceNames();

  const query = debounced.trim();
  const searching = query.length > 0;

  // Any filter change (incl. the workspace scope) returns to the first page.
  // Re-declaring the same filters on a remount deliberately keeps the page.
  useEffect(
    () => syncListFilters(JSON.stringify([query, solvedOnly, pageSize, scope, typeFilter])),
    [syncListFilters, query, solvedOnly, pageSize, scope, typeFilter],
  );

  // One unified, server-paged feed: observations and problems interleaved in a
  // single createdAt order, so pagination is consistent across page boundaries.
  const feedQuery = useQuery({
    queryKey: ["items", { solvedOnly, page, pageSize, workspaceId: scope, typeFilter }],
    queryFn: () =>
      api.listItems({
        solved: solvedOnly || undefined,
        workspaceId: scope ?? undefined,
        type: typeFilter,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
    placeholderData: keepPreviousData,
    enabled: !searching,
  });

  const searchQuery = useQuery({
    queryKey: ["search", { q: query, page, pageSize }],
    queryFn: () => api.search({ q: query, limit: pageSize, offset: (page - 1) * pageSize }),
    placeholderData: keepPreviousData,
    enabled: searching,
  });

  const active = searching ? searchQuery : feedQuery;
  const total = active.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // If the result set shrinks (a record was deleted, a filter narrowed results),
  // don't strand the user on a now-empty page past the end.
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const select = (kind: "observation" | "problem", id: string) =>
    kind === "observation" ? selectObservation(id) : selectProblem(id);

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
        {searching ? (
          <Text size="xs" c="dimmed">Ranked by relevance</Text>
        ) : (
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
        )}
        <Text size="xs" c="dimmed">
          {total} result{total === 1 ? "" : "s"}
        </Text>
      </Group>

      {active.isLoading ? (
        <Loader mt="md" />
      ) : active.error ? (
        <Text c="red" mt="md">{String(active.error)}</Text>
      ) : (
        <Stack gap="xs" style={{ opacity: active.isFetching ? 0.6 : 1 }}>
          {searching
            ? (searchQuery.data?.items ?? []).map((hit) => (
                <Card
                  key={`${hit.kind}-${hit.id}`}
                  withBorder
                  padding="sm"
                  onClick={() => select(hit.kind, hit.id)}
                  style={{
                    cursor: "pointer",
                    borderColor:
                      (hit.kind === "observation" ? selectedObservationId : selectedProblemId) ===
                      hit.id
                        ? "#228be6"
                        : undefined,
                  }}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Text fw={600} lineClamp={1}>{hit.title}</Text>
                    <Badge
                      size="xs"
                      variant="light"
                      color={hit.kind === "observation" ? "teal" : "orange"}
                    >
                      {hit.kind}
                    </Badge>
                  </Group>
                  <Text size="sm" c="dimmed" lineClamp={2}>{hit.snippet}</Text>
                </Card>
              ))
            : (feedQuery.data?.items ?? []).map((item) =>
                item.kind === "observation" ? (
                  <Card
                    key={`o-${item.id}`}
                    withBorder
                    padding="sm"
                    onClick={() => selectObservation(item.id)}
                    style={{
                      cursor: "pointer",
                      borderColor: selectedObservationId === item.id ? "#228be6" : undefined,
                    }}
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Text fw={600} lineClamp={1}>{item.title}</Text>
                      <Group gap="xs" wrap="nowrap">
                        <Badge size="xs" variant="dot" color="indigo">
                          {workspaceNames[item.workspaceId] ?? "workspace"}
                        </Badge>
                        <Badge size="xs" variant="light" color="teal">observation</Badge>
                        <Badge
                          size="xs"
                          variant="outline"
                          color={item.origin === "agent" ? "grape" : "gray"}
                        >
                          {item.origin}
                        </Badge>
                        <Badge size="xs" color={obsStatusColor[item.status] ?? "gray"}>
                          {item.status}
                        </Badge>
                      </Group>
                    </Group>
                    <Text size="sm" c="dimmed" lineClamp={2}>{item.body}</Text>
                    {item.projectTags.length > 0 && (
                      <Group gap={4} mt={4}>
                        {item.projectTags.map((t) => (
                          <Badge key={t} size="xs" variant="light" color="cyan">{t}</Badge>
                        ))}
                      </Group>
                    )}
                  </Card>
                ) : (
                  <Card
                    key={`p-${item.id}`}
                    withBorder
                    padding="sm"
                    onClick={() => selectProblem(item.id)}
                    style={{
                      cursor: "pointer",
                      borderColor: selectedProblemId === item.id ? "#228be6" : undefined,
                    }}
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Text fw={600} lineClamp={1}>{item.title}</Text>
                      <Group gap="xs" wrap="nowrap">
                        <Badge size="xs" variant="dot" color="indigo">
                          {workspaceNames[item.workspaceId] ?? "workspace"}
                        </Badge>
                        <Badge size="xs" variant="light" color="orange">problem</Badge>
                        <Badge size="xs" color={urgencyColor[item.urgency] ?? "gray"} variant="light">
                          {item.urgency}
                        </Badge>
                        <Badge size="xs" color={probStatusColor[item.status] ?? "gray"}>
                          {item.status}
                        </Badge>
                      </Group>
                    </Group>
                    <Text size="sm" c="dimmed" lineClamp={2}>{item.body}</Text>
                    {item.projectTags.length > 0 && (
                      <Group gap={4} mt={4}>
                        {item.projectTags.map((t) => (
                          <Badge key={t} size="xs" variant="light" color="cyan">{t}</Badge>
                        ))}
                      </Group>
                    )}
                  </Card>
                ),
              )}
          {total === 0 ? (
            <Text c="dimmed" size="sm">
              {searching || solvedOnly
                ? "No matching records."
                : "Nothing recorded yet — agents write here."}
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
