import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { GitLabApiError, type PushFileAction } from "../lib/gitlab-client.js";
import { getSessionAuth } from "../lib/auth-context.js";
import { stripNullsDeep } from "../lib/sanitize.js";
import type { AppContext } from "../types/context.js";
import { getMergeRequestCodeContext, mergeRequestCodeContextSchema } from "./mr-code-context.js";

type ToolArgs = Record<string, unknown>;

type ToolSchemaShape = Record<string, z.ZodTypeAny>;

interface GitLabToolDefinition {
  name: string;
  title: string;
  description: string;
  mutating: boolean;
  requiresAuth?: boolean;
  requiresFeature?: "wiki" | "milestone" | "pipeline" | "release";
  inputSchema?: ToolSchemaShape;
  handler: (args: ToolArgs, context: AppContext) => Promise<unknown>;
}

const optionalString = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.string().optional()
);
const optionalNumber = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.number().optional()
);
const optionalBoolean = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.boolean().optional()
);
const optionalStringArray = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.array(z.string()).optional()
);
const optionalNumberArray = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.array(z.number()).optional()
);
const optionalStringOrNumber = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.union([z.string(), z.number()]).optional()
);
const optionalStringOrStringArray = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.union([z.string(), z.array(z.string())]).optional()
);
const optionalRecord = z.preprocess(
  (value) => (value === null ? undefined : value),
  z.record(z.string(), z.unknown()).optional()
);

const paginationShape = {
  page: optionalNumber,
  per_page: optionalNumber
} satisfies ToolSchemaShape;

export function registerGitLabTools(server: McpServer, context: AppContext): void {
  const definitions = getGitLabToolDefinitions();
  const filtered = context.policy.filterTools(
    definitions.map((item) => ({
      name: item.name,
      mutating: item.mutating,
      requiresFeature: item.requiresFeature
    }))
  );
  const enabledNames = new Set(filtered.map((item) => item.name));

  for (const definition of definitions) {
    if (!enabledNames.has(definition.name)) {
      continue;
    }

    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema ?? {}
      },
      async (rawArgs) => {
        try {
          context.policy.assertCanExecute({
            name: definition.name,
            mutating: definition.mutating,
            requiresFeature: definition.requiresFeature
          });

          if (definition.requiresAuth ?? true) {
            assertAuthReady(context);
          }

          const args = stripNullsDeep((rawArgs ?? {}) as ToolArgs);
          const result = await definition.handler(args, context);
          const formatted = context.formatter.format(result);

          return {
            content: [
              {
                type: "text",
                text: formatted.text
              }
            ],
            structuredContent: {
              result: toStructuredContent(result),
              meta: {
                truncated: formatted.truncated,
                bytes: formatted.bytes
              }
            }
          };
        } catch (error) {
          return toToolError(error, context);
        }
      }
    );
  }
}

