import { ActionIcon, Button, Group, Menu, Modal, Select, Stack, Text, TextInput } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { workspace } from "../auth.js";
import { useAppStore } from "../store.js";
import { useWorkspaces } from "../workspaces.js";

/** Sentinel for the "show every workspace" option (Mantine values must be strings). */
const ALL = "__all__";

/** Random suffix keeps workspace slugs unique. */
function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Header control: pick / create / delete the active workspace. The workspace is
 * the Better Auth active organization (server session) — it owns the records you
 * create (observations, problems, solutions). The cross-workspace knowledge graph
 * is a separate, shared layer and is not gated by this picker.
 */
export function WorkspacePicker() {
  const qc = useQueryClient();
  const { data: workspaces } = useWorkspaces();
  const scope = useAppStore((s) => s.scopeWorkspaceId);
  const setScope = useAppStore((s) => s.setScopeWorkspace);
  const scoped = (workspaces ?? []).find((w) => w.id === scope) ?? null;

  const [createModal, createModalH] = useDisclosure(false);
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const [newName, setNewName] = useState("");

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ["items"] });
    void qc.invalidateQueries({ queryKey: ["observations"] });
    void qc.invalidateQueries({ queryKey: ["problems"] });
    void qc.invalidateQueries({ queryKey: ["graph"] });
    void qc.invalidateQueries({ queryKey: ["project-tags"] });
    void qc.invalidateQueries({ queryKey: ["workspaces"] });
  };

  const createWs = useMutation({
    mutationFn: async (name: string) => {
      const res = await workspace.create({ name, slug: slug(name) });
      if (res.error || !res.data) throw new Error(res.error?.message ?? "Create workspace failed");
      await workspace.setActive(res.data.id);
      return res.data;
    },
    onSuccess: (created) => {
      createModalH.close();
      setNewName("");
      setScope(created.id); // jump into the workspace you just made
      invalidateAll();
    },
  });

  const deleteWs = useMutation({
    mutationFn: async (id: string) => {
      const res = await workspace.delete(id);
      if (res.error) throw new Error(res.error.message ?? "Delete workspace failed");
      return id;
    },
    onSuccess: (deletedId) => {
      setConfirm(null);
      if (scope === deletedId) setScope(null); // fall back to "All"
      const next = (workspaces ?? []).find((w) => w.id !== deletedId);
      if (next) void workspace.setActive(next.id);
      invalidateAll();
    },
  });

  return (
    <>
      <Group gap={4}>
        <Select
          aria-label="Workspace"
          placeholder="Workspace"
          data={[
            { value: ALL, label: "All workspaces" },
            ...(workspaces ?? []).map((w) => ({ value: w.id, label: w.name })),
          ]}
          value={scope ?? ALL}
          onChange={(value) => {
            if (!value || value === ALL) {
              setScope(null); // show every workspace
              invalidateAll();
              return;
            }
            // A specific workspace scopes the view AND becomes the create target.
            setScope(value);
            void workspace.setActive(value).then(invalidateAll);
          }}
          allowDeselect={false}
          w={200}
        />
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" aria-label="Workspace actions">
              ⋯
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={createModalH.open}>New workspace</Menu.Item>
            <Menu.Item
              color="red"
              disabled={!scoped}
              onClick={() => scoped && setConfirm({ id: scoped.id, name: scoped.name })}
            >
              Delete workspace
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <Modal opened={createModal} onClose={createModalH.close} title="New workspace" centered>
        <Stack>
          <TextInput
            label="Name"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            data-autofocus
          />
          <Button
            loading={createWs.isPending}
            disabled={!newName.trim()}
            onClick={() => createWs.mutate(newName.trim())}
          >
            Create
          </Button>
        </Stack>
      </Modal>

      <Modal opened={confirm != null} onClose={() => setConfirm(null)} title="Delete workspace" centered>
        <Stack>
          <Text size="sm">
            Delete <b>{confirm?.name}</b>? This permanently removes the workspace and all its
            observations, problems and solutions. This cannot be undone.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button color="red" loading={deleteWs.isPending} onClick={() => confirm && deleteWs.mutate(confirm.id)}>
              Delete
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
