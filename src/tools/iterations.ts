import { z } from "zod";

import { nullableOptional, optionalProjectIdSchema } from "../lib/tool-schema.js";
import type { AppContext } from "../types/context.js";
import {
  deleteGraphqlCapabilities,
  executeGraphqlData,
  getOptionalStringArray,
  getString,
  isRecord,
  omit,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  paginationShape,
  projectApiPath,
  readCapabilities,
  readGraphqlCapabilities,
  resolveProjectId,
  toQuery,
  writeGraphqlCapabilities,
  type GitLabToolDefinitionInput,
  type ToolArgs
} from "./shared.js";

const ITERATION_GID_PREFIX = "gid://gitlab/Iteration/";
const CADENCE_GID_PREFIX = "gid://gitlab/Iterations::Cadence/";
const MAX_CADENCE_PAGES = 10;

const groupIdSchema = z.string().min(1).max(1024);
const iterationIdSchema = z.coerce.string().min(1);
const cadenceIdSchema = z.coerce.string().min(1);
const isoDateSchema = nullableOptional(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "dates must use YYYY-MM-DD")
);

const ITERATION_FIELDS = "id iid title description state startDate dueDate webUrl";
const CADENCE_FIELDS =
  "id title description automatic active startDate durationInWeeks iterationsInAdvance rollOver";

const cadenceFieldsShape = {
  title: nullableOptional(z.string().min(1).max(255)),
  description: optionalString,
  automatic: optionalBoolean,
  active: optionalBoolean,
  start_date: isoDateSchema,
  duration_in_weeks: nullableOptional(z.number().int().min(1).max(4)),
  iterations_in_advance: nullableOptional(z.number().int().min(0).max(10)),
  roll_over: optionalBoolean
};

