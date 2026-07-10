import { Buffer } from "node:buffer";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  Kind,
  parse,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode
} from "graphql";
import { z } from "zod";

import {
  GitLabApiError,
  type GitLabProjectUpdate,
  type GitLabPipelineInputValue,
  type PushFileAction
} from "../lib/gitlab-client.js";
import { encodeGitLabProjectId, isGitLabProjectIdentityAllowed } from "../lib/gitlab-path.js";
import {
  applySearchReplace,
  applyUnifiedDiff,
  parseSearchReplaceBlocks
} from "../lib/patch-helper.js";
import {
  ISSUE_ID_USERNAME_PAIRS,
  MERGE_REQUEST_ID_USERNAME_PAIRS,
  normalizeIdUsernameFilters
} from "../lib/query-normalization.js";
import {
  bodySchema,
  displayNameSchema,
  nullableOptional,
  optionalBodySchema,
  optionalDisplayNameSchema,
  optionalProjectIdSchema,
  optionalRefLikeSchema,
  optionalUrlOrPathSchema,
  protectedBranchNameSchema,
  projectIdSchema,
  refLikeSchema,
  slugSchema
} from "../lib/tool-schema.js";
import {
  TOOL_CAPABILITIES,
  type GitLabPermissionMode,
  type ToolCapability
} from "../lib/tool-capabilities.js";
import { annotationsForCapabilities } from "../lib/tool-annotations.js";
import {
  GITLAB_TOOLSETS,
  isToolEnabledByToolsets,
  toolsetsForTool,
  type GitLabToolset
} from "../lib/toolsets.js";
import { getSessionAuth } from "../lib/auth-context.js";
import { createDownloadToken, type DownloadTokenResource } from "../lib/download-token.js";
import { filterDiffRecords, filterDiffResponse } from "../lib/diff-filter.js";
import {
  copyPaginationMetadata,
  copyPaginationMetadataAfterLocalFilter,
  getPaginationMetadata
} from "../lib/pagination.js";
import { redactSuccessfulResponse } from "../lib/redact-success.js";
import { sanitizeToolArguments } from "../lib/sanitize.js";
import { resolveNestedWikiUpdateTitle } from "../lib/wiki-title.js";
import type { AppContext } from "../types/context.js";
import { getMergeRequestCodeContext, mergeRequestCodeContextSchema } from "./mr-code-context.js";

type ToolArgs = Record<string, unknown>;

type ToolSchemaShape = Record<string, z.ZodTypeAny>;

export interface GitLabToolDefinition {
  name: string;
  title: string;
  description: string;
  capabilities: ToolCapability[];
  scope: GitLabToolScopeMetadata;
  requiresAuth?: boolean;
  requiresFeature?: "wiki" | "milestone" | "pipeline" | "release";
  requiresExplicitEnable?: "ciVariables" | "dependencyProxy";
  requiresLocalFileTools?: boolean;
  compatibilityAlias?: boolean;
  sensitiveArguments?: readonly string[];
  inputSchema?: ToolSchemaShape;
  handler: (args: ToolArgs, context: AppContext) => Promise<unknown>;
}

type GitLabToolDefinitionInput = Omit<GitLabToolDefinition, "scope">;

export type GitLabToolScope = "project" | "group" | "global" | "rawGraphQL";

export interface GitLabToolScopeMetadata {
  kind: GitLabToolScope;
  projectIdArguments?: readonly string[];
  groupIdArguments?: readonly string[];
  projectScopedMode: "allow" | "filter" | "deny";
}

const GROUP_SCOPED_TOOL_NAMES = new Set([
  "gitlab_create_group",
  "gitlab_list_group_projects",
  "gitlab_list_group_iterations",
  "gitlab_search_group_code",
  "gitlab_list_group_wiki_pages",
  "gitlab_get_group_wiki_page",
  "gitlab_create_group_wiki_page",
  "gitlab_update_group_wiki_page",
  "gitlab_delete_group_wiki_page",
  "gitlab_list_group_variables",
  "gitlab_get_group_variable",
  "gitlab_create_group_variable",
  "gitlab_update_group_variable",
  "gitlab_delete_group_variable",
  "gitlab_get_dependency_proxy_settings",
  "gitlab_update_dependency_proxy_settings",
  "gitlab_list_dependency_proxy_blobs",
  "gitlab_purge_dependency_proxy_cache"
]);

const RAW_GRAPHQL_TOOL_NAMES = new Set([
  "gitlab_execute_graphql_query",
  "gitlab_execute_graphql_mutation",
  "gitlab_execute_graphql"
]);

const GLOBAL_TOOL_PROJECT_SCOPE_MODES = new Map<string, "allow" | "filter" | "deny">([
  ["gitlab_discover_tools", "allow"],
  ["gitlab_list_projects", "filter"],
  ["gitlab_search_repositories", "filter"],
  ["gitlab_search_code", "filter"],
  ["gitlab_list_todos", "filter"],
  ["gitlab_mark_todo_done", "filter"],
  ["gitlab_whoami", "allow"],
  ["gitlab_create_repository", "deny"],
  ["gitlab_mark_all_todos_done", "deny"],
  ["gitlab_list_namespaces", "deny"],
  ["gitlab_get_namespace", "deny"],
  ["gitlab_verify_namespace", "deny"],
  ["gitlab_get_users", "deny"],
  ["gitlab_get_user", "deny"],
  ["gitlab_list_events", "deny"],
  ["gitlab_fork_repository", "deny"],
  ["gitlab_list_ci_catalog_resources", "deny"],
  ["gitlab_get_ci_catalog_resource", "deny"]
]);

const PROJECT_ID_ARGUMENTS_BY_TOOL = new Map<string, readonly string[]>([
  ["gitlab_create_merge_request", ["project_id", "target_project_id"]],
  ["gitlab_create_issue_link", ["project_id", "target_project_id"]],
  ["gitlab_update_work_item", ["project_id", "parent_project_id"]],
  ["gitlab_move_work_item", ["project_id", "target_project_id"]],
  ["gitlab_list_todos", ["project_id"]],
  ["gitlab_list_webhooks", ["project_id"]],
  ["gitlab_list_webhook_events", ["project_id"]],
  ["gitlab_get_webhook_event", ["project_id"]]
]);

const GROUP_ID_ARGUMENTS_BY_TOOL = new Map<string, readonly string[]>([
  ["gitlab_create_group", []],
  ["gitlab_list_webhooks", ["group_id"]],
  ["gitlab_list_webhook_events", ["group_id"]],
  ["gitlab_get_webhook_event", ["group_id"]]
]);

const readCapabilities: ToolCapability[] = ["read"];
const writeCapabilities: ToolCapability[] = ["write"];
const deleteCapabilities: ToolCapability[] = ["delete"];
const adminCapabilities: ToolCapability[] = ["admin"];
const adminGraphqlCapabilities: ToolCapability[] = ["admin", "graphql"];
const adminDeleteCapabilities: ToolCapability[] = ["admin", "delete"];
const readGraphqlCapabilities: ToolCapability[] = ["read", "graphql"];
const writeGraphqlCapabilities: ToolCapability[] = ["write", "graphql"];
const deleteGraphqlCapabilities: ToolCapability[] = ["delete", "graphql"];

const optionalString = nullableOptional(z.string());
const optionalNumber = nullableOptional(z.number());
const optionalPositiveIntegerFromEmptyString = z
  .preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.coerce.number().int().positive().optional()
  )
  .optional();
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
const excludedFilePatternsSchema = nullableOptional(z.array(z.string().min(1).max(200)).max(20));

const paginationShape = {
  page: optionalNumber,
  per_page: optionalNumber
} satisfies ToolSchemaShape;
const protectedBranchAccessLevelSchema = z.union([
  z.literal(0),
  z.literal(30),
  z.literal(40),
  z.literal(60)
]);
const protectedBranchUnprotectAccessLevelSchema = z.union([
  z.literal(30),
  z.literal(40),
  z.literal(60)
]);
const projectFeatureAccessLevelSchema = z.enum(["disabled", "private", "enabled"]);
const projectPagesAccessLevelSchema = z.enum(["disabled", "private", "enabled", "public"]);
const emojiNameSchema = z.string().min(1);
const awardEmojiIdSchema = z.string().min(1);
const workItemTypes = [
  "issue",
  "task",
  "incident",
  "test_case",
  "epic",
  "key_result",
  "objective",
  "requirement",
  "ticket"
] as const;
const workItemTypeSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.toLowerCase() : value),
  z.enum(workItemTypes)
);
const optionalWorkItemType = nullableOptional(workItemTypeSchema);
const workItemIidSchema = z.coerce.number().int().positive();
const optionalCoercedNumber = nullableOptional(z.coerce.number());
const optionalCoercedBoolean = nullableOptional(z.coerce.boolean());
const workItemReferenceSchema = z.object({
  project_id: optionalProjectIdSchema,
  iid: workItemIidSchema
});
const linkedWorkItemReferenceSchema = z.object({
  project_id: optionalProjectIdSchema,
  iid: workItemIidSchema,
  link_type: z.enum(["RELATED", "BLOCKED_BY", "BLOCKS"]).optional()
});
const customFieldValueSchema = z.object({
  custom_field_id: z.string().min(1),
  text_value: optionalString,
  number_value: optionalCoercedNumber,
  selected_option_ids: optionalStringArray,
  date_value: optionalString
});
const ciVariableKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_]+$/, "CI/CD variable keys may contain only letters, digits, and '_'");
const ciVariableFilterSchema = z
  .object({
    environment_scope: z.string().min(1)
  })
  .optional();
const ciVariableMutationFields: ToolSchemaShape = {
  value: z.string(),
  variable_type: z.enum(["env_var", "file"]).optional(),
  protected: optionalBoolean,
  masked: optionalBoolean,
  raw: optionalBoolean,
  environment_scope: z.string().min(1).optional(),
  description: z.string().max(255).optional()
};
const ciVariableSensitiveArguments = ["value"] as const;

function isExplicitlyEnabled(definition: GitLabToolDefinition, context: AppContext): boolean {
  if (definition.requiresExplicitEnable === "ciVariables") {
    return context.env.GITLAB_ENABLE_CI_VARIABLE_TOOLS;
  }

  if (definition.requiresExplicitEnable === "dependencyProxy") {
    return context.env.GITLAB_ENABLE_DEPENDENCY_PROXY_TOOLS;
  }

  return true;
}

export function registerGitLabTools(server: McpServer, context: AppContext): void {
  const definitions = getGitLabToolDefinitions();
  const scopeFilteredDefinitions = definitions.filter(
    (definition) =>
      isToolEnabledByToolsets(definition.name, context.env.GITLAB_TOOLSETS) &&
      isExplicitlyEnabled(definition, context) &&
      isToolVisibleForProjectScope(definition, context.env.GITLAB_ALLOWED_PROJECT_IDS)
  );
  const filtered = context.policy.filterTools(
    scopeFilteredDefinitions.map((item) => ({
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

    if (definition.compatibilityAlias && !context.env.GITLAB_ENABLE_COMPATIBILITY_ALIASES) {
      continue;
    }

    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema ?? {},
        annotations: annotationsForCapabilities(definition.capabilities)
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

          const args = sanitizeToolArguments(definition.name, (rawArgs ?? {}) as ToolArgs);
          assertToolCanExecuteInProjectScope(definition, args, context);
          const result = redactSuccessfulResponse(await definition.handler(args, context));
          const pagination = getPaginationMetadata(result);
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
                bytes: formatted.bytes,
                ...(pagination ? { pagination } : {})
              }
            }
          };
        } catch (error) {
          return toToolError(error, context, {
            extraKeys: definition.sensitiveArguments,
            extraValues: getSensitiveArgumentValues(rawArgs, definition.sensitiveArguments)
          });
        }
      }
    );
  }
}

