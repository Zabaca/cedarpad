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
import { notifications } from "@mantine/notifications";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import { useAppStore } from "../store.js";
import { ShareLinkButton } from "./ShareLinkButton.js";

const linkColor: Record<string, string> = { identical: "red", partial: "orange", related: "blue" };
const OBS_STATUS = ["open", "synthesized", "archived"];
// Preserve newlines/paragraphs in free-form text (body, solutions).
const preWrap = { whiteSpace: "pre-wrap" } as const;

export function ObservationDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const setView = useAppStore((s) => s.setView);
  const selectProblem = useAppStore((s) => s.selectProblem);

  const { data, isLoading, error } = useQuery({
    queryKey: ["observation", id],
    queryFn: () => api.getObservation(id),
  });

  // Read-time cross-kind hint: solved problems that look like this observation.
  const { data: solvedMatches } = useQuery({
    queryKey: ["observation-solved-matches", id],
    queryFn: () => api.getObservationSolvedMatches(id),
  });

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("open");
  const [adding, setAdding] = useState(false);
  const [newSol, setNewSol] = useState("");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["observation", id] });
    void qc.invalidateQueries({ queryKey: ["observations"] });
    void qc.invalidateQueries({ queryKey: ["items"] });
    void qc.invalidateQueries({ queryKey: ["graph"] });
  };

  const saveObs = useMutation({
    mutationFn: () =>
      api.updateObservation(id, {
        title,
        body,
        status: status as "open" | "synthesized" | "archived",
      }),
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
  });
  const addSolution = useMutation({
    mutationFn: () => api.createSolution({ targetKind: "observation", targetId: id, body: newSol }),
    onSuccess: () => {
      setAdding(false);
      setNewSol("");
      invalidate();
    },
  });
  const synth = useMutation({
    mutationFn: () => api.synthesizeProblem({ observationIds: [id] }),
    onSuccess: () => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ["problems"] });
      // Async: the worker drafts + creates the problem, then publishes it via realtime.
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
  const dismissMatch = useMutation({
    mutationFn: (problemId: string) => api.dismissObservationSolvedMatch(id, problemId),
    onSuccess: (remaining) => qc.setQueryData(["observation-solved-matches", id], remaining),
    onError: (err) =>
      notifications.show({ title: "Couldn't dismiss", message: String(err), color: "red" }),
  });

  if (isLoading) return <Loader mt="md" />;
  if (error) return <Text c="red">{String(error)}</Text>;
  if (!data) return null;

  const startEdit = () => {
    setTitle(data.observation.title);
    setBody(data.observation.body);
    setStatus(data.observation.status);
    setEditing(true);
  };

  return (
    <Stack>
      {data.latestRun?.status === "running" && (
        <Alert color="blue" variant="light" icon={<Loader size="xs" />} title="Agent is processing…">
          Similar-observation links will appear here automatically when it finishes.
        </Alert>
      )}
      <Card withBorder padding="md">
        {editing ? (
          <Stack gap="xs">
            <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
            <Textarea label="Body" autosize minRows={3} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
            <Select label="Status" data={OBS_STATUS} value={status} onChange={(v) => v && setStatus(v)} allowDeselect={false} w={200} />
            <Group>
              <Button size="xs" loading={saveObs.isPending} disabled={!title.trim() || !body.trim()} onClick={() => saveObs.mutate()}>
                Save
              </Button>
              <Button size="xs" variant="default" onClick={() => setEditing(false)}>Cancel</Button>
            </Group>
          </Stack>
        ) : (
          <>
            <Group justify="space-between" wrap="nowrap">
              <Group gap="xs">
                <Title order={4}>{data.observation.title}</Title>
                <Badge size="sm" color="grape" variant="light">observation</Badge>
                <Badge size="sm" variant="outline">{data.observation.status}</Badge>
              </Group>
              <Group gap="xs" wrap="nowrap">
                <ShareLinkButton kind="observation" id={id} />
                <Button size="xs" variant="default" onClick={startEdit}>Edit</Button>
                <Button size="xs" variant="light" loading={synth.isPending} onClick={() => synth.mutate()}>
                  Synthesize problem
                </Button>
              </Group>
            </Group>
            <Text mt="xs" style={preWrap}>{data.observation.body}</Text>
            {data.observation.impact ? (
              <Text size="sm" mt="sm" style={preWrap}><b>Impact:</b> {data.observation.impact}</Text>
            ) : null}
            {data.observation.projectTags.length > 0 && (
              <Group gap={4} mt="xs">
                {data.observation.projectTags.map((t) => (
                  <Badge key={t} size="xs" variant="light" color="cyan">{t}</Badge>
                ))}
              </Group>
            )}
          </>
        )}
      </Card>

      {/* Read-time hint: this observation may already be covered by a solved problem */}
      {solvedMatches && solvedMatches.length > 0 && (
        <Alert color="yellow" variant="light" title="This may already be solved">
          <Stack gap="xs">
            <Text size="sm">
              {solvedMatches.length === 1
                ? "A solved problem looks like this observation"
                : `${solvedMatches.length} solved problems look like this observation`}
              . If one is the same issue, you may not need to synthesize a new problem.
            </Text>
            {solvedMatches.map((m) => (
              <Group key={m.problemId} justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Text
                    size="sm"
                    fw={500}
                    lineClamp={1}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      setView("library");
                      selectProblem(m.problemId);
                    }}
                  >
                    {m.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {(m.similarity * 100).toFixed(0)}%
                  </Text>
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => {
                      setView("library");
                      selectProblem(m.problemId);
                    }}
                  >
                    View
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    loading={dismissMatch.isPending && dismissMatch.variables === m.problemId}
                    onClick={() => dismissMatch.mutate(m.problemId)}
                  >
                    Not the same
                  </Button>
                </Group>
              </Group>
            ))}
          </Stack>
        </Alert>
      )}

      {/* Similar observations */}
      <Card withBorder padding="md">
        <Title order={5} mb="xs">Similar observations ({data.links.length})</Title>
        <Stack gap="xs">
          {data.links.map(({ link, observation }) => (
            <Group key={link.id} justify="space-between" wrap="nowrap">
              <Text size="sm" lineClamp={1} style={{ cursor: "pointer" }}
                onClick={() => useAppStore.getState().selectObservation(observation.id)}>
                {observation.title}
              </Text>
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

      {/* Synthesized problems */}
      {data.synthesizedProblems.length > 0 && (
        <Card withBorder padding="md">
          <Title order={5} mb="xs">Synthesized into ({data.synthesizedProblems.length})</Title>
          <Stack gap="xs">
            {data.synthesizedProblems.map((p) => (
              <Text key={p.id} size="sm" style={{ cursor: "pointer" }}
                onClick={() => { setView("library"); selectProblem(p.id); }}>
                → {p.title}
              </Text>
            ))}
          </Stack>
        </Card>
      )}

      {/* Solutions (optional for observations) */}
      <Card withBorder padding="md">
        <Group justify="space-between" mb="xs">
          <Title order={5}>Solutions ({data.solutions.length})</Title>
          {!adding ? (
            <Button size="xs" variant="light" onClick={() => setAdding(true)}>Add solution</Button>
          ) : null}
        </Group>
        {adding ? (
          <Stack gap="xs" mb="sm">
            <Textarea label="Solution" autosize minRows={3} value={newSol} onChange={(e) => setNewSol(e.currentTarget.value)} data-autofocus />
            <Group>
              <Button size="xs" loading={addSolution.isPending} disabled={!newSol.trim()} onClick={() => addSolution.mutate()}>
                Save as accepted
              </Button>
              <Button size="xs" variant="default" onClick={() => { setAdding(false); setNewSol(""); }}>Cancel</Button>
            </Group>
          </Stack>
        ) : null}
        <Stack gap="sm">
          {data.solutions.map((s) => (
            <div key={s.id}>
              <Group gap="xs">
                <Badge size="xs" variant="light">{s.origin}</Badge>
                <Badge size="xs" color={s.status === "accepted" ? "green" : "gray"}>{s.status}</Badge>
              </Group>
              <Text size="sm" mt={4} style={preWrap}>{s.body}</Text>
              <Divider mt="sm" />
            </div>
          ))}
          {data.solutions.length === 0 ? <Text size="sm" c="dimmed">No solutions — an observation doesn't need one.</Text> : null}
        </Stack>
      </Card>
    </Stack>
  );
}