function getGitLabToolDefinitions(): GitLabToolDefinition[] {
  return [
    {
      name: "gitlab_get_project",
      title: "Get Project",
      description: "Get project details by ID or path.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional()
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.getProject(projectId);
      }
    },
    {
      name: "gitlab_list_projects",
      title: "List Projects",
      description: "List projects available to the current user.",
      mutating: false,
      inputSchema: {
        search: optionalString,
        search_namespaces: optionalBoolean,
        membership: optionalBoolean,
        owned: optionalBoolean,
        simple: optionalBoolean,
        archived: optionalBoolean,
        visibility: z.enum(["public", "internal", "private"]).optional(),
        order_by: z
          .enum(["id", "name", "path", "created_at", "updated_at", "last_activity_at"])
          .optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        with_issues_enabled: optionalBoolean,
        with_merge_requests_enabled: optionalBoolean,
        min_access_level: optionalNumber,
        ...paginationShape
      },
      handler: async (args, context) => context.gitlab.listProjects({ query: toQuery(args) })
    },
    {
      name: "gitlab_create_repository",
      title: "Create Repository",
      description: "Create a new GitLab project/repository.",
      mutating: true,
      inputSchema: {
        name: optionalString,
        description: optionalString,
        visibility: z.enum(["private", "internal", "public"]).optional(),
        initialize_with_readme: optionalBoolean,
        path: optionalString,
        namespace_id: optionalString,
        default_branch: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.createRepository({
          name: getString(args, "name"),
          description: getOptionalString(args, "description"),
          visibility: getOptionalString(args, "visibility") as
            | "private"
            | "internal"
            | "public"
            | undefined,
          initialize_with_readme: getOptionalBoolean(args, "initialize_with_readme"),
          path: getOptionalString(args, "path"),
          namespace_id: getOptionalString(args, "namespace_id"),
          default_branch: getOptionalString(args, "default_branch")
        })
    },
    {
      name: "gitlab_list_project_members",
      title: "List Project Members",
      description: "List members of a project.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        query: optionalString,
        user_ids: optionalNumberArray,
        skip_users: optionalNumberArray,
        include_inheritance: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.listProjectMembers(projectId, {
          query: toQuery(omit(args, ["project_id"]))
        });
      }
    },
    {
      name: "gitlab_list_group_projects",
      title: "List Group Projects",
      description: "List projects under a group.",
      mutating: false,
      inputSchema: {
        group_id: z.string(),
        include_subgroups: optionalBoolean,
        search: optionalString,
        order_by: z
          .enum(["name", "path", "created_at", "updated_at", "last_activity_at"])
          .optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        archived: optionalBoolean,
        visibility: z.enum(["public", "internal", "private"]).optional(),
        with_issues_enabled: optionalBoolean,
        with_merge_requests_enabled: optionalBoolean,
        min_access_level: optionalNumber,
        with_programming_language: optionalString,
        starred: optionalBoolean,
        statistics: optionalBoolean,
        with_custom_attributes: optionalBoolean,
        with_security_reports: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => {
        return context.gitlab.listGroupProjects(getString(args, "group_id"), {
          query: toQuery(omit(args, ["group_id"]))
        });
      }
    },
    {
      name: "gitlab_list_group_iterations",
      title: "List Group Iterations",
      description: "List iterations for a group.",
      mutating: false,
      inputSchema: {
        group_id: z.string().min(1),
        state: optionalString,
        search: optionalString,
        search_in: optionalStringArray,
        include_ancestors: optionalBoolean,
        include_descendants: optionalBoolean,
        updated_before: optionalString,
        updated_after: optionalString,
        ...paginationShape
      },
      handler: async (args, context) => {
        const query = toQuery(omit(args, ["group_id"]));
        const searchIn = getOptionalStringArray(args, "search_in");
        if (searchIn && searchIn.length > 0) {
          query.in = searchIn.join(",");
          delete query.search_in;
        }

        return context.gitlab.listGroupIterations(getString(args, "group_id"), { query });
      }
    },
    {
      name: "gitlab_search_repositories",
      title: "Search Repositories",
      description: "Search repositories by keyword.",
      mutating: false,
      inputSchema: {
        search: z.string().min(1),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.searchRepositories(getString(args, "search"), {
          query: toQuery(omit(args, ["search"]))
        })
    },
    {
      name: "gitlab_search_code_blobs",
      title: "Search Code Blobs",
      description: "Search repository code blobs in a specific project.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        search: z.string().min(1),
        ref: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.searchCodeBlobs(
          resolveProjectId(args, context, true),
          getString(args, "search"),
          { query: toQuery(omit(args, ["project_id", "search"])) }
        )
    },
    {
      name: "gitlab_get_repository_tree",
      title: "Get Repository Tree",
      description: "List files and directories in a repository tree.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        path: optionalString,
        ref: optionalString,
        recursive: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.getRepositoryTree(projectId, {
          query: toQuery(omit(args, ["project_id"]))
        });
      }
    },
    {
      name: "gitlab_get_file_contents",
      title: "Get File Contents",
      description: "Get a file in repository by path and ref.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        file_path: z.string().min(1),
        ref: optionalString
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        let ref = getOptionalString(args, "ref");
        if (!ref) {
          const project = (await context.gitlab.getProject(projectId)) as {
            default_branch?: unknown;
          };
          ref = typeof project.default_branch === "string" ? project.default_branch : "main";
        }
        return context.gitlab.getFileContents(projectId, getString(args, "file_path"), ref);
      }
    },
    {
      name: "gitlab_create_or_update_file",
      title: "Create Or Update File",
      description: "Create or update one file in repository.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        file_path: z.string().min(1),
        branch: z.string().min(1),
        content: z.string(),
        commit_message: z.string().min(1),
        previous_path: optionalString,
        author_email: optionalString,
        author_name: optionalString,
        encoding: optionalString,
        execute_filemode: optionalBoolean,
        start_branch: optionalString,
        last_commit_id: optionalString,
        commit_id: optionalString
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.createOrUpdateFile(projectId, getString(args, "file_path"), {
          branch: getString(args, "branch"),
          content: getString(args, "content"),
          commit_message: getString(args, "commit_message"),
          author_email: getOptionalString(args, "author_email"),
          author_name: getOptionalString(args, "author_name"),
          encoding: getOptionalString(args, "encoding") as "text" | "base64" | undefined,
          execute_filemode: getOptionalBoolean(args, "execute_filemode"),
          start_branch: getOptionalString(args, "start_branch"),
          last_commit_id:
            getOptionalString(args, "last_commit_id") ?? getOptionalString(args, "commit_id")
        });
      }
    },
    {
      name: "gitlab_push_files",
      title: "Push Files",
      description: "Create a commit with multiple file actions.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        branch: z.string().min(1),
        commit_message: z.string().min(1),
        actions: z
          .array(
            z.object({
              action: z.enum(["create", "delete", "move", "update", "chmod"]),
              file_path: z.string(),
              previous_path: optionalString,
              content: optionalString,
              encoding: optionalString,
              execute_filemode: optionalBoolean,
              last_commit_id: optionalString
            })
          )
          .optional(),
        files: z
          .array(
            z.object({
              file_path: z.string(),
              content: z.string()
            })
          )
          .optional(),
        start_branch: optionalString,
        author_name: optionalString,
        author_email: optionalString,
        force: optionalBoolean
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const actionsInput = args.actions;
        const filesInput = args.files;

        let actions: PushFileAction[] = [];
        if (Array.isArray(actionsInput) && actionsInput.length > 0) {
          actions = actionsInput as PushFileAction[];
        } else if (Array.isArray(filesInput) && filesInput.length > 0) {
          actions = filesInput.map((item) => {
            const record = item as { file_path: string; content: string };
            return {
              action: "create",
              file_path: record.file_path,
              content: record.content
            } satisfies PushFileAction;
          });
        }

        if (actions.length === 0) {
          throw new Error("Either actions or files must contain at least one item");
        }

        return context.gitlab.pushFiles(projectId, {
          branch: getString(args, "branch"),
          commit_message: getString(args, "commit_message"),
          actions,
          start_branch: getOptionalString(args, "start_branch"),
          author_name: getOptionalString(args, "author_name"),
          author_email: getOptionalString(args, "author_email"),
          force: getOptionalBoolean(args, "force")
        });
      }
    },
    {
      name: "gitlab_create_branch",
      title: "Create Branch",
      description: "Create a new branch from an existing ref.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        branch: z.string().min(1),
        ref: optionalString
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        let ref = getOptionalString(args, "ref");

        if (!ref) {
          const project = (await context.gitlab.getProject(projectId)) as {
            default_branch?: unknown;
          };
          ref = typeof project.default_branch === "string" ? project.default_branch : "main";
        }

        return context.gitlab.createBranch(projectId, {
          branch: getString(args, "branch"),
          ref
        });
      }
    },
    {
      name: "gitlab_get_branch_diffs",
      title: "Get Branch Diffs",
      description: "Compare two branches/refs and return diffs.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        from: z.string().min(1),
        to: z.string().min(1),
        straight: optionalBoolean,
        excluded_file_patterns: optionalStringArray
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const query = toQuery({ excluded_file_patterns: args.excluded_file_patterns });
        return context.gitlab.getBranchDiffs(
          projectId,
          {
            from: getString(args, "from"),
            to: getString(args, "to"),
            straight: getOptionalBoolean(args, "straight")
          },
          {
            query
          }
        );
      }
    },
    {
      name: "gitlab_list_commits",
      title: "List Commits",
      description: "List commits in a project.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        ref_name: optionalString,
        since: optionalString,
        until: optionalString,
        path: optionalString,
        author: optionalString,
        all: optionalBoolean,
        with_stats: optionalBoolean,
        first_parent: optionalBoolean,
        order: z.enum(["default", "topo"]).optional(),
        trailers: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.listCommits(projectId, {
          query: toQuery(omit(args, ["project_id"]))
        });
      }
    },
    {
      name: "gitlab_get_commit",
      title: "Get Commit",
      description: "Get one commit by SHA.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        sha: z.string().min(1),
        stats: optionalBoolean
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.getCommit(projectId, getString(args, "sha"), {
          query: toQuery(omit(args, ["project_id", "sha"]))
        });
      }
    },
    {
      name: "gitlab_get_commit_diff",
      title: "Get Commit Diff",
      description: "Get diff for one commit.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        sha: z.string().min(1),
        full_diff: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.getCommitDiff(projectId, getString(args, "sha"), {
          query: toQuery(omit(args, ["project_id", "sha"]))
        });
      }
    },
    {
      name: "gitlab_list_merge_requests",
      title: "List Merge Requests",
      description: "List merge requests for a project.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        assignee_id: optionalStringOrNumber,
        assignee_username: optionalString,
        author_id: optionalStringOrNumber,
        author_username: optionalString,
        reviewer_id: optionalStringOrNumber,
        reviewer_username: optionalString,
        created_after: optionalString,
        created_before: optionalString,
        updated_after: optionalString,
        updated_before: optionalString,
        labels: optionalStringOrStringArray,
        milestone: optionalString,
        state: optionalString,
        scope: optionalString,
        order_by: z
          .enum([
            "created_at",
            "updated_at",
            "priority",
            "label_priority",
            "milestone_due",
            "popularity"
          ])
          .optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        source_branch: optionalString,
        target_branch: optionalString,
        search: optionalString,
        wip: z.enum(["yes", "no"]).optional(),
        with_labels_details: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, false);
        const query = toQuery(omit(args, ["project_id"]));

        if (projectId) {
          return context.gitlab.listMergeRequests(projectId, { query });
        }

        return context.gitlab.listGlobalMergeRequests({ query });
      }
    },
    {
      name: "gitlab_get_merge_request",
      title: "Get Merge Request",
      description: "Get one merge request.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        source_branch: optionalString
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const mergeRequestIid = getOptionalString(args, "merge_request_iid");

        if (mergeRequestIid) {
          return context.gitlab.getMergeRequest(projectId, mergeRequestIid);
        }

        const sourceBranch = getOptionalString(args, "source_branch");
        if (!sourceBranch) {
          throw new Error("Either merge_request_iid or source_branch must be provided");
        }

        const candidates = await context.gitlab.listMergeRequests(projectId, {
          query: {
            source_branch: sourceBranch,
            per_page: 100,
            page: 1
          }
        });
        const match = pickFirstMergeRequest(candidates);
        if (!match) {
          throw new Error(`No merge request found for source_branch='${sourceBranch}'`);
        }

        return match;
      }
    },
    {
      name: "gitlab_create_merge_request",
      title: "Create Merge Request",
      description: "Create a merge request.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        source_branch: z.string().min(1),
        target_branch: z.string().min(1),
        title: z.string().min(1),
        description: optionalString,
        target_project_id: optionalString,
        assignee_ids: optionalNumberArray,
        reviewer_ids: optionalNumberArray,
        labels: optionalStringOrStringArray,
        allow_collaboration: optionalBoolean,
        remove_source_branch: optionalBoolean,
        squash: optionalBoolean,
        draft: optionalBoolean
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.createMergeRequest(projectId, {
          source_branch: getString(args, "source_branch"),
          target_branch: getString(args, "target_branch"),
          title: getString(args, "title"),
          description: getOptionalString(args, "description"),
          target_project_id: getOptionalString(args, "target_project_id"),
          assignee_ids: getOptionalNumberArray(args, "assignee_ids"),
          reviewer_ids: getOptionalNumberArray(args, "reviewer_ids"),
          labels: toCsvValue(args.labels),
          allow_collaboration: getOptionalBoolean(args, "allow_collaboration"),
          remove_source_branch: getOptionalBoolean(args, "remove_source_branch"),
          squash: getOptionalBoolean(args, "squash"),
          draft: getOptionalBoolean(args, "draft")
        });
      }
    },
    {
      name: "gitlab_fork_repository",
      title: "Fork Repository",
      description: "Fork an existing project to another namespace.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        namespace: optionalString,
        namespace_id: optionalString,
        path: optionalString,
        name: optionalString,
        description: optionalString,
        visibility: z.enum(["private", "internal", "public"]).optional(),
        default_branch: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.forkRepository(resolveProjectId(args, context, true), {
          namespace: getOptionalString(args, "namespace"),
          namespace_id: getOptionalString(args, "namespace_id"),
          path: getOptionalString(args, "path"),
          name: getOptionalString(args, "name"),
          description: getOptionalString(args, "description"),
          visibility: getOptionalString(args, "visibility") as
            | "private"
            | "internal"
            | "public"
            | undefined,
          default_branch: getOptionalString(args, "default_branch")
        })
    },
    {
      name: "gitlab_update_merge_request",
      title: "Update Merge Request",
      description: "Update merge request fields.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        source_branch: optionalString,
        title: optionalString,
        description: optionalString,
        target_branch: optionalString,
        assignee_ids: optionalNumberArray,
        reviewer_ids: optionalNumberArray,
        reviewers: optionalStringArray,
        labels: optionalStringOrStringArray,
        state_event: optionalString,
        squash: optionalBoolean,
        draft: optionalBoolean,
        remove_source_branch: optionalBoolean
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const payload = toQuery(omit(args, ["project_id", "merge_request_iid"])) as Record<
          string,
          unknown
        >;
        if (payload.labels === undefined) {
          payload.labels = toCsvValue(args.labels);
        }
        if (Array.isArray(args.assignee_ids)) {
          payload.assignee_ids = args.assignee_ids as number[];
        }
        if (Array.isArray(args.reviewer_ids)) {
          payload.reviewer_ids = args.reviewer_ids as number[];
        }
        if (payload.reviewer_ids === undefined && Array.isArray(args.reviewers)) {
          payload.reviewer_ids = (args.reviewers as string[]).join(",");
        }
        return context.gitlab.updateMergeRequest(
          projectId,
          getString(args, "merge_request_iid"),
          payload
        );
      }
    },
    {
      name: "gitlab_merge_merge_request",
      title: "Merge Merge Request",
      description: "Merge an existing merge request.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: optionalString,
        source_branch: optionalString,
        auto_merge: optionalBoolean,
        merge_when_pipeline_succeeds: optionalBoolean,
        merge_commit_message: optionalString,
        squash_commit_message: optionalString,
        should_remove_source_branch: optionalBoolean,
        squash: optionalBoolean,
        sha: optionalString
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        let mergeRequestIid = getOptionalString(args, "merge_request_iid");
        if (!mergeRequestIid) {
          const sourceBranch = getOptionalString(args, "source_branch");
          if (!sourceBranch) {
            throw new Error("Either merge_request_iid or source_branch must be provided");
          }

          const candidates = await context.gitlab.listMergeRequests(projectId, {
            query: {
              source_branch: sourceBranch,
              per_page: 100,
              page: 1
            }
          });
          const match = pickFirstMergeRequest(candidates);
          const iid = match?.iid;
          if (typeof iid !== "number" && typeof iid !== "string") {
            throw new Error(`No merge request found for source_branch='${sourceBranch}'`);
          }
          mergeRequestIid = String(iid);
        }

        return context.gitlab.mergeMergeRequest(
          projectId,
          mergeRequestIid,
          toQuery(omit(args, ["project_id", "merge_request_iid", "source_branch"]))
        );
      }
    },
    {
      name: "gitlab_get_merge_request_diffs",
      title: "Get Merge Request Diffs",
      description: "Get MR diffs with changed files.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        view: z.enum(["inline", "parallel"]).optional(),
        excluded_file_patterns: optionalStringArray
      },
      handler: async (args, context) =>
        context.gitlab.getMergeRequestDiffs(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          { query: toQuery(omit(args, ["project_id", "merge_request_iid"])) }
        )
    },
    {
      name: "gitlab_list_merge_request_diffs",
      title: "List Merge Request Diffs",
      description: "List detailed MR diffs (versions/changes view).",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        page: optionalNumber,
        per_page: optionalNumber,
        unidiff: optionalBoolean
      },
      handler: async (args, context) =>
        context.gitlab.listMergeRequestDiffs(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          { query: toQuery(omit(args, ["project_id", "merge_request_iid"])) }
        )
    },
    {
      name: "gitlab_get_merge_request_code_context",
      title: "Get Merge Request Code Context",
      description:
        "High-signal MR code context with include/exclude filters, sorting, and token-budgeted output.",
      mutating: false,
      inputSchema: mergeRequestCodeContextSchema,
      handler: async (args, context) =>
        getMergeRequestCodeContext(
          {
            projectId: resolveProjectId(args, context, true),
            mergeRequestIid: getString(args, "merge_request_iid"),
            includePaths: getOptionalStringArray(args, "include_paths"),
            excludePaths: getOptionalStringArray(args, "exclude_paths"),
            extensions: getOptionalStringArray(args, "extensions"),
            languages: getOptionalStringArray(args, "languages"),
            maxFiles: getOptionalNumber(args, "max_files") ?? 30,
            maxTotalChars: getOptionalNumber(args, "max_total_chars") ?? 120_000,
            contextLines: getOptionalNumber(args, "context_lines") ?? 20,
            mode:
              (getOptionalString(args, "mode") as
                | "patch"
                | "surrounding"
                | "fullfile"
                | undefined) ?? "patch",
            sort:
              (getOptionalString(args, "sort") as
                | "changed_lines"
                | "path"
                | "file_size"
                | undefined) ?? "changed_lines",
            listOnly: getOptionalBoolean(args, "list_only") ?? false
          },
          context
        )
    },
    {
      name: "gitlab_list_merge_request_versions",
      title: "List Merge Request Versions",
      description: "List MR diff versions.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.listMergeRequestVersions(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid")
        )
    },
    {
      name: "gitlab_get_merge_request_version",
      title: "Get Merge Request Version",
      description: "Get one MR diff version.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        version_id: z.string().min(1),
        unidiff: optionalBoolean
      },
      handler: async (args, context) =>
        context.gitlab.getMergeRequestVersion(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "version_id"),
          { query: toQuery(omit(args, ["project_id", "merge_request_iid", "version_id"])) }
        )
    },
    {
      name: "gitlab_approve_merge_request",
      title: "Approve Merge Request",
      description: "Approve a merge request.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        sha: optionalString,
        approval_password: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.approveMergeRequest(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          toQuery(omit(args, ["project_id", "merge_request_iid"]))
        )
    },
    {
      name: "gitlab_unapprove_merge_request",
      title: "Unapprove Merge Request",
      description: "Remove current user approval from MR.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.unapproveMergeRequest(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid")
        )
    },
    {
      name: "gitlab_get_merge_request_approval_state",
      title: "Get Merge Request Approval State",
      description: "Get approval state for MR.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getMergeRequestApprovalState(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid")
        )
    },
    {
      name: "gitlab_list_merge_request_discussions",
      title: "List Merge Request Discussions",
      description: "List MR discussions.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listMergeRequestDiscussions(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          { query: toQuery(omit(args, ["project_id", "merge_request_iid"])) }
        )
    },
    {
      name: "gitlab_create_merge_request_thread",
      title: "Create Merge Request Thread",
      description: "Create a new MR discussion thread (supports diff positions).",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        body: z.string().min(1),
        position: optionalRecord,
        created_at: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.createMergeRequestThread(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          {
            body: getString(args, "body"),
            position: getOptionalRecord(args, "position"),
            created_at: getOptionalString(args, "created_at")
          }
        )
    },
    {
      name: "gitlab_mr_discussions",
      title: "Merge Request Discussions (Alias)",
      description: "Backward-compatible alias of gitlab_list_merge_request_discussions.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listMergeRequestDiscussions(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          { query: toQuery(omit(args, ["project_id", "merge_request_iid"])) }
        )
    },
    {
      name: "gitlab_create_merge_request_discussion_note",
      title: "Create MR Discussion Note",
      description: "Add note to existing MR discussion thread.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        discussion_id: z.string().min(1),
        body: z.string().min(1),
        created_at: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.createMergeRequestDiscussionNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "discussion_id"),
          {
            body: getString(args, "body"),
            created_at: getOptionalString(args, "created_at")
          }
        )
    },
    {
      name: "gitlab_update_merge_request_discussion_note",
      title: "Update MR Discussion Note",
      description: "Update note body/resolved state in MR discussion.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        discussion_id: z.string().min(1),
        note_id: z.string().min(1),
        body: optionalString,
        resolved: optionalBoolean
      },
      handler: async (args, context) => {
        const body = getOptionalString(args, "body");
        const resolved = getOptionalBoolean(args, "resolved");

        if (body === undefined && resolved === undefined) {
          throw new Error("Either body or resolved must be provided");
        }

        if (body !== undefined && resolved !== undefined) {
          throw new Error("Provide either body or resolved, not both");
        }

        return context.gitlab.updateMergeRequestDiscussionNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "discussion_id"),
          getString(args, "note_id"),
          {
            body,
            resolved
          }
        );
      }
    },
    {
      name: "gitlab_delete_merge_request_discussion_note",
      title: "Delete MR Discussion Note",
      description: "Delete note from MR discussion thread.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        discussion_id: z.string().min(1),
        note_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.deleteMergeRequestDiscussionNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "discussion_id"),
          getString(args, "note_id")
        )
    },
    {
      name: "gitlab_resolve_merge_request_thread",
      title: "Resolve Merge Request Thread",
      description: "Resolve/unresolve an MR discussion note.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        discussion_id: z.string().min(1),
        note_id: z.string().min(1),
        resolved: z.boolean().default(true)
      },
      handler: async (args, context) =>
        context.gitlab.resolveMergeRequestThread(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "discussion_id"),
          getString(args, "note_id"),
          getBoolean(args, "resolved")
        )
    },
    {
      name: "gitlab_list_merge_request_notes",
      title: "List Merge Request Notes",
      description: "List top-level notes for an MR.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        sort: optionalString,
        order_by: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listMergeRequestNotes(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          { query: toQuery(omit(args, ["project_id", "merge_request_iid"])) }
        )
    },
    {
      name: "gitlab_get_merge_request_notes",
      title: "Get Merge Request Notes (Alias)",
      description: "Backward-compatible alias of gitlab_list_merge_request_notes.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        sort: optionalString,
        order_by: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listMergeRequestNotes(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          { query: toQuery(omit(args, ["project_id", "merge_request_iid"])) }
        )
    },
    {
      name: "gitlab_get_draft_note",
      title: "Get Draft Note",
      description: "Get a single merge-request draft note.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        draft_note_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getDraftNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "draft_note_id")
        )
    },
    {
      name: "gitlab_list_draft_notes",
      title: "List Draft Notes",
      description: "List draft notes on a merge request.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.listDraftNotes(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid")
        )
    },
    {
      name: "gitlab_create_draft_note",
      title: "Create Draft Note",
      description: "Create a merge-request draft note.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        body: z.string().min(1),
        position: optionalRecord,
        resolve_discussion: optionalBoolean
      },
      handler: async (args, context) =>
        context.gitlab.createDraftNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          {
            body: getString(args, "body"),
            position: getOptionalRecord(args, "position"),
            resolve_discussion: getOptionalBoolean(args, "resolve_discussion")
          }
        )
    },
    {
      name: "gitlab_update_draft_note",
      title: "Update Draft Note",
      description: "Update a merge-request draft note.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        draft_note_id: z.string().min(1),
        body: optionalString,
        position: optionalRecord,
        resolve_discussion: optionalBoolean
      },
      handler: async (args, context) => {
        if (
          getOptionalString(args, "body") === undefined &&
          getOptionalRecord(args, "position") === undefined &&
          getOptionalBoolean(args, "resolve_discussion") === undefined
        ) {
          throw new Error("At least one of body, position, or resolve_discussion is required");
        }

        return context.gitlab.updateDraftNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "draft_note_id"),
          {
            body: getOptionalString(args, "body"),
            position: getOptionalRecord(args, "position"),
            resolve_discussion: getOptionalBoolean(args, "resolve_discussion")
          }
        );
      }
    },
    {
      name: "gitlab_delete_draft_note",
      title: "Delete Draft Note",
      description: "Delete a merge-request draft note.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        draft_note_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.deleteDraftNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "draft_note_id")
        )
    },
    {
      name: "gitlab_publish_draft_note",
      title: "Publish Draft Note",
      description: "Publish one merge-request draft note.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        draft_note_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.publishDraftNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "draft_note_id")
        )
    },
    {
      name: "gitlab_bulk_publish_draft_notes",
      title: "Bulk Publish Draft Notes",
      description: "Publish all merge-request draft notes.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.bulkPublishDraftNotes(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid")
        )
    },
    {
      name: "gitlab_get_merge_request_note",
      title: "Get Merge Request Note",
      description: "Get a single MR note.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        note_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getMergeRequestNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "note_id")
        )
    },
    {
      name: "gitlab_create_merge_request_note",
      title: "Create Merge Request Note",
      description: "Create a top-level MR note.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        body: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.createMergeRequestNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "body")
        )
    },
    {
      name: "gitlab_create_note",
      title: "Create Note",
      description: "Create a note on an issue or merge request.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        noteable_type: z.enum(["issue", "merge_request"]),
        noteable_iid: z.string().min(1),
        body: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.createNote(
          resolveProjectId(args, context, true),
          getString(args, "noteable_type") as "issue" | "merge_request",
          getString(args, "noteable_iid"),
          getString(args, "body")
        )
    },
    {
      name: "gitlab_update_merge_request_note",
      title: "Update Merge Request Note",
      description: "Update MR note body.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        note_id: z.string().min(1),
        body: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.updateMergeRequestNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "note_id"),
          getString(args, "body")
        )
    },
    {
      name: "gitlab_delete_merge_request_note",
      title: "Delete Merge Request Note",
      description: "Delete an MR note.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        note_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.deleteMergeRequestNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "note_id")
        )
    },
    {
      name: "gitlab_list_issues",
      title: "List Issues",
      description: "List issues in project.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        assignee_id: optionalStringOrNumber,
        assignee_username: optionalStringArray,
        author_id: optionalStringOrNumber,
        author_username: optionalString,
        confidential: optionalBoolean,
        created_after: optionalString,
        created_before: optionalString,
        due_date: optionalString,
        labels: optionalStringOrStringArray,
        milestone: optionalString,
        issue_type: z.enum(["issue", "incident", "test_case", "task"]).optional(),
        iteration_id: optionalStringOrNumber,
        scope: z.enum(["created_by_me", "assigned_to_me", "all"]).optional(),
        state: optionalString,
        search: optionalString,
        updated_after: optionalString,
        updated_before: optionalString,
        with_labels_details: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, false);
        const query = toQuery(omit(args, ["project_id"]));

        if (projectId) {
          return context.gitlab.listIssues(projectId, { query });
        }

        return context.gitlab.listGlobalIssues({ query });
      }
    },
    {
      name: "gitlab_my_issues",
      title: "My Issues",
      description: "List issues assigned to the current authenticated user.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        state: z.enum(["opened", "closed", "all"]).optional(),
        labels: optionalStringOrStringArray,
        milestone: optionalString,
        search: optionalString,
        created_after: optionalString,
        created_before: optionalString,
        updated_after: optionalString,
        updated_before: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.myIssues({
          project_id: getOptionalString(args, "project_id"),
          ...(toQuery(omit(args, ["project_id"])) as Record<string, string | number | boolean>)
        })
    },
    {
      name: "gitlab_get_issue",
      title: "Get Issue",
      description: "Get issue by IID.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getIssue(resolveProjectId(args, context, true), getString(args, "issue_iid"))
    },
    {
      name: "gitlab_create_issue",
      title: "Create Issue",
      description: "Create a new issue.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        title: z.string().min(1),
        description: optionalString,
        labels: optionalStringOrStringArray,
        milestone_id: optionalNumber,
        due_date: optionalString,
        confidential: optionalBoolean,
        issue_type: optionalString,
        assignee_ids: optionalNumberArray
      },
      handler: async (args, context) =>
        context.gitlab.createIssue(resolveProjectId(args, context, true), {
          title: getString(args, "title"),
          description: getOptionalString(args, "description"),
          labels: toCsvValue(args.labels),
          milestone_id: getOptionalNumber(args, "milestone_id"),
          due_date: getOptionalString(args, "due_date"),
          confidential: getOptionalBoolean(args, "confidential"),
          issue_type: getOptionalString(args, "issue_type"),
          assignee_ids: getOptionalNumberArray(args, "assignee_ids")
        })
    },
    {
      name: "gitlab_update_issue",
      title: "Update Issue",
      description: "Update issue fields.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1),
        title: optionalString,
        description: optionalString,
        state_event: optionalString,
        labels: optionalStringOrStringArray,
        milestone_id: optionalNumber,
        due_date: optionalString,
        confidential: optionalBoolean,
        assignee_ids: optionalNumberArray,
        discussion_locked: optionalBoolean,
        weight: optionalNumber,
        issue_type: z.enum(["issue", "incident", "test_case", "task"]).optional()
      },
      handler: async (args, context) => {
        const payload = toQuery(omit(args, ["project_id", "issue_iid"])) as Record<string, unknown>;
        if (payload.labels === undefined) {
          payload.labels = toCsvValue(args.labels);
        }
        if (Array.isArray(args.assignee_ids)) {
          payload.assignee_ids = args.assignee_ids as number[];
        }

        return context.gitlab.updateIssue(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          payload
        );
      }
    },
    {
      name: "gitlab_delete_issue",
      title: "Delete Issue",
      description: "Delete an issue.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.deleteIssue(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid")
        )
    },
    {
      name: "gitlab_list_issue_discussions",
      title: "List Issue Discussions",
      description: "List issue discussions.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listIssueDiscussions(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          { query: toQuery(omit(args, ["project_id", "issue_iid"])) }
        )
    },
    {
      name: "gitlab_create_issue_note",
      title: "Create Issue Note",
      description: "Create issue comment (top-level or discussion note).",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1),
        discussion_id: optionalString,
        body: z.string().min(1),
        created_at: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.createIssueNote(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          {
            body: getString(args, "body"),
            discussion_id: getOptionalString(args, "discussion_id"),
            created_at: getOptionalString(args, "created_at")
          }
        )
    },
    {
      name: "gitlab_update_issue_note",
      title: "Update Issue Note",
      description: "Update an issue discussion note body or resolved state.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1),
        discussion_id: z.string().min(1),
        note_id: z.string().min(1),
        body: optionalString,
        resolved: optionalBoolean
      },
      handler: async (args, context) => {
        const body = getOptionalString(args, "body");
        const resolved = getOptionalBoolean(args, "resolved");

        if (body === undefined && resolved === undefined) {
          throw new Error("Either body or resolved must be provided");
        }

        if (body !== undefined && resolved !== undefined) {
          throw new Error("Provide either body or resolved, not both");
        }

        return context.gitlab.updateIssueNote(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          getString(args, "discussion_id"),
          getString(args, "note_id"),
          { body, resolved }
        );
      }
    },
    {
      name: "gitlab_list_issue_links",
      title: "List Issue Links",
      description: "List related issue links for an issue.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.listIssueLinks(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid")
        )
    },
    {
      name: "gitlab_get_issue_link",
      title: "Get Issue Link",
      description: "Get a single issue link by ID.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1),
        issue_link_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getIssueLink(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          getString(args, "issue_link_id")
        )
    },
    {
      name: "gitlab_create_issue_link",
      title: "Create Issue Link",
      description: "Create a relation between two issues.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1),
        target_project_id: z.string().min(1),
        target_issue_iid: z.string().min(1),
        link_type: z.enum(["relates_to", "blocks", "is_blocked_by"]).optional()
      },
      handler: async (args, context) =>
        context.gitlab.createIssueLink(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          {
            target_project_id: getString(args, "target_project_id"),
            target_issue_iid: getString(args, "target_issue_iid"),
            link_type: getOptionalString(args, "link_type") as
              | "relates_to"
              | "blocks"
              | "is_blocked_by"
              | undefined
          }
        )
    },
    {
      name: "gitlab_delete_issue_link",
      title: "Delete Issue Link",
      description: "Delete a relation between issues.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1),
        issue_link_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.deleteIssueLink(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          getString(args, "issue_link_id")
        )
    },
    {
      name: "gitlab_list_wiki_pages",
      title: "List Wiki Pages",
      description: "List wiki pages in a project.",
      mutating: false,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: z.string().optional(),
        with_content: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listWikiPages(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_wiki_page",
      title: "Get Wiki Page",
      description: "Get wiki page by slug.",
      mutating: false,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: z.string().optional(),
        slug: z.string().min(1),
        version: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.getWikiPage(resolveProjectId(args, context, true), getString(args, "slug"), {
          query: toQuery(omit(args, ["project_id", "slug"]))
        })
    },
    {
      name: "gitlab_create_wiki_page",
      title: "Create Wiki Page",
      description: "Create a wiki page.",
      mutating: true,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: z.string().optional(),
        title: z.string().min(1),
        content: z.string().min(1),
        format: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.createWikiPage(resolveProjectId(args, context, true), {
          title: getString(args, "title"),
          content: getString(args, "content"),
          format: getOptionalString(args, "format") as
            | "markdown"
            | "rdoc"
            | "asciidoc"
            | "org"
            | undefined
        })
    },
    {
      name: "gitlab_update_wiki_page",
      title: "Update Wiki Page",
      description: "Update wiki page by slug.",
      mutating: true,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: z.string().optional(),
        slug: z.string().min(1),
        content: z.string().min(1),
        title: optionalString,
        format: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.updateWikiPage(
          resolveProjectId(args, context, true),
          getString(args, "slug"),
          {
            content: getString(args, "content"),
            title: getOptionalString(args, "title"),
            format: getOptionalString(args, "format") as
              | "markdown"
              | "rdoc"
              | "asciidoc"
              | "org"
              | undefined
          }
        )
    },
    {
      name: "gitlab_delete_wiki_page",
      title: "Delete Wiki Page",
      description: "Delete wiki page by slug.",
      mutating: true,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: z.string().optional(),
        slug: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.deleteWikiPage(
          resolveProjectId(args, context, true),
          getString(args, "slug")
        )
    },
    {
      name: "gitlab_list_pipelines",
      title: "List Pipelines",
      description: "List pipelines for a project.",
      mutating: false,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        scope: z.enum(["running", "pending", "finished", "branches", "tags"]).optional(),
        status: z
          .enum([
            "created",
            "waiting_for_resource",
            "preparing",
            "pending",
            "running",
            "success",
            "failed",
            "canceled",
            "skipped",
            "manual",
            "scheduled"
          ])
          .optional(),
        ref: optionalString,
        sha: optionalString,
        yaml_errors: optionalBoolean,
        username: optionalString,
        updated_after: optionalString,
        updated_before: optionalString,
        order_by: z.enum(["id", "status", "ref", "updated_at", "user_id"]).optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        source: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listPipelines(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_pipeline",
      title: "Get Pipeline",
      description: "Get one pipeline.",
      mutating: false,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        pipeline_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getPipeline(
          resolveProjectId(args, context, true),
          getString(args, "pipeline_id")
        )
    },
    {
      name: "gitlab_list_pipeline_jobs",
      title: "List Pipeline Jobs",
      description: "List jobs in a pipeline.",
      mutating: false,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        pipeline_id: z.string().min(1),
        scope: z
          .enum([
            "created",
            "pending",
            "running",
            "failed",
            "success",
            "canceled",
            "skipped",
            "manual"
          ])
          .optional(),
        include_retried: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listPipelineJobs(
          resolveProjectId(args, context, true),
          getString(args, "pipeline_id"),
          { query: toQuery(omit(args, ["project_id", "pipeline_id"])) }
        )
    },
    {
      name: "gitlab_list_pipeline_trigger_jobs",
      title: "List Pipeline Trigger Jobs",
      description: "List downstream/bridge trigger jobs in a pipeline.",
      mutating: false,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        pipeline_id: z.string().min(1),
        scope: z
          .enum([
            "canceled",
            "canceling",
            "created",
            "failed",
            "manual",
            "pending",
            "preparing",
            "running",
            "scheduled",
            "skipped",
            "success",
            "waiting_for_resource"
          ])
          .optional(),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listPipelineTriggerJobs(
          resolveProjectId(args, context, true),
          getString(args, "pipeline_id"),
          { query: toQuery(omit(args, ["project_id", "pipeline_id"])) }
        )
    },
    {
      name: "gitlab_get_pipeline_job",
      title: "Get Pipeline Job",
      description: "Get one job by job ID.",
      mutating: false,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        job_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getPipelineJob(
          resolveProjectId(args, context, true),
          getString(args, "job_id")
        )
    },
    {
      name: "gitlab_get_pipeline_job_output",
      title: "Get Pipeline Job Output",
      description: "Get raw job trace output.",
      mutating: false,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        job_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getPipelineJobOutput(
          resolveProjectId(args, context, true),
          getString(args, "job_id")
        )
    },
    {
      name: "gitlab_create_pipeline",
      title: "Create Pipeline",
      description: "Trigger a new pipeline.",
      mutating: true,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        ref: z.string().min(1),
        variables: z
          .array(
            z.object({
              key: z.string(),
              value: z.string(),
              variable_type: optionalString
            })
          )
          .optional()
      },
      handler: async (args, context) =>
        context.gitlab.createPipeline(resolveProjectId(args, context, true), {
          ref: getString(args, "ref"),
          variables: getArray(args, "variables") as Array<{
            key: string;
            value: string;
            variable_type?: "env_var" | "file";
          }>
        })
    },
    {
      name: "gitlab_retry_pipeline",
      title: "Retry Pipeline",
      description: "Retry failed jobs in pipeline.",
      mutating: true,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        pipeline_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.retryPipeline(
          resolveProjectId(args, context, true),
          getString(args, "pipeline_id")
        )
    },
    {
      name: "gitlab_cancel_pipeline",
      title: "Cancel Pipeline",
      description: "Cancel a running pipeline.",
      mutating: true,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        pipeline_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.cancelPipeline(
          resolveProjectId(args, context, true),
          getString(args, "pipeline_id")
        )
    },
    {
      name: "gitlab_retry_pipeline_job",
      title: "Retry Pipeline Job",
      description: "Retry one failed job.",
      mutating: true,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        job_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.retryPipelineJob(
          resolveProjectId(args, context, true),
          getString(args, "job_id")
        )
    },
    {
      name: "gitlab_cancel_pipeline_job",
      title: "Cancel Pipeline Job",
      description: "Cancel one running job.",
      mutating: true,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        job_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.cancelPipelineJob(
          resolveProjectId(args, context, true),
          getString(args, "job_id")
        )
    },
    {
      name: "gitlab_play_pipeline_job",
      title: "Play Pipeline Job",
      description: "Play a manual job.",
      mutating: true,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: z.string().optional(),
        job_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.playPipelineJob(
          resolveProjectId(args, context, true),
          getString(args, "job_id")
        )
    },
    {
      name: "gitlab_list_milestones",
      title: "List Milestones",
      description: "List project milestones.",
      mutating: false,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        iids: optionalNumberArray,
        state: optionalString,
        title: optionalString,
        search: optionalString,
        include_ancestors: optionalBoolean,
        updated_before: optionalString,
        updated_after: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listMilestones(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_milestone",
      title: "Get Milestone",
      description: "Get a milestone by ID.",
      mutating: false,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        milestone_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getMilestone(
          resolveProjectId(args, context, true),
          getString(args, "milestone_id")
        )
    },
    {
      name: "gitlab_create_milestone",
      title: "Create Milestone",
      description: "Create a milestone.",
      mutating: true,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        title: z.string().min(1),
        description: optionalString,
        due_date: optionalString,
        start_date: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.createMilestone(resolveProjectId(args, context, true), {
          title: getString(args, "title"),
          description: getOptionalString(args, "description"),
          due_date: getOptionalString(args, "due_date"),
          start_date: getOptionalString(args, "start_date")
        })
    },
    {
      name: "gitlab_update_milestone",
      title: "Update Milestone",
      description: "Update milestone fields.",
      mutating: true,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        milestone_id: z.string().min(1),
        title: optionalString,
        description: optionalString,
        due_date: optionalString,
        start_date: optionalString,
        state_event: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.updateMilestone(
          resolveProjectId(args, context, true),
          getString(args, "milestone_id"),
          toQuery(omit(args, ["project_id", "milestone_id"]))
        )
    },
    {
      name: "gitlab_edit_milestone",
      title: "Edit Milestone (Alias)",
      description: "Backward-compatible alias of gitlab_update_milestone.",
      mutating: true,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        milestone_id: z.string().min(1),
        title: optionalString,
        description: optionalString,
        due_date: optionalString,
        start_date: optionalString,
        state_event: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.updateMilestone(
          resolveProjectId(args, context, true),
          getString(args, "milestone_id"),
          toQuery(omit(args, ["project_id", "milestone_id"]))
        )
    },
    {
      name: "gitlab_delete_milestone",
      title: "Delete Milestone",
      description: "Delete a milestone.",
      mutating: true,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        milestone_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.deleteMilestone(
          resolveProjectId(args, context, true),
          getString(args, "milestone_id")
        )
    },
    {
      name: "gitlab_get_milestone_issue",
      title: "Get Milestone Issues",
      description: "List issues assigned to a milestone.",
      mutating: false,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        milestone_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getMilestoneIssues(
          resolveProjectId(args, context, true),
          getString(args, "milestone_id")
        )
    },
    {
      name: "gitlab_get_milestone_merge_requests",
      title: "Get Milestone Merge Requests",
      description: "List merge requests assigned to a milestone.",
      mutating: false,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        milestone_id: z.string().min(1),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.getMilestoneMergeRequests(
          resolveProjectId(args, context, true),
          getString(args, "milestone_id"),
          { query: toQuery(omit(args, ["project_id", "milestone_id"])) }
        )
    },
    {
      name: "gitlab_promote_milestone",
      title: "Promote Milestone",
      description: "Promote a project milestone to a group milestone.",
      mutating: true,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        milestone_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.promoteMilestone(
          resolveProjectId(args, context, true),
          getString(args, "milestone_id")
        )
    },
    {
      name: "gitlab_get_milestone_burndown_events",
      title: "Get Milestone Burndown Events",
      description: "List burndown events for a milestone.",
      mutating: false,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: z.string().optional(),
        milestone_id: z.string().min(1),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.getMilestoneBurndownEvents(
          resolveProjectId(args, context, true),
          getString(args, "milestone_id"),
          { query: toQuery(omit(args, ["project_id", "milestone_id"])) }
        )
    },
    {
      name: "gitlab_list_releases",
      title: "List Releases",
      description: "List project releases.",
      mutating: false,
      requiresFeature: "release",
      inputSchema: {
        project_id: z.string().optional(),
        order_by: z.enum(["released_at", "created_at"]).optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        include_html_description: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listReleases(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_release",
      title: "Get Release",
      description: "Get one release by tag name.",
      mutating: false,
      requiresFeature: "release",
      inputSchema: {
        project_id: z.string().optional(),
        tag_name: z.string().min(1),
        include_html_description: optionalBoolean
      },
      handler: async (args, context) =>
        context.gitlab.getRelease(
          resolveProjectId(args, context, true),
          getString(args, "tag_name"),
          { query: toQuery(omit(args, ["project_id", "tag_name"])) }
        )
    },
    {
      name: "gitlab_create_release",
      title: "Create Release",
      description: "Create a release.",
      mutating: true,
      requiresFeature: "release",
      inputSchema: {
        project_id: z.string().optional(),
        name: optionalString,
        tag_name: z.string().min(1),
        tag_message: optionalString,
        description: optionalString,
        ref: optionalString,
        released_at: optionalString,
        milestones: optionalStringArray,
        assets: optionalRecord
      },
      handler: async (args, context) =>
        context.gitlab.createRelease(
          resolveProjectId(args, context, true),
          toQuery(omit(args, ["project_id"]))
        )
    },
    {
      name: "gitlab_update_release",
      title: "Update Release",
      description: "Update existing release.",
      mutating: true,
      requiresFeature: "release",
      inputSchema: {
        project_id: z.string().optional(),
        tag_name: z.string().min(1),
        name: optionalString,
        description: optionalString,
        released_at: optionalString,
        milestones: optionalStringArray,
        assets: optionalRecord
      },
      handler: async (args, context) =>
        context.gitlab.updateRelease(
          resolveProjectId(args, context, true),
          getString(args, "tag_name"),
          toQuery(omit(args, ["project_id", "tag_name"]))
        )
    },
    {
      name: "gitlab_delete_release",
      title: "Delete Release",
      description: "Delete a release by tag.",
      mutating: true,
      requiresFeature: "release",
      inputSchema: {
        project_id: z.string().optional(),
        tag_name: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.deleteRelease(
          resolveProjectId(args, context, true),
          getString(args, "tag_name")
        )
    },
    {
      name: "gitlab_create_release_evidence",
      title: "Create Release Evidence",
      description: "Create evidence for an existing release.",
      mutating: true,
      requiresFeature: "release",
      inputSchema: {
        project_id: z.string().optional(),
        tag_name: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.createReleaseEvidence(
          resolveProjectId(args, context, true),
          getString(args, "tag_name")
        )
    },
    {
      name: "gitlab_download_release_asset",
      title: "Download Release Asset",
      description: "Download a release asset using its direct asset path.",
      mutating: false,
      requiresFeature: "release",
      inputSchema: {
        project_id: z.string().optional(),
        tag_name: z.string().min(1),
        direct_asset_path: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.downloadReleaseAsset(
          resolveProjectId(args, context, true),
          getString(args, "tag_name"),
          getString(args, "direct_asset_path")
        )
    },
    {
      name: "gitlab_list_labels",
      title: "List Labels",
      description: "List project labels.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        with_counts: optionalBoolean,
        include_ancestor_groups: optionalBoolean,
        search: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listLabels(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_label",
      title: "Get Label",
      description: "Get one label by ID.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        label_id: z.string().min(1),
        include_ancestor_groups: optionalBoolean
      },
      handler: async (args, context) =>
        context.gitlab.getLabel(
          resolveProjectId(args, context, true),
          getString(args, "label_id"),
          {
            query: toQuery(omit(args, ["project_id", "label_id"]))
          }
        )
    },
    {
      name: "gitlab_create_label",
      title: "Create Label",
      description: "Create a label.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        name: z.string().min(1),
        color: z.string().min(1),
        description: optionalString,
        priority: optionalNumber
      },
      handler: async (args, context) =>
        context.gitlab.createLabel(
          resolveProjectId(args, context, true),
          toQuery(omit(args, ["project_id"]))
        )
    },
    {
      name: "gitlab_update_label",
      title: "Update Label",
      description: "Update a label.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        name: optionalString,
        label_id: optionalString,
        new_name: optionalString,
        color: optionalString,
        description: optionalString,
        priority: optionalNumber
      },
      handler: async (args, context) => {
        const payload = toQuery(omit(args, ["project_id"])) as Record<string, unknown>;
        if (payload.name === undefined) {
          payload.name = getOptionalString(args, "label_id");
        }
        if (payload.name === undefined) {
          throw new Error("Either name or label_id must be provided");
        }

        return context.gitlab.updateLabel(resolveProjectId(args, context, true), payload);
      }
    },
    {
      name: "gitlab_delete_label",
      title: "Delete Label",
      description: "Delete a label by name.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        name: optionalString,
        label_id: optionalString
      },
      handler: async (args, context) => {
        const labelName = getOptionalString(args, "name") ?? getOptionalString(args, "label_id");
        if (!labelName) {
          throw new Error("Either name or label_id must be provided");
        }
        return context.gitlab.deleteLabel(resolveProjectId(args, context, true), labelName);
      }
    },
    {
      name: "gitlab_list_namespaces",
      title: "List Namespaces",
      description: "List namespaces visible to user.",
      mutating: false,
      inputSchema: {
        search: optionalString,
        owned: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => context.gitlab.listNamespaces({ query: toQuery(args) })
    },
    {
      name: "gitlab_get_namespace",
      title: "Get Namespace",
      description: "Get namespace by ID or path.",
      mutating: false,
      inputSchema: {
        namespace_id_or_path: optionalString,
        namespace_id: optionalString
      },
      handler: async (args, context) => {
        const namespaceId =
          getOptionalString(args, "namespace_id_or_path") ??
          getOptionalString(args, "namespace_id");
        if (!namespaceId) {
          throw new Error("Either namespace_id_or_path or namespace_id must be provided");
        }

        return context.gitlab.getNamespace(namespaceId);
      }
    },
    {
      name: "gitlab_verify_namespace",
      title: "Verify Namespace",
      description: "Verify if namespace path exists.",
      mutating: false,
      inputSchema: {
        path: z.string().min(1)
      },
      handler: async (args, context) => context.gitlab.verifyNamespace(getString(args, "path"))
    },
    {
      name: "gitlab_get_users",
      title: "Get Users",
      description: "Search users.",
      mutating: false,
      inputSchema: {
        username: optionalString,
        search: optionalString,
        active: optionalBoolean,
        extern_uid: optionalString,
        provider: optionalString,
        ...paginationShape
      },
      handler: async (args, context) => context.gitlab.getUsers({ query: toQuery(args) })
    },
    {
      name: "gitlab_list_events",
      title: "List Events",
      description: "List current user events.",
      mutating: false,
      inputSchema: {
        action: optionalString,
        target_type: optionalString,
        before: optionalString,
        after: optionalString,
        scope: optionalString,
        sort: optionalString,
        ...paginationShape
      },
      handler: async (args, context) => context.gitlab.listEvents({ query: toQuery(args) })
    },
    {
      name: "gitlab_get_project_events",
      title: "Get Project Events",
      description: "List events for a specific project.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        action: optionalString,
        target_type: optionalString,
        before: optionalString,
        after: optionalString,
        sort: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.getProjectEvents(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_upload_markdown",
      title: "Upload Markdown",
      description: "Upload markdown file/attachment to project.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        content: optionalString,
        filename: z.string().default("upload.md"),
        file_path: optionalString
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const filePath = getOptionalString(args, "file_path");
        if (filePath) {
          return context.gitlab.uploadMarkdownFile(projectId, filePath);
        }

        const content = getOptionalString(args, "content");
        if (!content) {
          throw new Error("Either file_path or content must be provided");
        }

        return context.gitlab.uploadMarkdown(projectId, content, getString(args, "filename"));
      }
    },
    {
      name: "gitlab_download_attachment",
      title: "Download Attachment",
      description: "Download attachment by URL/path and return base64.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        url_or_path: optionalString,
        secret: optionalString,
        filename: optionalString,
        local_path: optionalString
      },
      handler: async (args, context) => {
        const urlOrPath = getOptionalString(args, "url_or_path");
        if (urlOrPath) {
          return context.gitlab.downloadAttachment(urlOrPath);
        }

        const secret = getOptionalString(args, "secret");
        const filename = getOptionalString(args, "filename");
        if (!secret || !filename) {
          throw new Error(
            "Either url_or_path must be provided, or both secret and filename must be provided"
          );
        }

        const projectId = resolveProjectId(args, context, true);
        const apiRelativePath = `api/v4/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(secret)}/${encodeURIComponent(filename)}`;

        return context.gitlab.downloadAttachment(apiRelativePath);
      }
    },
    {
      name: "gitlab_execute_graphql_query",
      title: "Execute GraphQL Query",
      description: "Execute read-only GraphQL query.",
      mutating: false,
      inputSchema: {
        query: z.string().min(1),
        variables: optionalRecord
      },
      handler: async (args, context) => {
        const query = getString(args, "query");

        if (containsGraphqlMutation(query)) {
          throw new Error(
            "Mutation detected. Use gitlab_execute_graphql_mutation for mutation operations."
          );
        }

        return context.gitlab.executeGraphql(query, getOptionalRecord(args, "variables"));
      }
    },
    {
      name: "gitlab_execute_graphql_mutation",
      title: "Execute GraphQL Mutation",
      description: "Execute GraphQL mutation (disabled in read-only mode).",
      mutating: true,
      inputSchema: {
        query: z.string().min(1),
        variables: optionalRecord
      },
      handler: async (args, context) => {
        const query = getString(args, "query");

        if (!containsGraphqlMutation(query)) {
          throw new Error("No mutation detected. Use gitlab_execute_graphql_query for queries.");
        }

        return context.gitlab.executeGraphql(query, getOptionalRecord(args, "variables"));
      }
    },
    {
      name: "gitlab_execute_graphql",
      title: "Execute GraphQL (Compat)",
      description:
        "Backward-compatible GraphQL executor. Mutation payloads still honor read-only policy.",
      mutating: false,
      inputSchema: {
        query: z.string().min(1),
        variables: optionalRecord
      },
      handler: async (args, context) => {
        const query = getString(args, "query");
        if (containsGraphqlMutation(query)) {
          context.policy.assertCanExecute({
            name: "gitlab_execute_graphql",
            mutating: true
          });
        }

        return context.gitlab.executeGraphql(query, getOptionalRecord(args, "variables"));
      }
    }
  ];
}

function assertAuthReady(context: AppContext): void {
  const auth = getSessionAuth();

  if (context.env.REMOTE_AUTHORIZATION) {
    const token = auth?.token;
    if (!token) {
      throw new Error("Missing remote authorization token for this session");
    }

    if (context.env.ENABLE_DYNAMIC_API_URL && !auth?.apiUrl) {
      throw new Error("Missing remote API URL for this session");
    }

    return;
  }

  const hasFallbackAuth =
    Boolean(context.env.GITLAB_PERSONAL_ACCESS_TOKEN) ||
    Boolean(context.env.GITLAB_USE_OAUTH && context.env.GITLAB_OAUTH_CLIENT_ID) ||
    Boolean(context.env.GITLAB_TOKEN_SCRIPT) ||
    Boolean(context.env.GITLAB_TOKEN_FILE) ||
    Boolean(context.env.GITLAB_AUTH_COOKIE_PATH);

  if (!hasFallbackAuth) {
    throw new Error(
      "Authentication required: set GITLAB_PERSONAL_ACCESS_TOKEN, GITLAB_TOKEN_SCRIPT, GITLAB_TOKEN_FILE, or GITLAB_AUTH_COOKIE_PATH"
    );
  }
}

export function containsGraphqlMutation(query: string): boolean {
  if (!query.trim()) {
    return false;
  }

  // Remove comments and string values to avoid false positives from text content.
  const normalized = query
    .replace(/#[^\n]*/g, " ")
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ");

  return /\bmutation\b\s*(?:[A-Za-z_][A-Za-z0-9_]*)?\s*(?:\(|\{)/i.test(normalized);
}

function resolveProjectId(args: ToolArgs, context: AppContext, required: boolean): string {
  const fromArgs = getOptionalString(args, "project_id");
  const allowed = context.env.GITLAB_ALLOWED_PROJECT_IDS;

  if (allowed.length > 0) {
    if (fromArgs && !allowed.includes(fromArgs)) {
      throw new Error(
        `Project '${fromArgs}' is not in GITLAB_ALLOWED_PROJECT_IDS: ${allowed.join(", ")}`
      );
    }

    if (!fromArgs && allowed.length === 1) {
      return requireArrayValue(allowed, 0, "GITLAB_ALLOWED_PROJECT_IDS is empty");
    }

    if (!fromArgs && allowed.length > 1) {
      throw new Error(
        `Multiple allowed projects configured (${allowed.join(", ")}). Please specify project_id.`
      );
    }

    return fromArgs ?? requireArrayValue(allowed, 0, "GITLAB_ALLOWED_PROJECT_IDS is empty");
  }

  if (required && !fromArgs) {
    throw new Error("project_id is required");
  }

  return fromArgs ?? "";
}

function toToolError(error: unknown, context?: AppContext): CallToolResult {
  const detailMode = context?.env.GITLAB_ERROR_DETAIL_MODE ?? "full";

  if (error instanceof GitLabApiError) {
    const payload: Record<string, unknown> = {
      error: `GitLab API error ${error.status}`
    };
    if (detailMode === "full") {
      payload.details = redactSensitive(error.details);
    }

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(payload, null, 2)
        }
      ]
    };
  }

  if (error instanceof Error) {
    const message = detailMode === "full" ? error.message : "Request failed";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: message
        }
      ]
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "Unknown error"
      }
    ]
  };
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      return {
        items: value,
        count: value.length
      };
    }

    return value as Record<string, unknown>;
  }

  return {
    value
  };
}

