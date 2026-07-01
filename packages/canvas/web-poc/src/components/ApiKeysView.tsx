import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Loader,
  Modal,
  MultiSelect,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ApiKeyAdmin } from "../../lib/contract/index.js";
import { api } from "../api.js";
import { apiKeys } from "../auth.js";
import { useWorkspaceNames, useWorkspaces } from "../workspaces.js";

/** Expiry presets. Better Auth caps custom expiry at 365 days; "never" omits it. */
const EXPIRY_OPTIONS = [
  { value: "never", label: "Never" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
];

const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString());

/** Coarse "time ago" for the last-seen column, so stale keys stand out. */
function relativeTime(ms: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const steps: [number, string][] = [
    [60, "s"],
    [60, "m"],
    [24, "h"],
    [30, "d"],
    [12, "mo"],
    [Number.POSITIVE_INFINITY, "y"],
  ];
  let value = secs;
  let label = "s";
  for (let i = 0; i < steps.length; i++) {
    const [size, unit] = steps[i]!;
    if (value < size) {
      label = unit;
      break;
    }
    value = Math.floor(value / size);
    label = steps[i + 1]?.[1] ?? unit;
  }
  if (label === "s" && value < 10) return "just now";
  return `${value}${label} ago`;
}

/** A key is "stale" if it has never been used or hasn't been seen in 30+ days. */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const isStale = (lastRequest: number | null) =>
  lastRequest === null || Date.now() - lastRequest > STALE_MS;

/**
 * A click-to-copy workspace id. The id — not the name — is what an external
 * agent passes to the API (`?workspaceId=…` to read one workspace; the write
 * target is informational), so it must be copyable straight from this screen.
 */
function CopyableId({ id }: { id: string }) {
  return (
    <CopyButton value={id}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? "Copied" : "Copy id"} withArrow>
          <Code
            onClick={copy}
            c={copied ? "teal" : "dimmed"}
            style={{ cursor: "pointer", fontSize: 11 }}
          >
            {id}
          </Code>
        </Tooltip>
      )}
    </CopyButton>
  );
}

/**
 * Shared API-key registry. A key lets an external service or AI agent
 * authenticate via `x-api-key` and create observations/problems against a
 * chosen workspace. There is no admin role — every user sees and can revoke
 * every key — so each row shows its owner and last-used time to make stale
 * keys easy to spot and prune. The plaintext secret is shown once, at creation.
 */
