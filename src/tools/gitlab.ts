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
          return toToolError(error);
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
        membership: optionalBoolean,
        owned: optionalBoolean,
        simple: optionalBoolean,
        archived: optionalBoolean,
        ...paginationShape
      },
      handler: async (args, context) => context.gitlab.listProjects({ query: toQuery(args) })
    },
    {
      name: "gitlab_list_project_members",
      title: "List Project Members",
      description: "List members of a project.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        query: optionalString,
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
        ...paginationShape
      },
      handler: async (args, context) => {
        return context.gitlab.listGroupProjects(getString(args, "group_id"), {
          query: toQuery(omit(args, ["group_id"]))
        });
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
        ref: z.string().default("main")
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.getFileContents(
          projectId,
          getString(args, "file_path"),
          getString(args, "ref")
        );
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
        author_email: optionalString,
        author_name: optionalString,
        encoding: optionalString,
        execute_filemode: optionalBoolean,
        start_branch: optionalString,
        last_commit_id: optionalString
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
          last_commit_id: getOptionalString(args, "last_commit_id")
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
        actions: z.array(
          z.object({
            action: z.enum(["create", "delete", "move", "update", "chmod"]),
            file_path: z.string(),
            previous_path: optionalString,
            content: optionalString,
            encoding: optionalString,
            execute_filemode: optionalBoolean,
            last_commit_id: optionalString
          })
        ),
        start_branch: optionalString,
        author_name: optionalString,
        author_email: optionalString,
        force: optionalBoolean
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.pushFiles(projectId, {
          branch: getString(args, "branch"),
          commit_message: getString(args, "commit_message"),
          actions: getArray(args, "actions") as PushFileAction[],
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
        ref: z.string().min(1)
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.createBranch(projectId, {
          branch: getString(args, "branch"),
          ref: getString(args, "ref")
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
        straight: optionalBoolean
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.getBranchDiffs(projectId, {
          from: getString(args, "from"),
          to: getString(args, "to"),
          straight: getOptionalBoolean(args, "straight")
        });
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
        sha: z.string().min(1)
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.getCommit(projectId, getString(args, "sha"));
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
        state: optionalString,
        scope: optionalString,
        source_branch: optionalString,
        target_branch: optionalString,
        search: optionalString,
        ...paginationShape
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.listMergeRequests(projectId, {
          query: toQuery(omit(args, ["project_id"]))
        });
      }
    },
    {
      name: "gitlab_get_merge_request",
      title: "Get Merge Request",
      description: "Get one merge request.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1)
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.getMergeRequest(projectId, getString(args, "merge_request_iid"));
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
          remove_source_branch: getOptionalBoolean(args, "remove_source_branch"),
          squash: getOptionalBoolean(args, "squash"),
          draft: getOptionalBoolean(args, "draft")
        });
      }
    },
    {
      name: "gitlab_update_merge_request",
      title: "Update Merge Request",
      description: "Update merge request fields.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        title: optionalString,
        description: optionalString,
        target_branch: optionalString,
        state_event: optionalString,
        squash: optionalBoolean,
        remove_source_branch: optionalBoolean,
        reviewers: optionalStringArray
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const payload = toQuery(omit(args, ["project_id", "merge_request_iid"]));
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
        merge_request_iid: z.string().min(1),
        merge_commit_message: optionalString,
        squash_commit_message: optionalString,
        should_remove_source_branch: optionalBoolean,
        squash: optionalBoolean,
        sha: optionalString
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return context.gitlab.mergeMergeRequest(
          projectId,
          getString(args, "merge_request_iid"),
          toQuery(omit(args, ["project_id", "merge_request_iid"]))
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
        merge_request_iid: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getMergeRequestDiffs(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid")
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
        version_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getMergeRequestVersion(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "version_id")
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
        sha: optionalString
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
      name: "gitlab_create_merge_request_discussion_note",
      title: "Create MR Discussion Note",
      description: "Add note to existing MR discussion thread.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        merge_request_iid: z.string().min(1),
        discussion_id: z.string().min(1),
        body: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.createMergeRequestDiscussionNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "discussion_id"),
          { body: getString(args, "body") }
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
        return context.gitlab.updateMergeRequestDiscussionNote(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          getString(args, "discussion_id"),
          getString(args, "note_id"),
          {
            body: getOptionalString(args, "body") ?? "",
            resolved: getOptionalBoolean(args, "resolved")
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
        state: optionalString,
        labels: optionalString,
        search: optionalString,
        assignee_id: optionalNumber,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listIssues(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
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
        labels: optionalString,
        milestone_id: optionalNumber,
        due_date: optionalString,
        confidential: optionalBoolean,
        issue_type: optionalString,
        assignee_ids: z.array(z.number()).optional()
      },
      handler: async (args, context) =>
        context.gitlab.createIssue(resolveProjectId(args, context, true), {
          title: getString(args, "title"),
          description: getOptionalString(args, "description"),
          labels: getOptionalString(args, "labels"),
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
        labels: optionalString,
        milestone_id: optionalNumber,
        due_date: optionalString,
        confidential: optionalBoolean,
        assignee_ids: z.array(z.number()).optional()
      },
      handler: async (args, context) =>
        context.gitlab.updateIssue(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          toQuery(omit(args, ["project_id", "issue_iid"]))
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
      description: "Create issue comment.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        issue_iid: z.string().min(1),
        body: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.createIssueNote(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          getString(args, "body")
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
        scope: optionalString,
        status: optionalString,
        ref: optionalString,
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
        scope: optionalString,
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
        state: optionalString,
        search: optionalString,
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
      name: "gitlab_list_releases",
      title: "List Releases",
      description: "List project releases.",
      mutating: false,
      requiresFeature: "release",
      inputSchema: {
        project_id: z.string().optional(),
        order_by: optionalString,
        sort: optionalString,
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
        tag_name: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getRelease(
          resolveProjectId(args, context, true),
          getString(args, "tag_name")
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
        name: z.string().min(1),
        tag_name: z.string().min(1),
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
      name: "gitlab_list_labels",
      title: "List Labels",
      description: "List project labels.",
      mutating: false,
      inputSchema: {
        project_id: z.string().optional(),
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
        label_id: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getLabel(resolveProjectId(args, context, true), getString(args, "label_id"))
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
        name: z.string().min(1),
        new_name: optionalString,
        color: optionalString,
        description: optionalString,
        priority: optionalNumber
      },
      handler: async (args, context) =>
        context.gitlab.updateLabel(
          resolveProjectId(args, context, true),
          toQuery(omit(args, ["project_id"]))
        )
    },
    {
      name: "gitlab_delete_label",
      title: "Delete Label",
      description: "Delete a label by name.",
      mutating: true,
      inputSchema: {
        project_id: z.string().optional(),
        name: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.deleteLabel(resolveProjectId(args, context, true), getString(args, "name"))
    },
    {
      name: "gitlab_list_namespaces",
      title: "List Namespaces",
      description: "List namespaces visible to user.",
      mutating: false,
      inputSchema: {
        search: optionalString,
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
        namespace_id_or_path: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.getNamespace(getString(args, "namespace_id_or_path"))
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
        content: z.string().min(1),
        filename: z.string().default("upload.md")
      },
      handler: async (args, context) =>
        context.gitlab.uploadMarkdown(
          resolveProjectId(args, context, true),
          getString(args, "content"),
          getString(args, "filename")
        )
    },
    {
      name: "gitlab_download_attachment",
      title: "Download Attachment",
      description: "Download attachment by URL/path and return base64.",
      mutating: false,
      inputSchema: {
        url_or_path: z.string().min(1)
      },
      handler: async (args, context) =>
        context.gitlab.downloadAttachment(getString(args, "url_or_path"))
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

  if (!context.env.GITLAB_PERSONAL_ACCESS_TOKEN) {
    throw new Error("GITLAB_PERSONAL_ACCESS_TOKEN is required");
  }
}

export function containsGraphqlMutation(query: string): boolean {
  const stripped = query
    .replace(/#[^\n]*/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  if (!stripped) {
    return false;
  }

  if (stripped.startsWith("mutation ")) {
    return true;
  }

  if (stripped.startsWith("mutation{")) {
    return true;
  }

  return /^\w+\s+mutation\b/.test(stripped);
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

function toToolError(error: unknown): CallToolResult {
  if (error instanceof GitLabApiError) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: `GitLab API error ${error.status}`,
              details: error.details
            },
            null,
            2
          )
        }
      ]
    };
  }

  if (error instanceof Error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error.message
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