function omit(args: ToolArgs, keys: string[]): ToolArgs {
  const result: ToolArgs = {};
  for (const [key, value] of Object.entries(args)) {
    if (!keys.includes(key)) {
      result[key] = value;
    }
  }

  return result;
}

function toQuery(args: ToolArgs): Record<string, string | number | boolean | undefined> {
  const output: Record<string, string | number | boolean | undefined> = {};

  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      output[key] = value.join(",");
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }

  return output;
}

function toCsvValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string");
    return items.length > 0 ? items.join(",") : undefined;
  }

  return undefined;
}

function pickFirstMergeRequest(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const first = value[0];
  if (typeof first !== "object" || first === null) {
    return undefined;
  }

  return first as Record<string, unknown>;
}

function getString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`'${key}' must be a non-empty string`);
  }

  return value;
}

function getOptionalString(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`'${key}' must be a string`);
  }

  return value;
}

function getOptionalStringArray(args: ToolArgs, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`'${key}' must be string[]`);
  }

  return value;
}

function getBoolean(args: ToolArgs, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean") {
    throw new Error(`'${key}' must be boolean`);
  }

  return value;
}

function getOptionalBoolean(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`'${key}' must be boolean`);
  }

  return value;
}

function getOptionalNumber(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`'${key}' must be number`);
  }

  return value;
}

function getArray(args: ToolArgs, key: string): unknown[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    throw new Error(`'${key}' must be array`);
  }

  return value;
}

function getOptionalNumberArray(args: ToolArgs, key: string): number[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) {
    throw new Error(`'${key}' must be number[]`);
  }

  return value;
}

function getOptionalRecord(args: ToolArgs, key: string): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`'${key}' must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireArrayValue<T>(items: T[], index: number, errorMessage: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(errorMessage);
  }

  return value;
}

function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(
        /\b(glpat-[a-z0-9_-]{10,}|ghp_[a-z0-9]{20,}|eyJ[a-zA-Z0-9._-]{20,})\b/g,
        "[REDACTED]"
      )
      .replace(
        /(private[-_]?token|authorization)["']?\s*[:=]\s*["']?[^"'\s,}]+/gi,
        "$1=[REDACTED]"
      );
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }

  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      if (/token|authorization|password|secret/i.test(key)) {
        output[key] = "[REDACTED]";
        continue;
      }
      output[key] = redactSensitive(item);
    }
    return output;
  }

  return value;
}