export function ApiKeysView() {
  const qc = useQueryClient();
  const { data: keys, isLoading } = useQuery({ queryKey: ["api-keys"], queryFn: () => api.listApiKeys() });
  const { data: workspaces } = useWorkspaces();
  const wsNames = useWorkspaceNames();

  const [createOpen, createH] = useDisclosure(false);
  // The one-time plaintext secret + its scoping, surfaced after a successful
  // create so the operator can copy the key AND the ids the agent will need.
  const [secret, setSecret] = useState<{
    name: string;
    key: string;
    defaultWorkspaceId: string;
    allowedWorkspaces: string[] | null;
  } | null>(null);
  const [confirm, setConfirm] = useState<ApiKeyAdmin | null>(null);

  const [name, setName] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [expiry, setExpiry] = useState("never");

  const resetForm = () => {
    setName("");
    setTarget(null);
    setAllowed([]);
    setExpiry("never");
  };

  const createKey = useMutation({
    mutationFn: async () => {
      // Include the write target in the read allowlist so the key can always
      // read what it writes. An empty allowlist ⇒ access to all workspaces.
      const allowlist = allowed.length ? [...new Set([target!, ...allowed])] : undefined;
      const res = await apiKeys.create({
        name: name.trim(),
        defaultWorkspaceId: target!,
        allowedWorkspaces: allowlist,
        expiresInDays: expiry === "never" ? null : Number(expiry),
      });
      if (res.error || !res.data) throw new Error(res.error?.message ?? "Failed to create key");
      return { key: res.data.key, allowlist };
    },
    onSuccess: ({ key, allowlist }) => {
      createH.close();
      setSecret({
        name: name.trim(),
        key,
        defaultWorkspaceId: target!,
        allowedWorkspaces: allowlist ?? null,
      });
      resetForm();
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const revokeKey = useMutation({
    mutationFn: (id: string) => api.revokeApiKey(id),
    onSuccess: () => {
      setConfirm(null);
      void qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  const wsOptions = (workspaces ?? []).map((w) => ({ value: w.id, label: w.name }));

  return (
    <Stack maw={1100} mx="auto">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={3}>API keys</Title>
          <Text size="sm" c="dimmed">
            Let an external service or AI agent create observations and problems via the API. Send
            the key as the <Code>x-api-key</Code> header. Everyone shares this list — any teammate
            can revoke a key.
          </Text>
        </div>
        <Button onClick={createH.open}>Create API key</Button>
      </Group>

      {isLoading ? (
        <Group justify="center" py="xl">
          <Loader />
        </Group>
      ) : (keys ?? []).length === 0 ? (
        <Text c="dimmed" py="xl" ta="center">
          No API keys yet. Create one to give an agent programmatic access.
        </Text>
      ) : (
        <Table verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Name</Table.Th>
              <Table.Th>Key</Table.Th>
              <Table.Th>Owner</Table.Th>
              <Table.Th>Writes to</Table.Th>
              <Table.Th>Read scope</Table.Th>
              <Table.Th>Created</Table.Th>
              <Table.Th>Last seen</Table.Th>
              <Table.Th>Expires</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(keys ?? []).map((k) => (
              <Table.Tr key={k.id}>
                <Table.Td>{k.name ?? "Untitled"}</Table.Td>
                <Table.Td>
                  <Code>{k.start ? `${k.start}…` : "—"}</Code>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{k.owner?.email ?? "—"}</Text>
                </Table.Td>
                <Table.Td>
                  {k.defaultWorkspaceId ? (
                    <Stack gap={4} align="flex-start">
                      <Badge variant="light">
                        {wsNames[k.defaultWorkspaceId] ?? k.defaultWorkspaceId}
                      </Badge>
                      <CopyableId id={k.defaultWorkspaceId} />
                    </Stack>
                  ) : (
                    <Text c="dimmed" size="sm">
                      —
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  {!k.allowedWorkspaces || k.allowedWorkspaces.length === 0 ? (
                    <Stack gap={2} align="flex-start">
                      <Text size="sm">All workspaces</Text>
                      <Text size="xs" c="dimmed">
                        narrow with <Code>?workspaceId=</Code>
                      </Text>
                    </Stack>
                  ) : (
                    <Stack gap={4} align="flex-start">
                      {k.allowedWorkspaces.map((id) => (
                        <Group key={id} gap={6} wrap="nowrap">
                          <Text size="sm">{wsNames[id] ?? id}</Text>
                          <CopyableId id={id} />
                        </Group>
                      ))}
                    </Stack>
                  )}
                </Table.Td>
                <Table.Td>{fmtDate(k.createdAt)}</Table.Td>
                <Table.Td>
                  {k.lastRequest === null ? (
                    <Badge variant="light" color="orange">
                      Never used
                    </Badge>
                  ) : (
                    <Text size="sm" c={isStale(k.lastRequest) ? "orange" : undefined}>
                      {relativeTime(k.lastRequest)}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>{fmtDate(k.expiresAt)}</Table.Td>
                <Table.Td>
                  <Button size="xs" variant="subtle" color="red" onClick={() => setConfirm(k)}>
                    Revoke
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {/* Create */}
      <Modal opened={createOpen} onClose={createH.close} title="Create API key" centered>
        <Stack>
          <TextInput
            label="Name"
            placeholder="e.g. Production agent"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            data-autofocus
          />
          <Select
            label="Writes to"
            description="Workspace where this key's observations and problems land."
            placeholder="Select a workspace"
            data={wsOptions}
            value={target}
            onChange={setTarget}
            searchable
          />
          <MultiSelect
            label="Read scope (optional)"
            description="Workspaces this key may read. Leave empty for all accessible workspaces."
            placeholder="All workspaces"
            data={wsOptions}
            value={allowed}
            onChange={setAllowed}
            searchable
            clearable
          />
          <Select
            label="Expires"
            data={EXPIRY_OPTIONS}
            value={expiry}
            onChange={(v) => setExpiry(v ?? "never")}
            allowDeselect={false}
          />
          {createKey.isError ? (
            <Text c="red" size="sm">
              {(createKey.error as Error).message}
            </Text>
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={createH.close}>
              Cancel
            </Button>
            <Button
              loading={createKey.isPending}
              disabled={!name.trim() || !target}
              onClick={() => createKey.mutate()}
            >
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* One-time secret reveal */}
      <Modal
        opened={secret != null}
        onClose={() => setSecret(null)}
        title="API key created"
        centered
        closeOnClickOutside={false}
      >
        <Stack>
          <Alert color="yellow" title="Copy this key now">
            This is the only time the full key for <b>{secret?.name}</b> is shown. Store it somewhere
            safe — you won't be able to see it again.
          </Alert>
          <Group gap="xs" wrap="nowrap">
            <Code style={{ flex: 1, wordBreak: "break-all" }}>{secret?.key}</Code>
            <CopyButton value={secret?.key ?? ""}>
              {({ copied, copy }) => (
                <Button variant="light" color={copied ? "teal" : "blue"} onClick={copy}>
                  {copied ? "Copied" : "Copy"}
                </Button>
              )}
            </CopyButton>
          </Group>

          {/* The ids the agent needs to call the API, copyable right here. */}
          {secret ? (
            <Stack gap={6}>
              <Text size="xs" c="dimmed">
                Send the key as the <Code>x-api-key</Code> header.
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Text size="sm" w={90}>
                  Writes to
                </Text>
                <Text size="sm">{wsNames[secret.defaultWorkspaceId] ?? secret.defaultWorkspaceId}</Text>
                <CopyableId id={secret.defaultWorkspaceId} />
              </Group>
              <Group gap="xs" wrap="nowrap" align="flex-start">
                <Text size="sm" w={90}>
                  Can read
                </Text>
                {secret.allowedWorkspaces && secret.allowedWorkspaces.length > 0 ? (
                  <Stack gap={4}>
                    {secret.allowedWorkspaces.map((id) => (
                      <Group key={id} gap={6} wrap="nowrap">
                        <Text size="sm">{wsNames[id] ?? id}</Text>
                        <CopyableId id={id} />
                      </Group>
                    ))}
                  </Stack>
                ) : (
                  <Text size="sm">
                    All workspaces — pass <Code>?workspaceId=&lt;id&gt;</Code> to read one (ids from{" "}
                    <Code>GET /v1/workspaces</Code>)
                  </Text>
                )}
              </Group>
            </Stack>
          ) : null}

          <Group justify="flex-end">
            <Button onClick={() => setSecret(null)}>Done</Button>
          </Group>
        </Stack>
      </Modal>

      {/* Revoke confirm */}
      <Modal opened={confirm != null} onClose={() => setConfirm(null)} title="Revoke API key" centered>
        <Stack>
          <Text size="sm">
            Revoke <b>{confirm?.name ?? "this key"}</b>
            {confirm?.owner ? ` (owned by ${confirm.owner.email})` : ""}? Any service using it will
            immediately stop working. This cannot be undone.
          </Text>
          {revokeKey.isError ? (
            <Text c="red" size="sm">
              {(revokeKey.error as Error).message}
            </Text>
          ) : null}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              color="red"
              loading={revokeKey.isPending}
              onClick={() => confirm && revokeKey.mutate(confirm.id)}
            >
              Revoke
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
