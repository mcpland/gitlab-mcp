export const TOOL_CAPABILITIES = ["read", "write", "delete", "admin", "graphql"] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

export const GITLAB_PERMISSION_MODES = ["readonly", "modify", "full"] as const;

export type GitLabPermissionMode = (typeof GITLAB_PERMISSION_MODES)[number];

export const PERMISSION_MODE_BLOCKED_CAPABILITIES: Readonly<
  Record<GitLabPermissionMode, ReadonlySet<ToolCapability>>
> = {
  readonly: new Set<ToolCapability>(["write", "delete", "admin"]),
  modify: new Set<ToolCapability>(["delete"]),
  full: new Set<ToolCapability>()
};
