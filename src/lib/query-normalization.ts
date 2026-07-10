export type IdUsernamePair = readonly [idField: string, usernameField: string];

export const ISSUE_ID_USERNAME_PAIRS: readonly IdUsernamePair[] = [
  ["author_id", "author_username"],
  ["assignee_id", "assignee_username"]
];

export const MERGE_REQUEST_ID_USERNAME_PAIRS: readonly IdUsernamePair[] = [
  ...ISSUE_ID_USERNAME_PAIRS,
  ["reviewer_id", "reviewer_username"]
];

/** GitLab rejects requests containing both an ID and username filter. */
export function normalizeIdUsernameFilters<T extends Record<string, unknown>>(
  input: T,
  pairs: readonly IdUsernamePair[]
): T {
  const output = { ...input };

  for (const [idField, usernameField] of pairs) {
    if (hasUsernameFilter(output[usernameField])) {
      delete output[idField];
    }
  }

  return output;
}

function hasUsernameFilter(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return value !== undefined && value !== null;
}
