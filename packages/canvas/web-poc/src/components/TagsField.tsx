import { TagsInput } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api.js";

/**
 * Project meta-tag input with autocomplete from the workspace's existing tags,
 * so people reuse tags rather than coining near-duplicates. These tags are
 * weightless metadata — they never affect heuristics or the LLM.
 */
export function TagsField({
  value,
  onChange,
  label = "Project tags",
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  label?: string;
}) {
  const { data: existing } = useQuery({
    queryKey: ["project-tags"],
    queryFn: () => api.listProjectTags(),
  });

  return (
    <TagsInput
      label={label}
      description="Optional, human-only labels (no effect on AI matching)"
      placeholder="Add a project…"
      data={existing ?? []}
      value={value}
      onChange={onChange}
      clearable
    />
  );
}
