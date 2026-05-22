import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Kind, parse } from "graphql";
import { z } from "zod";

import {
  GitLabApiError,
  type GitLabPipelineInputValue,
  type PushFileAction
} from "../lib/gitlab-client.js";
import {
  applySearchReplace,
  applyUnifiedDiff,
  parseSearchReplaceBlocks
} from "../lib/patch-helper.js";
import {
  bodySchema,
  displayNameSchema,
  nullableOptional,
  optionalBodySchema,
  optionalDisplayNameSchema,
  optionalProjectIdSchema,
  optionalRefLikeSchema,
  optionalUrlOrPathSchema,
  projectIdSchema,
  refLikeSchema,
  slugSchema
} from "../lib/tool-schema.js";
import type { ToolCapability } from "../lib/tool-capabilities.js";
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
  capabilities: ToolCapability[];
  requiresAuth?: boolean;
  requiresFeature?: "wiki" | "milestone" | "pipeline" | "release";
  requiresLocalFileTools?: boolean;
  inputSchema?: ToolSchemaShape;
  handler: (args: ToolArgs, context: AppContext) => Promise<unknown>;
}

const readCapabilities: ToolCapability[] = ["read"];
const writeCapabilities: ToolCapability[] = ["write"];
const deleteCapabilities: ToolCapability[] = ["delete"];
const adminCapabilities: ToolCapability[] = ["admin"];
const readGraphqlCapabilities: ToolCapability[] = ["read", "graphql"];
const writeGraphqlCapabilities: ToolCapability[] = ["write", "graphql"];

const optionalString = nullableOptional(z.string());
const optionalNumber = nullableOptional(z.number());
const optionalBoolean = nullableOptional(z.boolean());
const optionalStringArray = nullableOptional(z.array(z.string()));
const optionalNumberArray = nullableOptional(z.array(z.number()));
const optionalStringOrNumber = nullableOptional(z.union([z.string(), z.number()]));
const optionalStringOrStringArray = nullableOptional(z.union([z.string(), z.array(z.string())]));
const optionalRecord = nullableOptional(z.record(z.string(), z.unknown()));
const pipelineInputValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()]))
]);
const optionalPipelineInputsRecord = nullableOptional(
  z.record(z.string(), pipelineInputValueSchema)
);

const paginationShape = {
  page: optionalNumber,
  per_page: optionalNumber
} satisfies ToolSchemaShape;
const emojiNameSchema = z.string().min(1);
const awardEmojiIdSchema = z.string().min(1);

