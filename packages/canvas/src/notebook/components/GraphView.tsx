import { Badge, Button, Card, Group, Loader, ScrollArea, Stack, Text } from "@mantine/core";
import { Background, Controls, type Edge, type Node, ReactFlow } from "@xyflow/react";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import type { Graph, Neighborhood, ProblemContext } from "../../../lib/contract/index.js";
import { api } from "../api.js";
import { useAppStore } from "../store.js";
import { ResizableSplit } from "./ResizableSplit.js";

/** Deterministic rings: observations inner, problems middle, solutions outer. */
function toFlow(graph: Graph, rootId?: string): { nodes: Node[]; edges: Edge[] } {
  const observations = graph.nodes.filter((n) => n.type === "observation");
  const problems = graph.nodes.filter((n) => n.type === "problem");
  const solutions = graph.nodes.filter((n) => n.type === "solution");

  const place = (count: number, i: number, radius: number) => {
    const angle = (i / Math.max(count, 1)) * 2 * Math.PI;
    return { x: 460 + radius * Math.cos(angle), y: 360 + radius * Math.sin(angle) };
  };

  const nodes: Node[] = [
    ...observations.map((n, i) => ({
      id: n.id,
      position: place(observations.length, i, 110),
      data: { label: n.label, nodeType: n.type },
      style: {
        background: "#f8f0fc",
        border: "1px solid #9c36b5",
        borderRadius: 8,
        padding: 6,
        width: 150,
        fontSize: 12,
      },
    })),
    ...problems.map((n, i) => ({
      id: n.id,
      position: place(problems.length, i, 250),
      data: { label: n.label, nodeType: n.type },
      style: {
        background: n.id === rootId ? "#fff3bf" : "#e7f5ff",
        border: `1px solid ${n.id === rootId ? "#f08c00" : "#228be6"}`,
        borderRadius: 8,
        padding: 6,
        width: 160,
        fontSize: 12,
      },
    })),
    ...solutions.map((n, i) => ({
      id: n.id,
      position: place(solutions.length, i, 400),
      data: { label: n.label, nodeType: n.type },
      style: {
        background: "#ebfbee",
        border: "1px solid #2f9e44",
        borderRadius: 8,
        padding: 6,
        width: 160,
        fontSize: 12,
      },
    })),
  ];

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.kind,
    animated: e.kind === "identical",
    style: { stroke: e.kind === "solves" ? "#2f9e44" : "#868e96" },
  }));

  return { nodes, edges };
}

/** Adapt a bounded neighborhood (problems only) into the shared Graph shape. */
function neighborhoodToGraph(nb: Neighborhood): Graph {
  return {
    nodes: nb.nodes.map((n) => ({
      id: n.id,
      type: "problem" as const,
      label: n.title,
      status: n.status,
    })),
    edges: nb.edges.map((e) => ({
      id: e.id,
      source: e.fromProblemId,
      target: e.toProblemId,
      kind: e.kind,
      weight: e.similarity,
    })),
  };
}

const kindColor: Record<string, string> = {
  identical: "red",
  partial: "orange",
  related: "blue",
};

/** Side panel: the focused problem's edges (with rationale) and solutions. */
function ContextPanel({ ctx }: { ctx: ProblemContext }) {
  return (
    <ScrollArea h="100%" p="md">
      <Stack gap="sm">
        <div>
          <Text fw={600}>{ctx.problem.title}</Text>
          <Badge size="xs" variant="light" mt={4}>
            {ctx.problem.status}
          </Badge>
        </div>

        <Text size="sm" fw={600} c="dimmed">
          Links ({ctx.edges.length})
        </Text>
        {ctx.edges.length === 0 && (
          <Text size="xs" c="dimmed">
            No links yet.
          </Text>
        )}
        {ctx.edges.map((e) => (
          <Card key={e.id} withBorder padding="xs" radius="sm">
            <Group gap="xs" mb={4}>
              <Badge size="xs" color={kindColor[e.kind] ?? "gray"}>
                {e.kind}
              </Badge>
              <Text size="xs" c="dimmed">
                {e.direction === "out" ? "→" : "←"} {e.title}
              </Text>
              {e.similarity != null && (
                <Text size="xs" c="dimmed">
                  {(e.similarity * 100).toFixed(0)}%
                </Text>
              )}
            </Group>
            {e.rationale && <Text size="xs">{e.rationale}</Text>}
          </Card>
        ))}

        <Text size="sm" fw={600} c="dimmed" mt="xs">
          Solutions ({ctx.solutions.length})
        </Text>
        {ctx.solutions.map((s) => (
          <Card key={s.id} withBorder padding="xs" radius="sm">
            <Group gap="xs" mb={4}>
              <Badge size="xs" variant="light">
                {s.origin}
              </Badge>
              <Badge size="xs" color={s.status === "accepted" ? "green" : "gray"}>
                {s.status}
              </Badge>
            </Group>
            <Text size="xs">{s.body}</Text>
          </Card>
        ))}
      </Stack>
    </ScrollArea>
  );
}

export function GraphView() {
  const [focusId, setFocusId] = useState<string | null>(null);
  const scope = useAppStore((s) => s.scopeWorkspaceId);

  const overview = useQuery({
    queryKey: ["graph", { workspaceId: scope }],
    queryFn: () => api.getGraph(scope ?? undefined),
    enabled: !focusId,
  });
  const neighborhood = useQuery({
    queryKey: ["neighborhood", focusId],
    queryFn: () => api.getNeighborhood(focusId!),
    enabled: !!focusId,
  });
  const context = useQuery({
    queryKey: ["context", focusId],
    queryFn: () => api.getProblemContext(focusId!),
    enabled: !!focusId,
  });

  const graph = focusId ? (neighborhood.data ? neighborhoodToGraph(neighborhood.data) : null) : overview.data;
  const flow = useMemo(
    () => (graph ? toFlow(graph, focusId ?? undefined) : { nodes: [], edges: [] }),
    [graph, focusId],
  );

  const loading = focusId ? neighborhood.isLoading : overview.isLoading;
  const error = focusId ? neighborhood.error : overview.error;

  if (error) return <Text c="red">{String(error)}</Text>;

  return (
    <Card withBorder padding={0} style={{ height: "calc(100vh - 120px)" }}>
      <Group justify="space-between" p="xs" style={{ borderBottom: "1px solid #e9ecef" }}>
        <Text size="sm" c="dimmed">
          {focusId ? "Neighborhood (bounded)" : "Full workspace graph"}
        </Text>
        {focusId && (
          <Button size="xs" variant="subtle" onClick={() => setFocusId(null)}>
            Show full graph
          </Button>
        )}
      </Group>
      <ResizableSplit
        storageKey="cedarpad:graphCanvasPct"
        defaultPct={70}
        minPct={40}
        maxPct={82}
        height="calc(100% - 45px)"
        showRight={!!(focusId && context.data)}
        left={
          <div style={{ height: "100%", position: "relative" }}>
            {loading ? (
              <Loader m="md" />
            ) : (
              <ReactFlow
                nodes={flow.nodes}
                edges={flow.edges}
                fitView
                onNodeClick={(_, node) => {
                  if ((node.data as { nodeType?: string }).nodeType === "problem") {
                    setFocusId(node.id);
                  }
                }}
              >
                <Background />
                <Controls />
              </ReactFlow>
            )}
          </div>
        }
        right={context.data ? <ContextPanel ctx={context.data} /> : null}
      />
    </Card>
  );
}