export const iterationToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_list_project_iterations",
    title: "List Project Iterations",
    description:
      "List iterations available to a project (those of its group hierarchy). Supports state, search, search_in, include_ancestors, and date filters. Premium/Ultimate.",
    capabilities: readCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      state: z.enum(["opened", "upcoming", "current", "closed", "all"]).optional(),
      search: optionalString,
      search_in: optionalStringArray,
      include_ancestors: optionalBoolean,
      updated_before: optionalString,
      updated_after: optionalString,
      ...paginationShape
    },
    handler: async (args, context) => {
      const query = toQuery(omit(args, ["project_id", "search_in"]));
      const searchIn = getOptionalStringArray(args, "search_in");
      if (searchIn && searchIn.length > 0) {
        query.in = searchIn.join(",");
      }
      return context.gitlab.get(
        projectApiPath(resolveProjectId(args, context, true), "iterations"),
        { query }
      );
    }
  },
  {
    name: "gitlab_create_group_iteration",
    title: "Create Group Iteration",
    description:
      "Create an iteration in a group. Recent GitLab versions require iterations_cadence_id of a manual (non-automatic) cadence. Dates use YYYY-MM-DD. Premium/Ultimate.",
    capabilities: writeGraphqlCapabilities,
    inputSchema: {
      group_id: groupIdSchema,
      title: nullableOptional(z.string().min(1).max(255)),
      description: optionalString,
      start_date: isoDateSchema,
      due_date: isoDateSchema,
      iterations_cadence_id: nullableOptional(cadenceIdSchema)
    },
    handler: async (args, context) => {
      const input: ToolArgs = {
        groupPath: await resolveGroupFullPath(context, getString(args, "group_id")),
        ...iterationFieldInput(args)
      };
      if (typeof args.iterations_cadence_id === "string") {
        input.iterationsCadenceId = toCadenceGid(args.iterations_cadence_id);
      }

      const data = await executeGraphqlData<{
        iterationCreate?: { iteration?: unknown; errors?: string[] };
      }>(
        context,
        `mutation CreateIteration($input: iterationCreateInput!) {
          iterationCreate(input: $input) { iteration { ${ITERATION_FIELDS} } errors }
        }`,
        { input }
      );
      return requireMutationPayload(data.iterationCreate, "iteration", "create the iteration");
    }
  },
  {
    name: "gitlab_update_group_iteration",
    title: "Update Group Iteration",
    description:
      "Update a group iteration's title, description, or dates. iteration_id is the numeric ID from the iteration list or its global ID. Premium/Ultimate.",
    capabilities: writeGraphqlCapabilities,
    inputSchema: {
      group_id: groupIdSchema,
      iteration_id: iterationIdSchema,
      title: nullableOptional(z.string().min(1).max(255)),
      description: optionalString,
      start_date: isoDateSchema,
      due_date: isoDateSchema
    },
    handler: async (args, context) => {
      const fields = iterationFieldInput(args);
      if (Object.keys(fields).length === 0) {
        throw new Error("Provide at least one iteration field to update");
      }

      const data = await executeGraphqlData<{
        updateIteration?: { iteration?: unknown; errors?: string[] };
      }>(
        context,
        `mutation UpdateIteration($input: UpdateIterationInput!) {
          updateIteration(input: $input) { iteration { ${ITERATION_FIELDS} } errors }
        }`,
        {
          input: {
            groupPath: await resolveGroupFullPath(context, getString(args, "group_id")),
            id: toIterationGid(getString(args, "iteration_id")),
            ...fields
          }
        }
      );
      return requireMutationPayload(data.updateIteration, "iteration", "update the iteration");
    }
  },
  {
    name: "gitlab_delete_group_iteration",
    title: "Delete Group Iteration",
    description:
      "Delete a group iteration permanently; issues lose the iteration. Irreversible. Requires group_id and iteration_id. Recommended pre-check: gitlab_list_group_iterations. Premium/Ultimate.",
    capabilities: deleteGraphqlCapabilities,
    inputSchema: {
      group_id: groupIdSchema,
      iteration_id: iterationIdSchema
    },
    handler: async (args, context) => {
      const groupPath = await resolveGroupFullPath(context, getString(args, "group_id"));
      const iterationGid = toIterationGid(getString(args, "iteration_id"));
      await assertGroupOwnsIteration(context, groupPath, iterationGid);

      const data = await executeGraphqlData<{ iterationDelete?: { errors?: string[] } }>(
        context,
        `mutation DeleteIteration($id: IterationID!) {
          iterationDelete(input: { id: $id }) { errors }
        }`,
        { id: iterationGid }
      );
      assertNoMutationErrors(data.iterationDelete?.errors, "delete the iteration");
      return { status: "deleted", group_path: groupPath, iteration_id: iterationGid };
    }
  },
  {
    name: "gitlab_list_group_iteration_cadences",
    title: "List Group Iteration Cadences",
    description:
      "List a group's iteration cadences (GraphQL; no REST endpoint exists). Filters: active, automatic, title, duration_in_weeks, include_ancestor_groups. Returned IDs are cadence global IDs. Premium/Ultimate.",
    capabilities: readGraphqlCapabilities,
    inputSchema: {
      group_id: groupIdSchema,
      active: optionalBoolean,
      automatic: optionalBoolean,
      title: optionalString,
      duration_in_weeks: nullableOptional(z.number().int().min(1).max(4)),
      include_ancestor_groups: optionalBoolean
    },
    handler: async (args, context) => {
      const groupPath = await resolveGroupFullPath(context, getString(args, "group_id"));
      return listCadences(context, groupPath, {
        active: args.active,
        automatic: args.automatic,
        title: args.title,
        durationInWeeks: args.duration_in_weeks,
        includeAncestorGroups: args.include_ancestor_groups
      });
    }
  },
  {
    name: "gitlab_create_group_iteration_cadence",
    title: "Create Group Iteration Cadence",
    description:
      "Create an iteration cadence. automatic cadences schedule iterations from start_date, duration_in_weeks, and iterations_in_advance; manual cadences let you create iterations yourself. Premium/Ultimate.",
    capabilities: writeGraphqlCapabilities,
    inputSchema: {
      group_id: groupIdSchema,
      ...cadenceFieldsShape,
      title: z.string().min(1).max(255),
      automatic: z.boolean(),
      active: z.boolean()
    },
    handler: async (args, context) => {
      const data = await executeGraphqlData<{
        iterationCadenceCreate?: { iterationCadence?: unknown; errors?: string[] };
      }>(
        context,
        `mutation CreateIterationCadence($input: IterationCadenceCreateInput!) {
          iterationCadenceCreate(input: $input) { iterationCadence { ${CADENCE_FIELDS} } errors }
        }`,
        {
          input: {
            groupPath: await resolveGroupFullPath(context, getString(args, "group_id")),
            ...cadenceFieldInput(args)
          }
        }
      );
      return requireMutationPayload(
        data.iterationCadenceCreate,
        "iterationCadence",
        "create the iteration cadence"
      );
    }
  },
  {
    name: "gitlab_update_group_iteration_cadence",
    title: "Update Group Iteration Cadence",
    description:
      "Update an iteration cadence of the group. iteration_cadence_id is a numeric ID or cadence global ID from gitlab_list_group_iteration_cadences. Premium/Ultimate.",
    capabilities: writeGraphqlCapabilities,
    inputSchema: {
      group_id: groupIdSchema,
      iteration_cadence_id: cadenceIdSchema,
      ...cadenceFieldsShape
    },
    handler: async (args, context) => {
      const fields = cadenceFieldInput(args);
      if (Object.keys(fields).length === 0) {
        throw new Error("Provide at least one iteration cadence field to update");
      }

      const groupPath = await resolveGroupFullPath(context, getString(args, "group_id"));
      const cadenceGid = toCadenceGid(getString(args, "iteration_cadence_id"));
      await assertGroupOwnsCadence(context, groupPath, cadenceGid);

      const data = await executeGraphqlData<{
        iterationCadenceUpdate?: { iterationCadence?: unknown; errors?: string[] };
      }>(
        context,
        `mutation UpdateIterationCadence($input: IterationCadenceUpdateInput!) {
          iterationCadenceUpdate(input: $input) { iterationCadence { ${CADENCE_FIELDS} } errors }
        }`,
        { input: { id: cadenceGid, ...fields } }
      );
      return requireMutationPayload(
        data.iterationCadenceUpdate,
        "iterationCadence",
        "update the iteration cadence"
      );
    }
  },
  {
    name: "gitlab_delete_group_iteration_cadence",
    title: "Delete Group Iteration Cadence",
    description:
      "Delete an iteration cadence and its iterations permanently. Irreversible. Requires group_id and iteration_cadence_id. Recommended pre-check: gitlab_list_group_iteration_cadences. Premium/Ultimate.",
    capabilities: deleteGraphqlCapabilities,
    inputSchema: {
      group_id: groupIdSchema,
      iteration_cadence_id: cadenceIdSchema
    },
    handler: async (args, context) => {
      const groupPath = await resolveGroupFullPath(context, getString(args, "group_id"));
      const cadenceGid = toCadenceGid(getString(args, "iteration_cadence_id"));
      await assertGroupOwnsCadence(context, groupPath, cadenceGid);

      const data = await executeGraphqlData<{ iterationCadenceDestroy?: { errors?: string[] } }>(
        context,
        `mutation DeleteIterationCadence($id: IterationsCadenceID!) {
          iterationCadenceDestroy(input: { id: $id }) { errors }
        }`,
        { id: cadenceGid }
      );
      assertNoMutationErrors(data.iterationCadenceDestroy?.errors, "delete the iteration cadence");
      return { status: "deleted", group_path: groupPath, iteration_cadence_id: cadenceGid };
    }
  }
];

