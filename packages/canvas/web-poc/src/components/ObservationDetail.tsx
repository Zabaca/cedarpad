import {
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  Modal,
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

const OBS_STATUS = ["open", "synthesized", "archived"];
// Preserve newlines/paragraphs in free-form text (body, solutions).
const preWrap = { whiteSpace: "pre-wrap" } as const;

export function ObservationDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const setView = useAppStore((s) => s.setView);
  const selectProblem = useAppStore((s) => s.selectProblem);
  const selectObservation = useAppStore((s) => s.selectObservation);

  const { data, isLoading, error } = useQuery({
    queryKey: ["observation", id],
    queryFn: () => api.getObservation(id),
  });

  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("open");
  const [adding, setAdding] = useState(false);
  const [newSol, setNewSol] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

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
  // Deleting is a correction, not a workflow — it clears the selection so the
  // detail pane doesn't sit on a record that is gone.
  const deleteObs = useMutation({
    mutationFn: () => api.deleteObservation(id),
    onSuccess: () => {
      setConfirmDelete(false);
      selectObservation(null);
      invalidate();
      notifications.show({ title: "Observation deleted", message: "Removed.", color: "gray" });
    },
    onError: (err) =>
      notifications.show({ title: "Delete failed", message: String(err), color: "red" }),
  });
  const addSolution = useMutation({
    mutationFn: () => api.createSolution({ targetKind: "observation", targetId: id, body: newSol }),
    onSuccess: () => {
      setAdding(false);
      setNewSol("");
      invalidate();
    },
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
      <Modal
        opened={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete observation"
        centered
      >
        <Stack gap="sm">
          <Text size="sm">
            Delete <b>{data.observation.title}</b>? This removes the record and its ties.
          </Text>
          <Group justify="flex-end">
            <Button size="xs" variant="default" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button size="xs" color="red" loading={deleteObs.isPending} onClick={() => deleteObs.mutate()}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
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
                {/* Who produced it — distinct from the Source below, which is
                    where it came from. */}
                <Badge
                  size="sm"
                  variant="outline"
                  color={data.observation.origin === "agent" ? "grape" : "gray"}
                >
                  {data.observation.origin}
                </Badge>
                <Badge size="sm" variant="outline">{data.observation.status}</Badge>
              </Group>
              <Group gap="xs" wrap="nowrap">
                <ShareLinkButton kind="observation" id={id} />
                <Button size="xs" variant="default" onClick={startEdit}>Edit</Button>
                <Button size="xs" variant="subtle" color="red" onClick={() => setConfirmDelete(true)}>
                  Delete
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

      {/* Where it came from */}
      {data.source && (
        <Card withBorder padding="md">
          <Title order={5} mb="xs">Source</Title>
          <Group gap="xs">
            <Badge size="sm" variant="light">{data.source.kind}</Badge>
            <Text size="sm">
              {data.source.label ?? data.source.identifier ?? data.source.description}
            </Text>
          </Group>
        </Card>
      )}

      {/* Synthesized problems */}
      {data.problems.length > 0 && (
        <Card withBorder padding="md">
          <Title order={5} mb="xs">Feeds ({data.problems.length})</Title>
          <Stack gap="xs">
            {data.problems.map((p) => (
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
