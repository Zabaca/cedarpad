import {
  Button,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Textarea,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { URGENCY_PRIORITY, urgencyToPriority } from "../../../lib/contract/index.js";
import { api } from "../api.js";
import { workspace as workspaceApi, useActiveWorkspace } from "../auth.js";
import { useAppStore } from "../store.js";
import { useWorkspaces } from "../workspaces.js";
import { TagsField } from "./TagsField.js";

type Kind = "observation" | "problem";
const URGENCY = ["low", "medium", "high", "critical"];

/**
 * Unified intake. The user explicitly chooses whether they are recording a loose
 * **observation** or a distinct **problem** (which adds priority/urgency and a
 * solution direction). Both kinds can carry an impact — it's folded into the
 * embedding so records that share an impact cluster together. Problems run the
 * full agent pipeline; observations are embedded and similarity-linked so
 * patterns can later be synthesized.
 */
export function Capture({
  defaultKind = "observation",
  onDone,
}: {
  defaultKind?: Kind;
  /** Called after a successful submit — lets a hosting modal close itself. */
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const setView = useAppStore((s) => s.setView);
  const selectProblem = useAppStore((s) => s.selectProblem);
  const selectObservation = useAppStore((s) => s.selectObservation);
  const scope = useAppStore((s) => s.scopeWorkspaceId);
  const { data: workspaces } = useWorkspaces();
  const { data: activeWs } = useActiveWorkspace();

  // Where the new record lands. A scoped view fixes the target; in "All
  // workspaces" the user picks it, defaulting to the active/first workspace.
  const [targetWs, setTargetWs] = useState<string | null>(null);
  const target = scope ?? targetWs ?? activeWs?.id ?? workspaces?.[0]?.id ?? null;

  const [kind, setKind] = useState<Kind>(defaultKind);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  // Impact applies to both kinds; the rest are problem-only.
  const [impact, setImpact] = useState("");
  const [urgency, setUrgency] = useState<(typeof URGENCY)[number]>("low");
  // Urgency seeds priority ("urgency implies priority"); once the user edits the
  // number by hand we stop overwriting it so they keep fine-grained control.
  const [priority, setPriority] = useState<number>(URGENCY_PRIORITY.low);
  const [priorityTouched, setPriorityTouched] = useState(false);
  const [solutionDirection, setSolutionDirection] = useState("");

  // Change urgency and, unless priority was hand-tuned, re-seed the sort weight.
  const changeUrgency = (v: (typeof URGENCY)[number]) => {
    setUrgency(v);
    if (!priorityTouched) setPriority(urgencyToPriority(v as "low" | "medium" | "high" | "critical"));
  };

  const reset = () => {
    setTitle("");
    setBody("");
    setTags([]);
    setImpact("");
    setUrgency("low");
    setPriority(URGENCY_PRIORITY.low);
    setPriorityTouched(false);
    setSolutionDirection("");
  };

  const mutation = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("Pick a workspace to capture into");
      // The API writes to the session's active workspace, so make the chosen
      // target active first. Idempotent when it's already active.
      if (target !== activeWs?.id) await workspaceApi.setActive(target);
      if (kind === "observation") {
        return {
          type: "observation" as const,
          detail: await api.createObservation({
            title,
            body,
            projectTags: tags,
            impact: impact || undefined,
            runAgent: true,
          }),
        };
      }
      return {
        type: "problem" as const,
        detail: await api.createProblem({
          title,
          body,
          projectTags: tags,
          impact: impact || undefined,
          urgency: urgency as "low" | "medium" | "high" | "critical",
          priority,
          solutionDirection: solutionDirection || undefined,
          runAgent: true,
        }),
      };
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: [res.type === "problem" ? "problems" : "observations"] });
      void qc.invalidateQueries({ queryKey: ["items"] });
      void qc.invalidateQueries({ queryKey: ["graph"] });
      void qc.invalidateQueries({ queryKey: ["project-tags"] });
      if (res.type === "problem") {
        notifications.show({
          title: "Problem submitted",
          message: "The agent is processing it — links and a solution will appear shortly.",
          color: "blue",
        });
        setView("library");
        selectProblem(res.detail.problem.id);
      } else {
        notifications.show({
          title: "Observation recorded",
          message: "The agent is processing it — similar links will appear shortly.",
          color: "blue",
        });
        setView("library");
        selectObservation(res.detail.observation.id);
      }
      reset();
      onDone?.();
    },
    onError: (err) =>
      notifications.show({ title: "Submission failed", message: String(err), color: "red" }),
  });

  return (
    <Stack gap="sm">
      <SegmentedControl
        fullWidth
        value={kind}
        onChange={(v) => setKind(v as Kind)}
        data={[
          { label: "Observation", value: "observation" },
          { label: "Problem", value: "problem" },
        ]}
      />
      {/* In "All workspaces" view the create target is ambiguous, so let the
          user choose it. A scoped view already fixes the target implicitly. */}
      {scope === null && (
        <Select
          label="Target workspace"
          description="The new item is created in this workspace"
          data={(workspaces ?? []).map((w) => ({ value: w.id, label: w.name }))}
          value={target}
          onChange={setTargetWs}
          allowDeselect={false}
          placeholder={workspaces?.length ? "Select a workspace" : "No workspaces available"}
        />
      )}
      <TextInput
        label="Title"
        placeholder={kind === "observation" ? "What did you notice?" : "Short problem summary"}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />
      <Textarea
        label={kind === "observation" ? "What happened?" : "Description"}
        placeholder={kind === "observation" ? "A loose note worth recording…" : "Describe the problem in detail…"}
        minRows={4}
        autosize
        value={body}
        onChange={(e) => setBody(e.currentTarget.value)}
      />
      <Textarea
        label="Impact"
        description="Who/what it affects — helps similar items cluster together"
        placeholder={
          kind === "observation"
            ? "Who/what did this affect?"
            : "What does this problem cost / who does it hurt?"
        }
        autosize
        minRows={2}
        value={impact}
        onChange={(e) => setImpact(e.currentTarget.value)}
      />
      {kind === "problem" && (
        <>
          <Select
            label="Urgency"
            description="Seeds the priority below"
            data={URGENCY}
            value={urgency}
            onChange={(v) => v && changeUrgency(v)}
            allowDeselect={false}
            w={160}
          />
          <NumberInput
            label="Priority"
            description="Higher sorts first (seeded from urgency)"
            value={priority}
            onChange={(v) => {
              setPriorityTouched(true);
              setPriority(typeof v === "number" ? v : 0);
            }}
            w={160}
          />
          <Textarea
            label="Solution direction"
            placeholder="How should a solution be approached?"
            autosize
            minRows={2}
            value={solutionDirection}
            onChange={(e) => setSolutionDirection(e.currentTarget.value)}
          />
        </>
      )}
      <TagsField value={tags} onChange={setTags} />
      <Button
        onClick={() => mutation.mutate()}
        loading={mutation.isPending}
        disabled={!title.trim() || !body.trim() || !target}
      >
        {kind === "observation" ? "Record observation" : "Submit & run agent"}
      </Button>
    </Stack>
  );
}