/** Iteration tools that address a group; they are group scoped. */
export const GROUP_ITERATION_TOOL_NAMES = iterationToolDefinitions
  .map((definition) => definition.name)
  .filter((name) => name !== "gitlab_list_project_iterations");

function iterationFieldInput(args: ToolArgs): ToolArgs {
  return dropUndefined({
    title: args.title,
    description: args.description,
    startDate: args.start_date,
    dueDate: args.due_date
  });
}

function cadenceFieldInput(args: ToolArgs): ToolArgs {
  return dropUndefined({
    title: args.title,
    description: args.description,
    automatic: args.automatic,
    active: args.active,
    startDate: args.start_date,
    durationInWeeks: args.duration_in_weeks,
    iterationsInAdvance: args.iterations_in_advance,
    rollOver: args.roll_over
  });
}

function dropUndefined(record: ToolArgs): ToolArgs {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function toIterationGid(value: string): string {
  return toGlobalId(value, ITERATION_GID_PREFIX, "iteration_id");
}

export function toCadenceGid(value: string): string {
  return toGlobalId(value, CADENCE_GID_PREFIX, "iteration_cadence_id");
}

function toGlobalId(value: string, prefix: string, label: string): string {
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    return `${prefix}${trimmed}`;
  }
  if (trimmed.startsWith(prefix) && /^\d+$/u.test(trimmed.slice(prefix.length))) {
    return trimmed;
  }
  throw new Error(`'${label}' must be a numeric ID or a ${prefix}<id> global ID`);
}

