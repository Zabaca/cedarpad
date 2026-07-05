import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import { useAppStore } from "../store.js";
import { ShareLinkButton } from "./ShareLinkButton.js";

const linkColor: Record<string, string> = { identical: "red", partial: "orange", related: "blue" };
const solutionColor: Record<string, string> = { accepted: "green", rejected: "red", draft: "gray" };
const statusColor: Record<string, string> = { open: "blue", investigating: "yellow", resolved: "green", archived: "gray" };
const urgencyColor: Record<string, string> = { low: "gray", medium: "blue", high: "orange", critical: "red" };
const PROBLEM_STATUS = ["open", "investigating", "resolved", "archived"];
const URGENCY = ["low", "medium", "high", "critical"];
// Preserve newlines/paragraphs in free-form text (bodies, impact, solutions).
const preWrap = { whiteSpace: "pre-wrap" } as const;

export function ProblemDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const setView = useAppStore((s) => s.setView);
  const selectObservation = useAppStore((s) => s.selectObservation);

  const { data, isLoading, error } = useQuery({
    queryKey: ["problem", id],
    queryFn: () => api.getProblem(id),
  });

  // Local edit state
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("open");
  const [urgency, setUrgency] = useState("medium");
  const [editSolId, setEditSolId] = useState<string | null>(null);
  const [solBody, setSolBody] = useState("");
  const [adding, setAdding] = useState(false);
  const [newSol, setNewSol] = useState("");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["problem", id] });
    void qc.invalidateQueries({ queryKey: ["problems"] });
    void qc.invalidateQueries({ queryKey: ["items"] });
    void qc.invalidateQueries({ queryKey: ["graph"] });
  };

  const reprocess = useMutation({ mutationFn: () => api.reprocess(id), onSuccess: invalidate });
  const saveProblem = useMutation({
    mutationFn: () =>
      api.updateProblem(id, {
        title,
        body,
        status: status as "open" | "investigating" | "resolved" | "archived",
        urgency: urgency as "low" | "medium" | "high" | "critical",
      }),
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
  });
  const saveSolution = useMutation({
    mutationFn: (vars: { sid: string; patch: Parameters<typeof api.updateSolution>[1] }) =>
      api.updateSolution(vars.sid, vars.patch),
    onSuccess: () => {
      setEditSolId(null);
      invalidate();
    },
  });
  const addSolution = useMutation({
    mutationFn: () => api.createSolution({ targetKind: "problem", targetId: id, body: newSol }),
    onSuccess: () => {
      setAdding(false);
      setNewSol("");
      invalidate();
    },
  });

  if (isLoading) return <Loader mt="md" />;
  if (error) return <Text c="red">{String(error)}</Text>;
  if (!data) return null;

  const p = data.problem;
  const startEdit = () => {
    setTitle(p.title);
    setBody(p.body);
    setStatus(p.status);
    setUrgency(p.urgency);
    setEditing(true);
  };

  return (
    <Stack>
      {data.latestRun?.status === "running" && (
        <Alert color="blue" variant="light" icon={<Loader size="xs" />} title="Agent is processing…">
          Related links and a solution will appear here automatically when it finishes.
        </Alert>
      )}

      {/* Problem */}
      <Card withBorder padding="md">
        {editing ? (
          <Stack gap="xs">
            <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
            <Textarea label="Description" autosize minRows={3} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
            <Group>
              <Select label="Status" data={PROBLEM_STATUS} value={status} onChange={(v) => v && setStatus(v)} allowDeselect={false} w={180} />
              <Select label="Urgency" data={URGENCY} value={urgency} onChange={(v) => v && setUrgency(v)} allowDeselect={false} w={160} />
            </Group>
            <Group>
              <Button size="xs" loading={saveProblem.isPending} disabled={!title.trim() || !body.trim()} onClick={() => saveProblem.mutate()}>
                Save
              </Button>
              <Button size="xs" variant="default" onClick={() => setEditing(false)}>Cancel</Button>
            </Group>
          </Stack>
        ) : (
          <>
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs">
                <Title order={4}>{p.title}</Title>
                <Badge size="sm" color={urgencyColor[p.urgency] ?? "gray"} variant="light">{p.urgency}</Badge>
                <Badge size="sm" color={statusColor[p.status] ?? "gray"}>{p.status}</Badge>
              </Group>
              <Group gap="xs" wrap="nowrap">
                <ShareLinkButton kind="problem" id={id} />
                <Button size="xs" variant="default" onClick={startEdit}>Edit</Button>
                <Button size="xs" variant="light" loading={reprocess.isPending} onClick={() => reprocess.mutate()}>
                  Re-run agent
                </Button>
              </Group>
            </Group>
            <Text mt="xs" style={preWrap}>{p.body}</Text>
            {p.impact ? <Text size="sm" mt="sm" style={preWrap}><b>Impact:</b> {p.impact}</Text> : null}
            {p.solutionDirection ? <Text size="sm" mt={4} style={preWrap}><b>Solution direction:</b> {p.solutionDirection}</Text> : null}
            <Text size="xs" c="dimmed" mt={4}>Priority {p.priority}</Text>
            {p.projectTags.length > 0 && (
              <Group gap={4} mt="xs">
                {p.projectTags.map((t) => (
                  <Badge key={t} size="xs" variant="light" color="cyan">{t}</Badge>
                ))}
              </Group>
            )}
            {data.latestRun ? (
              <Text size="xs" c="dimmed" mt="sm">
                Last agent run: {data.latestRun.status}
                {data.latestRun.providerModel ? ` · ${data.latestRun.providerModel}` : ""}
              </Text>
            ) : null}
          </>
        )}
      </Card>

      {/* Source observations */}
      {data.sourceObservations.length > 0 && (
        <Card withBorder padding="md">
          <Title order={5} mb="xs">Synthesized from ({data.sourceObservations.length})</Title>
          <Stack gap="xs">
            {data.sourceObservations.map((o) => (
              <Text key={o.id} size="sm" style={{ cursor: "pointer" }}
                onClick={() => { setView("library"); selectObservation(o.id); }}>
                ← {o.title}
              </Text>
            ))}
          </Stack>
        </Card>
      )}

      {/* Related problems */}
      <Card withBorder padding="md">
        <Title order={5} mb="xs">Related problems ({data.links.length})</Title>
        <Stack gap="xs">
          {data.links.map(({ link, problem }) => (
            <Group key={link.id} justify="space-between" wrap="nowrap">
              <Text size="sm" lineClamp={1}>{problem.title}</Text>
              <Group gap="xs" wrap="nowrap">
                {link.similarity != null ? (
                  <Text size="xs" c="dimmed">{(link.similarity * 100).toFixed(0)}%</Text>
                ) : null}
                <Badge size="sm" color={linkColor[link.kind] ?? "gray"}>{link.kind}</Badge>
              </Group>
            </Group>
          ))}
          {data.links.length === 0 ? <Text size="sm" c="dimmed">None found.</Text> : null}
        </Stack>
      </Card>

      {/* Solutions */}
      <Card withBorder padding="md">
        <Group justify="space-between" mb="xs">
          <Title order={5}>Solutions ({data.solutions.length})</Title>
          {!adding ? (
            <Button size="xs" variant="light" onClick={() => setAdding(true)}>Add solution that worked</Button>
          ) : null}
        </Group>

        {adding ? (
          <Card withBorder padding="sm" mb="sm" bg="var(--mantine-color-teal-light)">
            <Stack gap="xs">
              <Textarea label="The solution that actually worked" autosize minRows={3} value={newSol} onChange={(e) => setNewSol(e.currentTarget.value)} data-autofocus />
              <Group>
                <Button size="xs" loading={addSolution.isPending} disabled={!newSol.trim()} onClick={() => addSolution.mutate()}>
                  Save as accepted
                </Button>
                <Button size="xs" variant="default" onClick={() => { setAdding(false); setNewSol(""); }}>Cancel</Button>
              </Group>
            </Stack>
          </Card>
        ) : null}

        <Stack gap="sm">
          {data.solutions.map((s) => (
            <div key={s.id}>
              <Group gap="xs" justify="space-between" wrap="nowrap">
                <Group gap="xs">
                  <Badge size="xs" variant="light">{s.origin}</Badge>
                  <Badge size="xs" color={solutionColor[s.status] ?? "gray"}>{s.status}</Badge>
                </Group>
                {editSolId !== s.id ? (
                  <Group gap={4} wrap="nowrap">
                    {s.status !== "accepted" ? (
                      <Button size="compact-xs" variant="subtle" color="green"
                        onClick={() => saveSolution.mutate({ sid: s.id, patch: { status: "accepted" } })}>
                        Accept
                      </Button>
                    ) : null}
                    {s.status !== "rejected" ? (
                      <Button size="compact-xs" variant="subtle" color="red"
                        onClick={() => saveSolution.mutate({ sid: s.id, patch: { status: "rejected" } })}>
                        Reject
                      </Button>
                    ) : null}
                    <Button size="compact-xs" variant="subtle"
                      onClick={() => { setEditSolId(s.id); setSolBody(s.body); }}>
                      Edit
                    </Button>
                  </Group>
                ) : null}
              </Group>

              {editSolId === s.id ? (
                <Stack gap="xs" mt={6}>
                  <Textarea autosize minRows={3} value={solBody} onChange={(e) => setSolBody(e.currentTarget.value)} />
                  <Group>
                    <Button size="xs" loading={saveSolution.isPending} disabled={!solBody.trim()}
                      onClick={() => saveSolution.mutate({ sid: s.id, patch: { body: solBody } })}>
                      Save
                    </Button>
                    <Button size="xs" variant="default" onClick={() => setEditSolId(null)}>Cancel</Button>
                  </Group>
                </Stack>
              ) : (
                <Text size="sm" mt={4} style={preWrap}>{s.body}</Text>
              )}
              <Divider mt="sm" />
            </div>
          ))}
          {data.solutions.length === 0 ? <Text size="sm" c="dimmed">No solutions yet.</Text> : null}
        </Stack>
      </Card>
    </Stack>
  );
}
