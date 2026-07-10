const PRESERVED_TOP_LEVEL_NULL_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  gitlab_create_label: new Set(["priority"]),
  gitlab_update_label: new Set(["priority"])
};

/**
 * Remove null/undefined values injected for omitted top-level MCP arguments.
 * Nested values are intentional payload data and must be preserved (for
 * example GraphQL variables and merge-request diff position line numbers).
 */
export function sanitizeToolArguments(
  toolName: string,
  args: Record<string, unknown>
): Record<string, unknown> {
  const preservedNullFields = PRESERVED_TOP_LEVEL_NULL_FIELDS[toolName] ?? new Set<string>();
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) {
      continue;
    }

    if (value === null && !preservedNullFields.has(key)) {
      continue;
    }

    output[key] = value;
  }

  return output;
}