export function registerGitLabTools(server: McpServer, context: AppContext): void {
  const definitions = getGitLabToolDefinitions();
  const disableGraphqlTools = shouldDisableGraphqlTools(
    context.env.GITLAB_ALLOWED_PROJECT_IDS,
    context.env.GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE
  );
  const filtered = context.policy.filterTools(
    definitions.map((item) => ({
      name: item.name,
      capabilities: item.capabilities,
      requiresFeature: item.requiresFeature
    }))
  );
  const enabledNames = new Set(filtered.map((item) => item.name));

  for (const definition of definitions) {
    if (!enabledNames.has(definition.name)) {
      continue;
    }

    if (definition.requiresLocalFileTools && !context.allowLocalFileTools) {
      continue;
    }

    if (disableGraphqlTools && isGraphqlToolName(definition.name)) {
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
            capabilities: definition.capabilities,
            requiresFeature: definition.requiresFeature
          });

          if (definition.requiresAuth ?? true) {
            assertAuthReady(context);
          }

          const args = stripNullsDeep((rawArgs ?? {}) as ToolArgs);
          const result = await definition.handler(args, context);
          const formatted = context.formatter.format(result);
          const structuredResult = formatted.truncated
            ? { truncated: true }
            : toStructuredContent(result);

          return {
            content: [
              {
                type: "text",
                text: formatted.text
              }
            ],
            structuredContent: {
              result: structuredResult,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema
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
      capabilities: readCapabilities,
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
      capabilities: adminCapabilities,
      inputSchema: {
        name: displayNameSchema,
        description: optionalString,
        visibility: z.enum(["private", "internal", "public"]).optional(),
        initialize_with_readme: optionalBoolean,
        path: optionalString,
        namespace_id: optionalProjectIdSchema,
        default_branch: optionalRefLikeSchema
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
      name: "gitlab_create_group",
      title: "Create Group",
      description: "Create a new GitLab group or subgroup.",
      capabilities: adminCapabilities,
      inputSchema: {
        name: displayNameSchema,
        path: z.string().min(1),
        description: optionalString,
        visibility: z.enum(["private", "internal", "public"]).optional(),
        parent_id: optionalNumber
      },
      handler: async (args, context) =>
        context.gitlab.createGroup({
          name: getString(args, "name"),
          path: getString(args, "path"),
          description: getOptionalString(args, "description"),
          visibility: getOptionalString(args, "visibility") as
            | "private"
            | "internal"
            | "public"
            | undefined,
          parent_id: getOptionalNumber(args, "parent_id")
        })
    },
    {
      name: "gitlab_list_project_members",
      title: "List Project Members",
      description: "List members of a project.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
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
      capabilities: readCapabilities,
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
      capabilities: readCapabilities,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        search: z.string().min(1),
        ref: optionalRefLikeSchema,
        filename: optionalString,
        path: optionalString,
        extension: optionalString,
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
      name: "gitlab_search_code",
      title: "Search Code",
      description:
        "Search code across all projects on the GitLab instance. Requires GitLab code search support.",
      capabilities: readCapabilities,
      inputSchema: {
        search: z.string().min(1),
        filename: optionalString,
        path: optionalString,
        extension: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.searchCode(getString(args, "search"), {
          query: toQuery(omit(args, ["search"]))
        })
    },
    {
      name: "gitlab_search_project_code",
      title: "Search Project Code",
      description: "Search code in a specific project.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        search: z.string().min(1),
        ref: optionalRefLikeSchema,
        filename: optionalString,
        path: optionalString,
        extension: optionalString,
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
      name: "gitlab_search_group_code",
      title: "Search Group Code",
      description: "Search code in a specific group.",
      capabilities: readCapabilities,
      inputSchema: {
        group_id: projectIdSchema,
        search: z.string().min(1),
        filename: optionalString,
        path: optionalString,
        extension: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.searchGroupCodeBlobs(
          getString(args, "group_id"),
          getString(args, "search"),
          {
            query: toQuery(omit(args, ["group_id", "search"]))
          }
        )
    },
    {
      name: "gitlab_get_repository_tree",
      title: "Get Repository Tree",
      description: "List files and directories in a repository tree.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        path: optionalString,
        ref: optionalRefLikeSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        file_path: z.string().min(1),
        ref: optionalRefLikeSchema
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
      name: "gitlab_get_file_blame",
      title: "Get File Blame",
      description:
        "Get git blame for a repository file at a given ref. Optional line range must provide both range_start and range_end.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        file_path: z.string().min(1),
        ref: refLikeSchema,
        range_start: z.number().int().positive().optional(),
        range_end: z.number().int().positive().optional()
      },
      handler: async (args, context) => {
        const rangeStart = getOptionalNumber(args, "range_start");
        const rangeEnd = getOptionalNumber(args, "range_end");

        if ((rangeStart === undefined) !== (rangeEnd === undefined)) {
          throw new Error("range_start and range_end must be provided together");
        }
        if (rangeStart !== undefined && rangeEnd !== undefined && rangeStart > rangeEnd) {
          throw new Error("range_start must be less than or equal to range_end");
        }

        return context.gitlab.getFileBlame(
          resolveProjectId(args, context, true),
          getString(args, "file_path"),
          getString(args, "ref"),
          {
            query: toQuery({
              "range[start]": rangeStart,
              "range[end]": rangeEnd
            })
          }
        );
      }
    },
    {
      name: "gitlab_create_or_update_file",
      title: "Create Or Update File",
      description: "Create or update one file in repository.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        file_path: z.string().min(1),
        branch: refLikeSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        branch: refLikeSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        branch: refLikeSchema,
        ref: optionalRefLikeSchema
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
      name: "gitlab_list_branches",
      title: "List Branches",
      description: "List repository branches.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        search: optionalString,
        regex: optionalString,
        sort: z.enum(["name_asc", "updated_asc", "updated_desc"]).optional(),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listBranches(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_branch",
      title: "Get Branch",
      description: "Get details for one repository branch.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        branch: refLikeSchema
      },
      handler: async (args, context) =>
        context.gitlab.getBranch(resolveProjectId(args, context, true), getString(args, "branch"))
    },
    {
      name: "gitlab_delete_branch",
      title: "Delete Branch",
      description:
        "Delete a repository branch permanently. Requires branch. Recommended pre-check: gitlab_get_branch.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        branch: refLikeSchema
      },
      handler: async (args, context) =>
        context.gitlab.deleteBranch(
          resolveProjectId(args, context, true),
          getString(args, "branch")
        )
    },
    {
      name: "gitlab_get_branch_diffs",
      title: "Get Branch Diffs",
      description: "Compare two branches/refs and return diffs.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        from: refLikeSchema,
        to: refLikeSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        ref_name: optionalRefLikeSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      name: "gitlab_list_commit_statuses",
      title: "List Commit Statuses",
      description: "List statuses for a commit.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        sha: z.string().min(1),
        ref: optionalRefLikeSchema,
        stage: optionalString,
        name: optionalString,
        pipeline_id: optionalNumber,
        order_by: z.enum(["id", "pipeline_id"]).optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        all: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listCommitStatuses(
          resolveProjectId(args, context, true),
          getString(args, "sha"),
          { query: toQuery(omit(args, ["project_id", "sha"])) }
        )
    },
    {
      name: "gitlab_create_commit_status",
      title: "Create Commit Status",
      description: "Create or update the status of a commit.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        sha: z.string().min(1),
        state: z.enum(["pending", "running", "success", "failed", "canceled", "skipped"]),
        ref: optionalRefLikeSchema,
        name: optionalString,
        context: optionalString,
        target_url: optionalString,
        description: optionalString,
        coverage: optionalNumber,
        pipeline_id: optionalNumber
      },
      handler: async (args, context) => {
        if (getOptionalString(args, "name") && getOptionalString(args, "context")) {
          throw new Error("Use either name or context when creating a commit status, not both");
        }

        return context.gitlab.createCommitStatus(
          resolveProjectId(args, context, true),
          getString(args, "sha"),
          toQuery(omit(args, ["project_id", "sha"]))
        );
      }
    },
    {
      name: "gitlab_list_merge_requests",
      title: "List Merge Requests",
      description: "List merge requests for a project.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
        source_branch: optionalRefLikeSchema,
        target_branch: optionalRefLikeSchema,
        search: optionalString,
        wip: z.enum(["yes", "no"]).optional(),
        with_labels_details: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, false);
        const query = toQuery(cleanMergeRequestListArgs(omit(args, ["project_id"])));

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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: optionalString,
        source_branch: optionalRefLikeSchema
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
        const match = pickMergeRequestForSourceBranch(candidates, sourceBranch, {
          requireOpened: false
        });

        return match;
      }
    },
    {
      name: "gitlab_list_merge_request_pipelines",
      title: "List Merge Request Pipelines",
      description: "List pipelines associated with a merge request.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listMergeRequestPipelines(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          { query: toQuery(omit(args, ["project_id", "merge_request_iid"])) }
        )
    },
    {
      name: "gitlab_create_merge_request",
      title: "Create Merge Request",
      description: "Create a merge request.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        source_branch: refLikeSchema,
        target_branch: refLikeSchema,
        title: z.string().min(1),
        description: optionalString,
        target_project_id: optionalProjectIdSchema,
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
      capabilities: adminCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        namespace: optionalString,
        namespace_id: optionalProjectIdSchema,
        path: optionalString,
        name: optionalDisplayNameSchema,
        description: optionalString,
        visibility: z.enum(["private", "internal", "public"]).optional(),
        default_branch: optionalRefLikeSchema
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        source_branch: optionalRefLikeSchema,
        title: optionalString,
        description: optionalString,
        target_branch: optionalRefLikeSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: optionalString,
        source_branch: optionalRefLikeSchema,
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
          const match = pickMergeRequestForSourceBranch(candidates, sourceBranch, {
            requireOpened: true
          });
          const iid = getMergeRequestIid(match);
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      name: "gitlab_list_merge_request_changed_files",
      title: "List Merge Request Changed Files",
      description: "Step 1 for large MR review: return changed file metadata without diff content.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: optionalString,
        source_branch: optionalRefLikeSchema,
        excluded_file_patterns: optionalStringArray
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const mergeRequestIid = await resolveMergeRequestIid(args, context, projectId, {
          requireOpened: false
        });
        const response = await context.gitlab.getMergeRequestDiffs(projectId, mergeRequestIid);
        const files = extractMergeRequestChanges(response).map((item) => ({
          new_path: item.new_path,
          old_path: item.old_path,
          new_file: item.new_file,
          deleted_file: item.deleted_file,
          renamed_file: item.renamed_file
        }));

        return filterChangedFiles(files, getOptionalStringArray(args, "excluded_file_patterns"));
      }
    },
    {
      name: "gitlab_list_merge_request_diffs",
      title: "List Merge Request Diffs",
      description: "List detailed MR diffs (versions/changes view).",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      name: "gitlab_get_merge_request_file_diff",
      title: "Get Merge Request File Diff",
      description:
        "Step 2 for large MR review: fetch diffs for specific files from a merge request.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: optionalString,
        source_branch: optionalRefLikeSchema,
        file_paths: z.array(z.string().min(1)).min(1),
        unidiff: optionalBoolean
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const mergeRequestIid = await resolveMergeRequestIid(args, context, projectId, {
          requireOpened: false
        });
        const requested = getRequiredStringArray(args, "file_paths");
        const remaining = new Set(requested);
        const results: unknown[] = [];
        let page = 1;
        const perPage = 20;

        while (remaining.size > 0) {
          const pageItems = extractMergeRequestDiffRecords(
            await context.gitlab.listMergeRequestDiffs(projectId, mergeRequestIid, {
              query: toQuery({
                page,
                per_page: perPage,
                unidiff: getOptionalBoolean(args, "unidiff")
              })
            })
          );

          if (pageItems.length === 0) {
            break;
          }

          for (const item of pageItems) {
            const newPath = typeof item.new_path === "string" ? item.new_path : undefined;
            const oldPath = typeof item.old_path === "string" ? item.old_path : undefined;

            if ((newPath && remaining.has(newPath)) || (oldPath && remaining.has(oldPath))) {
              results.push(item);
              if (newPath) {
                remaining.delete(newPath);
              }
              if (oldPath) {
                remaining.delete(oldPath);
              }
            }
          }

          if (pageItems.length < perPage) {
            break;
          }
          page += 1;
        }

        for (const missing of remaining) {
          results.push({
            file_path: missing,
            error: `File not found in merge request diffs: ${missing}`,
            hint: "Use gitlab_list_merge_request_changed_files to verify the correct file paths."
          });
        }

        return results;
      }
    },
    {
      name: "gitlab_get_merge_request_code_context",
      title: "Get Merge Request Code Context",
      description:
        "High-signal MR code context with include/exclude filters, sorting, and token-budgeted output.",
      capabilities: readCapabilities,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getMergeRequestApprovalState(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid")
        )
    },
    {
      name: "gitlab_get_merge_request_conflicts",
      title: "Get Merge Request Conflicts",
      description: "Get conflict details for MR.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getMergeRequestConflicts(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid")
        )
    },
    {
      name: "gitlab_list_merge_request_discussions",
      title: "List Merge Request Discussions",
      description: "List MR discussions.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        body: bodySchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        discussion_id: z.string().min(1),
        body: bodySchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        discussion_id: z.string().min(1),
        note_id: z.string().min(1),
        body: optionalBodySchema,
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
      description:
        "Delete an MR discussion note permanently. Irreversible. Requires merge_request_iid, discussion_id, and note_id. Recommended pre-check: gitlab_list_merge_request_discussions.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        body: bodySchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        draft_note_id: z.string().min(1),
        body: optionalBodySchema,
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
      description:
        "Delete a merge-request draft note permanently. Irreversible. Requires merge_request_iid and draft_note_id. Recommended pre-check: gitlab_get_draft_note or gitlab_list_draft_notes.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        body: bodySchema
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        noteable_type: z.enum(["issue", "merge_request"]),
        noteable_iid: z.string().min(1),
        body: bodySchema
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        note_id: z.string().min(1),
        body: bodySchema
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
      description:
        "Delete a top-level MR note permanently. Irreversible. Requires merge_request_iid and note_id. Recommended pre-check: gitlab_get_merge_request_note or gitlab_list_merge_request_notes.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      name: "gitlab_list_merge_request_emoji_reactions",
      title: "List Merge Request Emoji Reactions",
      description: "List emoji reactions on a merge request.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listMergeRequestEmojiReactions(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          { query: toQuery(omit(args, ["project_id", "merge_request_iid"])) }
        )
    },
    {
      name: "gitlab_list_merge_request_note_emoji_reactions",
      title: "List MR Note Emoji Reactions",
      description:
        "List emoji reactions on a merge request note. Pass discussion_id for discussion replies.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        note_id: z.string().min(1),
        discussion_id: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listMergeRequestNoteEmojiReactions(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "note_id"),
          { discussion_id: getOptionalString(args, "discussion_id") },
          {
            query: toQuery(
              omit(args, ["project_id", "merge_request_iid", "note_id", "discussion_id"])
            )
          }
        )
    },
    {
      name: "gitlab_create_merge_request_emoji_reaction",
      title: "Create Merge Request Emoji Reaction",
      description:
        "Add an emoji reaction to a merge request, for example thumbsup, rocket, or eyes.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        name: emojiNameSchema
      },
      handler: async (args, context) =>
        context.gitlab.createMergeRequestEmojiReaction(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "name")
        )
    },
    {
      name: "gitlab_delete_merge_request_emoji_reaction",
      title: "Delete Merge Request Emoji Reaction",
      description:
        "Delete an emoji reaction from a merge request permanently. Irreversible for that reaction. Requires merge_request_iid and award_id. Recommended pre-check: gitlab_list_merge_request_emoji_reactions.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        award_id: awardEmojiIdSchema
      },
      handler: async (args, context) =>
        context.gitlab.deleteMergeRequestEmojiReaction(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "award_id")
        )
    },
    {
      name: "gitlab_create_merge_request_note_emoji_reaction",
      title: "Create MR Note Emoji Reaction",
      description:
        "Add an emoji reaction to a merge request note. Pass discussion_id for discussion replies.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        note_id: z.string().min(1),
        discussion_id: optionalString,
        name: emojiNameSchema
      },
      handler: async (args, context) =>
        context.gitlab.createMergeRequestNoteEmojiReaction(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "note_id"),
          {
            name: getString(args, "name"),
            discussion_id: getOptionalString(args, "discussion_id")
          }
        )
    },
    {
      name: "gitlab_delete_merge_request_note_emoji_reaction",
      title: "Delete MR Note Emoji Reaction",
      description:
        "Delete an emoji reaction from a merge request note permanently. Irreversible for that reaction. Requires merge_request_iid, note_id, and award_id. Recommended pre-check: gitlab_list_merge_request_note_emoji_reactions.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        merge_request_iid: z.string().min(1),
        note_id: z.string().min(1),
        discussion_id: optionalString,
        award_id: awardEmojiIdSchema
      },
      handler: async (args, context) =>
        context.gitlab.deleteMergeRequestNoteEmojiReaction(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "note_id"),
          {
            award_id: getString(args, "award_id"),
            discussion_id: getOptionalString(args, "discussion_id")
          }
        )
    },
    {
      name: "gitlab_list_issues",
      title: "List Issues",
      description: "List issues in project.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, false);
        return context.gitlab.myIssues({
          project_id: projectId || undefined,
          ...(toQuery(omit(args, ["project_id"])) as Record<string, string | number | boolean>)
        });
      }
    },
    {
      name: "gitlab_list_todos",
      title: "List Todos",
      description: "List to-do items for the current authenticated user.",
      capabilities: readCapabilities,
      inputSchema: {
        action: z
          .enum([
            "assigned",
            "mentioned",
            "build_failed",
            "marked",
            "approval_required",
            "unmergeable",
            "directly_addressed",
            "merge_train_removed",
            "member_access_requested"
          ])
          .optional(),
        author_id: optionalNumber,
        project_id: optionalNumber,
        group_id: optionalNumber,
        state: z.enum(["pending", "done"]).optional(),
        type: z
          .enum([
            "Issue",
            "MergeRequest",
            "Commit",
            "Epic",
            "DesignManagement::Design",
            "AlertManagement::Alert",
            "Project",
            "Namespace",
            "Vulnerability",
            "WikiPage::Meta"
          ])
          .optional(),
        ...paginationShape
      },
      handler: async (args, context) => context.gitlab.listTodos({ query: toQuery(args) })
    },
    {
      name: "gitlab_mark_todo_done",
      title: "Mark Todo Done",
      description: "Mark one to-do item as done.",
      capabilities: writeCapabilities,
      inputSchema: {
        todo_id: z.string().min(1)
      },
      handler: async (args, context) => context.gitlab.markTodoDone(getString(args, "todo_id"))
    },
    {
      name: "gitlab_mark_all_todos_done",
      title: "Mark All Todos Done",
      description: "Mark all pending to-do items as done for the current authenticated user.",
      capabilities: writeCapabilities,
      inputSchema: {},
      handler: async (_args, context) => {
        await context.gitlab.markAllTodosDone();
        return {
          status: "success",
          message: "All pending to-do items marked as done"
        };
      }
    },
    {
      name: "gitlab_get_issue",
      title: "Get Issue",
      description: "Get issue by IID.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getIssue(resolveProjectId(args, context, true), getString(args, "issue_iid"))
    },
    {
      name: "gitlab_create_issue",
      title: "Create Issue",
      description: "Create a new issue.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      name: "gitlab_update_issue_description_patch",
      title: "Update Issue Description Patch",
      description:
        "Apply a search/replace or unified diff patch to an issue description without sending the full replacement text.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        patch_type: z.enum(["search_replace", "unified_diff"]),
        patch: z.string().min(1).max(50_000),
        dry_run: optionalBoolean,
        create_note: optionalBoolean,
        allow_multiple: optionalBoolean
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const issueIid = getString(args, "issue_iid");
        const issue = (await context.gitlab.getIssue(projectId, issueIid)) as {
          description?: unknown;
        };
        const currentDescription = typeof issue.description === "string" ? issue.description : "";

        const patchType = getString(args, "patch_type");
        const patch = getString(args, "patch");
        let result;
        if (patchType === "search_replace") {
          const blocks = parseSearchReplaceBlocks(patch);
          if (blocks.length === 0) {
            throw new Error(
              "No valid search/replace blocks found. Expected format: <<<<<<< SEARCH\\ntext\\n=======\\nnew text\\n>>>>>>> REPLACE"
            );
          }
          result = applySearchReplace(
            currentDescription,
            blocks,
            getOptionalBoolean(args, "allow_multiple") ?? false
          );
        } else {
          result = applyUnifiedDiff(currentDescription, patch);
        }

        if (getOptionalBoolean(args, "dry_run")) {
          return {
            status: "preview",
            dry_run: true,
            changes: result.changes,
            summary: result.summary,
            preview: result.preview
          };
        }

        const updatedIssue = (await context.gitlab.updateIssue(projectId, issueIid, {
          description: result.description
        })) as Record<string, unknown>;

        let note: unknown;
        if (getOptionalBoolean(args, "create_note")) {
          try {
            await context.gitlab.createIssueNote(projectId, issueIid, {
              body: `Updated issue description using patch-based tool.\n\n${result.summary}`
            });
            note = { status: "created" };
          } catch (error) {
            note = {
              status: "failed",
              message: error instanceof Error ? error.message : String(error)
            };
          }
        }

        return {
          status: "success",
          changes: result.changes,
          summary: result.summary,
          note,
          issue: {
            iid: updatedIssue.iid,
            title: updatedIssue.title,
            web_url: updatedIssue.web_url,
            updated_at: updatedIssue.updated_at
          }
        };
      }
    },
    {
      name: "gitlab_delete_issue",
      title: "Delete Issue",
      description:
        "Delete an issue permanently. Irreversible. Requires issue_iid. Recommended pre-check: gitlab_get_issue.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        discussion_id: optionalString,
        body: bodySchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        discussion_id: z.string().min(1),
        note_id: z.string().min(1),
        body: optionalBodySchema,
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
      name: "gitlab_list_issue_emoji_reactions",
      title: "List Issue Emoji Reactions",
      description: "List emoji reactions on an issue.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listIssueEmojiReactions(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          { query: toQuery(omit(args, ["project_id", "issue_iid"])) }
        )
    },
    {
      name: "gitlab_list_issue_note_emoji_reactions",
      title: "List Issue Note Emoji Reactions",
      description:
        "List emoji reactions on an issue note. Pass discussion_id for discussion replies.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        note_id: z.string().min(1),
        discussion_id: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listIssueNoteEmojiReactions(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          getString(args, "note_id"),
          { discussion_id: getOptionalString(args, "discussion_id") },
          { query: toQuery(omit(args, ["project_id", "issue_iid", "note_id", "discussion_id"])) }
        )
    },
    {
      name: "gitlab_create_issue_emoji_reaction",
      title: "Create Issue Emoji Reaction",
      description: "Add an emoji reaction to an issue, for example thumbsup, rocket, or eyes.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        name: emojiNameSchema
      },
      handler: async (args, context) =>
        context.gitlab.createIssueEmojiReaction(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          getString(args, "name")
        )
    },
    {
      name: "gitlab_delete_issue_emoji_reaction",
      title: "Delete Issue Emoji Reaction",
      description:
        "Delete an emoji reaction from an issue permanently. Irreversible for that reaction. Requires issue_iid and award_id. Recommended pre-check: gitlab_list_issue_emoji_reactions.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        award_id: awardEmojiIdSchema
      },
      handler: async (args, context) =>
        context.gitlab.deleteIssueEmojiReaction(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          getString(args, "award_id")
        )
    },
    {
      name: "gitlab_create_issue_note_emoji_reaction",
      title: "Create Issue Note Emoji Reaction",
      description:
        "Add an emoji reaction to an issue note. Pass discussion_id for discussion replies.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        note_id: z.string().min(1),
        discussion_id: optionalString,
        name: emojiNameSchema
      },
      handler: async (args, context) =>
        context.gitlab.createIssueNoteEmojiReaction(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          getString(args, "note_id"),
          {
            name: getString(args, "name"),
            discussion_id: getOptionalString(args, "discussion_id")
          }
        )
    },
    {
      name: "gitlab_delete_issue_note_emoji_reaction",
      title: "Delete Issue Note Emoji Reaction",
      description:
        "Delete an emoji reaction from an issue note permanently. Irreversible for that reaction. Requires issue_iid, note_id, and award_id. Recommended pre-check: gitlab_list_issue_note_emoji_reactions.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        note_id: z.string().min(1),
        discussion_id: optionalString,
        award_id: awardEmojiIdSchema
      },
      handler: async (args, context) =>
        context.gitlab.deleteIssueNoteEmojiReaction(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          getString(args, "note_id"),
          {
            award_id: getString(args, "award_id"),
            discussion_id: getOptionalString(args, "discussion_id")
          }
        )
    },
    {
      name: "gitlab_list_issue_links",
      title: "List Issue Links",
      description: "List related issue links for an issue.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        issue_iid: z.string().min(1),
        target_project_id: projectIdSchema,
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
      description:
        "Delete an issue link permanently. Irreversible for that relation. Requires issue_iid and issue_link_id. Recommended pre-check: gitlab_get_issue_link or gitlab_list_issue_links.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        slug: slugSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        slug: slugSchema,
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
      description:
        "Delete a wiki page permanently. Irreversible. Requires slug. Recommended pre-check: gitlab_get_wiki_page or gitlab_list_wiki_pages.",
      capabilities: deleteCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        slug: slugSchema
      },
      handler: async (args, context) =>
        context.gitlab.deleteWikiPage(
          resolveProjectId(args, context, true),
          getString(args, "slug")
        )
    },
    {
      name: "gitlab_list_group_wiki_pages",
      title: "List Group Wiki Pages",
      description: "List wiki pages in a group.",
      capabilities: readCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        group_id: projectIdSchema,
        with_content: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listGroupWikiPages(getString(args, "group_id"), {
          query: toQuery(omit(args, ["group_id"]))
        })
    },
    {
      name: "gitlab_get_group_wiki_page",
      title: "Get Group Wiki Page",
      description: "Get group wiki page by slug.",
      capabilities: readCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        group_id: projectIdSchema,
        slug: slugSchema,
        version: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.getGroupWikiPage(getString(args, "group_id"), getString(args, "slug"), {
          query: toQuery(omit(args, ["group_id", "slug"]))
        })
    },
    {
      name: "gitlab_create_group_wiki_page",
      title: "Create Group Wiki Page",
      description: "Create a group wiki page.",
      capabilities: writeCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        group_id: projectIdSchema,
        title: z.string().min(1),
        content: z.string().min(1),
        format: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.createGroupWikiPage(getString(args, "group_id"), {
          title: getString(args, "title"),
          content: getString(args, "content"),
          format: getOptionalString(args, "format")
        })
    },
    {
      name: "gitlab_update_group_wiki_page",
      title: "Update Group Wiki Page",
      description: "Update group wiki page by slug.",
      capabilities: writeCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        group_id: projectIdSchema,
        slug: slugSchema,
        title: optionalString,
        content: optionalString,
        format: optionalString
      },
      handler: async (args, context) => {
        const payload = toQuery(omit(args, ["group_id", "slug"]));
        if (Object.keys(payload).length === 0) {
          throw new Error("At least one of title, content, or format must be provided");
        }
        return context.gitlab.updateGroupWikiPage(
          getString(args, "group_id"),
          getString(args, "slug"),
          payload
        );
      }
    },
    {
      name: "gitlab_delete_group_wiki_page",
      title: "Delete Group Wiki Page",
      description:
        "Delete a group wiki page permanently. Irreversible. Requires group_id and slug. Recommended pre-check: gitlab_get_group_wiki_page or gitlab_list_group_wiki_pages.",
      capabilities: deleteCapabilities,
      requiresFeature: "wiki",
      inputSchema: {
        group_id: projectIdSchema,
        slug: slugSchema
      },
      handler: async (args, context) =>
        context.gitlab.deleteGroupWikiPage(getString(args, "group_id"), getString(args, "slug"))
    },
    {
      name: "gitlab_list_pipelines",
      title: "List Pipelines",
      description: "List pipelines for a project.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
        ref: optionalRefLikeSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        pipeline_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getPipeline(
          resolveProjectId(args, context, true),
          getString(args, "pipeline_id")
        )
    },
    {
      name: "gitlab_list_deployments",
      title: "List Deployments",
      description: "List deployments in a project.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        environment: optionalString,
        ref: optionalRefLikeSchema,
        sha: optionalString,
        status: optionalString,
        updated_after: optionalString,
        updated_before: optionalString,
        order_by: z
          .enum(["id", "iid", "created_at", "updated_at", "ref", "status", "environment"])
          .optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listDeployments(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_deployment",
      title: "Get Deployment",
      description: "Get one deployment by ID.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        deployment_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getDeployment(
          resolveProjectId(args, context, true),
          getString(args, "deployment_id")
        )
    },
    {
      name: "gitlab_list_environments",
      title: "List Environments",
      description: "List environments in a project.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        name: optionalDisplayNameSchema,
        search: optionalString,
        states: z.enum(["available", "stopped"]).optional(),
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listEnvironments(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_environment",
      title: "Get Environment",
      description: "Get one environment by ID.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        environment_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getEnvironment(
          resolveProjectId(args, context, true),
          getString(args, "environment_id")
        )
    },
    {
      name: "gitlab_list_pipeline_jobs",
      title: "List Pipeline Jobs",
      description: "List jobs in a pipeline.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        job_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getPipelineJobOutput(
          resolveProjectId(args, context, true),
          getString(args, "job_id")
        )
    },
    {
      name: "gitlab_validate_ci_lint",
      title: "Validate CI Lint",
      description: "Validate provided GitLab CI/CD YAML content for a project.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        content: z.string().min(1),
        dry_run: optionalBoolean,
        include_jobs: optionalBoolean,
        ref: optionalRefLikeSchema
      },
      handler: async (args, context) =>
        context.gitlab.validateCiLint(
          resolveProjectId(args, context, true),
          toQuery(omit(args, ["project_id"]))
        )
    },
    {
      name: "gitlab_validate_project_ci_lint",
      title: "Validate Project CI Lint",
      description: "Validate an existing project CI/CD configuration.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        content_ref: optionalRefLikeSchema,
        dry_run: optionalBoolean,
        dry_run_ref: optionalRefLikeSchema,
        include_jobs: optionalBoolean
      },
      handler: async (args, context) =>
        context.gitlab.validateProjectCiLint(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_list_job_artifacts",
      title: "List Job Artifacts",
      description: "List files and directories inside a job artifacts archive.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        job_id: z.string().min(1),
        path: optionalString,
        recursive: optionalBoolean
      },
      handler: async (args, context) =>
        context.gitlab.listJobArtifacts(
          resolveProjectId(args, context, true),
          getString(args, "job_id"),
          { query: toQuery(omit(args, ["project_id", "job_id"])) }
        )
    },
    {
      name: "gitlab_download_job_artifacts",
      title: "Download Job Artifacts",
      description: "Download the full job artifacts archive as base64 content.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        job_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.downloadJobArtifacts(
          resolveProjectId(args, context, true),
          getString(args, "job_id")
        )
    },
    {
      name: "gitlab_download_job_artifacts_local",
      title: "Download Job Artifacts Local",
      description: "Download the full job artifacts archive to a local directory.",
      capabilities: writeCapabilities,
      requiresFeature: "pipeline",
      requiresLocalFileTools: true,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        job_id: z.string().min(1),
        local_path: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.saveJobArtifacts(
          resolveProjectId(args, context, true),
          getString(args, "job_id"),
          getOptionalString(args, "local_path")
        )
    },
    {
      name: "gitlab_get_job_artifact_file",
      title: "Get Job Artifact File",
      description:
        "Return one file from a job artifacts archive as inline UTF-8 or base64 content.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        job_id: z.string().min(1),
        artifact_path: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getJobArtifactFile(
          resolveProjectId(args, context, true),
          getString(args, "job_id"),
          getString(args, "artifact_path")
        )
    },
    {
      name: "gitlab_get_job_artifact_file_local",
      title: "Get Job Artifact File Local",
      description: "Save one file from a job artifacts archive to a local directory.",
      capabilities: writeCapabilities,
      requiresFeature: "pipeline",
      requiresLocalFileTools: true,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        job_id: z.string().min(1),
        artifact_path: z.string().min(1),
        local_path: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.saveJobArtifactFile(
          resolveProjectId(args, context, true),
          getString(args, "job_id"),
          getString(args, "artifact_path"),
          getOptionalString(args, "local_path")
        )
    },
    {
      name: "gitlab_create_pipeline",
      title: "Create Pipeline",
      description: "Trigger a new pipeline.",
      capabilities: writeCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        ref: refLikeSchema,
        inputs: optionalPipelineInputsRecord,
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
          inputs: getOptionalPipelineInputsRecord(args, "inputs"),
          variables: getOptionalArray(args, "variables") as
            | Array<{
                key: string;
                value: string;
                variable_type?: "env_var" | "file";
              }>
            | undefined
        })
    },
    {
      name: "gitlab_retry_pipeline",
      title: "Retry Pipeline",
      description: "Retry failed jobs in pipeline.",
      capabilities: writeCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      description:
        "Delete a milestone permanently. Irreversible. Requires milestone_id. Recommended pre-check: gitlab_get_milestone or gitlab_list_milestones.",
      capabilities: deleteCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: adminCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "milestone",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "release",
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      requiresFeature: "release",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        tag_name: refLikeSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "release",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        name: optionalDisplayNameSchema,
        tag_name: refLikeSchema,
        tag_message: optionalString,
        description: optionalString,
        ref: optionalRefLikeSchema,
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
      capabilities: writeCapabilities,
      requiresFeature: "release",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        tag_name: refLikeSchema,
        name: optionalDisplayNameSchema,
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
      description:
        "Delete the release record for tag_name permanently. Irreversible for the release entry. Requires tag_name. Recommended pre-check: gitlab_get_release or gitlab_list_releases.",
      capabilities: deleteCapabilities,
      requiresFeature: "release",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        tag_name: refLikeSchema
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
      capabilities: writeCapabilities,
      requiresFeature: "release",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        tag_name: refLikeSchema
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
      capabilities: readCapabilities,
      requiresFeature: "release",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        tag_name: refLikeSchema,
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
      name: "gitlab_list_tags",
      title: "List Tags",
      description: "List repository tags for a project.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        order_by: z.enum(["name", "updated", "version"]).optional(),
        sort: z.enum(["asc", "desc"]).optional(),
        search: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listTags(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_tag",
      title: "Get Tag",
      description: "Get a repository tag by name.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        tag_name: refLikeSchema
      },
      handler: async (args, context) =>
        context.gitlab.getTag(resolveProjectId(args, context, true), getString(args, "tag_name"))
    },
    {
      name: "gitlab_create_tag",
      title: "Create Tag",
      description: "Create a repository tag from a branch, commit SHA, or another tag.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        tag_name: refLikeSchema,
        ref: refLikeSchema,
        message: optionalString
      },
      handler: async (args, context) =>
        context.gitlab.createTag(
          resolveProjectId(args, context, true),
          toQuery(omit(args, ["project_id"]))
        )
    },
    {
      name: "gitlab_delete_tag",
      title: "Delete Tag",
      description:
        "Delete a repository tag permanently. Irreversible for tag_name. Requires tag_name. Recommended pre-check: gitlab_get_tag or gitlab_list_tags.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        tag_name: refLikeSchema
      },
      handler: async (args, context) =>
        context.gitlab.deleteTag(resolveProjectId(args, context, true), getString(args, "tag_name"))
    },
    {
      name: "gitlab_get_tag_signature",
      title: "Get Tag Signature",
      description: "Get the X.509 signature for a signed repository tag.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        tag_name: refLikeSchema
      },
      handler: async (args, context) =>
        context.gitlab.getTagSignature(
          resolveProjectId(args, context, true),
          getString(args, "tag_name")
        )
    },
    {
      name: "gitlab_list_labels",
      title: "List Labels",
      description: "List project labels.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        label_id: displayNameSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        name: displayNameSchema,
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
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        name: optionalDisplayNameSchema,
        label_id: optionalDisplayNameSchema,
        new_name: optionalDisplayNameSchema,
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
      description:
        "Delete a label permanently. Irreversible. Requires name or label_id. Recommended pre-check: gitlab_get_label or gitlab_list_labels.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        name: optionalDisplayNameSchema,
        label_id: optionalDisplayNameSchema
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
      capabilities: readCapabilities,
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
      capabilities: readCapabilities,
      inputSchema: {
        namespace_id_or_path: optionalProjectIdSchema,
        namespace_id: optionalProjectIdSchema
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
      capabilities: readCapabilities,
      inputSchema: {
        path: z.string().min(1)
      },
      handler: async (args, context) => context.gitlab.verifyNamespace(getString(args, "path"))
    },
    {
      name: "gitlab_get_users",
      title: "Get Users",
      description: "Search users.",
      capabilities: readCapabilities,
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
      name: "gitlab_get_user",
      title: "Get User",
      description: "Get one user by ID.",
      capabilities: readCapabilities,
      inputSchema: {
        user_id: z.string().min(1)
      },
      handler: async (args, context) => context.gitlab.getUser(getString(args, "user_id"))
    },
    {
      name: "gitlab_whoami",
      title: "Who Am I",
      description: "Get the current authenticated user.",
      capabilities: readCapabilities,
      inputSchema: {},
      handler: async (_args, context) => context.gitlab.whoami()
    },
    {
      name: "gitlab_list_events",
      title: "List Events",
      description: "List current user events.",
      capabilities: readCapabilities,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      name: "gitlab_list_webhooks",
      title: "List Webhooks",
      description: "List configured webhooks for a project or group.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        group_id: optionalProjectIdSchema,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listWebhooks(resolveWebhookScope(args), {
          query: toQuery(omit(args, ["project_id", "group_id"]))
        })
    },
    {
      name: "gitlab_list_webhook_events",
      title: "List Webhook Events",
      description:
        "List recent webhook events for a project or group webhook. Use summary mode for overviews.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        group_id: optionalProjectIdSchema,
        hook_id: z.union([z.string(), z.number()]),
        status: optionalStringOrNumber,
        summary: optionalBoolean,
        page: optionalNumber,
        per_page: z.number().int().min(1).max(20).optional()
      },
      handler: async (args, context) => {
        const events = extractRecords(
          await context.gitlab.listWebhookEvents(
            resolveWebhookScope(args),
            getIdString(args, "hook_id"),
            {
              query: toQuery({
                status: args.status,
                page: args.page,
                per_page: args.per_page ?? 20
              })
            }
          )
        );
        return getOptionalBoolean(args, "summary") ? summarizeWebhookEvents(events) : events;
      }
    },
    {
      name: "gitlab_get_webhook_event",
      title: "Get Webhook Event",
      description:
        "Find one webhook event by ID. Provide page when known, otherwise scans up to 500 recent events.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        group_id: optionalProjectIdSchema,
        hook_id: z.union([z.string(), z.number()]),
        event_id: z.union([z.string(), z.number()]),
        page: optionalNumber
      },
      handler: async (args, context) => {
        const event = await findWebhookEvent(
          context,
          resolveWebhookScope(args),
          getIdString(args, "hook_id"),
          getIdString(args, "event_id"),
          getOptionalNumber(args, "page")
        );

        if (event) {
          return event;
        }

        return {
          error: `Webhook event ${getIdString(args, "event_id")} not found ${
            getOptionalNumber(args, "page")
              ? `on page ${getOptionalNumber(args, "page")}`
              : "in the 500 most recent events"
          }`
        };
      }
    },
    {
      name: "gitlab_upload_markdown",
      title: "Upload Markdown",
      description: "Upload markdown file/attachment to project.",
      capabilities: writeCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
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
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        url_or_path: optionalUrlOrPathSchema,
        secret: optionalString,
        filename: optionalString
      },
      handler: async (args, context) => {
        const urlOrPath = getOptionalString(args, "url_or_path");
        if (urlOrPath) {
          const projectId = resolveProjectId(args, context, false);
          const upload = parseProjectUploadReference(urlOrPath);

          if (context.env.GITLAB_ALLOWED_PROJECT_IDS.length > 0) {
            if (!projectId) {
              throw new Error(
                "project_id is required when GITLAB_ALLOWED_PROJECT_IDS is configured"
              );
            }

            if (!upload) {
              throw new Error(
                "In project-scoped mode, url_or_path must be a GitLab upload URL/path like '/uploads/<secret>/<filename>'"
              );
            }

            const apiRelativePath = `api/v4/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(upload.secret)}/${encodeURIComponent(upload.filename)}`;
            return context.gitlab.downloadAttachment(apiRelativePath);
          }

          if (projectId && upload) {
            const apiRelativePath = `api/v4/projects/${encodeURIComponent(projectId)}/uploads/${encodeURIComponent(upload.secret)}/${encodeURIComponent(upload.filename)}`;
            return context.gitlab.downloadAttachment(apiRelativePath);
          }

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
      capabilities: readGraphqlCapabilities,
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
      capabilities: writeGraphqlCapabilities,
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
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        query: z.string().min(1),
        variables: optionalRecord
      },
      handler: async (args, context) => {
        const query = getString(args, "query");
        if (containsGraphqlMutation(query)) {
          context.policy.assertCanExecute({
            name: "gitlab_execute_graphql",
            capabilities: writeGraphqlCapabilities
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
    Boolean(context.env.GITLAB_JOB_TOKEN) ||
    Boolean(context.env.GITLAB_USE_OAUTH && context.env.GITLAB_OAUTH_CLIENT_ID) ||
    Boolean(context.env.GITLAB_TOKEN_SCRIPT) ||
    Boolean(context.env.GITLAB_TOKEN_FILE) ||
    Boolean(context.env.GITLAB_AUTH_COOKIE_PATH);

  if (!hasFallbackAuth) {
    throw new Error(
      "Authentication required: set GITLAB_PERSONAL_ACCESS_TOKEN, GITLAB_JOB_TOKEN, GITLAB_TOKEN_SCRIPT, GITLAB_TOKEN_FILE, or GITLAB_AUTH_COOKIE_PATH"
    );
  }
}

export function containsGraphqlMutation(query: string): boolean {
  if (!query.trim()) {
    return false;
  }

  try {
    const document = parse(query, { noLocation: true });
    return document.definitions.some(
      (definition) =>
        definition.kind === Kind.OPERATION_DEFINITION && definition.operation === "mutation"
    );
  } catch {
    // Keep a conservative fallback for malformed GraphQL payloads.
    const normalized = query
      .replace(/#[^\n]*/g, " ")
      .replace(/"""[\s\S]*?"""/g, " ")
      .replace(/"(?:\\.|[^"\\])*"/g, " ");

    return /\bmutation\b\s*(?:[A-Za-z_][A-Za-z0-9_]*)?\s*(?:\([^)]*\))?\s*(?:@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?\s*)*\{/i.test(
      normalized
    );
  }
}

export function parseProjectUploadReference(
  input: string
): { secret: string; filename: string } | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  let pathValue = trimmed;

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      pathValue = new URL(trimmed).pathname;
    } catch {
      return undefined;
    }
  }

  const [pathOnly] = pathValue.split(/[?#]/, 1);
  if (!pathOnly) {
    return undefined;
  }

  const marker = "/uploads/";
  const markerIndex = pathOnly.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const suffix = pathOnly.slice(markerIndex + marker.length);
  const [secret, ...filenameParts] = suffix.split("/").filter((segment) => segment.length > 0);

  if (!secret || filenameParts.length === 0) {
    return undefined;
  }

  let filename: string;

  try {
    filename = decodeURIComponent(filenameParts.join("/"));
  } catch {
    return undefined;
  }

  if (!filename) {
    return undefined;
  }

  return { secret, filename };
}

export function shouldDisableGraphqlTools(
  allowedProjectIds: string[],
  allowGraphqlWithProjectScope: boolean
): boolean {
  return allowedProjectIds.length > 0 && !allowGraphqlWithProjectScope;
}

function isGraphqlToolName(name: string): boolean {
  return (
    name === "gitlab_execute_graphql_query" ||
    name === "gitlab_execute_graphql_mutation" ||
    name === "gitlab_execute_graphql"
  );
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
          text: formatPayloadText(payload, context)
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

function formatPayloadText(payload: unknown, context?: AppContext): string {
  if (!context) {
    return JSON.stringify(payload, null, 2);
  }

  return context.formatter.format(payload).text;
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

async function resolveMergeRequestIid(
  args: ToolArgs,
  context: AppContext,
  projectId: string,
  options: { requireOpened: boolean }
): Promise<string> {
  const mergeRequestIid = getOptionalString(args, "merge_request_iid");
  if (mergeRequestIid) {
    return mergeRequestIid;
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
  const match = pickMergeRequestForSourceBranch(candidates, sourceBranch, options);
  return getMergeRequestIid(match);
}

function extractMergeRequestChanges(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || !("changes" in value)) {
    return [];
  }

  const changes = (value as { changes?: unknown }).changes;
  return extractMergeRequestDiffRecords(changes);
}

function extractMergeRequestDiffRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null
  );
}

function filterChangedFiles(
  files: Array<Record<string, unknown>>,
  patterns: string[] | undefined
): Array<Record<string, unknown>> {
  if (!patterns || patterns.length === 0) {
    return files;
  }

  const regexes = patterns.map((pattern) => new RegExp(pattern));
  return files.filter((file) => {
    const paths = [file.new_path, file.old_path].filter(
      (value): value is string => typeof value === "string"
    );
    return !regexes.some((regex) => paths.some((filePath) => regex.test(filePath)));
  });
}

function resolveWebhookScope(args: ToolArgs): { projectId?: string; groupId?: string } {
  const projectId = getOptionalString(args, "project_id");
  const groupId = getOptionalString(args, "group_id");

  if ((projectId ? 1 : 0) + (groupId ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of project_id or group_id");
  }

  return projectId ? { projectId } : { groupId };
}

function summarizeWebhookEvents(
  events: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return events.map((event) => ({
    id: event.id,
    url: event.url,
    trigger: event.trigger,
    response_status: event.response_status,
    execution_duration: event.execution_duration
  }));
}

async function findWebhookEvent(
  context: AppContext,
  scope: { projectId?: string; groupId?: string },
  hookId: string,
  eventId: string,
  page?: number
): Promise<Record<string, unknown> | undefined> {
  const perPage = 20;
  const pages = page ? [page] : Array.from({ length: 25 }, (_value, index) => index + 1);

  for (const currentPage of pages) {
    const events = extractRecords(
      await context.gitlab.listWebhookEvents(scope, hookId, {
        query: { page: currentPage, per_page: perPage }
      })
    );
    const match = events.find((event) => String(event.id) === eventId);
    if (match) {
      return match;
    }
    if (events.length < perPage) {
      break;
    }
  }

  return undefined;
}

function extractRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null
  );
}

function pickMergeRequestForSourceBranch(
  value: unknown,
  sourceBranch: string,
  options: { requireOpened: boolean }
): Record<string, unknown> {
  const matches = extractMergeRequestRecords(value).filter((item) => {
    const candidateBranch = item.source_branch;
    return typeof candidateBranch === "string" && candidateBranch === sourceBranch;
  });

  const opened = matches.filter((item) => item.state === "opened");

  if (options.requireOpened) {
    if (opened.length === 1) {
      return requireArrayValue(
        opened,
        0,
        `No opened merge request found for source_branch='${sourceBranch}'`
      );
    }

    if (opened.length > 1) {
      throw new Error(
        `Multiple opened merge requests found for source_branch='${sourceBranch}'. Please specify merge_request_iid.`
      );
    }

    if (matches.length === 0) {
      throw new Error(`No merge request found for source_branch='${sourceBranch}'`);
    }

    throw new Error(`No opened merge request found for source_branch='${sourceBranch}'`);
  }

  if (opened.length === 1) {
    return requireArrayValue(
      opened,
      0,
      `No merge request found for source_branch='${sourceBranch}'`
    );
  }

  if (opened.length > 1) {
    throw new Error(
      `Multiple opened merge requests found for source_branch='${sourceBranch}'. Please specify merge_request_iid.`
    );
  }

  if (matches.length === 1) {
    return requireArrayValue(
      matches,
      0,
      `No merge request found for source_branch='${sourceBranch}'`
    );
  }

  if (matches.length === 0) {
    throw new Error(`No merge request found for source_branch='${sourceBranch}'`);
  }

  throw new Error(
    `Multiple merge requests found for source_branch='${sourceBranch}'. Please specify merge_request_iid.`
  );
}

function extractMergeRequestRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null
  );
}

