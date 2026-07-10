export const GITLAB_TOOLSETS = [
  "all",
  "core",
  "projects",
  "repository",
  "merge-requests",
  "issues",
  "pipelines",
  "ci-catalog",
  "wiki",
  "milestones",
  "releases",
  "labels",
  "groups",
  "work-items",
  "webhooks",
  "identity",
  "graphql"
] as const;

export type GitLabToolset = (typeof GITLAB_TOOLSETS)[number];

const VALID_TOOLSETS = new Set<string>(GITLAB_TOOLSETS);

const CORE_TOOLS = new Set([
  "gitlab_get_project",
  "gitlab_list_projects",
  "gitlab_get_repository_tree",
  "gitlab_get_file_contents",
  "gitlab_list_branches",
  "gitlab_get_branch",
  "gitlab_list_commits",
  "gitlab_get_commit",
  "gitlab_search_project_code",
  "gitlab_list_merge_requests",
  "gitlab_get_merge_request",
  "gitlab_get_merge_request_diffs",
  "gitlab_list_merge_request_changed_files",
  "gitlab_get_merge_request_file_diff",
  "gitlab_get_merge_request_code_context",
  "gitlab_list_merge_request_discussions",
  "gitlab_list_merge_request_notes",
  "gitlab_create_merge_request_note",
  "gitlab_list_issues",
  "gitlab_get_issue",
  "gitlab_create_issue",
  "gitlab_update_issue",
  "gitlab_list_pipelines",
  "gitlab_get_pipeline",
  "gitlab_list_pipeline_jobs",
  "gitlab_get_pipeline_job",
  "gitlab_get_pipeline_job_output",
  "gitlab_list_milestones",
  "gitlab_list_releases",
  "gitlab_list_labels",
  "gitlab_whoami",
  "gitlab_get_work_item",
  "gitlab_list_work_items"
]);

const TOOLSET_PATTERNS: ReadonlyArray<{
  toolset: Exclude<GitLabToolset, "all" | "core">;
  pattern: RegExp;
}> = [
  {
    toolset: "merge-requests",
    pattern: /(?:merge_request|draft_note|gitlab_create_note$)/
  },
  { toolset: "issues", pattern: /(?:issue|todo)/ },
  {
    toolset: "pipelines",
    pattern: /(?:pipeline|\bjob|job_|artifact|deployment|environment|ci_lint)/
  },
  { toolset: "ci-catalog", pattern: /ci_catalog/ },
  { toolset: "wiki", pattern: /wiki/ },
  { toolset: "milestones", pattern: /milestone/ },
  { toolset: "releases", pattern: /(?:release|_tag|tags$)/ },
  { toolset: "labels", pattern: /label/ },
  { toolset: "work-items", pattern: /(?:work_item|custom_field|timeline_event)/ },
  { toolset: "webhooks", pattern: /webhook/ },
  { toolset: "graphql", pattern: /graphql/ },
  {
    toolset: "groups",
    pattern: /(?:create_group|group_|namespace)/
  },
  {
    toolset: "identity",
    pattern: /(?:_user|users$|whoami|event)/
  },
  {
    toolset: "repository",
    pattern: /(?:repository_tree|file|branch|commit|blame|push_files|upload|attachment|_tag|tags$)/
  },
  {
    toolset: "projects",
    pattern: /(?:project|projects|repository|repositories|fork_repository)/
  }
];

export function parseGitLabToolsets(entries: readonly string[]): GitLabToolset[] {
  const normalized = entries.map((entry) => entry.trim().toLowerCase().replaceAll("_", "-"));
  const invalid = normalized.filter((entry) => !VALID_TOOLSETS.has(entry));

  if (invalid.length > 0) {
    throw new Error(
      `Invalid GITLAB_TOOLSETS value(s): ${invalid.join(", ")}. Expected any of: ${GITLAB_TOOLSETS.join(", ")}`
    );
  }

  return [...new Set(normalized)] as GitLabToolset[];
}

export function toolsetsForTool(toolName: string): GitLabToolset[] {
  const toolsets = new Set<GitLabToolset>();

  if (toolName === "gitlab_discover_tools") {
    toolsets.add("core");
  }

  if (CORE_TOOLS.has(toolName)) {
    toolsets.add("core");
  }

  for (const matcher of TOOLSET_PATTERNS) {
    if (matcher.pattern.test(toolName)) {
      toolsets.add(matcher.toolset);
    }
  }

  return [...toolsets];
}

export function isToolEnabledByToolsets(
  toolName: string,
  enabledToolsets: readonly GitLabToolset[]
): boolean {
  if (toolName === "gitlab_discover_tools") {
    return true;
  }

  if (enabledToolsets.length === 0 || enabledToolsets.includes("all")) {
    return true;
  }

  const toolsets = toolsetsForTool(toolName);
  return enabledToolsets.some((toolset) => toolsets.includes(toolset));
}
