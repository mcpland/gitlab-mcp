/**
 * One-line "next step" hints for failed tool calls, so agents can recover
 * (fix an ID, ask for a scope, back off) instead of retrying blindly.
 * Hints are generic and never echo request data.
 */

export function nextStepForGitLabStatus(
  status: number,
  details: unknown,
  options: { remoteCredentials: boolean }
): string | undefined {
  if (status === 401) {
    return options.remoteCredentials
      ? "The GitLab credential sent with this request was rejected or has expired; send a valid Authorization, Private-Token, or Job-Token header."
      : "The configured GitLab credential was rejected or has expired; update it (for example GITLAB_PERSONAL_ACCESS_TOKEN) and retry.";
  }
  if (status === 403) {
    return hasInsufficientScope(details)
      ? "The token lacks a required scope (for example api, read_api, or read_user); use a token with that scope."
      : "The token's user lacks permission for this action (role, protected resource, or project settings); use a read-only alternative or ask for access.";
  }
  if (status === 404) {
    return "Check project_id (numeric ID or full path such as group/project) and the resource ID or IID; GitLab also returns 404 for resources the token cannot see.";
  }
  if (status === 409) {
    return "The resource already exists or changed concurrently; fetch its current state before retrying.";
  }
  if (status === 400 || status === 422) {
    return "GitLab rejected the input; fix the field named in the details and retry.";
  }
  if (status === 429) {
    return "GitLab rate-limited the request; wait retry_after_seconds when present, then retry with fewer or smaller requests.";
  }
  if (status >= 500) {
    return "GitLab returned a server error; retry later or check the GitLab instance status.";
  }
  return undefined;
}

/** Hints for errors raised by this server's own policy and scope checks. */
export function nextStepForMessage(message: string): string | undefined {
  if (/is disabled by policy/u.test(message)) {
    return "This tool is blocked by GITLAB_PERMISSION_MODE, GITLAB_DISABLED_CAPABILITIES, GITLAB_ALLOWED_TOOLS, or GITLAB_DENIED_TOOLS_REGEX; use gitlab_discover_tools to find an allowed alternative.";
  }
  if (/GITLAB_ALLOWED_PROJECT_IDS/u.test(message)) {
    return "This server is limited to the projects in GITLAB_ALLOWED_PROJECT_IDS; pass one of them as project_id or use a project-scoped tool.";
  }
  return undefined;
}

function hasInsufficientScope(details: unknown): boolean {
  if (typeof details !== "object" || details === null) {
    return false;
  }
  const error = (details as Record<string, unknown>).error;
  return error === "insufficient_scope" || error === "insufficient_granular_scope";
}