function getMergeRequestIid(mergeRequest: Record<string, unknown>): string {
  const iid = mergeRequest.iid;
  if (typeof iid === "number" || typeof iid === "string") {
    return String(iid);
  }

  throw new Error("Matched merge request is missing a valid iid");
}

function getString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`'${key}' must be a non-empty string`);
  }

  return value;
}

function getIdString(args: ToolArgs, key: string): string {
  const value = args[key];
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0) {
    throw new Error(`'${key}' must be a non-empty string or number`);
  }

  return String(value);
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

function getRequiredStringArray(args: ToolArgs, key: string): string[] {
  const value = getOptionalStringArray(args, key);
  if (!value || value.length === 0) {
    throw new Error(`'${key}' must be a non-empty string array`);
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

function getOptionalArray(args: ToolArgs, key: string): unknown[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }

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

function getOptionalPipelineInputsRecord(
  args: ToolArgs,
  key: string
): Record<string, GitLabPipelineInputValue> | undefined {
  const value = getOptionalRecord(args, key);
  if (!value) {
    return undefined;
  }

  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (!pipelineInputValueSchema.safeParse(entryValue).success) {
      throw new Error(
        `'${key}.${entryKey}' must be a string, number, boolean, or array of primitive values`
      );
    }
  }

  return value as Record<string, GitLabPipelineInputValue>;
}

function cleanMergeRequestListArgs(args: ToolArgs): ToolArgs {
  const cleanedArgs = { ...args };

  if (hasValue(cleanedArgs.author_username)) {
    delete cleanedArgs.author_id;
  }

  if (hasValue(cleanedArgs.assignee_username)) {
    delete cleanedArgs.assignee_id;
  }

  if (hasValue(cleanedArgs.reviewer_username)) {
    delete cleanedArgs.reviewer_id;
  }

  return cleanedArgs;
}

function hasValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.length > 0;
  }

  return value !== undefined && value !== null;
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