export function getGitLabToolDefinitions(): GitLabToolDefinition[] {
  const definitions: GitLabToolDefinitionInput[] = [
    {
      name: "gitlab_discover_tools",
      title: "Discover GitLab Tools",
      description:
        "Search the complete tool registry without mutating session state. Results explain whether each tool is currently enabled.",
      capabilities: readCapabilities,
      inputSchema: {
        query: optionalString,
        toolset: z.enum(GITLAB_TOOLSETS).optional(),
        capability: z.enum(TOOL_CAPABILITIES).optional(),
        include_disabled: z.boolean().default(true),
        limit: z.number().int().min(1).max(100).default(20)
      },
      handler: async (args, context) => discoverGitLabTools(args, context)
    },
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
        topic: optionalString,
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
      handler: async (args, context) =>
        filterProjectScopedResponse(
          await context.gitlab.listProjects({ query: toQuery(args) }),
          context,
          "project"
        )
    },
    {
      name: "gitlab_update_project",
      title: "Update Project",
      description:
        "Update an allowlisted set of project metadata, merge defaults, and feature access levels.",
      capabilities: adminCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        name: optionalDisplayNameSchema,
        description: optionalString,
        visibility: z.enum(["private", "internal", "public"]).optional(),
        topics: optionalStringArray,
        request_access_enabled: optionalBoolean,
        remove_source_branch_after_merge: optionalBoolean,
        only_allow_merge_if_pipeline_succeeds: optionalBoolean,
        only_allow_merge_if_all_discussions_are_resolved: optionalBoolean,
        squash_option: z.enum(["never", "always", "default_on", "default_off"]).optional(),
        merge_method: z.enum(["merge", "rebase_merge", "ff"]).optional(),
        issues_access_level: projectFeatureAccessLevelSchema.optional(),
        merge_requests_access_level: projectFeatureAccessLevelSchema.optional(),
        builds_access_level: projectFeatureAccessLevelSchema.optional(),
        wiki_access_level: projectFeatureAccessLevelSchema.optional(),
        snippets_access_level: projectFeatureAccessLevelSchema.optional(),
        container_registry_access_level: projectFeatureAccessLevelSchema.optional(),
        environments_access_level: projectFeatureAccessLevelSchema.optional(),
        forking_access_level: projectFeatureAccessLevelSchema.optional(),
        package_registry_access_level: projectFeatureAccessLevelSchema.optional(),
        pages_access_level: projectPagesAccessLevelSchema.optional()
      },
      handler: async (args, context) => {
        const updates: GitLabProjectUpdate = {
          name: getOptionalString(args, "name"),
          description: getOptionalString(args, "description"),
          visibility: getOptionalString(args, "visibility") as GitLabProjectUpdate["visibility"],
          topics: getOptionalStringArray(args, "topics"),
          request_access_enabled: getOptionalBoolean(args, "request_access_enabled"),
          remove_source_branch_after_merge: getOptionalBoolean(
            args,
            "remove_source_branch_after_merge"
          ),
          only_allow_merge_if_pipeline_succeeds: getOptionalBoolean(
            args,
            "only_allow_merge_if_pipeline_succeeds"
          ),
          only_allow_merge_if_all_discussions_are_resolved: getOptionalBoolean(
            args,
            "only_allow_merge_if_all_discussions_are_resolved"
          ),
          squash_option: getOptionalString(
            args,
            "squash_option"
          ) as GitLabProjectUpdate["squash_option"],
          merge_method: getOptionalString(
            args,
            "merge_method"
          ) as GitLabProjectUpdate["merge_method"],
          issues_access_level: getOptionalString(
            args,
            "issues_access_level"
          ) as GitLabProjectUpdate["issues_access_level"],
          merge_requests_access_level: getOptionalString(
            args,
            "merge_requests_access_level"
          ) as GitLabProjectUpdate["merge_requests_access_level"],
          builds_access_level: getOptionalString(
            args,
            "builds_access_level"
          ) as GitLabProjectUpdate["builds_access_level"],
          wiki_access_level: getOptionalString(
            args,
            "wiki_access_level"
          ) as GitLabProjectUpdate["wiki_access_level"],
          snippets_access_level: getOptionalString(
            args,
            "snippets_access_level"
          ) as GitLabProjectUpdate["snippets_access_level"],
          container_registry_access_level: getOptionalString(
            args,
            "container_registry_access_level"
          ) as GitLabProjectUpdate["container_registry_access_level"],
          environments_access_level: getOptionalString(
            args,
            "environments_access_level"
          ) as GitLabProjectUpdate["environments_access_level"],
          forking_access_level: getOptionalString(
            args,
            "forking_access_level"
          ) as GitLabProjectUpdate["forking_access_level"],
          package_registry_access_level: getOptionalString(
            args,
            "package_registry_access_level"
          ) as GitLabProjectUpdate["package_registry_access_level"],
          pages_access_level: getOptionalString(
            args,
            "pages_access_level"
          ) as GitLabProjectUpdate["pages_access_level"]
        };
        const payload = Object.fromEntries(
          Object.entries(updates).filter(([, value]) => value !== undefined)
        ) as GitLabProjectUpdate;
        if (Object.keys(payload).length === 0) {
          throw new Error("At least one allowlisted project field must be provided");
        }

        return context.gitlab.updateProject(resolveProjectId(args, context, true), payload);
      }
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
        namespace_id: optionalPositiveIntegerFromEmptyString,
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
          namespace_id: getOptionalNumber(args, "namespace_id"),
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
      description:
        "List direct project members by default; set include_inheritance=true to include inherited members.",
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
        const userIds = getOptionalNumberArray(args, "user_ids");
        const skipUsers = getOptionalNumberArray(args, "skip_users");
        const includeInheritance = getOptionalBoolean(args, "include_inheritance");
        return context.gitlab.listProjectMembers(projectId, {
          query: {
            ...toQuery(omit(args, ["project_id", "user_ids", "skip_users", "include_inheritance"])),
            ...(userIds ? { user_ids: userIds } : {}),
            ...(skipUsers ? { skip_users: skipUsers } : {})
          },
          ...(includeInheritance !== undefined ? { includeInheritance } : {})
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
        topic: optionalString,
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
        filterProjectScopedResponse(
          await context.gitlab.searchRepositories(getString(args, "search"), {
            query: toQuery(omit(args, ["search"]))
          }),
          context,
          "project"
        )
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
      handler: async (args, context) => {
        const search = getString(args, "search");
        const query = toQuery(omit(args, ["search"]));
        const allowed = context.env.GITLAB_ALLOWED_PROJECT_IDS;
        if (allowed.length === 0) {
          return context.gitlab.searchCode(search, { query });
        }

        const results = await Promise.all(
          allowed.map((projectId) => context.gitlab.searchCodeBlobs(projectId, search, { query }))
        );
        return results.flatMap((result) => extractRecords(result));
      }
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
        ref: optionalRefLikeSchema,
        decode_base64: optionalBoolean
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
        const result = await context.gitlab.getFileContents(
          projectId,
          getString(args, "file_path"),
          ref
        );
        return maybeDecodeRepositoryFileContents(result, getOptionalBoolean(args, "decode_base64"));
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
      name: "gitlab_list_protected_branches",
      title: "List Protected Branches",
      description: "List protected branch rules for a project.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        search: optionalString,
        ...paginationShape
      },
      handler: async (args, context) =>
        context.gitlab.listProtectedBranches(resolveProjectId(args, context, true), {
          query: toQuery(omit(args, ["project_id"]))
        })
    },
    {
      name: "gitlab_get_protected_branch",
      title: "Get Protected Branch",
      description: "Get one protected branch or wildcard rule.",
      capabilities: readCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        branch: protectedBranchNameSchema
      },
      handler: async (args, context) =>
        context.gitlab.getProtectedBranch(
          resolveProjectId(args, context, true),
          getString(args, "branch")
        )
    },
    {
      name: "gitlab_protect_branch",
      title: "Protect Branch",
      description:
        "Protect a branch or wildcard rule and configure role-based push, merge, and unprotect access.",
      capabilities: adminCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        branch: protectedBranchNameSchema,
        push_access_level: nullableOptional(protectedBranchAccessLevelSchema),
        merge_access_level: nullableOptional(protectedBranchAccessLevelSchema),
        unprotect_access_level: nullableOptional(protectedBranchUnprotectAccessLevelSchema),
        allow_force_push: optionalBoolean,
        code_owner_approval_required: optionalBoolean
      },
      handler: async (args, context) =>
        context.gitlab.protectBranch(resolveProjectId(args, context, true), {
          name: getString(args, "branch"),
          push_access_level: getOptionalNumber(args, "push_access_level"),
          merge_access_level: getOptionalNumber(args, "merge_access_level"),
          unprotect_access_level: getOptionalNumber(args, "unprotect_access_level"),
          allow_force_push: getOptionalBoolean(args, "allow_force_push"),
          code_owner_approval_required: getOptionalBoolean(args, "code_owner_approval_required")
        })
    },
    {
      name: "gitlab_unprotect_branch",
      title: "Unprotect Branch",
      description:
        "Remove protection from a branch or wildcard rule. This immediately permits actions previously blocked. Requires branch. Recommended pre-check: gitlab_get_protected_branch.",
      capabilities: deleteCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        branch: protectedBranchNameSchema
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const branch = getString(args, "branch");
        await context.gitlab.unprotectBranch(projectId, branch);
        return { status: "unprotected", project_id: projectId, branch };
      }
    },
    {
      name: "gitlab_update_default_branch",
      title: "Update Default Branch",
      description: "Change a project's default branch to an existing branch.",
      capabilities: adminCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        default_branch: refLikeSchema
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const defaultBranch = getString(args, "default_branch");
        await context.gitlab.updateDefaultBranch(projectId, defaultBranch);
        return { status: "updated", project_id: projectId, default_branch: defaultBranch };
      }
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
        excluded_file_patterns: excludedFilePatternsSchema
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const response = await context.gitlab.getBranchDiffs(projectId, {
          from: getString(args, "from"),
          to: getString(args, "to"),
          straight: getOptionalBoolean(args, "straight")
        });
        return filterDiffResponse(response, getOptionalStringArray(args, "excluded_file_patterns"));
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
        approved_by_usernames: optionalStringArray,
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
        const normalized = normalizeIdUsernameFilters(
          omit(args, ["project_id"]),
          MERGE_REQUEST_ID_USERNAME_PAIRS
        );
        const approvedByUsernames = getOptionalStringArray(normalized, "approved_by_usernames");
        const query = {
          ...toQuery(omit(normalized, ["approved_by_usernames"])),
          ...(approvedByUsernames ? { approved_by_usernames: approvedByUsernames } : {})
        };

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
        source_branch: optionalRefLikeSchema,
        include_summaries: optionalBoolean
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const mergeRequestIid = getOptionalString(args, "merge_request_iid");
        const includeSummaries = getOptionalBoolean(args, "include_summaries") ?? false;

        if (mergeRequestIid) {
          const mergeRequest = await context.gitlab.getMergeRequest(projectId, mergeRequestIid);
          return includeSummaries
            ? withMergeRequestSummaries(projectId, mergeRequest, context)
            : mergeRequest;
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

        const mergeRequest = await getDetailedMergeRequestFromMatch(projectId, match, context);
        return includeSummaries
          ? withMergeRequestSummaries(projectId, mergeRequest, context)
          : mergeRequest;
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
        const targetProjectId = getOptionalString(args, "target_project_id");
        return context.gitlab.createMergeRequest(projectId, {
          source_branch: getString(args, "source_branch"),
          target_branch: getString(args, "target_branch"),
          title: getString(args, "title"),
          description: getOptionalString(args, "description"),
          target_project_id: targetProjectId
            ? resolveExplicitProjectId(context, targetProjectId)
            : undefined,
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
        namespace_id: optionalPositiveIntegerFromEmptyString,
        path: optionalString,
        name: optionalDisplayNameSchema,
        description: optionalString,
        visibility: z.enum(["private", "internal", "public"]).optional(),
        default_branch: optionalRefLikeSchema
      },
      handler: async (args, context) =>
        context.gitlab.forkRepository(resolveProjectId(args, context, true), {
          namespace: getOptionalString(args, "namespace"),
          namespace_id: getOptionalNumber(args, "namespace_id"),
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
        excluded_file_patterns: excludedFilePatternsSchema
      },
      handler: async (args, context) => {
        const response = await context.gitlab.getMergeRequestDiffs(
          resolveProjectId(args, context, true),
          getString(args, "merge_request_iid"),
          { query: toQuery({ view: args.view }) }
        );
        return filterDiffResponse(response, getOptionalStringArray(args, "excluded_file_patterns"));
      }
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
        excluded_file_patterns: excludedFilePatternsSchema
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

        return filterDiffRecords(files, getOptionalStringArray(args, "excluded_file_patterns"));
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
      compatibilityAlias: true,
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
      compatibilityAlias: true,
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
        const normalized = normalizeIdUsernameFilters(
          omit(args, ["project_id"]),
          ISSUE_ID_USERNAME_PAIRS
        );
        const assigneeUsernames = getOptionalStringArray(normalized, "assignee_username");
        const query = {
          ...toQuery(omit(normalized, ["assignee_username"])),
          ...(assigneeUsernames ? { assignee_username: assigneeUsernames } : {})
        };

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
      handler: async (args, context) =>
        filterProjectScopedResponse(
          await context.gitlab.listTodos({ query: toQuery(args) }),
          context,
          "resource"
        )
    },
    {
      name: "gitlab_mark_todo_done",
      title: "Mark Todo Done",
      description: "Mark one to-do item as done.",
      capabilities: writeCapabilities,
      inputSchema: {
        todo_id: z.string().min(1)
      },
      handler: async (args, context) => {
        const todoId = getString(args, "todo_id");
        await assertTodoProjectAllowed(todoId, context);
        return context.gitlab.markTodoDone(todoId);
      }
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
        issue_iid: z.string().min(1),
        full_response: optionalBoolean
      },
      handler: async (args, context) => {
        const issue = await context.gitlab.getIssue(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid")
        );
        return getOptionalBoolean(args, "full_response") ? issue : slimIssueMilestone(issue);
      }
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
        weight: optionalCoercedNumber,
        issue_type: z.enum(["issue", "incident", "test_case", "task"]).optional(),
        full_response: optionalBoolean
      },
      handler: async (args, context) => {
        const payload = toQuery(omit(args, ["project_id", "issue_iid", "full_response"])) as Record<
          string,
          unknown
        >;
        if (payload.labels === undefined) {
          payload.labels = toCsvValue(args.labels);
        }
        if (Array.isArray(args.assignee_ids)) {
          payload.assignee_ids = args.assignee_ids as number[];
        }

        const issue = await context.gitlab.updateIssue(
          resolveProjectId(args, context, true),
          getString(args, "issue_iid"),
          payload
        );
        return getOptionalBoolean(args, "full_response") ? issue : slimUpdatedIssue(issue);
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
            target_project_id: resolveExplicitProjectId(
              context,
              getString(args, "target_project_id")
            ),
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
        render_html: optionalBoolean,
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
        version: optionalString,
        render_html: optionalBoolean
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
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const slug = getString(args, "slug");
        const title = await resolveWikiUpdateTitle(slug, getOptionalString(args, "title"), () =>
          context.gitlab.getWikiPage(projectId, slug, { query: { render_html: true } })
        );
        return context.gitlab.updateWikiPage(projectId, slug, {
          content: getString(args, "content"),
          title,
          format: getOptionalString(args, "format") as
            | "markdown"
            | "rdoc"
            | "asciidoc"
            | "org"
            | undefined
        });
      }
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
        render_html: optionalBoolean,
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
        version: optionalString,
        render_html: optionalBoolean
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
        const groupId = getString(args, "group_id");
        const slug = getString(args, "slug");
        const payload = toQuery(omit(args, ["group_id", "slug"]));
        if (Object.keys(payload).length === 0) {
          throw new Error("At least one of title, content, or format must be provided");
        }
        payload.title = await resolveWikiUpdateTitle(slug, getOptionalString(args, "title"), () =>
          context.gitlab.getGroupWikiPage(groupId, slug, { query: { render_html: true } })
        );
        if (payload.title === undefined) {
          delete payload.title;
        }
        return context.gitlab.updateGroupWikiPage(groupId, slug, payload);
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
      description:
        "Get a bounded, untrusted job trace window. Returns at most 1,000 lines from the end.",
      capabilities: readCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        project_id: optionalProjectIdSchema,
        job_id: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).max(1_000_000).optional()
      },
      handler: async (args, context) =>
        context.gitlab.getPipelineJobOutput(
          resolveProjectId(args, context, true),
          getString(args, "job_id"),
          {
            limit: getOptionalNumber(args, "limit"),
            offset: getOptionalNumber(args, "offset")
          }
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
        withCiLintHttpDiagnostics(() =>
          context.gitlab.validateCiLint(
            resolveProjectId(args, context, true),
            toQuery(omit(args, ["project_id"]))
          )
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
        withCiLintHttpDiagnostics(() =>
          context.gitlab.validateProjectCiLint(resolveProjectId(args, context, true), {
            query: toQuery(omit(args, ["project_id"]))
          })
        )
    },
    {
      name: "gitlab_list_ci_catalog_resources",
      title: "List CI/CD Catalog Resources",
      description:
        "List GitLab CI/CD Catalog resources with cursor pagination and catalog filters.",
      capabilities: readGraphqlCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        search: optionalString,
        first: z.coerce.number().int().min(1).max(100).optional(),
        after: optionalString,
        group_ids: optionalStringArray,
        scope: z.enum(["ALL", "NAMESPACES"]).optional(),
        sort: z
          .enum([
            "CREATED_ASC",
            "CREATED_DESC",
            "LATEST_RELEASED_AT_ASC",
            "LATEST_RELEASED_AT_DESC",
            "NAME_ASC",
            "NAME_DESC",
            "STAR_COUNT_ASC",
            "STAR_COUNT_DESC",
            "USAGE_COUNT_ASC",
            "USAGE_COUNT_DESC"
          ])
          .optional(),
        topics: optionalStringArray,
        verification_level: z
          .enum([
            "GITLAB_MAINTAINED",
            "GITLAB_PARTNER_MAINTAINED",
            "UNVERIFIED",
            "VERIFIED_CREATOR_MAINTAINED",
            "VERIFIED_CREATOR_SELF_MANAGED"
          ])
          .optional()
      },
      handler: listCiCatalogResources
    },
    {
      name: "gitlab_get_ci_catalog_resource",
      title: "Get CI/CD Catalog Resource",
      description:
        "Get one GitLab CI/CD Catalog resource, including paginated versions and components.",
      capabilities: readGraphqlCapabilities,
      requiresFeature: "pipeline",
      inputSchema: {
        id: optionalString,
        full_path: optionalString,
        version_limit: z.coerce.number().int().min(1).max(20).optional(),
        version_after: optionalString,
        component_limit: z.coerce.number().int().min(1).max(50).optional(),
        component_after: optionalString,
        component_name: optionalString,
        include_readme: optionalBoolean
      },
      handler: getCiCatalogResource
    },
    {
      name: "gitlab_list_project_variables",
      title: "List Project CI/CD Variables",
      description:
        "List project CI/CD variable metadata. Values require both server opt-in and include_value=true.",
      capabilities: readCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        page: z.coerce.number().int().positive().optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
        filter: ciVariableFilterSchema,
        include_value: optionalBoolean
      },
      handler: async (args, context) => {
        const variables = await context.gitlab.listProjectVariables(
          resolveProjectId(args, context, true),
          {
            query: {
              ...toQuery(omit(args, ["project_id", "filter", "include_value"])),
              ...ciVariableFilterQuery(args)
            }
          }
        );
        return projectCiVariableResponse(variables, shouldIncludeCiVariableValue(args, context));
      }
    },
    {
      name: "gitlab_get_project_variable",
      title: "Get Project CI/CD Variable",
      description:
        "Get project CI/CD variable metadata. The value requires both server opt-in and include_value=true.",
      capabilities: readCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        key: ciVariableKeySchema,
        filter: ciVariableFilterSchema,
        include_value: optionalBoolean
      },
      handler: async (args, context) => {
        const variable = await context.gitlab.getProjectVariable(
          resolveProjectId(args, context, true),
          getString(args, "key"),
          { query: ciVariableFilterQuery(args) }
        );
        return projectCiVariableResponse(variable, shouldIncludeCiVariableValue(args, context));
      }
    },
    {
      name: "gitlab_create_project_variable",
      title: "Create Project CI/CD Variable",
      description:
        "Create a project CI/CD variable. The supplied value is never returned or included in errors.",
      capabilities: writeCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        key: ciVariableKeySchema,
        ...ciVariableMutationFields,
        masked_and_hidden: optionalBoolean
      },
      handler: async (args, context) => {
        const variable = await context.gitlab.createProjectVariable(
          resolveProjectId(args, context, true),
          ciVariablePayload(args, true)
        );
        return projectCiVariableResponse(variable, false);
      }
    },
    {
      name: "gitlab_update_project_variable",
      title: "Update Project CI/CD Variable",
      description:
        "Update a project CI/CD variable. The supplied value is never returned or included in errors.",
      capabilities: writeCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        key: ciVariableKeySchema,
        ...ciVariableMutationFields,
        filter: ciVariableFilterSchema
      },
      handler: async (args, context) => {
        const variable = await context.gitlab.updateProjectVariable(
          resolveProjectId(args, context, true),
          getString(args, "key"),
          ciVariablePayload(args, false),
          { query: ciVariableFilterQuery(args) }
        );
        return projectCiVariableResponse(variable, false);
      }
    },
    {
      name: "gitlab_delete_project_variable",
      title: "Delete Project CI/CD Variable",
      description: "Permanently delete a project CI/CD variable.",
      capabilities: deleteCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        key: ciVariableKeySchema,
        filter: ciVariableFilterSchema
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const key = getString(args, "key");
        await context.gitlab.deleteProjectVariable(projectId, key, {
          query: ciVariableFilterQuery(args)
        });
        return { status: "deleted", scope: "project", project_id: projectId, key };
      }
    },
    {
      name: "gitlab_list_group_variables",
      title: "List Group CI/CD Variables",
      description:
        "List group CI/CD variable metadata. Values require both server opt-in and include_value=true.",
      capabilities: readCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        group_id: projectIdSchema,
        page: z.coerce.number().int().positive().optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
        filter: ciVariableFilterSchema,
        include_value: optionalBoolean
      },
      handler: async (args, context) => {
        const variables = await context.gitlab.listGroupVariables(getString(args, "group_id"), {
          query: {
            ...toQuery(omit(args, ["group_id", "filter", "include_value"])),
            ...ciVariableFilterQuery(args)
          }
        });
        return projectCiVariableResponse(variables, shouldIncludeCiVariableValue(args, context));
      }
    },
    {
      name: "gitlab_get_group_variable",
      title: "Get Group CI/CD Variable",
      description:
        "Get group CI/CD variable metadata. The value requires both server opt-in and include_value=true.",
      capabilities: readCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        group_id: projectIdSchema,
        key: ciVariableKeySchema,
        filter: ciVariableFilterSchema,
        include_value: optionalBoolean
      },
      handler: async (args, context) => {
        const variable = await context.gitlab.getGroupVariable(
          getString(args, "group_id"),
          getString(args, "key"),
          { query: ciVariableFilterQuery(args) }
        );
        return projectCiVariableResponse(variable, shouldIncludeCiVariableValue(args, context));
      }
    },
    {
      name: "gitlab_create_group_variable",
      title: "Create Group CI/CD Variable",
      description:
        "Create a group CI/CD variable. The supplied value is never returned or included in errors.",
      capabilities: writeCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        group_id: projectIdSchema,
        key: ciVariableKeySchema,
        ...ciVariableMutationFields,
        masked_and_hidden: optionalBoolean
      },
      handler: async (args, context) => {
        const variable = await context.gitlab.createGroupVariable(
          getString(args, "group_id"),
          ciVariablePayload(args, true)
        );
        return projectCiVariableResponse(variable, false);
      }
    },
    {
      name: "gitlab_update_group_variable",
      title: "Update Group CI/CD Variable",
      description:
        "Update a group CI/CD variable. The supplied value is never returned or included in errors.",
      capabilities: writeCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        group_id: projectIdSchema,
        key: ciVariableKeySchema,
        ...ciVariableMutationFields,
        filter: ciVariableFilterSchema
      },
      handler: async (args, context) => {
        const variable = await context.gitlab.updateGroupVariable(
          getString(args, "group_id"),
          getString(args, "key"),
          ciVariablePayload(args, false),
          { query: ciVariableFilterQuery(args) }
        );
        return projectCiVariableResponse(variable, false);
      }
    },
    {
      name: "gitlab_delete_group_variable",
      title: "Delete Group CI/CD Variable",
      description: "Permanently delete a group CI/CD variable.",
      capabilities: deleteCapabilities,
      requiresExplicitEnable: "ciVariables",
      sensitiveArguments: ciVariableSensitiveArguments,
      inputSchema: {
        group_id: projectIdSchema,
        key: ciVariableKeySchema,
        filter: ciVariableFilterSchema
      },
      handler: async (args, context) => {
        const groupId = getString(args, "group_id");
        const key = getString(args, "key");
        await context.gitlab.deleteGroupVariable(groupId, key, {
          query: ciVariableFilterQuery(args)
        });
        return { status: "deleted", scope: "group", group_id: groupId, key };
      }
    },
    {
      name: "gitlab_get_dependency_proxy_settings",
      title: "Get Dependency Proxy Settings",
      description:
        "Get group Dependency Proxy settings, cache usage, image prefix, and TTL policy.",
      capabilities: adminGraphqlCapabilities,
      requiresExplicitEnable: "dependencyProxy",
      inputSchema: {
        group_id: projectIdSchema
      },
      handler: getDependencyProxySettings
    },
    {
      name: "gitlab_update_dependency_proxy_settings",
      title: "Update Dependency Proxy Settings",
      description:
        "Update group Dependency Proxy enablement or Docker Hub credentials. Requires at least one setting.",
      capabilities: adminGraphqlCapabilities,
      requiresExplicitEnable: "dependencyProxy",
      sensitiveArguments: ["secret"],
      inputSchema: {
        group_id: projectIdSchema,
        enabled: optionalBoolean,
        identity: z.string().optional(),
        secret: z.string().optional()
      },
      handler: updateDependencyProxySettings
    },
    {
      name: "gitlab_list_dependency_proxy_blobs",
      title: "List Dependency Proxy Blobs",
      description: "List cached group Dependency Proxy blobs with cursor pagination.",
      capabilities: adminGraphqlCapabilities,
      requiresExplicitEnable: "dependencyProxy",
      inputSchema: {
        group_id: projectIdSchema,
        first: z.coerce.number().int().min(1).max(100).optional(),
        after: optionalString
      },
      handler: listDependencyProxyBlobs
    },
    {
      name: "gitlab_purge_dependency_proxy_cache",
      title: "Purge Dependency Proxy Cache",
      description:
        "Schedule permanent deletion of all cached Dependency Proxy manifests and blobs for a group.",
      capabilities: adminDeleteCapabilities,
      requiresExplicitEnable: "dependencyProxy",
      inputSchema: {
        group_id: projectIdSchema
      },
      handler: async (args, context) => {
        const groupId = getString(args, "group_id");
        await context.gitlab.purgeDependencyProxyCache(groupId);
        return { status: "scheduled", scope: "group", group_id: groupId };
      }
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
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const jobId = getString(args, "job_id");
        if (shouldReturnDownloadProxy(context)) {
          return buildDownloadProxyResult(
            context,
            {
              type: "job-artifacts",
              params: { project_id: projectId, job_id: jobId }
            },
            `artifacts_job_${jobId}.zip`
          );
        }

        return context.gitlab.downloadJobArtifacts(projectId, jobId);
      }
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
      handler: async (args, context) => {
        const iids = getOptionalNumberArray(args, "iids");
        return context.gitlab.listMilestones(resolveProjectId(args, context, true), {
          query: {
            ...toQuery(omit(args, ["project_id", "iids"])),
            ...(iids ? { iids } : {})
          }
        });
      }
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
      compatibilityAlias: true,
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
          pickPresentFields(args, [
            "name",
            "tag_name",
            "tag_message",
            "description",
            "ref",
            "released_at",
            "milestones",
            "assets"
          ])
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
          pickPresentFields(args, ["name", "description", "released_at", "milestones", "assets"])
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
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const tagName = getString(args, "tag_name");
        const directAssetPath = getString(args, "direct_asset_path");
        if (shouldReturnDownloadProxy(context)) {
          return buildDownloadProxyResult(
            context,
            {
              type: "release-asset",
              params: {
                project_id: projectId,
                tag_name: tagName,
                direct_asset_path: directAssetPath
              }
            },
            directAssetPath.split("/").pop() || directAssetPath
          );
        }

        return context.gitlab.downloadReleaseAsset(projectId, tagName, directAssetPath);
      }
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
          pickPresentFields(args, ["name", "color", "description", "priority"])
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
        const payload = pickPresentFields(args, [
          "name",
          "label_id",
          "new_name",
          "color",
          "description",
          "priority"
        ]);
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
        path: z.string().min(1),
        parent_id: optionalPositiveIntegerFromEmptyString
      },
      handler: async (args, context) => {
        const parentId = getOptionalNumber(args, "parent_id");
        return context.gitlab.verifyNamespace(
          getString(args, "path"),
          parentId === undefined ? undefined : { query: { parent_id: parentId } }
        );
      }
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
        context.gitlab.listWebhooks(resolveWebhookScope(args, context), {
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
            resolveWebhookScope(args, context),
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
          resolveWebhookScope(args, context),
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
          if (!context.allowLocalFileTools) {
            throw new Error("file_path cannot be used over HTTP. Provide content and filename.");
          }
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

            if (shouldReturnDownloadProxy(context)) {
              return buildDownloadProxyResult(
                context,
                {
                  type: "attachment",
                  params: {
                    project_id: projectId,
                    secret: upload.secret,
                    filename: upload.filename
                  }
                },
                upload.filename
              );
            }

            const apiRelativePath = `api/v4/projects/${encodeGitLabProjectId(projectId)}/uploads/${encodeURIComponent(upload.secret)}/${encodeURIComponent(upload.filename)}`;
            return context.gitlab.downloadAttachment(apiRelativePath);
          }

          if (projectId && upload) {
            if (shouldReturnDownloadProxy(context)) {
              return buildDownloadProxyResult(
                context,
                {
                  type: "attachment",
                  params: {
                    project_id: projectId,
                    secret: upload.secret,
                    filename: upload.filename
                  }
                },
                upload.filename
              );
            }

            const apiRelativePath = `api/v4/projects/${encodeGitLabProjectId(projectId)}/uploads/${encodeURIComponent(upload.secret)}/${encodeURIComponent(upload.filename)}`;
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
        const apiRelativePath = `api/v4/projects/${encodeGitLabProjectId(projectId)}/uploads/${encodeURIComponent(secret)}/${encodeURIComponent(filename)}`;
        if (shouldReturnDownloadProxy(context)) {
          return buildDownloadProxyResult(
            context,
            {
              type: "attachment",
              params: { project_id: projectId, secret, filename }
            },
            filename
          );
        }

        return context.gitlab.downloadAttachment(apiRelativePath);
      }
    },
    {
      name: "gitlab_get_work_item",
      title: "Get Work Item",
      description:
        "Get a single work item with full widget details including status, hierarchy, labels, assignees, linked items, custom fields, and development data.",
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema
      },
      handler: async (args, context) =>
        getWorkItem(context, resolveProjectId(args, context, true), getNumber(args, "iid"))
    },
    {
      name: "gitlab_list_work_items",
      title: "List Work Items",
      description:
        "List work items in a project with filters for type, state, search, assignees, and labels.",
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        types: nullableOptional(z.array(workItemTypeSchema)),
        state: z.enum(["opened", "closed"]).optional(),
        search: optionalString,
        assignee_usernames: optionalStringArray,
        label_names: optionalStringArray,
        first: z.coerce.number().int().positive().max(100).optional(),
        after: optionalString
      },
      handler: async (args, context) =>
        listWorkItems(context, resolveProjectId(args, context, true), {
          types: getOptionalStringArray(args, "types") as WorkItemType[] | undefined,
          state: getOptionalString(args, "state") as "opened" | "closed" | undefined,
          search: getOptionalString(args, "search"),
          assigneeUsernames: getOptionalStringArray(args, "assignee_usernames"),
          labelNames: getOptionalStringArray(args, "label_names"),
          first: getOptionalNumber(args, "first"),
          after: getOptionalString(args, "after")
        })
    },
    {
      name: "gitlab_create_work_item",
      title: "Create Work Item",
      description:
        "Create a work item of type issue, task, incident, test_case, epic, key_result, objective, requirement, or ticket.",
      capabilities: writeGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        title: z.string().min(1),
        type: optionalWorkItemType,
        description: optionalString,
        labels: optionalStringArray,
        assignee_usernames: optionalStringArray,
        parent_iid: workItemIidSchema.optional(),
        weight: optionalCoercedNumber,
        health_status: z.enum(["onTrack", "needsAttention", "atRisk"]).optional(),
        start_date: optionalString,
        due_date: optionalString,
        milestone_id: optionalString,
        iteration_id: optionalString,
        confidential: optionalCoercedBoolean
      },
      handler: async (args, context) => {
        const type = getOptionalString(args, "type") as WorkItemType | undefined;
        const weight = getOptionalNumber(args, "weight");
        if (type === "incident" && weight !== undefined) {
          throw new Error("Incident work items do not support the weight field");
        }

        return createWorkItem(context, resolveProjectId(args, context, true), {
          title: getString(args, "title"),
          type,
          description: getOptionalString(args, "description"),
          labels: getOptionalStringArray(args, "labels"),
          assigneeUsernames: getOptionalStringArray(args, "assignee_usernames"),
          parentIid: getOptionalNumber(args, "parent_iid"),
          weight,
          healthStatus: getOptionalString(args, "health_status"),
          startDate: getOptionalString(args, "start_date"),
          dueDate: getOptionalString(args, "due_date"),
          milestoneId: getOptionalString(args, "milestone_id"),
          iterationId: getOptionalString(args, "iteration_id"),
          confidential: getOptionalBoolean(args, "confidential")
        });
      }
    },
    {
      name: "gitlab_update_work_item",
      title: "Update Work Item",
      description:
        "Update a work item title, description, labels, assignees, state, status, hierarchy, linked items, custom fields, dates, milestone, iteration, and incident metadata.",
      capabilities: writeGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        title: optionalString,
        description: optionalString,
        add_labels: optionalStringArray,
        remove_labels: optionalStringArray,
        assignee_usernames: optionalStringArray,
        state_event: z.enum(["close", "reopen"]).optional(),
        weight: optionalNumber,
        status: optionalString,
        parent_iid: workItemIidSchema.optional(),
        parent_project_id: optionalProjectIdSchema,
        remove_parent: optionalCoercedBoolean,
        children_to_add: nullableOptional(z.array(workItemReferenceSchema)),
        children_to_remove: nullableOptional(z.array(workItemReferenceSchema)),
        health_status: z.enum(["onTrack", "needsAttention", "atRisk"]).optional(),
        start_date: optionalString,
        due_date: optionalString,
        milestone_id: optionalString,
        iteration_id: optionalString,
        confidential: optionalCoercedBoolean,
        linked_items_to_add: nullableOptional(z.array(linkedWorkItemReferenceSchema)),
        linked_items_to_remove: nullableOptional(z.array(workItemReferenceSchema)),
        custom_fields: nullableOptional(z.array(customFieldValueSchema)),
        severity: z.enum(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
        escalation_status: z.enum(["TRIGGERED", "ACKNOWLEDGED", "RESOLVED", "IGNORED"]).optional()
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        return updateWorkItem(context, projectId, getNumber(args, "iid"), {
          title: getOptionalString(args, "title"),
          description: getOptionalString(args, "description"),
          addLabels: getOptionalStringArray(args, "add_labels"),
          removeLabels: getOptionalStringArray(args, "remove_labels"),
          assigneeUsernames: getOptionalStringArray(args, "assignee_usernames"),
          stateEvent: getOptionalString(args, "state_event") as "close" | "reopen" | undefined,
          weight: getOptionalNumber(args, "weight"),
          status: getOptionalString(args, "status"),
          parentIid: getOptionalNumber(args, "parent_iid"),
          parentProjectId: resolveOptionalExplicitProjectId(
            context,
            getOptionalString(args, "parent_project_id")
          ),
          removeParent: getOptionalBoolean(args, "remove_parent"),
          childrenToAdd: getWorkItemReferences(args, "children_to_add", context, projectId),
          childrenToRemove: getWorkItemReferences(args, "children_to_remove", context, projectId),
          healthStatus: getOptionalString(args, "health_status"),
          startDate: getOptionalString(args, "start_date"),
          dueDate: getOptionalString(args, "due_date"),
          milestoneId: getOptionalString(args, "milestone_id"),
          iterationId: getOptionalString(args, "iteration_id"),
          confidential: getOptionalBoolean(args, "confidential"),
          linkedItemsToAdd: getLinkedWorkItemReferences(
            args,
            "linked_items_to_add",
            context,
            projectId
          ),
          linkedItemsToRemove: getWorkItemReferences(
            args,
            "linked_items_to_remove",
            context,
            projectId
          ),
          customFields: getOptionalArray(args, "custom_fields") as
            | WorkItemCustomFieldInput[]
            | undefined,
          severity: getOptionalString(args, "severity"),
          escalationStatus: getOptionalString(args, "escalation_status")
        });
      }
    },
    {
      name: "gitlab_convert_work_item_type",
      title: "Convert Work Item Type",
      description: "Convert a work item to a different type.",
      capabilities: writeGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        new_type: workItemTypeSchema
      },
      handler: async (args, context) =>
        convertWorkItemType(
          context,
          resolveProjectId(args, context, true),
          getNumber(args, "iid"),
          getString(args, "new_type") as WorkItemType
        )
    },
    {
      name: "gitlab_list_work_item_statuses",
      title: "List Work Item Statuses",
      description:
        "List available statuses and allowed hierarchy/conversion types for a work item type.",
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        work_item_type: optionalWorkItemType
      },
      handler: async (args, context) =>
        listWorkItemStatuses(
          context,
          resolveProjectId(args, context, true),
          (getOptionalString(args, "work_item_type") as WorkItemType | undefined) ?? "issue"
        )
    },
    {
      name: "gitlab_list_custom_field_definitions",
      title: "List Custom Field Definitions",
      description:
        "List custom field definitions for a work item type, including field IDs, types, options, and supported work item types.",
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        work_item_type: optionalWorkItemType
      },
      handler: async (args, context) =>
        listCustomFieldDefinitions(
          context,
          resolveProjectId(args, context, true),
          (getOptionalString(args, "work_item_type") as WorkItemType | undefined) ?? "issue"
        )
    },
    {
      name: "gitlab_move_work_item",
      title: "Move Work Item",
      description: "Move a work item to a different project.",
      capabilities: writeGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        target_project_id: projectIdSchema
      },
      handler: async (args, context) =>
        moveWorkItem(
          context,
          resolveProjectId(args, context, true),
          getNumber(args, "iid"),
          resolveExplicitProjectId(context, getString(args, "target_project_id"))
        )
    },
    {
      name: "gitlab_list_work_item_notes",
      title: "List Work Item Notes",
      description: "List threaded discussions and notes on a work item.",
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        page_size: z.coerce.number().int().positive().max(100).optional(),
        after: optionalString,
        sort: z.enum(["CREATED_ASC", "CREATED_DESC"]).optional()
      },
      handler: async (args, context) =>
        listWorkItemNotes(context, resolveProjectId(args, context, true), getNumber(args, "iid"), {
          pageSize: getOptionalNumber(args, "page_size"),
          after: getOptionalString(args, "after"),
          sort: getOptionalString(args, "sort")
        })
    },
    {
      name: "gitlab_create_work_item_note",
      title: "Create Work Item Note",
      description: "Add a note or threaded reply to a work item.",
      capabilities: writeGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        body: bodySchema,
        internal: optionalCoercedBoolean,
        discussion_id: optionalString
      },
      handler: async (args, context) =>
        createWorkItemNote(
          context,
          resolveProjectId(args, context, true),
          getNumber(args, "iid"),
          getString(args, "body"),
          {
            internal: getOptionalBoolean(args, "internal"),
            discussionId: getOptionalString(args, "discussion_id")
          }
        )
    },
    {
      name: "gitlab_list_work_item_emoji_reactions",
      title: "List Work Item Emoji Reactions",
      description: "List emoji reactions on a work item.",
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema
      },
      handler: async (args, context) =>
        listGraphqlAwardEmoji(
          context,
          (
            await resolveWorkItemGid(
              context,
              resolveProjectId(args, context, true),
              getNumber(args, "iid")
            )
          ).workItemGid
        )
    },
    {
      name: "gitlab_list_work_item_note_emoji_reactions",
      title: "List Work Item Note Emoji Reactions",
      description: "List emoji reactions on a work item note by GraphQL note_id.",
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        note_id: z.string().min(1)
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const noteId = await resolveWorkItemNoteAwardableId(
          context,
          projectId,
          getNumber(args, "iid"),
          getString(args, "note_id")
        );
        return listGraphqlAwardEmoji(context, noteId);
      }
    },
    {
      name: "gitlab_create_work_item_emoji_reaction",
      title: "Create Work Item Emoji Reaction",
      description: "Add an emoji reaction to a work item, for example thumbsup, rocket, or eyes.",
      capabilities: writeGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        name: emojiNameSchema
      },
      handler: async (args, context) =>
        addGraphqlAwardEmoji(
          context,
          (
            await resolveWorkItemGid(
              context,
              resolveProjectId(args, context, true),
              getNumber(args, "iid")
            )
          ).workItemGid,
          getString(args, "name")
        )
    },
    {
      name: "gitlab_delete_work_item_emoji_reaction",
      title: "Delete Work Item Emoji Reaction",
      description:
        "Remove the current user's emoji reaction from a work item by emoji name. Requires iid and name.",
      capabilities: deleteGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        name: emojiNameSchema
      },
      handler: async (args, context) =>
        removeGraphqlAwardEmoji(
          context,
          (
            await resolveWorkItemGid(
              context,
              resolveProjectId(args, context, true),
              getNumber(args, "iid")
            )
          ).workItemGid,
          getString(args, "name")
        )
    },
    {
      name: "gitlab_create_work_item_note_emoji_reaction",
      title: "Create Work Item Note Emoji Reaction",
      description: "Add an emoji reaction to a work item note by GraphQL note_id.",
      capabilities: writeGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        note_id: z.string().min(1),
        name: emojiNameSchema
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const noteId = await resolveWorkItemNoteAwardableId(
          context,
          projectId,
          getNumber(args, "iid"),
          getString(args, "note_id")
        );
        return addGraphqlAwardEmoji(context, noteId, getString(args, "name"));
      }
    },
    {
      name: "gitlab_delete_work_item_note_emoji_reaction",
      title: "Delete Work Item Note Emoji Reaction",
      description:
        "Remove the current user's emoji reaction from a work item note by GraphQL note_id and emoji name.",
      capabilities: deleteGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        iid: workItemIidSchema,
        note_id: z.string().min(1),
        name: emojiNameSchema
      },
      handler: async (args, context) => {
        const projectId = resolveProjectId(args, context, true);
        const noteId = await resolveWorkItemNoteAwardableId(
          context,
          projectId,
          getNumber(args, "iid"),
          getString(args, "note_id")
        );
        return removeGraphqlAwardEmoji(context, noteId, getString(args, "name"));
      }
    },
    {
      name: "gitlab_get_timeline_events",
      title: "Get Timeline Events",
      description: "List timeline events for an incident work item.",
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        incident_iid: workItemIidSchema
      },
      handler: async (args, context) =>
        getTimelineEvents(
          context,
          resolveProjectId(args, context, true),
          getNumber(args, "incident_iid")
        )
    },
    {
      name: "gitlab_create_timeline_event",
      title: "Create Timeline Event",
      description:
        "Create an incident timeline event with optional known GitLab incident timeline tags.",
      capabilities: writeGraphqlCapabilities,
      inputSchema: {
        project_id: optionalProjectIdSchema,
        incident_iid: workItemIidSchema,
        note: bodySchema,
        occurred_at: z.string().min(1),
        tag_names: nullableOptional(
          z.array(
            z.enum([
              "Start time",
              "End time",
              "Impact detected",
              "Response initiated",
              "Impact mitigated",
              "Cause identified"
            ])
          )
        )
      },
      handler: async (args, context) =>
        createTimelineEvent(
          context,
          resolveProjectId(args, context, true),
          getNumber(args, "incident_iid"),
          getString(args, "note"),
          getString(args, "occurred_at"),
          getOptionalStringArray(args, "tag_names")
        )
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
      description:
        "Execute a GraphQL mutation. Readonly mode disables this tool; modify mode rejects destructive mutation-root fields.",
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
        assertGraphqlDocumentAllowedByPermissionMode(query, context.env.GITLAB_PERMISSION_MODE);

        return context.gitlab.executeGraphql(query, getOptionalRecord(args, "variables"));
      }
    },
    {
      name: "gitlab_execute_graphql",
      compatibilityAlias: true,
      title: "Execute GraphQL (Compat)",
      description:
        "Backward-compatible GraphQL executor. Mutation payloads still honor permission-mode policy.",
      capabilities: readGraphqlCapabilities,
      inputSchema: {
        query: z.string().min(1),
        variables: optionalRecord
      },
      handler: async (args, context) => {
        const query = getString(args, "query");
        const containsMutation = containsGraphqlMutation(query);
        if (containsMutation) {
          context.policy.assertCanExecute({
            name: "gitlab_execute_graphql",
            capabilities: writeGraphqlCapabilities
          });
        }
        assertGraphqlDocumentAllowedByPermissionMode(query, context.env.GITLAB_PERMISSION_MODE);

        return context.gitlab.executeGraphql(query, getOptionalRecord(args, "variables"));
      }
    }
  ];

  return definitions.map((definition) => {
    const scope = resolveToolScopeMetadata(definition.name);
    assertScopeMetadataMatchesDefinition(definition, scope);
    return { ...definition, scope };
  });
}