/** GraphQL mutations need the group's full path; numeric IDs are resolved over REST. */
async function resolveGroupFullPath(context: AppContext, groupId: string): Promise<string> {
  if (/^\d+$/u.test(groupId)) {
    const group = await context.gitlab.getGroup(groupId);
    if (!isRecord(group) || typeof group.full_path !== "string") {
      throw new Error(`Could not resolve the full path of group ${groupId}`);
    }
    return group.full_path;
  }

  try {
    return decodeURIComponent(groupId);
  } catch {
    return groupId;
  }
}

async function listCadences(
  context: AppContext,
  groupPath: string,
  filters: Record<string, unknown>
): Promise<unknown[]> {
  const cadences: unknown[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_CADENCE_PAGES; page += 1) {
    const data = await executeGraphqlData<{
      group?: {
        iterationCadences?: {
          nodes?: unknown[];
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
        };
      } | null;
    }>(
      context,
      `query GroupIterationCadences(
        $fullPath: ID!, $id: IterationsCadenceID, $active: Boolean, $automatic: Boolean,
        $title: String, $durationInWeeks: Int, $includeAncestorGroups: Boolean, $after: String
      ) {
        group(fullPath: $fullPath) {
          iterationCadences(
            id: $id, active: $active, automatic: $automatic, title: $title,
            durationInWeeks: $durationInWeeks, includeAncestorGroups: $includeAncestorGroups,
            first: 100, after: $after
          ) {
            nodes { ${CADENCE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`,
      { fullPath: groupPath, ...dropUndefined(filters), after }
    );

    if (!data.group) {
      throw new Error(`Group '${groupPath}' was not found or is not accessible`);
    }
    const connection = data.group.iterationCadences;
    cadences.push(...(connection?.nodes ?? []));
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) {
      break;
    }
    after = connection.pageInfo.endCursor;
  }
  return cadences;
}

async function assertGroupOwnsCadence(
  context: AppContext,
  groupPath: string,
  cadenceGid: string
): Promise<void> {
  const cadences = await listCadences(context, groupPath, { id: cadenceGid });
  if (!cadences.some((cadence) => isRecord(cadence) && cadence.id === cadenceGid)) {
    throw new Error(`Iteration cadence ${cadenceGid} does not belong to group '${groupPath}'`);
  }
}

async function assertGroupOwnsIteration(
  context: AppContext,
  groupPath: string,
  iterationGid: string
): Promise<void> {
  const data = await executeGraphqlData<{
    group?: { iterations?: { nodes?: Array<{ id?: string }> } } | null;
  }>(
    context,
    `query GroupIteration($fullPath: ID!, $id: ID!) {
      group(fullPath: $fullPath) {
        iterations(id: $id, includeAncestors: false, first: 1) { nodes { id } }
      }
    }`,
    { fullPath: groupPath, id: iterationGid }
  );
  if (!data.group?.iterations?.nodes?.some((node) => node.id === iterationGid)) {
    throw new Error(`Iteration ${iterationGid} does not belong to group '${groupPath}'`);
  }
}

function requireMutationPayload(
  payload: Record<string, unknown> | undefined,
  key: string,
  action: string
): unknown {
  assertNoMutationErrors(payload?.errors as string[] | undefined, action);
  const value = payload?.[key];
  if (!value) {
    throw new Error(`GitLab did not ${action}: the mutation returned no ${key}`);
  }
  return value;
}

function assertNoMutationErrors(errors: string[] | undefined, action: string): void {
  if (errors && errors.length > 0) {
    throw new Error(`Failed to ${action}: ${errors.join(", ")}`);
  }
}