function shouldReturnDownloadProxy(context: AppContext): boolean {
  return !context.allowLocalFileTools && resolveDownloadTokenAuth(context) !== undefined;
}

function buildDownloadProxyResult(
  context: AppContext,
  resource: DownloadTokenResource,
  filename: string
): Record<string, unknown> {
  return {
    download_url: buildDownloadProxyUrl(context, resource),
    filename,
    expires_in_seconds: context.env.GITLAB_DOWNLOAD_TOKEN_TTL_SECONDS
  };
}

function buildDownloadProxyUrl(context: AppContext, resource: DownloadTokenResource): string {
  const baseUrl = new URL(
    context.env.MCP_SERVER_URL ?? `http://${context.env.HTTP_HOST}:${String(context.env.HTTP_PORT)}`
  );
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  const url = new URL(`${basePath}/downloads/${encodeURIComponent(resource.type)}`, baseUrl.origin);

  for (const [key, value] of Object.entries(resource.params)) {
    url.searchParams.set(key, value);
  }

  const tokenAuth = resolveDownloadTokenAuth(context);
  if (tokenAuth) {
    url.searchParams.set(
      "_token",
      createDownloadToken(tokenAuth, resource, {
        secret: context.env.GITLAB_DOWNLOAD_TOKEN_SECRET,
        ttlSeconds: context.env.GITLAB_DOWNLOAD_TOKEN_TTL_SECONDS
      })
    );
  }

  return url.toString();
}

function resolveDownloadTokenAuth(context: AppContext):
  | {
      header: "authorization" | "private-token" | "job-token";
      token: string;
      apiUrl?: string;
    }
  | undefined {
  const sessionAuth = getSessionAuth();
  if (sessionAuth?.token) {
    return {
      header: sessionAuth.header ?? "private-token",
      token: sessionAuth.token,
      apiUrl:
        context.env.ENABLE_DYNAMIC_API_URL && sessionAuth.apiUrl !== context.env.GITLAB_API_URL
          ? sessionAuth.apiUrl
          : undefined
    };
  }

  if (context.env.GITLAB_PERSONAL_ACCESS_TOKEN) {
    return {
      header: "private-token",
      token: context.env.GITLAB_PERSONAL_ACCESS_TOKEN
    };
  }

  if (context.env.GITLAB_JOB_TOKEN) {
    return {
      header: "job-token",
      token: context.env.GITLAB_JOB_TOKEN
    };
  }

  return undefined;
}

function assertAuthReady(context: AppContext): void {
  const auth = getSessionAuth();

  if (context.env.REMOTE_AUTHORIZATION || context.env.GITLAB_MCP_OAUTH) {
    const token = auth?.token;
    if (!token) {
      throw new Error(
        context.env.REMOTE_AUTHORIZATION
          ? "Missing remote authorization token for this session"
          : "Missing OAuth authorization token for this session"
      );
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

/* eslint-disable @typescript-eslint/no-explicit-any -- GitLab Work Items GraphQL widgets are polymorphic and only partially typed by GitLab. */
type WorkItemType = (typeof workItemTypes)[number];

interface WorkItemReference {
  project_id: string;
  iid: number;
}

interface LinkedWorkItemReference extends WorkItemReference {
  link_type?: "RELATED" | "BLOCKED_BY" | "BLOCKS";
}

interface WorkItemCustomFieldInput {
  custom_field_id: string;
  text_value?: string;
  number_value?: number;
  selected_option_ids?: string[];
  date_value?: string;
}

interface WorkItemCreateOptions {
  title: string;
  type?: WorkItemType;
  description?: string;
  labels?: string[];
  assigneeUsernames?: string[];
  parentIid?: number;
  weight?: number;
  healthStatus?: string;
  startDate?: string;
  dueDate?: string;
  milestoneId?: string;
  iterationId?: string;
  confidential?: boolean;
}

interface WorkItemUpdateOptions {
  title?: string;
  description?: string;
  addLabels?: string[];
  removeLabels?: string[];
  assigneeUsernames?: string[];
  stateEvent?: "close" | "reopen";
  weight?: number;
  status?: string;
  parentIid?: number;
  parentProjectId?: string;
  removeParent?: boolean;
  childrenToAdd?: WorkItemReference[];
  childrenToRemove?: WorkItemReference[];
  healthStatus?: string;
  startDate?: string;
  dueDate?: string;
  milestoneId?: string;
  iterationId?: string;
  confidential?: boolean;
  linkedItemsToAdd?: LinkedWorkItemReference[];
  linkedItemsToRemove?: WorkItemReference[];
  customFields?: WorkItemCustomFieldInput[];
  severity?: string;
  escalationStatus?: string;
}

const WORK_ITEM_TYPE_NAMES: Record<WorkItemType, string> = {
  issue: "Issue",
  task: "Task",
  incident: "Incident",
  test_case: "Test Case",
  epic: "Epic",
  key_result: "Key Result",
  objective: "Objective",
  requirement: "Requirement",
  ticket: "Ticket"
};

const WORK_ITEM_GRAPHQL_TYPES: Record<WorkItemType, string> = {
  issue: "ISSUE",
  task: "TASK",
  incident: "INCIDENT",
  test_case: "TEST_CASE",
  epic: "EPIC",
  key_result: "KEY_RESULT",
  objective: "OBJECTIVE",
  requirement: "REQUIREMENT",
  ticket: "TICKET"
};

async function executeGraphqlData<T>(
  context: AppContext,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const response = (await context.gitlab.executeGraphql(query, variables)) as
    | { data?: T; errors?: Array<{ message?: string }> }
    | T;

  if (
    typeof response === "object" &&
    response !== null &&
    "errors" in response &&
    Array.isArray((response as { errors?: unknown }).errors)
  ) {
    const errors = (response as { errors: Array<{ message?: string }> }).errors;
    throw new Error(
      `GraphQL errors: ${errors.map((item) => item.message ?? String(item)).join(", ")}`
    );
  }

  if (typeof response === "object" && response !== null && "data" in response) {
    return (response as { data?: T }).data as T;
  }

  return response as T;
}

async function listCiCatalogResources(args: ToolArgs, context: AppContext): Promise<unknown> {
  const data = await executeGraphqlData<{
    ciCatalogResources?: Record<string, unknown> | null;
  }>(
    context,
    `query ListCiCatalogResources(
      $search: String
      $first: Int
      $after: String
      $groupIds: [GroupID!]
      $scope: CiCatalogResourceScope
      $sort: CiCatalogResourceSort
      $topics: [String!]
      $verificationLevel: CiCatalogResourceVerificationLevel
    ) {
      ciCatalogResources(
        search: $search
        first: $first
        after: $after
        groupIds: $groupIds
        scope: $scope
        sort: $sort
        topics: $topics
        verificationLevel: $verificationLevel
      ) {
        nodes {
          id
          name
          description
          fullPath
          icon
          starCount
          topics
          verificationLevel
          visibilityLevel
          webPath
          latestReleasedAt
          last30DayUsageCount
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    {
      search: getOptionalString(args, "search"),
      first: getOptionalNumber(args, "first") ?? 20,
      after: getOptionalString(args, "after"),
      groupIds: getOptionalStringArray(args, "group_ids"),
      scope: getOptionalString(args, "scope"),
      sort: getOptionalString(args, "sort"),
      topics: getOptionalStringArray(args, "topics"),
      verificationLevel: getOptionalString(args, "verification_level")
    }
  );

  return data.ciCatalogResources ?? null;
}

async function getCiCatalogResource(args: ToolArgs, context: AppContext): Promise<unknown> {
  const id = getOptionalString(args, "id");
  const fullPath = getOptionalString(args, "full_path");
  if (Boolean(id) === Boolean(fullPath)) {
    throw new Error("Provide exactly one of 'id' or 'full_path'");
  }

  const data = await executeGraphqlData<{
    ciCatalogResource?: Record<string, unknown> | null;
  }>(
    context,
    `query GetCiCatalogResource(
      $id: CiCatalogResourceID
      $fullPath: ID
      $versionLimit: Int!
      $versionAfter: String
      $componentLimit: Int!
      $componentAfter: String
      $includeReadme: Boolean!
    ) {
      ciCatalogResource(id: $id, fullPath: $fullPath) {
        id
        name
        description
        fullPath
        icon
        starCount
        topics
        verificationLevel
        visibilityLevel
        webPath
        latestReleasedAt
        last30DayUsageCount
        versions(first: $versionLimit, after: $versionAfter) {
          nodes {
            id
            name
            path
            createdAt
            releasedAt
            readme @include(if: $includeReadme)
            semver { major minor patch }
            components(first: $componentLimit, after: $componentAfter) {
              nodes {
                id
                name
                description
                includePath
                last30DayUsageCount
                inputs {
                  name
                  description
                  type
                  required
                  default
                  options
                  regex
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    {
      id,
      fullPath,
      versionLimit: getOptionalNumber(args, "version_limit") ?? 5,
      versionAfter: getOptionalString(args, "version_after"),
      componentLimit: getOptionalNumber(args, "component_limit") ?? 20,
      componentAfter: getOptionalString(args, "component_after"),
      includeReadme: getOptionalBoolean(args, "include_readme") ?? false
    }
  );

  const resource = data.ciCatalogResource ?? null;
  const componentName = getOptionalString(args, "component_name");
  if (!resource || !componentName) {
    return resource;
  }

  return filterCiCatalogComponents(resource, componentName);
}

function filterCiCatalogComponents(
  resource: Record<string, unknown>,
  componentName: string
): Record<string, unknown> {
  const versions = resource.versions;
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    return resource;
  }

  const versionConnection = versions as Record<string, unknown>;
  if (!Array.isArray(versionConnection.nodes)) {
    return resource;
  }

  return {
    ...resource,
    versions: {
      ...versionConnection,
      nodes: versionConnection.nodes.map((version) => {
        if (!version || typeof version !== "object" || Array.isArray(version)) {
          return version;
        }
        const versionRecord = version as Record<string, unknown>;
        const components = versionRecord.components;
        if (!components || typeof components !== "object" || Array.isArray(components)) {
          return version;
        }
        const componentConnection = components as Record<string, unknown>;
        if (!Array.isArray(componentConnection.nodes)) {
          return version;
        }

        return {
          ...versionRecord,
          components: {
            ...componentConnection,
            nodes: componentConnection.nodes.filter(
              (component) =>
                component &&
                typeof component === "object" &&
                !Array.isArray(component) &&
                (component as Record<string, unknown>).name === componentName
            )
          }
        };
      })
    }
  };
}

const CI_VARIABLE_SAFE_RESPONSE_FIELDS = [
  "key",
  "variable_type",
  "protected",
  "masked",
  "masked_and_hidden",
  "hidden",
  "raw",
  "environment_scope",
  "description"
] as const;

function shouldIncludeCiVariableValue(args: ToolArgs, context: AppContext): boolean {
  return (
    context.env.GITLAB_ALLOW_CI_VARIABLE_VALUES &&
    getOptionalBoolean(args, "include_value") === true
  );
}

function projectCiVariableResponse(value: unknown, includeValue: boolean): unknown {
  if (Array.isArray(value)) {
    return copyPaginationMetadata(
      value,
      value.map((item) => projectCiVariableResponse(item, includeValue))
    );
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const field of CI_VARIABLE_SAFE_RESPONSE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      output[field] = input[field];
    }
  }
  if (includeValue && Object.prototype.hasOwnProperty.call(input, "value")) {
    output.value = input.value;
  }

  return output;
}

function ciVariableFilterQuery(args: ToolArgs): Record<string, string> {
  const filter = getOptionalRecord(args, "filter");
  if (!filter) {
    return {};
  }

  const environmentScope = filter.environment_scope;
  if (typeof environmentScope !== "string" || environmentScope.length === 0) {
    throw new Error("'filter.environment_scope' must be a non-empty string");
  }

  return { "filter[environment_scope]": environmentScope };
}

function ciVariablePayload(args: ToolArgs, includeCreateOnlyFields: boolean): ToolArgs {
  const fields = [
    "value",
    "variable_type",
    "protected",
    "masked",
    "raw",
    "environment_scope",
    "description"
  ];
  if (includeCreateOnlyFields) {
    fields.unshift("key");
    fields.push("masked_and_hidden");
  }

  const payload: ToolArgs = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(args, field)) {
      payload[field] = args[field];
    }
  }
  return payload;
}

interface DependencyProxyGroupData {
  dependencyProxySetting?: { enabled?: boolean; identity?: string | null } | null;
  dependencyProxyBlobCount?: number | null;
  dependencyProxyImageCount?: number | null;
  dependencyProxyTotalSize?: string | null;
  dependencyProxyTotalSizeBytes?: string | number | null;
  dependencyProxyImagePrefix?: string | null;
  dependencyProxyImageTtlPolicy?: {
    enabled?: boolean;
    ttl?: number | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  } | null;
}

async function getDependencyProxySettings(args: ToolArgs, context: AppContext): Promise<unknown> {
  const fullPath = await resolveDependencyProxyGroupFullPath(getString(args, "group_id"), context);
  return getDependencyProxySettingsForFullPath(fullPath, context);
}

async function getDependencyProxySettingsForFullPath(
  fullPath: string,
  context: AppContext
): Promise<unknown> {
  const data = await executeGraphqlData<{ group?: DependencyProxyGroupData | null }>(
    context,
    `query GetDependencyProxySettings($fullPath: ID!) {
      group(fullPath: $fullPath) {
        dependencyProxySetting { enabled identity }
        dependencyProxyBlobCount
        dependencyProxyImageCount
        dependencyProxyTotalSize
        dependencyProxyTotalSizeBytes
        dependencyProxyImagePrefix
        dependencyProxyImageTtlPolicy { enabled ttl createdAt updatedAt }
      }
    }`,
    { fullPath }
  );
  const group = data.group;
  if (!group) {
    throw new Error(`Group not found: ${fullPath}`);
  }

  return {
    enabled: group.dependencyProxySetting?.enabled ?? false,
    identity: group.dependencyProxySetting?.identity ?? null,
    blob_count: group.dependencyProxyBlobCount ?? 0,
    image_count: group.dependencyProxyImageCount ?? 0,
    total_size: group.dependencyProxyTotalSize ?? null,
    total_size_bytes: group.dependencyProxyTotalSizeBytes ?? null,
    image_prefix: group.dependencyProxyImagePrefix ?? null,
    ttl_policy: group.dependencyProxyImageTtlPolicy ?? null
  };
}

async function updateDependencyProxySettings(
  args: ToolArgs,
  context: AppContext
): Promise<unknown> {
  const settingNames = ["enabled", "identity", "secret"] as const;
  if (!settingNames.some((name) => Object.prototype.hasOwnProperty.call(args, name))) {
    throw new Error("Provide at least one of 'enabled', 'identity', or 'secret'");
  }

  const fullPath = await resolveDependencyProxyGroupFullPath(getString(args, "group_id"), context);
  const input: Record<string, unknown> = { groupPath: fullPath };
  for (const name of settingNames) {
    if (Object.prototype.hasOwnProperty.call(args, name)) {
      input[name] = args[name];
    }
  }

  const data = await executeGraphqlData<{
    updateDependencyProxySettings?: { errors?: string[] | null } | null;
  }>(
    context,
    `mutation UpdateDependencyProxySettings($input: UpdateDependencyProxySettingsInput!) {
      updateDependencyProxySettings(input: $input) {
        errors
      }
    }`,
    { input }
  );
  const errors = data.updateDependencyProxySettings?.errors ?? [];
  if (errors.length > 0) {
    throw new Error(`Failed to update Dependency Proxy settings: ${errors.join(", ")}`);
  }

  return getDependencyProxySettingsForFullPath(fullPath, context);
}

async function listDependencyProxyBlobs(args: ToolArgs, context: AppContext): Promise<unknown> {
  const fullPath = await resolveDependencyProxyGroupFullPath(getString(args, "group_id"), context);
  const data = await executeGraphqlData<{
    group?: {
      dependencyProxyBlobs?: {
        nodes?: Array<{
          fileName?: string;
          size?: string;
          createdAt?: string | null;
          updatedAt?: string | null;
        } | null> | null;
        pageInfo?: Record<string, unknown> | null;
      } | null;
    } | null;
  }>(
    context,
    `query ListDependencyProxyBlobs($fullPath: ID!, $first: Int, $after: String) {
      group(fullPath: $fullPath) {
        dependencyProxyBlobs(first: $first, after: $after) {
          nodes { fileName size createdAt updatedAt }
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        }
      }
    }`,
    {
      fullPath,
      first: getOptionalNumber(args, "first") ?? 20,
      after: getOptionalString(args, "after")
    }
  );
  if (!data.group) {
    throw new Error(`Group not found: ${fullPath}`);
  }
  const connection = data.group.dependencyProxyBlobs;
  if (!connection) {
    throw new Error(`Dependency Proxy is unavailable for group: ${fullPath}`);
  }

  return {
    blobs: (connection.nodes ?? [])
      .filter((node): node is NonNullable<typeof node> => node !== null)
      .map((node) => ({
        file_name: node.fileName,
        size: node.size,
        created_at: node.createdAt ?? null,
        updated_at: node.updatedAt ?? null
      })),
    pageInfo: connection.pageInfo ?? null
  };
}

async function resolveDependencyProxyGroupFullPath(
  groupId: string,
  context: AppContext
): Promise<string> {
  let decodedGroupId: string;
  try {
    decodedGroupId = decodeURIComponent(groupId);
  } catch {
    throw new Error("'group_id' must be a valid group ID or URL-encoded path");
  }

  if (!/^\d+$/.test(decodedGroupId)) {
    return decodedGroupId;
  }

  const group = await context.gitlab.getGroup(decodedGroupId);
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    throw new Error(`Group not found: ${decodedGroupId}`);
  }
  const fullPath = (group as Record<string, unknown>).full_path;
  if (typeof fullPath !== "string" || fullPath.length === 0) {
    throw new Error(`GitLab group '${decodedGroupId}' did not return a full_path`);
  }

  return fullPath;
}

function resolveExplicitProjectId(context: AppContext, projectId: string): string {
  const allowed = context.env.GITLAB_ALLOWED_PROJECT_IDS;
  if (allowed.length > 0 && !isGitLabProjectIdentityAllowed(projectId, allowed)) {
    throw new Error(
      `Project '${projectId}' is not in GITLAB_ALLOWED_PROJECT_IDS: ${allowed.join(", ")}`
    );
  }
  return projectId;
}

function resolveOptionalExplicitProjectId(
  context: AppContext,
  projectId: string | undefined
): string | undefined {
  return projectId ? resolveExplicitProjectId(context, projectId) : undefined;
}

function filterProjectScopedResponse(
  value: unknown,
  context: AppContext,
  identityKind: "project" | "resource"
): unknown {
  const allowed = context.env.GITLAB_ALLOWED_PROJECT_IDS;
  if (allowed.length === 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return copyPaginationMetadataAfterLocalFilter(
      value,
      value.filter(
        (item): item is Record<string, unknown> =>
          isObjectRecord(item) && recordMatchesAllowedProject(item, allowed, identityKind)
      )
    );
  }

  if (isObjectRecord(value) && Array.isArray(value.items)) {
    const items = value.items.filter(
      (item): item is Record<string, unknown> =>
        isObjectRecord(item) && recordMatchesAllowedProject(item, allowed, identityKind)
    );
    return copyPaginationMetadataAfterLocalFilter(value, {
      ...value,
      items,
      count: items.length
    });
  }

  return [];
}

function recordMatchesAllowedProject(
  record: Record<string, unknown>,
  allowedProjectIds: readonly string[],
  identityKind: "project" | "resource" = "resource"
): boolean {
  const project = isObjectRecord(record.project) ? record.project : undefined;
  const target = isObjectRecord(record.target) ? record.target : undefined;
  const targetProject = target && isObjectRecord(target.project) ? target.project : undefined;
  const candidates = [
    ...(identityKind === "project"
      ? [record.id, record.path_with_namespace, record.full_path]
      : []),
    record.project_id,
    project?.id,
    project?.path_with_namespace,
    project?.full_path,
    target?.project_id,
    targetProject?.id,
    targetProject?.path_with_namespace,
    targetProject?.full_path
  ];

  return candidates.some(
    (candidate) =>
      (typeof candidate === "string" || typeof candidate === "number") &&
      isGitLabProjectIdentityAllowed(String(candidate), allowedProjectIds)
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function discoverGitLabTools(args: ToolArgs, context: AppContext): Record<string, unknown> {
  const query = getOptionalString(args, "query")?.toLowerCase();
  const requestedToolset = getOptionalString(args, "toolset") as GitLabToolset | undefined;
  const requestedCapability = getOptionalString(args, "capability") as ToolCapability | undefined;
  const includeDisabled = getBoolean(args, "include_disabled");
  const limit = getNumber(args, "limit");

  const matches = getGitLabToolDefinitions()
    .filter((definition) => definition.name !== "gitlab_discover_tools")
    .map((definition) => {
      const toolsets = toolsetsForTool(definition.name);
      const disabledReasons = getToolDisabledReasons(definition, context);
      return {
        name: definition.name,
        title: definition.title,
        description: definition.description,
        capabilities: definition.capabilities,
        scope: definition.scope.kind,
        toolsets,
        enabled: disabledReasons.length === 0,
        ...(disabledReasons.length > 0 ? { disabled_reasons: disabledReasons } : {})
      };
    })
    .filter((tool) => {
      if (!includeDisabled && !tool.enabled) {
        return false;
      }
      if (
        requestedToolset &&
        requestedToolset !== "all" &&
        !tool.toolsets.includes(requestedToolset)
      ) {
        return false;
      }
      if (requestedCapability && !tool.capabilities.includes(requestedCapability)) {
        return false;
      }
      if (!query) {
        return true;
      }
      return `${tool.name} ${tool.title} ${tool.description}`.toLowerCase().includes(query);
    })
    .sort(
      (left, right) =>
        Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name)
    );

  return {
    total_matches: matches.length,
    returned: Math.min(matches.length, limit),
    tools: matches.slice(0, limit),
    note: "Discovery is read-only. Change GITLAB_TOOLSETS or the policy configuration and reconnect to expose disabled tools."
  };
}

function getToolDisabledReasons(definition: GitLabToolDefinition, context: AppContext): string[] {
  const reasons: string[] = [];
  const policyMeta = {
    name: definition.name,
    capabilities: definition.capabilities,
    requiresFeature: definition.requiresFeature
  };

  if (!context.policy.isToolEnabled(policyMeta)) {
    reasons.push("policy");
  }
  if (!isToolEnabledByToolsets(definition.name, context.env.GITLAB_TOOLSETS)) {
    reasons.push("toolset");
  }
  if (!isExplicitlyEnabled(definition, context)) {
    reasons.push("explicit_enable");
  }
  if (!isToolVisibleForProjectScope(definition, context.env.GITLAB_ALLOWED_PROJECT_IDS)) {
    reasons.push("project_scope");
  }
  if (definition.requiresLocalFileTools && !context.allowLocalFileTools) {
    reasons.push("transport");
  }
  if (definition.compatibilityAlias && !context.env.GITLAB_ENABLE_COMPATIBILITY_ALIASES) {
    reasons.push("compatibility_alias");
  }

  return reasons;
}

async function assertTodoProjectAllowed(todoId: string, context: AppContext): Promise<void> {
  const allowed = context.env.GITLAB_ALLOWED_PROJECT_IDS;
  if (allowed.length === 0) {
    return;
  }

  const perPage = 100;
  for (let page = 1; page <= 100; page += 1) {
    const todos = extractRecords(
      await context.gitlab.listTodos({
        query: {
          state: "pending",
          page,
          per_page: perPage
        }
      })
    );
    const todo = todos.find((item) => String(item.id) === todoId);
    if (todo) {
      if (!recordMatchesAllowedProject(todo, allowed)) {
        throw new Error(
          `Todo '${todoId}' does not belong to a project in GITLAB_ALLOWED_PROJECT_IDS`
        );
      }
      return;
    }

    if (todos.length < perPage) {
      break;
    }
  }

  throw new Error(
    `Todo '${todoId}' could not be verified against GITLAB_ALLOWED_PROJECT_IDS and was not modified`
  );
}

async function resolveProjectPathForWorkItem(
  context: AppContext,
  projectId: string
): Promise<string> {
  let project: unknown;
  try {
    project = await context.gitlab.getProject(projectId);
  } catch (error) {
    if (
      !(error instanceof GitLabApiError) ||
      error.status !== 404 ||
      context.env.GITLAB_ALLOWED_PROJECT_IDS.length > 0
    ) {
      throw error;
    }

    let decodedId: string;
    try {
      decodedId = decodeURIComponent(projectId);
    } catch {
      throw error;
    }

    // Numeric project and group IDs occupy separate namespaces. Falling back
    // could silently resolve an unrelated group that happens to share the ID.
    if (/^\d+$/u.test(decodedId)) {
      throw error;
    }

    const group = await context.gitlab.getGroup(decodedId);
    if (!isObjectRecord(group) || typeof group.full_path !== "string" || !group.full_path) {
      throw new Error(`GitLab group '${decodedId}' did not return a full_path`);
    }
    return group.full_path;
  }

  if (!isObjectRecord(project)) {
    throw new Error(`Project '${projectId}' returned an invalid response`);
  }
  const pathWithNamespace = project.path_with_namespace;

  if (typeof pathWithNamespace === "string" && pathWithNamespace.length > 0) {
    return pathWithNamespace;
  }

  if (projectId.includes("/")) {
    return projectId;
  }

  throw new Error(`Project '${projectId}' did not include path_with_namespace`);
}

async function resolveWorkItemGid(
  context: AppContext,
  projectId: string,
  iid: number
): Promise<{ workItemGid: string; projectPath: string }> {
  const projectPath = await resolveProjectPathForWorkItem(context, projectId);
  const data = await executeGraphqlData<{
    namespace?: { workItem?: { id?: string } | null } | null;
  }>(
    context,
    `query($path: ID!, $iid: String!) {
      namespace(fullPath: $path) {
        workItem(iid: $iid) { id }
      }
    }`,
    { path: projectPath, iid: String(iid) }
  );
  const workItemGid = data.namespace?.workItem?.id;

  if (!workItemGid) {
    throw new Error(`Work item #${iid} not found in project ${projectPath}`);
  }

  return { workItemGid, projectPath };
}

async function resolveWorkItemTypeGid(
  context: AppContext,
  projectPath: string,
  type: WorkItemType
): Promise<string> {
  const targetName = WORK_ITEM_TYPE_NAMES[type];
  const data = await executeGraphqlData<{
    namespace?: { workItemTypes?: { nodes?: Array<{ id: string; name: string }> } } | null;
  }>(
    context,
    `query($path: ID!) {
      namespace(fullPath: $path) {
        workItemTypes { nodes { id name } }
      }
    }`,
    { path: projectPath }
  );
  const match = data.namespace?.workItemTypes?.nodes?.find((item) => item.name === targetName);

  if (!match) {
    throw new Error(`Work item type '${targetName}' not found in project ${projectPath}`);
  }

  return match.id;
}

async function resolveNamesToIds(
  context: AppContext,
  projectPath: string,
  labelNames?: string[],
  usernames?: string[]
): Promise<{ labelIds: string[]; userIds: string[] }> {
  if ((!labelNames || labelNames.length === 0) && (!usernames || usernames.length === 0)) {
    return { labelIds: [], userIds: [] };
  }

  const data = await executeGraphqlData<{
    project?: { labels?: { nodes?: Array<{ id: string; title: string }> } } | null;
    users?: { nodes?: Array<{ id: string; username: string }> };
  }>(
    context,
    `query($path: ID!, $usernames: [String!]!) {
      project(fullPath: $path) {
        labels(includeAncestorGroups: true, first: 250) { nodes { id title } }
      }
      users(usernames: $usernames) { nodes { id username } }
    }`,
    { path: projectPath, usernames: usernames ?? [] }
  );

  const labels = data.project?.labels?.nodes ?? [];
  const users = data.users?.nodes ?? [];
  const labelIds = (labelNames ?? []).map((name) => {
    const label = labels.find((item) => item.title === name);
    if (!label) {
      throw new Error(`Label '${name}' not found in project ${projectPath}`);
    }
    return label.id;
  });
  const userIds = (usernames ?? []).map((username) => {
    const user = users.find((item) => item.username === username);
    if (!user) {
      throw new Error(`User '${username}' not found`);
    }
    return user.id;
  });

  return { labelIds, userIds };
}

function normalizeGlobalId(value: string, typeName: string): string {
  return value.startsWith("gid://") ? value : `gid://gitlab/${typeName}/${value}`;
}

function toWorkItemGraphqlType(type: WorkItemType): string {
  return WORK_ITEM_GRAPHQL_TYPES[type] ?? type.replace(/ /g, "_").toUpperCase();
}

function workItemTypeName(type: WorkItemType): string {
  return WORK_ITEM_TYPE_NAMES[type] ?? "Issue";
}

function findWidget(widgets: unknown, typename: string): Record<string, any> | undefined {
  if (!Array.isArray(widgets)) {
    return undefined;
  }
  return widgets.find(
    (item): item is Record<string, any> =>
      typeof item === "object" && item !== null && item.__typename === typename
  );
}

async function getWorkItem(context: AppContext, projectId: string, iid: number): Promise<unknown> {
  const projectPath = await resolveProjectPathForWorkItem(context, projectId);
  const data = await executeGraphqlData<{
    namespace?: { workItem?: Record<string, any> | null } | null;
  }>(
    context,
    `query($path: ID!, $iid: String!) {
      namespace(fullPath: $path) {
        workItem(iid: $iid) {
          id
          iid
          title
          state
          description
          webUrl
          confidential
          author { username }
          createdAt
          closedAt
          workItemType { name }
          widgets {
            __typename
            ... on WorkItemWidgetHierarchy {
              hasChildren
              hasParent
              parent { id iid title webUrl workItemType { name } namespace { fullPath } }
              children { nodes { id iid title state webUrl workItemType { name } namespace { fullPath } } }
            }
            ... on WorkItemWidgetStatus { status { id name category color iconName position } }
            ... on WorkItemWidgetCustomFields {
              customFieldValues {
                __typename
                customField { id name fieldType }
                ... on WorkItemNumberFieldValue { value }
                ... on WorkItemTextFieldValue { value }
                ... on WorkItemSelectFieldValue { selectedOptions { id value } }
              }
            }
            ... on WorkItemWidgetLabels { labels { nodes { id title color } } }
            ... on WorkItemWidgetAssignees { assignees { nodes { id username name } } }
            ... on WorkItemWidgetWeight { weight rolledUpWeight rolledUpCompletedWeight }
            ... on WorkItemWidgetHealthStatus { healthStatus }
            ... on WorkItemWidgetStartAndDueDate { startDate dueDate }
            ... on WorkItemWidgetMilestone { milestone { id title } }
            ... on WorkItemWidgetLinkedItems {
              blocked
              blockedByCount
              blockingCount
              linkedItems { nodes { linkType workItem { id iid title state webUrl workItemType { name } namespace { fullPath } } } }
            }
            ... on WorkItemWidgetTimeTracking { timeEstimate totalTimeSpent }
            ... on WorkItemWidgetDevelopment {
              willAutoCloseByMergeRequest
              relatedBranches { nodes { name } }
              relatedMergeRequests { nodes { iid title webUrl state sourceBranch } }
              closingMergeRequests { nodes { mergeRequest { iid title webUrl state sourceBranch } } }
              featureFlags { nodes { name active } }
            }
            ... on WorkItemWidgetIteration {
              iteration { id title startDate dueDate webUrl iterationCadence { id title } }
            }
            ... on WorkItemWidgetProgress { progress }
            ... on WorkItemWidgetColor { color textColor }
          }
        }
      }
    }`,
    { path: projectPath, iid: String(iid) }
  );
  const workItem = data.namespace?.workItem;

  if (!workItem) {
    throw new Error(`Work item #${iid} not found in project ${projectPath}`);
  }

  return flattenWorkItem(workItem);
}

function flattenWorkItem(workItem: Record<string, any>): Record<string, any> {
  const widgets = workItem.widgets ?? [];
  const hierarchy = findWidget(widgets, "WorkItemWidgetHierarchy");
  const status = findWidget(widgets, "WorkItemWidgetStatus");
  const labels = findWidget(widgets, "WorkItemWidgetLabels");
  const assignees = findWidget(widgets, "WorkItemWidgetAssignees");
  const weight = findWidget(widgets, "WorkItemWidgetWeight");
  const health = findWidget(widgets, "WorkItemWidgetHealthStatus");
  const dates = findWidget(widgets, "WorkItemWidgetStartAndDueDate");
  const milestone = findWidget(widgets, "WorkItemWidgetMilestone");
  const linked = findWidget(widgets, "WorkItemWidgetLinkedItems");
  const timeTracking = findWidget(widgets, "WorkItemWidgetTimeTracking");
  const development = findWidget(widgets, "WorkItemWidgetDevelopment");
  const customFields = findWidget(widgets, "WorkItemWidgetCustomFields");
  const iteration = findWidget(widgets, "WorkItemWidgetIteration");
  const progress = findWidget(widgets, "WorkItemWidgetProgress");
  const color = findWidget(widgets, "WorkItemWidgetColor");
  const result: Record<string, any> = {
    id: workItem.id,
    iid: workItem.iid,
    title: workItem.title,
    state: workItem.state,
    type: workItem.workItemType?.name,
    webUrl: workItem.webUrl
  };

  if (workItem.description) result.description = workItem.description;
  if (workItem.confidential) result.confidential = true;
  if (workItem.author?.username) result.author = workItem.author.username;
  if (workItem.createdAt) result.createdAt = workItem.createdAt;
  if (workItem.closedAt) result.closedAt = workItem.closedAt;
  if (status?.status) {
    result.status = {
      id: status.status.id,
      name: status.status.name,
      category: status.status.category
    };
  }

  const labelNames = (labels?.labels?.nodes ?? []).map((item: any) => item.title);
  if (labelNames.length > 0) result.labels = labelNames;

  const assigneeNames = (assignees?.assignees?.nodes ?? []).map((item: any) => item.username);
  if (assigneeNames.length > 0) result.assignees = assigneeNames;

  if (weight?.weight != null) {
    result.weight = weight.weight;
    if (weight.rolledUpWeight != null) result.rolledUpWeight = weight.rolledUpWeight;
    if (weight.rolledUpCompletedWeight != null) {
      result.rolledUpCompletedWeight = weight.rolledUpCompletedWeight;
    }
  }
  if (health?.healthStatus) result.healthStatus = health.healthStatus;
  if (dates?.startDate) result.startDate = dates.startDate;
  if (dates?.dueDate) result.dueDate = dates.dueDate;
  if (milestone?.milestone) result.milestone = milestone.milestone;
  if (iteration?.iteration) result.iteration = iteration.iteration;
  if (progress?.progress != null) result.progress = progress.progress;
  if (color?.color) result.color = color.color;

  if (hierarchy?.parent) {
    result.parent = {
      iid: hierarchy.parent.iid,
      title: hierarchy.parent.title,
      type: hierarchy.parent.workItemType?.name,
      project: hierarchy.parent.namespace?.fullPath,
      webUrl: hierarchy.parent.webUrl
    };
  }
  const children = hierarchy?.children?.nodes ?? [];
  if (children.length > 0) {
    result.children = children.map((item: any) => ({
      iid: item.iid,
      title: item.title,
      state: item.state,
      type: item.workItemType?.name,
      project: item.namespace?.fullPath,
      webUrl: item.webUrl
    }));
  }

  if (linked?.blocked) result.blocked = true;
  if ((linked?.blockedByCount ?? 0) > 0) result.blockedByCount = linked?.blockedByCount;
  if ((linked?.blockingCount ?? 0) > 0) result.blockingCount = linked?.blockingCount;
  const linkedItems = linked?.linkedItems?.nodes ?? [];
  if (linkedItems.length > 0) {
    result.linkedItems = linkedItems.map((item: any) => ({
      linkType: item.linkType,
      iid: item.workItem?.iid,
      title: item.workItem?.title,
      state: item.workItem?.state,
      type: item.workItem?.workItemType?.name,
      project: item.workItem?.namespace?.fullPath,
      webUrl: item.workItem?.webUrl
    }));
  }

  if ((timeTracking?.timeEstimate ?? 0) > 0) result.timeEstimate = timeTracking?.timeEstimate;
  if ((timeTracking?.totalTimeSpent ?? 0) > 0) {
    result.totalTimeSpent = timeTracking?.totalTimeSpent;
  }

  const relatedMergeRequests = development?.relatedMergeRequests?.nodes ?? [];
  const closingMergeRequests = (development?.closingMergeRequests?.nodes ?? []).map(
    (item: any) => item.mergeRequest
  );
  const branches = development?.relatedBranches?.nodes ?? [];
  const flags = development?.featureFlags?.nodes ?? [];
  if (
    relatedMergeRequests.length > 0 ||
    closingMergeRequests.length > 0 ||
    branches.length > 0 ||
    flags.length > 0
  ) {
    result.development = {};
    if (relatedMergeRequests.length > 0) {
      result.development.relatedMergeRequests = relatedMergeRequests;
    }
    if (closingMergeRequests.length > 0) {
      result.development.closingMergeRequests = closingMergeRequests;
    }
    if (branches.length > 0) {
      result.development.relatedBranches = branches.map((item: any) => item.name);
    }
    if (flags.length > 0) result.development.featureFlags = flags;
  }

  const fieldValues = (customFields?.customFieldValues ?? []).filter(
    (item: any) => item.value != null || item.selectedOptions != null
  );
  if (fieldValues.length > 0) {
    result.customFields = fieldValues.map((item: any) => ({
      name: item.customField?.name,
      type: item.customField?.fieldType,
      value: item.value ?? item.selectedOptions ?? null
    }));
  }

  return result;
}

async function listWorkItems(
  context: AppContext,
  projectId: string,
  options: {
    types?: WorkItemType[];
    state?: "opened" | "closed";
    search?: string;
    assigneeUsernames?: string[];
    labelNames?: string[];
    first?: number;
    after?: string;
  }
): Promise<unknown> {
  const projectPath = await resolveProjectPathForWorkItem(context, projectId);
  const variables: Record<string, unknown> = {
    path: projectPath,
    first: options.first ?? 20,
    types: options.types?.map(toWorkItemGraphqlType),
    state: options.state,
    search: options.search,
    assigneeUsernames: options.assigneeUsernames,
    labelName: options.labelNames,
    after: options.after
  };
  const data = await executeGraphqlData<{ project?: { workItems?: Record<string, any> } }>(
    context,
    `query($path: ID!, $types: [IssueType!], $state: IssuableState, $search: String, $assigneeUsernames: [String!], $labelName: [String!], $first: Int, $after: String) {
      project(fullPath: $path) {
        workItems(types: $types, state: $state, search: $search, assigneeUsernames: $assigneeUsernames, labelName: $labelName, first: $first, after: $after) {
          nodes {
            id iid title state webUrl workItemType { name }
            widgets {
              __typename
              ... on WorkItemWidgetStatus { status { id name category color } }
              ... on WorkItemWidgetLabels { labels { nodes { title } } }
              ... on WorkItemWidgetAssignees { assignees { nodes { username } } }
              ... on WorkItemWidgetWeight { weight }
              ... on WorkItemWidgetHealthStatus { healthStatus }
              ... on WorkItemWidgetStartAndDueDate { startDate dueDate }
              ... on WorkItemWidgetMilestone { milestone { id title } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`,
    variables
  );
  const nodes = data.project?.workItems?.nodes ?? [];

  return {
    items: nodes.map(flattenWorkItemSummary),
    pageInfo: data.project?.workItems?.pageInfo ?? {}
  };
}

function flattenWorkItemSummary(workItem: Record<string, any>): Record<string, any> {
  const widgets = workItem.widgets ?? [];
  const status = findWidget(widgets, "WorkItemWidgetStatus");
  const labels = findWidget(widgets, "WorkItemWidgetLabels");
  const assignees = findWidget(widgets, "WorkItemWidgetAssignees");
  const weight = findWidget(widgets, "WorkItemWidgetWeight");
  const health = findWidget(widgets, "WorkItemWidgetHealthStatus");
  const dates = findWidget(widgets, "WorkItemWidgetStartAndDueDate");
  const milestone = findWidget(widgets, "WorkItemWidgetMilestone");
  const item: Record<string, any> = {
    iid: workItem.iid,
    title: workItem.title,
    state: workItem.state,
    type: workItem.workItemType?.name,
    webUrl: workItem.webUrl
  };

  if (status?.status) item.status = status.status.name;
  const labelNames = (labels?.labels?.nodes ?? []).map((label: any) => label.title);
  if (labelNames.length > 0) item.labels = labelNames;
  const assigneeNames = (assignees?.assignees?.nodes ?? []).map(
    (assignee: any) => assignee.username
  );
  if (assigneeNames.length > 0) item.assignees = assigneeNames;
  if (weight?.weight != null) item.weight = weight.weight;
  if (health?.healthStatus) item.healthStatus = health.healthStatus;
  if (dates?.startDate) item.startDate = dates.startDate;
  if (dates?.dueDate) item.dueDate = dates.dueDate;
  if (milestone?.milestone) item.milestone = milestone.milestone.title;

  return item;
}

async function createWorkItem(
  context: AppContext,
  projectId: string,
  options: WorkItemCreateOptions
): Promise<unknown> {
  const projectPath = await resolveProjectPathForWorkItem(context, projectId);
  const typeId = await resolveWorkItemTypeGid(context, projectPath, options.type ?? "issue");
  const variableDefinitions = ["$projectPath: ID!", "$title: String!", "$typeId: WorkItemsTypeID!"];
  const inputParts = ["namespacePath: $projectPath", "title: $title", "workItemTypeId: $typeId"];
  const variables: Record<string, unknown> = {
    projectPath,
    title: options.title,
    typeId
  };

  if (options.description !== undefined) {
    variableDefinitions.push("$description: String!");
    inputParts.push("descriptionWidget: { description: $description }");
    variables.description = options.description;
  }

  const { labelIds, userIds } = await resolveNamesToIds(
    context,
    projectPath,
    options.labels,
    options.assigneeUsernames
  );
  if (labelIds.length > 0) {
    variableDefinitions.push("$labelIds: [LabelID!]!");
    inputParts.push("labelsWidget: { labelIds: $labelIds }");
    variables.labelIds = labelIds;
  }
  if (userIds.length > 0) {
    variableDefinitions.push("$assigneeIds: [UserID!]!");
    inputParts.push("assigneesWidget: { assigneeIds: $assigneeIds }");
    variables.assigneeIds = userIds;
  }
  if (options.weight !== undefined) {
    variableDefinitions.push("$weight: Int");
    inputParts.push("weightWidget: { weight: $weight }");
    variables.weight = options.weight;
  }
  if (options.parentIid !== undefined) {
    const { workItemGid: parentId } = await resolveWorkItemGid(
      context,
      projectId,
      options.parentIid
    );
    variableDefinitions.push("$parentId: WorkItemID");
    inputParts.push("hierarchyWidget: { parentId: $parentId }");
    variables.parentId = parentId;
  }
  if (options.healthStatus !== undefined) {
    variableDefinitions.push("$healthStatus: HealthStatus");
    inputParts.push("healthStatusWidget: { healthStatus: $healthStatus }");
    variables.healthStatus = options.healthStatus;
  }
  appendDateWidget(variableDefinitions, inputParts, variables, options.startDate, options.dueDate);
  if (options.milestoneId !== undefined) {
    variableDefinitions.push("$milestoneId: MilestoneID");
    inputParts.push("milestoneWidget: { milestoneId: $milestoneId }");
    variables.milestoneId = normalizeGlobalId(options.milestoneId, "Milestone");
  }
  if (options.iterationId !== undefined) {
    variableDefinitions.push("$iterationId: IterationID");
    inputParts.push("iterationWidget: { iterationId: $iterationId }");
    variables.iterationId = normalizeGlobalId(options.iterationId, "Iteration");
  }
  if (options.confidential !== undefined) {
    variableDefinitions.push("$confidential: Boolean");
    inputParts.push("confidential: $confidential");
    variables.confidential = options.confidential;
  }

  const data = await executeGraphqlData<{
    workItemCreate: { workItem?: Record<string, any> | null; errors?: string[] };
  }>(
    context,
    `mutation(${variableDefinitions.join(", ")}) {
      workItemCreate(input: { ${inputParts.join(", ")} }) {
        workItem { id iid title webUrl workItemType { name } }
        errors
      }
    }`,
    variables
  );
  assertNoGraphqlMutationErrors(data.workItemCreate?.errors, "Failed to create work item");
  const workItem = data.workItemCreate.workItem;

  return {
    id: workItem?.id,
    iid: workItem?.iid,
    title: workItem?.title,
    type: workItem?.workItemType?.name,
    webUrl: workItem?.webUrl
  };
}

function appendDateWidget(
  variableDefinitions: string[],
  inputParts: string[],
  variables: Record<string, unknown>,
  startDate?: string,
  dueDate?: string
): void {
  if (startDate === undefined && dueDate === undefined) {
    return;
  }
  const dateParts: string[] = [];
  if (startDate !== undefined) {
    variableDefinitions.push("$startDate: Date");
    dateParts.push("startDate: $startDate");
    variables.startDate = startDate;
  }
  if (dueDate !== undefined) {
    variableDefinitions.push("$dueDate: Date");
    dateParts.push("dueDate: $dueDate");
    variables.dueDate = dueDate;
  }
  inputParts.push(`startAndDueDateWidget: { ${dateParts.join(", ")} }`);
}

async function updateWorkItem(
  context: AppContext,
  projectId: string,
  iid: number,
  options: WorkItemUpdateOptions
): Promise<unknown> {
  const { workItemGid, projectPath } = await resolveWorkItemGid(context, projectId, iid);
  const variableDefinitions = ["$id: WorkItemID!"];
  const inputParts = ["id: $id"];
  const variables: Record<string, unknown> = { id: workItemGid };

  if (options.title !== undefined) {
    variableDefinitions.push("$title: String");
    inputParts.push("title: $title");
    variables.title = options.title;
  }
  if (options.description !== undefined) {
    variableDefinitions.push("$description: String!");
    inputParts.push("descriptionWidget: { description: $description }");
    variables.description = options.description;
  }

  const allLabelNames = [...(options.addLabels ?? []), ...(options.removeLabels ?? [])];
  const needsNameResolution = allLabelNames.length > 0 || !!options.assigneeUsernames?.length;
  const { labelIds, userIds } = needsNameResolution
    ? await resolveNamesToIds(
        context,
        projectPath,
        allLabelNames.length > 0 ? allLabelNames : undefined,
        options.assigneeUsernames
      )
    : { labelIds: [], userIds: [] };

  if (options.addLabels || options.removeLabels) {
    const labelParts: string[] = [];
    if (options.addLabels && options.addLabels.length > 0) {
      variableDefinitions.push("$addLabelIds: [LabelID!]");
      labelParts.push("addLabelIds: $addLabelIds");
      variables.addLabelIds = labelIds.slice(0, options.addLabels.length);
    }
    if (options.removeLabels && options.removeLabels.length > 0) {
      variableDefinitions.push("$removeLabelIds: [LabelID!]");
      labelParts.push("removeLabelIds: $removeLabelIds");
      variables.removeLabelIds = labelIds.slice(options.addLabels?.length ?? 0);
    }
    if (labelParts.length > 0) inputParts.push(`labelsWidget: { ${labelParts.join(", ")} }`);
  }

  if (userIds.length > 0) {
    variableDefinitions.push("$assigneeIds: [UserID!]!");
    inputParts.push("assigneesWidget: { assigneeIds: $assigneeIds }");
    variables.assigneeIds = userIds;
  }
  if (options.stateEvent !== undefined) {
    variableDefinitions.push("$stateEvent: WorkItemStateEvent");
    inputParts.push("stateEvent: $stateEvent");
    variables.stateEvent = options.stateEvent === "close" ? "CLOSE" : "REOPEN";
  }
  if (options.weight !== undefined) {
    variableDefinitions.push("$weight: Int");
    inputParts.push("weightWidget: { weight: $weight }");
    variables.weight = options.weight;
  }
  if (options.status !== undefined) {
    variableDefinitions.push("$status: WorkItemsStatusesStatusID");
    inputParts.push("statusWidget: { status: $status }");
    variables.status = options.status;
  }
  if (options.healthStatus !== undefined) {
    variableDefinitions.push("$healthStatus: HealthStatus");
    inputParts.push("healthStatusWidget: { healthStatus: $healthStatus }");
    variables.healthStatus = options.healthStatus;
  }
  appendDateWidget(variableDefinitions, inputParts, variables, options.startDate, options.dueDate);
  if (options.milestoneId !== undefined) {
    variableDefinitions.push("$milestoneId: MilestoneID");
    inputParts.push("milestoneWidget: { milestoneId: $milestoneId }");
    variables.milestoneId = normalizeGlobalId(options.milestoneId, "Milestone");
  }
  if (options.iterationId !== undefined) {
    variableDefinitions.push("$iterationId: IterationID");
    inputParts.push("iterationWidget: { iterationId: $iterationId }");
    variables.iterationId = normalizeGlobalId(options.iterationId, "Iteration");
  }
  if (options.confidential !== undefined) {
    variableDefinitions.push("$confidential: Boolean");
    inputParts.push("confidential: $confidential");
    variables.confidential = options.confidential;
  }
  if (options.customFields && options.customFields.length > 0) {
    variableDefinitions.push("$customFieldsWidget: [WorkItemWidgetCustomFieldValueInputType!]");
    inputParts.push("customFieldsWidget: $customFieldsWidget");
    variables.customFieldsWidget = options.customFields.map((field) => ({
      customFieldId: normalizeGlobalId(field.custom_field_id, "IssuablesCustomField"),
      textValue: field.text_value,
      numberValue: field.number_value,
      selectedOptionIds: field.selected_option_ids,
      dateValue: field.date_value
    }));
  }
  if (options.removeParent) {
    inputParts.push("hierarchyWidget: { parentId: null }");
  } else if (options.parentIid !== undefined) {
    const parentProjectId = options.parentProjectId ?? projectId;
    const { workItemGid: parentId } = await resolveWorkItemGid(
      context,
      parentProjectId,
      options.parentIid
    );
    variableDefinitions.push("$parentId: WorkItemID");
    inputParts.push("hierarchyWidget: { parentId: $parentId }");
    variables.parentId = parentId;
  }

  const data = await executeGraphqlData<{
    workItemUpdate: { workItem?: Record<string, any> | null; errors?: string[] };
  }>(
    context,
    `mutation(${variableDefinitions.join(", ")}) {
      workItemUpdate(input: { ${inputParts.join(", ")} }) {
        workItem {
          id iid title state webUrl workItemType { name }
          widgets {
            __typename
            ... on WorkItemWidgetStatus { status { id name category color } }
            ... on WorkItemWidgetLabels { labels { nodes { title } } }
            ... on WorkItemWidgetAssignees { assignees { nodes { username } } }
            ... on WorkItemWidgetWeight { weight }
            ... on WorkItemWidgetHierarchy { parent { id title workItemType { name } } }
            ... on WorkItemWidgetHealthStatus { healthStatus }
            ... on WorkItemWidgetStartAndDueDate { startDate dueDate }
            ... on WorkItemWidgetMilestone { milestone { id title } }
          }
        }
        errors
      }
    }`,
    variables
  );
  assertNoGraphqlMutationErrors(data.workItemUpdate?.errors, "Failed to update work item");

  await updateWorkItemRelationships(context, workItemGid, options);
  if (options.severity !== undefined) {
    await updateIncidentSeverity(context, projectPath, iid, options.severity);
  }
  if (options.escalationStatus !== undefined) {
    await updateIncidentEscalationStatus(context, projectPath, iid, options.escalationStatus);
  }

  const workItem = data.workItemUpdate.workItem ?? {};
  return {
    ...flattenWorkItemSummary(workItem),
    id: workItem.id,
    children_added: options.childrenToAdd?.length ?? 0,
    children_removed: options.childrenToRemove?.length ?? 0,
    linked_items_added: options.linkedItemsToAdd?.length ?? 0,
    linked_items_removed: options.linkedItemsToRemove?.length ?? 0,
    ...(options.severity !== undefined ? { severity: options.severity } : {}),
    ...(options.escalationStatus !== undefined
      ? { escalation_status: options.escalationStatus }
      : {})
  };
}

async function updateWorkItemRelationships(
  context: AppContext,
  workItemGid: string,
  options: WorkItemUpdateOptions
): Promise<void> {
  if (options.childrenToAdd && options.childrenToAdd.length > 0) {
    const childIds = [];
    for (const child of options.childrenToAdd) {
      const { workItemGid: childId } = await resolveWorkItemGid(
        context,
        child.project_id,
        child.iid
      );
      childIds.push(childId);
    }
    const data = await executeGraphqlData<{ workItemUpdate: { errors?: string[] } }>(
      context,
      `mutation($id: WorkItemID!, $childrenIds: [WorkItemID!]!) {
        workItemUpdate(input: { id: $id, hierarchyWidget: { childrenIds: $childrenIds } }) {
          errors
        }
      }`,
      { id: workItemGid, childrenIds: childIds }
    );
    assertNoGraphqlMutationErrors(data.workItemUpdate?.errors, "Failed to add children");
  }

  if (options.childrenToRemove) {
    for (const child of options.childrenToRemove) {
      await removeWorkItemParent(context, child.project_id, child.iid);
    }
  }

  if (options.linkedItemsToAdd && options.linkedItemsToAdd.length > 0) {
    const grouped: Record<string, string[]> = {};
    for (const item of options.linkedItemsToAdd) {
      const linkType = item.link_type ?? "RELATED";
      const { workItemGid: targetId } = await resolveWorkItemGid(
        context,
        item.project_id,
        item.iid
      );
      grouped[linkType] = [...(grouped[linkType] ?? []), targetId];
    }
    for (const [linkType, targetIds] of Object.entries(grouped)) {
      const data = await executeGraphqlData<{ workItemAddLinkedItems: { errors?: string[] } }>(
        context,
        `mutation($id: WorkItemID!, $workItemsIds: [WorkItemID!]!, $linkType: WorkItemRelatedLinkType!) {
          workItemAddLinkedItems(input: { id: $id, workItemsIds: $workItemsIds, linkType: $linkType }) {
            errors
          }
        }`,
        { id: workItemGid, workItemsIds: targetIds, linkType }
      );
      assertNoGraphqlMutationErrors(
        data.workItemAddLinkedItems?.errors,
        "Failed to add linked items"
      );
    }
  }

  if (options.linkedItemsToRemove && options.linkedItemsToRemove.length > 0) {
    const targetIds = [];
    for (const item of options.linkedItemsToRemove) {
      const { workItemGid: targetId } = await resolveWorkItemGid(
        context,
        item.project_id,
        item.iid
      );
      targetIds.push(targetId);
    }
    const data = await executeGraphqlData<{ workItemRemoveLinkedItems: { errors?: string[] } }>(
      context,
      `mutation($id: WorkItemID!, $workItemsIds: [WorkItemID!]!) {
        workItemRemoveLinkedItems(input: { id: $id, workItemsIds: $workItemsIds }) { errors }
      }`,
      { id: workItemGid, workItemsIds: targetIds }
    );
    assertNoGraphqlMutationErrors(
      data.workItemRemoveLinkedItems?.errors,
      "Failed to remove linked items"
    );
  }
}

async function removeWorkItemParent(
  context: AppContext,
  projectId: string,
  iid: number
): Promise<void> {
  const { workItemGid } = await resolveWorkItemGid(context, projectId, iid);
  const data = await executeGraphqlData<{ workItemUpdate: { errors?: string[] } }>(
    context,
    `mutation($id: WorkItemID!) {
      workItemUpdate(input: { id: $id, hierarchyWidget: { parentId: null } }) { errors }
    }`,
    { id: workItemGid }
  );
  assertNoGraphqlMutationErrors(data.workItemUpdate?.errors, "Failed to remove parent");
}

async function convertWorkItemType(
  context: AppContext,
  projectId: string,
  iid: number,
  newType: WorkItemType
): Promise<unknown> {
  const { workItemGid, projectPath } = await resolveWorkItemGid(context, projectId, iid);
  const typeId = await resolveWorkItemTypeGid(context, projectPath, newType);
  const data = await executeGraphqlData<{
    workItemConvert: {
      workItem?: { id: string; workItemType?: { name?: string } } | null;
      errors?: string[];
    };
  }>(
    context,
    `mutation($id: WorkItemID!, $typeId: WorkItemsTypeID!) {
      workItemConvert(input: { id: $id, workItemTypeId: $typeId }) {
        workItem { id workItemType { name } }
        errors
      }
    }`,
    { id: workItemGid, typeId }
  );
  assertNoGraphqlMutationErrors(data.workItemConvert?.errors, "Conversion failed");
  return {
    id: data.workItemConvert.workItem?.id,
    type: data.workItemConvert.workItem?.workItemType?.name
  };
}

async function listWorkItemStatuses(
  context: AppContext,
  projectId: string,
  type: WorkItemType
): Promise<unknown> {
  const projectPath = await resolveProjectPathForWorkItem(context, projectId);
  const typeName = workItemTypeName(type);
  const data = await executeGraphqlData<{
    namespace?: {
      workItemTypes?: {
        nodes?: Array<{
          name: string;
          supportedConversionTypes?: Array<{ id: string; name: string }>;
          widgetDefinitions?: Array<Record<string, any>>;
        }>;
      };
    };
  }>(
    context,
    `query($path: ID!, $typeName: IssueType) {
      namespace(fullPath: $path) {
        workItemTypes(name: $typeName) {
          nodes {
            id
            name
            supportedConversionTypes { id name }
            widgetDefinitions {
              __typename
              ... on WorkItemWidgetDefinitionStatus {
                allowedStatuses { id name iconName color position }
              }
              ... on WorkItemWidgetDefinitionHierarchy {
                allowedChildTypes { nodes { id name } }
                allowedParentTypes { nodes { id name } }
              }
            }
          }
        }
      }
    }`,
    { path: projectPath, typeName: typeName.replace(/ /g, "_").toUpperCase() }
  );
  const typeNode = data.namespace?.workItemTypes?.nodes?.[0];
  if (!typeNode) {
    throw new Error(`Work item type '${typeName}' not found in project ${projectPath}`);
  }

  const statusWidget = typeNode.widgetDefinitions?.find(
    (widget) => widget.__typename === "WorkItemWidgetDefinitionStatus"
  );
  const hierarchyWidget = typeNode.widgetDefinitions?.find(
    (widget) => widget.__typename === "WorkItemWidgetDefinitionHierarchy"
  );

  return {
    work_item_type: typeNode.name,
    statuses_available: (statusWidget?.allowedStatuses ?? []).length > 0,
    statuses: statusWidget?.allowedStatuses ?? [],
    supported_conversion_types: (typeNode.supportedConversionTypes ?? []).map((item) => item.name),
    allowed_child_types: (hierarchyWidget?.allowedChildTypes?.nodes ?? []).map(
      (item: any) => item.name
    ),
    allowed_parent_types: (hierarchyWidget?.allowedParentTypes?.nodes ?? []).map(
      (item: any) => item.name
    )
  };
}

async function listCustomFieldDefinitions(
  context: AppContext,
  projectId: string,
  type: WorkItemType
): Promise<unknown> {
  const projectPath = await resolveProjectPathForWorkItem(context, projectId);
  const typeName = workItemTypeName(type);
  const data = await executeGraphqlData<{
    namespace?: { workItemTypes?: { nodes?: Array<{ name: string; widgetDefinitions?: any[] }> } };
  }>(
    context,
    `query($path: ID!, $typeName: IssueType) {
      namespace(fullPath: $path) {
        workItemTypes(name: $typeName) {
          nodes {
            id
            name
            widgetDefinitions {
              __typename
              ... on WorkItemWidgetDefinitionCustomFields {
                customFieldValues {
                  customField {
                    id
                    name
                    fieldType
                    selectOptions { id value }
                    workItemTypes { id name }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    { path: projectPath, typeName: typeName.replace(/ /g, "_").toUpperCase() }
  );
  const typeNode = data.namespace?.workItemTypes?.nodes?.[0];
  if (!typeNode) {
    throw new Error(`Work item type '${typeName}' not found in project ${projectPath}`);
  }
  const widget = typeNode.widgetDefinitions?.find(
    (item) => item.__typename === "WorkItemWidgetDefinitionCustomFields"
  );

  return {
    work_item_type: typeNode.name,
    custom_fields: (widget?.customFieldValues ?? []).map((item: any) => {
      const field = item.customField ?? {};
      return {
        id: field.id,
        name: field.name,
        type: field.fieldType,
        ...(field.selectOptions?.length ? { selectOptions: field.selectOptions } : {}),
        ...(field.workItemTypes?.length
          ? { workItemTypes: field.workItemTypes.map((workItemType: any) => workItemType.name) }
          : {})
      };
    })
  };
}

async function moveWorkItem(
  context: AppContext,
  projectId: string,
  iid: number,
  targetProjectId: string
): Promise<unknown> {
  const projectPath = await resolveProjectPathForWorkItem(context, projectId);
  const targetProjectPath = await resolveProjectPathForWorkItem(context, targetProjectId);
  const data = await executeGraphqlData<{
    issueMove: { issue?: Record<string, unknown> | null; errors?: string[] };
  }>(
    context,
    `mutation($projectPath: ID!, $iid: String!, $targetProjectPath: ID!) {
      issueMove(input: { projectPath: $projectPath, iid: $iid, targetProjectPath: $targetProjectPath }) {
        issue { id iid webUrl }
        errors
      }
    }`,
    { projectPath, iid: String(iid), targetProjectPath }
  );
  assertNoGraphqlMutationErrors(data.issueMove?.errors, "Failed to move work item");
  return data.issueMove.issue;
}

async function listWorkItemNotes(
  context: AppContext,
  projectId: string,
  iid: number,
  options: { pageSize?: number; after?: string; sort?: string }
): Promise<unknown> {
  const projectPath = await resolveProjectPathForWorkItem(context, projectId);
  const data = await executeGraphqlData<{ namespace?: { workItem?: Record<string, any> | null } }>(
    context,
    `query($path: ID!, $iid: String!, $pageSize: Int, $after: String, $sort: WorkItemDiscussionsSort) {
      namespace(fullPath: $path) {
        workItem(iid: $iid) {
          id
          widgets(onlyTypes: [NOTES]) {
            ... on WorkItemWidgetNotes {
              discussionLocked
              discussions(first: $pageSize, after: $after, filter: ALL_NOTES, sort: $sort) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  resolved
                  resolvable
                  notes {
                    nodes {
                      id
                      body
                      system
                      internal
                      createdAt
                      lastEditedAt
                      author { username }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }`,
    {
      path: projectPath,
      iid: String(iid),
      pageSize: options.pageSize ?? 20,
      after: options.after ?? null,
      sort: options.sort ?? "CREATED_ASC"
    }
  );
  const workItem = data.namespace?.workItem;
  if (!workItem) {
    throw new Error(`Work item #${iid} not found in project ${projectPath}`);
  }
  const notesWidget = (workItem.widgets ?? []).find((widget: any) => widget.discussions);
  const discussions = notesWidget?.discussions;

  return {
    discussions: (discussions?.nodes ?? []).map((discussion: any) => ({
      id: discussion.id,
      resolved: discussion.resolved,
      resolvable: discussion.resolvable,
      notes: (discussion.notes?.nodes ?? []).map((note: any) => ({
        id: note.id,
        author: note.author?.username,
        body: note.body,
        createdAt: note.createdAt,
        ...(note.system ? { system: true } : {}),
        ...(note.internal ? { internal: true } : {}),
        ...(note.lastEditedAt ? { lastEditedAt: note.lastEditedAt } : {})
      }))
    })),
    pageInfo: discussions?.pageInfo ?? {}
  };
}

async function resolveWorkItemNoteAwardableId(
  context: AppContext,
  projectId: string,
  iid: number,
  noteId: string
): Promise<string> {
  let after: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const result = (await listWorkItemNotes(context, projectId, iid, {
      pageSize: 100,
      after,
      sort: "CREATED_ASC"
    })) as {
      discussions?: Array<{ notes?: Array<{ id?: unknown }> }>;
      pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
    };

    const found = (result.discussions ?? []).some((discussion) =>
      (discussion.notes ?? []).some((note) => note.id === noteId)
    );
    if (found) {
      return noteId;
    }

    if (result.pageInfo?.hasNextPage !== true || typeof result.pageInfo.endCursor !== "string") {
      break;
    }
    after = result.pageInfo.endCursor;
  }

  throw new Error(`Note '${noteId}' was not found on work item #${iid} in project ${projectId}`);
}

async function createWorkItemNote(
  context: AppContext,
  projectId: string,
  iid: number,
  body: string,
  options: { internal?: boolean; discussionId?: string }
): Promise<unknown> {
  const { workItemGid } = await resolveWorkItemGid(context, projectId, iid);
  const variableDefinitions = ["$noteableId: NoteableID!", "$body: String!"];
  const inputParts = ["noteableId: $noteableId", "body: $body"];
  const variables: Record<string, unknown> = { noteableId: workItemGid, body };

  if (options.internal) {
    variableDefinitions.push("$internal: Boolean");
    inputParts.push("internal: $internal");
    variables.internal = true;
  }
  if (options.discussionId) {
    variableDefinitions.push("$discussionId: DiscussionID");
    inputParts.push("discussionId: $discussionId");
    variables.discussionId = options.discussionId;
  }

  const data = await executeGraphqlData<{
    createNote: {
      note?: { id: string; body: string; discussion?: { id: string } } | null;
      errors?: string[];
    };
  }>(
    context,
    `mutation(${variableDefinitions.join(", ")}) {
      createNote(input: { ${inputParts.join(", ")} }) {
        note { id body discussion { id } }
        errors
      }
    }`,
    variables
  );
  assertNoGraphqlMutationErrors(data.createNote?.errors, "Failed to create note");
  return data.createNote.note;
}

async function addGraphqlAwardEmoji(
  context: AppContext,
  awardableId: string,
  name: string
): Promise<unknown> {
  const data = await executeGraphqlData<{
    awardEmojiAdd: {
      awardEmoji?: { name: string; user?: { username?: string } } | null;
      errors?: string[];
    };
  }>(
    context,
    `mutation($awardableId: AwardableID!, $name: String!) {
      awardEmojiAdd(input: { awardableId: $awardableId, name: $name }) {
        awardEmoji { name user { username } }
        errors
      }
    }`,
    { awardableId, name }
  );
  assertNoGraphqlMutationErrors(data.awardEmojiAdd?.errors, "Failed to add emoji reaction");
  return data.awardEmojiAdd.awardEmoji;
}

async function listGraphqlAwardEmoji(context: AppContext, awardableId: string): Promise<unknown[]> {
  const data = await executeGraphqlData<{
    awardable?: {
      awardEmoji?: { nodes?: Array<{ name: string; user?: { username?: string } }> };
    } | null;
  }>(
    context,
    `query($id: AwardableID!) {
      awardable(id: $id) {
        awardEmoji { nodes { name user { username } } }
      }
    }`,
    { id: awardableId }
  );
  return data.awardable?.awardEmoji?.nodes ?? [];
}

async function removeGraphqlAwardEmoji(
  context: AppContext,
  awardableId: string,
  name: string
): Promise<unknown> {
  const data = await executeGraphqlData<{
    awardEmojiRemove: {
      awardEmoji?: { name: string } | null;
      errors?: string[];
    };
  }>(
    context,
    `mutation($awardableId: AwardableID!, $name: String!) {
      awardEmojiRemove(input: { awardableId: $awardableId, name: $name }) {
        awardEmoji { name }
        errors
      }
    }`,
    { awardableId, name }
  );
  assertNoGraphqlMutationErrors(data.awardEmojiRemove?.errors, "Failed to remove emoji reaction");
  return data.awardEmojiRemove.awardEmoji ?? { status: "success" };
}

async function getTimelineEvents(
  context: AppContext,
  projectId: string,
  incidentIid: number
): Promise<unknown> {
  const { workItemGid, projectPath } = await resolveWorkItemGid(context, projectId, incidentIid);
  const incidentId = workItemGid.replace("/WorkItem/", "/Issue/");
  const data = await executeGraphqlData<{
    project?: { incidentManagementTimelineEvents?: { nodes?: Array<Record<string, any>> } };
  }>(
    context,
    `query($fullPath: ID!, $incidentId: IssueID!) {
      project(fullPath: $fullPath) {
        incidentManagementTimelineEvents(incidentId: $incidentId) {
          nodes {
            id
            note
            noteHtml
            action
            occurredAt
            createdAt
            timelineEventTags { nodes { id name } }
          }
        }
      }
    }`,
    { fullPath: projectPath, incidentId }
  );

  return (data.project?.incidentManagementTimelineEvents?.nodes ?? []).map((event) => ({
    id: event.id,
    note: event.note,
    action: event.action,
    occurredAt: event.occurredAt,
    createdAt: event.createdAt,
    ...(event.noteHtml ? { noteHtml: event.noteHtml } : {}),
    ...(event.timelineEventTags?.nodes?.length
      ? { tags: event.timelineEventTags.nodes.map((tag: any) => tag.name) }
      : {})
  }));
}

async function createTimelineEvent(
  context: AppContext,
  projectId: string,
  incidentIid: number,
  note: string,
  occurredAt: string,
  tagNames?: string[]
): Promise<unknown> {
  const { workItemGid } = await resolveWorkItemGid(context, projectId, incidentIid);
  const incidentId = workItemGid.replace("/WorkItem/", "/Issue/");
  const input: Record<string, unknown> = { incidentId, note, occurredAt };
  if (tagNames && tagNames.length > 0) {
    input.timelineEventTagNames = tagNames;
  }
  const data = await executeGraphqlData<{
    timelineEventCreate: { timelineEvent?: Record<string, unknown> | null; errors?: string[] };
  }>(
    context,
    `mutation CreateTimelineEvent($input: TimelineEventCreateInput!) {
      timelineEventCreate(input: $input) {
        timelineEvent {
          id
          note
          noteHtml
          action
          occurredAt
          createdAt
          timelineEventTags { nodes { id name } }
        }
        errors
      }
    }`,
    { input }
  );
  assertNoGraphqlMutationErrors(
    data.timelineEventCreate?.errors,
    "Failed to create timeline event"
  );
  return data.timelineEventCreate.timelineEvent;
}

async function updateIncidentSeverity(
  context: AppContext,
  projectPath: string,
  incidentIid: number,
  severity: string
): Promise<void> {
  const data = await executeGraphqlData<{ issueSetSeverity: { errors?: string[] } }>(
    context,
    `mutation($projectPath: ID!, $severity: IssuableSeverity!, $iid: String!) {
      issueSetSeverity(input: { iid: $iid, severity: $severity, projectPath: $projectPath }) {
        errors
      }
    }`,
    { projectPath, severity, iid: String(incidentIid) }
  );
  assertNoGraphqlMutationErrors(data.issueSetSeverity?.errors, "Failed to set severity");
}

async function updateIncidentEscalationStatus(
  context: AppContext,
  projectPath: string,
  incidentIid: number,
  status: string
): Promise<void> {
  const data = await executeGraphqlData<{ issueSetEscalationStatus: { errors?: string[] } }>(
    context,
    `mutation($projectPath: ID!, $status: IssueEscalationStatus!, $iid: String!) {
      issueSetEscalationStatus(input: { projectPath: $projectPath, status: $status, iid: $iid }) {
        errors
      }
    }`,
    { projectPath, status, iid: String(incidentIid) }
  );
  assertNoGraphqlMutationErrors(
    data.issueSetEscalationStatus?.errors,
    "Failed to set escalation status"
  );
}

function assertNoGraphqlMutationErrors(errors: string[] | undefined, prefix: string): void {
  if (errors && errors.length > 0) {
    throw new Error(`${prefix}: ${errors.join(", ")}`);
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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

const DESTRUCTIVE_GRAPHQL_MUTATION_FIELD_PATTERN = /(?:delete|destroy|remove|prune|purge)/iu;

export function assertGraphqlDocumentAllowedByPermissionMode(
  query: string,
  permissionMode: GitLabPermissionMode
): void {
  if (permissionMode !== "modify") {
    return;
  }

  let mutationFields: string[];
  try {
    mutationFields = getTopLevelGraphqlMutationFields(parse(query, { noLocation: true }));
  } catch {
    throw new Error(
      "Raw GraphQL document could not be verified safely; modify permission mode blocks unverifiable operations."
    );
  }

  const destructiveField = mutationFields.find((fieldName) =>
    DESTRUCTIVE_GRAPHQL_MUTATION_FIELD_PATTERN.test(fieldName)
  );
  if (destructiveField) {
    throw new Error(
      `GraphQL mutation field '${destructiveField}' is blocked in modify permission mode because it is destructive.`
    );
  }
}

function getTopLevelGraphqlMutationFields(document: DocumentNode): string[] {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.FRAGMENT_DEFINITION) {
      continue;
    }

    const fragmentName = definition.name.value;
    if (fragments.has(fragmentName)) {
      throw new Error(`Duplicate GraphQL fragment '${fragmentName}'`);
    }
    fragments.set(fragmentName, definition);
  }

  const fields: string[] = [];
  for (const definition of document.definitions) {
    if (definition.kind === Kind.OPERATION_DEFINITION && definition.operation === "mutation") {
      collectTopLevelGraphqlFields(definition.selectionSet, fragments, new Set(), fields);
    }
  }

  return fields;
}

function collectTopLevelGraphqlFields(
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  activeFragments: Set<string>,
  fields: string[]
): void {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      fields.push(selection.name.value);
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectTopLevelGraphqlFields(selection.selectionSet, fragments, activeFragments, fields);
      continue;
    }

    const fragmentName = selection.name.value;
    const fragment = fragments.get(fragmentName);
    if (!fragment || activeFragments.has(fragmentName)) {
      throw new Error(`GraphQL fragment '${fragmentName}' cannot be resolved safely`);
    }

    activeFragments.add(fragmentName);
    try {
      collectTopLevelGraphqlFields(fragment.selectionSet, fragments, activeFragments, fields);
    } finally {
      activeFragments.delete(fragmentName);
    }
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

export function resolveToolScopeMetadata(name: string): GitLabToolScopeMetadata {
  if (RAW_GRAPHQL_TOOL_NAMES.has(name)) {
    return {
      kind: "rawGraphQL",
      projectScopedMode: "deny"
    };
  }

  if (GROUP_SCOPED_TOOL_NAMES.has(name)) {
    return {
      kind: "group",
      groupIdArguments: GROUP_ID_ARGUMENTS_BY_TOOL.get(name) ?? ["group_id"],
      projectScopedMode: "deny"
    };
  }

  const globalMode = GLOBAL_TOOL_PROJECT_SCOPE_MODES.get(name);
  if (globalMode) {
    return {
      kind: "global",
      projectIdArguments: PROJECT_ID_ARGUMENTS_BY_TOOL.get(name),
      projectScopedMode: globalMode
    };
  }

  return {
    kind: "project",
    projectIdArguments: PROJECT_ID_ARGUMENTS_BY_TOOL.get(name) ?? ["project_id"],
    groupIdArguments: GROUP_ID_ARGUMENTS_BY_TOOL.get(name),
    projectScopedMode: "allow"
  };
}

function assertScopeMetadataMatchesDefinition(
  definition: GitLabToolDefinitionInput,
  scope: GitLabToolScopeMetadata
): void {
  if (scope.kind === "project" && !scope.projectIdArguments?.includes("project_id")) {
    throw new Error(`Project-scoped tool '${definition.name}' must declare project_id metadata`);
  }

  for (const argumentName of [
    ...(scope.projectIdArguments ?? []),
    ...(scope.groupIdArguments ?? [])
  ]) {
    if (!Object.prototype.hasOwnProperty.call(definition.inputSchema, argumentName)) {
      throw new Error(
        `Tool '${definition.name}' scope metadata references missing '${argumentName}' input`
      );
    }
  }
}

function isToolVisibleForProjectScope(
  definition: GitLabToolDefinition,
  allowedProjectIds: readonly string[]
): boolean {
  if (allowedProjectIds.length === 0) {
    return true;
  }

  return definition.scope.projectScopedMode !== "deny";
}

function assertToolCanExecuteInProjectScope(
  definition: GitLabToolDefinition,
  args: ToolArgs,
  context: AppContext
): void {
  const allowedProjectIds = context.env.GITLAB_ALLOWED_PROJECT_IDS;
  if (allowedProjectIds.length === 0) {
    return;
  }

  if (definition.scope.projectScopedMode === "deny") {
    throw new Error(
      `Tool '${definition.name}' is unavailable while GITLAB_ALLOWED_PROJECT_IDS is configured because its ${definition.scope.kind} scope cannot be proven safe.`
    );
  }

  for (const argumentName of definition.scope.groupIdArguments ?? []) {
    if (hasValue(args[argumentName])) {
      throw new Error(
        `'${argumentName}' is unavailable while GITLAB_ALLOWED_PROJECT_IDS is configured; use a project-scoped form instead.`
      );
    }
  }

  for (const argumentName of definition.scope.projectIdArguments ?? []) {
    const value = args[argumentName];
    if (!hasValue(value)) {
      continue;
    }

    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error(`'${argumentName}' must be a string or number`);
    }

    resolveExplicitProjectId(context, String(value));
  }
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function resolveProjectId(args: ToolArgs, context: AppContext, required: boolean): string {
  const fromArgs = getOptionalString(args, "project_id");
  const allowed = context.env.GITLAB_ALLOWED_PROJECT_IDS;

  if (allowed.length > 0) {
    if (fromArgs && !isGitLabProjectIdentityAllowed(fromArgs, allowed)) {
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

async function withCiLintHttpDiagnostics(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const lintResult = toCiLintHttpDiagnosticResult(error);
    if (lintResult) {
      return lintResult;
    }

    throw error;
  }
}

function toCiLintHttpDiagnosticResult(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof GitLabApiError) || error.status !== 400) {
    return undefined;
  }

  const details = redactSensitive(error.details);
  const errors = extractCiLintMessages(details);
  if (errors.length === 0 || !hasCiLintDiagnosticSignal(details, errors)) {
    return undefined;
  }

  const result: Record<string, unknown> =
    typeof details === "object" && details !== null && !Array.isArray(details)
      ? { ...(details as Record<string, unknown>) }
      : {};

  return {
    ...result,
    valid: false,
    errors,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    status: error.status
  };
}

function extractCiLintMessages(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractCiLintMessages(item));
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const messages: string[] = [];
  for (const key of ["errors", "message", "error"]) {
    messages.push(...extractCiLintMessages(record[key]));
  }

  return [...new Set(messages.map((item) => item.trim()).filter((item) => item.length > 0))];
}

function hasCiLintDiagnosticSignal(details: unknown, messages: string[]): boolean {
  if (typeof details === "object" && details !== null && !Array.isArray(details)) {
    const record = details as Record<string, unknown>;
    if (
      record.valid === false ||
      record.status === "invalid" ||
      hasNonEmptyCiLintErrorsArray(record)
    ) {
      return true;
    }
  }

  return messages.some((message) =>
    /gitlab ci configuration is invalid|jobs config|ci config|config should contain/i.test(message)
  );
}

function hasNonEmptyCiLintErrorsArray(record: Record<string, unknown>): boolean {
  return Array.isArray(record.errors) && extractCiLintMessages(record.errors).length > 0;
}

interface SensitiveRedactionOptions {
  extraKeys?: readonly string[];
  extraValues?: readonly string[];
}

function toToolError(
  error: unknown,
  context?: AppContext,
  redactionOptions: SensitiveRedactionOptions = {}
): CallToolResult {
  const detailMode = context?.env.GITLAB_ERROR_DETAIL_MODE ?? "full";

  if (error instanceof GitLabApiError) {
    const payload: Record<string, unknown> = {
      error: `GitLab API error ${error.status}`
    };
    if (detailMode === "full") {
      payload.details = redactSensitive(error.details, redactionOptions);
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
    const message =
      detailMode === "full"
        ? String(redactSensitive(error.message, redactionOptions))
        : "Request failed";
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

function maybeDecodeRepositoryFileContents(value: unknown, shouldDecode?: boolean): unknown {
  if (!shouldDecode || typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const file = value as Record<string, unknown>;
  if (file.encoding !== "base64" || typeof file.content !== "string") {
    return value;
  }

  return {
    ...file,
    content: Buffer.from(file.content, "base64").toString("utf8"),
    encoding: "utf8"
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

function pickPresentFields(args: ToolArgs, fields: readonly string[]): ToolArgs {
  const result: ToolArgs = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(args, field) && args[field] !== undefined) {
      result[field] = args[field];
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

function resolveWebhookScope(
  args: ToolArgs,
  context: AppContext
): { projectId?: string; groupId?: string } {
  const projectId = getOptionalString(args, "project_id");
  const groupId = getOptionalString(args, "group_id");

  if ((projectId ? 1 : 0) + (groupId ? 1 : 0) !== 1) {
    throw new Error("Provide exactly one of project_id or group_id");
  }

  if (projectId) {
    return { projectId: resolveExplicitProjectId(context, projectId) };
  }

  if (context.env.GITLAB_ALLOWED_PROJECT_IDS.length > 0) {
    throw new Error(
      "group_id is unavailable while GITLAB_ALLOWED_PROJECT_IDS is configured; use project_id instead"
    );
  }

  return { groupId };
}

function summarizeWebhookEvents(
  events: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return copyPaginationMetadata(
    events,
    events.map((event) => ({
      id: event.id,
      url: event.url,
      trigger: event.trigger,
      response_status: event.response_status,
      execution_duration: event.execution_duration
    }))
  );
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

  return copyPaginationMetadata(
    value,
    value.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null
    )
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

async function getDetailedMergeRequestFromMatch(
  projectId: string,
  mergeRequest: Record<string, unknown>,
  context: AppContext
): Promise<unknown> {
  if (typeof context.gitlab.getMergeRequest !== "function") {
    return mergeRequest;
  }

  return context.gitlab.getMergeRequest(projectId, getMergeRequestIid(mergeRequest));
}

async function withMergeRequestSummaries(
  projectId: string,
  mergeRequest: unknown,
  context: AppContext
): Promise<unknown> {
  if (typeof mergeRequest !== "object" || mergeRequest === null || Array.isArray(mergeRequest)) {
    return mergeRequest;
  }

  const record = mergeRequest as Record<string, unknown>;
  const [commitAdditionSummary, approvalSummary] = await Promise.all([
    buildMergeRequestCommitAdditionSummary(projectId, record, context),
    buildMergeRequestApprovalSummary(projectId, record, context)
  ]);

  return {
    ...record,
    commit_addition_summary: commitAdditionSummary,
    approval_summary: approvalSummary
  };
}

async function buildMergeRequestCommitAdditionSummary(
  projectId: string,
  mergeRequest: Record<string, unknown>,
  context: AppContext
): Promise<Record<string, unknown>> {
  const targetBranch =
    typeof mergeRequest.target_branch === "string" ? mergeRequest.target_branch : null;

  try {
    const sourceCommitCount = await context.gitlab.countMergeRequestCommits(
      projectId,
      getMergeRequestIid(mergeRequest)
    );
    const project = (await context.gitlab.getProject(projectId)) as Record<string, unknown>;
    const mergeMethod = typeof project.merge_method === "string" ? project.merge_method : null;
    const mergeCommitCount = estimateMergeCommitCount(mergeMethod, sourceCommitCount);
    const summary =
      targetBranch && mergeCommitCount !== null
        ? `${sourceCommitCount} commits and ${mergeCommitCount} merge commit${
            mergeCommitCount === 1 ? "" : "s"
          } will be added to ${targetBranch}.`
        : null;

    return {
      target_branch: targetBranch,
      source_commits_count: sourceCommitCount,
      merge_method: mergeMethod,
      merge_commit_count: mergeCommitCount,
      summary
    };
  } catch (error) {
    return {
      target_branch: targetBranch,
      source_commits_count: null,
      merge_method: null,
      merge_commit_count: null,
      summary: null,
      unavailable_reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function estimateMergeCommitCount(
  mergeMethod: string | null,
  sourceCommitCount: number
): number | null {
  if (sourceCommitCount === 0) {
    return 0;
  }

  if (mergeMethod === "merge") {
    return 1;
  }

  if (mergeMethod === "ff" || mergeMethod === "rebase_merge") {
    return 0;
  }

  return null;
}

async function buildMergeRequestApprovalSummary(
  projectId: string,
  mergeRequest: Record<string, unknown>,
  context: AppContext
): Promise<Record<string, unknown>> {
  try {
    const approvalState = (await context.gitlab.getMergeRequestApprovalState(
      projectId,
      getMergeRequestIid(mergeRequest)
    )) as Record<string, unknown>;
    const approvedBy = extractRecords(approvalState.approved_by);
    const approvedByUsernames = getApprovalUsernames(approvalState, approvedBy);
    const rules = extractRecords(approvalState.rules);

    return {
      approved:
        typeof approvalState.approved === "boolean"
          ? approvalState.approved
          : inferMergeRequestApproved(rules),
      user_has_approved:
        typeof approvalState.user_has_approved === "boolean"
          ? approvalState.user_has_approved
          : null,
      user_can_approve:
        typeof approvalState.user_can_approve === "boolean" ? approvalState.user_can_approve : null,
      approved_by: approvedBy,
      approved_by_usernames: approvedByUsernames,
      rules_count: Array.isArray(approvalState.rules) ? approvalState.rules.length : null,
      source_endpoint:
        approvalState.source_endpoint === "approval_state" ||
        approvalState.source_endpoint === "approvals"
          ? approvalState.source_endpoint
          : null
    };
  } catch (error) {
    return {
      approved: null,
      user_has_approved: null,
      user_can_approve: null,
      approved_by: [],
      approved_by_usernames: [],
      rules_count: null,
      source_endpoint: null,
      unavailable_reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function getApprovalUsernames(
  approvalState: Record<string, unknown>,
  approvedBy: Array<Record<string, unknown>>
): string[] {
  const explicit = approvalState.approved_by_usernames;
  if (Array.isArray(explicit) && explicit.every((item) => typeof item === "string")) {
    return explicit;
  }

  return approvedBy
    .map((user) => user.username)
    .filter((username): username is string => typeof username === "string");
}

function inferMergeRequestApproved(rules: Array<Record<string, unknown>>): boolean | null {
  if (rules.length === 0) {
    return null;
  }

  if (rules.some((rule) => typeof rule.approved !== "boolean")) {
    return null;
  }

  return rules.every((rule) => rule.approved === true);
}

function slimIssueMilestone(issue: unknown): unknown {
  if (!isRecord(issue) || !isRecord(issue.milestone)) {
    return issue;
  }

  return {
    ...issue,
    milestone: pickRecordFields(issue.milestone, ["id", "iid", "title", "state", "web_url"])
  };
}

function slimUpdatedIssue(issue: unknown): unknown {
  if (!isRecord(issue)) {
    return issue;
  }

  return pickRecordFields(issue, [
    "id",
    "iid",
    "project_id",
    "title",
    "state",
    "updated_at",
    "web_url"
  ]);
}

function pickRecordFields(
  record: Record<string, unknown>,
  fields: string[]
): Record<string, unknown> {
  return Object.fromEntries(
    fields
      .filter((field) => Object.prototype.hasOwnProperty.call(record, field))
      .map((field) => [field, record[field]])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveWikiUpdateTitle(
  slug: string,
  providedTitle: string | undefined,
  getExistingPage: () => Promise<unknown>
): Promise<string | undefined> {
  if (!providedTitle || !slug.includes("/") || providedTitle.includes("/")) {
    return providedTitle;
  }

  const existingPage = await getExistingPage();
  const existingTitle = getExistingWikiTitle(existingPage);
  return resolveNestedWikiUpdateTitle(slug, providedTitle, existingTitle);
}

function getExistingWikiTitle(page: unknown): string {
  if (!isRecord(page)) {
    return "";
  }

  const title = typeof page.title === "string" ? page.title : "";
  const frontMatterTitle = isRecord(page.front_matter) ? page.front_matter.title : undefined;

  if (title.includes("/")) {
    return title;
  }
  if (typeof frontMatterTitle === "string" && frontMatterTitle.includes("/")) {
    return frontMatterTitle;
  }
  return title || (typeof frontMatterTitle === "string" ? frontMatterTitle : "");
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

function getNumber(args: ToolArgs, key: string): number {
  const value = args[key];
  const numericValue = typeof value === "string" ? Number(value) : value;
  if (typeof numericValue !== "number" || Number.isNaN(numericValue)) {
    throw new Error(`'${key}' must be number`);
  }

  return numericValue;
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

function getWorkItemReferences(
  args: ToolArgs,
  key: string,
  context: AppContext,
  defaultProjectId: string
): WorkItemReference[] | undefined {
  const values = getOptionalArray(args, key);
  if (!values) {
    return undefined;
  }

  return values.map((value) => {
    if (typeof value !== "object" || value === null) {
      throw new Error(`'${key}' must contain objects`);
    }
    const record = value as Record<string, unknown>;
    if (record.project_id !== undefined && typeof record.project_id !== "string") {
      throw new Error(`'${key}.project_id' must be string`);
    }
    const iid = typeof record.iid === "string" ? Number(record.iid) : record.iid;
    if (typeof iid !== "number" || Number.isNaN(iid)) {
      throw new Error(`'${key}.iid' must be number`);
    }
    const projectId = record.project_id ?? defaultProjectId;
    return {
      project_id: resolveExplicitProjectId(context, projectId),
      iid
    };
  });
}

function getLinkedWorkItemReferences(
  args: ToolArgs,
  key: string,
  context: AppContext,
  defaultProjectId: string
): LinkedWorkItemReference[] | undefined {
  const references = getWorkItemReferences(args, key, context, defaultProjectId) as
    | LinkedWorkItemReference[]
    | undefined;
  const rawValues = getOptionalArray(args, key);
  if (!references || !rawValues) {
    return references;
  }

  return references.map((reference, index) => {
    const raw = rawValues[index] as Record<string, unknown>;
    const linkType = raw.link_type;
    if (linkType !== undefined && typeof linkType !== "string") {
      throw new Error(`'${key}.link_type' must be string`);
    }
    return {
      ...reference,
      link_type: linkType as LinkedWorkItemReference["link_type"] | undefined
    };
  });
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

function requireArrayValue<T>(items: T[], index: number, errorMessage: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(errorMessage);
  }

  return value;
}

function redactSensitive(value: unknown, options: SensitiveRedactionOptions = {}): unknown {
  if (typeof value === "string") {
    let output = value
      .replace(
        /\b(glpat-[a-z0-9_-]{10,}|ghp_[a-z0-9]{20,}|eyJ[a-zA-Z0-9._-]{20,})\b/g,
        "[REDACTED]"
      )
      .replace(
        /(private[-_]?token|authorization)["']?\s*[:=]\s*["']?[^"'\s,}]+/gi,
        "$1=[REDACTED]"
      );

    for (const sensitiveValue of [...(options.extraValues ?? [])].sort(
      (left, right) => right.length - left.length
    )) {
      if (sensitiveValue.length > 0) {
        output = output.split(sensitiveValue).join("[REDACTED]");
      }
    }

    return output;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item, options));
  }

  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const extraKeys = new Set((options.extraKeys ?? []).map((key) => key.toLowerCase()));
    for (const [key, item] of Object.entries(input)) {
      if (/token|authorization|password|secret/i.test(key) || extraKeys.has(key.toLowerCase())) {
        output[key] = "[REDACTED]";
        continue;
      }
      output[key] = redactSensitive(item, options);
    }
    return output;
  }

  return value;
}

function getSensitiveArgumentValues(
  args: unknown,
  sensitiveArguments: readonly string[] | undefined
): string[] {
  if (!sensitiveArguments || typeof args !== "object" || args === null || Array.isArray(args)) {
    return [];
  }

  const record = args as Record<string, unknown>;
  return sensitiveArguments.flatMap((argumentName) => {
    const value = record[argumentName];
    return typeof value === "string" && value.length > 0 ? [value] : [];
  });
}
