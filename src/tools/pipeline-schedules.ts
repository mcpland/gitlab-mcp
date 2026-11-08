import { z } from "zod";

import { copyPaginationMetadata } from "../lib/pagination.js";
import {
  nullableOptional,
  optionalDisplayNameSchema,
  optionalProjectIdSchema,
  optionalRefLikeSchema
} from "../lib/tool-schema.js";
import {
  ciVariableKeySchema,
  deleteCapabilities,
  getOptionalBoolean,
  getString,
  isRecord,
  jsonBody,
  omit,
  optionalBoolean,
  optionalString,
  paginationShape,
  pickPresentFields,
  projectApiPath,
  readCapabilities,
  resolveProjectId,
  toQuery,
  writeCapabilities,
  type GitLabToolDefinitionInput,
  type ToolArgs
} from "./shared.js";

const scheduleIdSchema = z.coerce.string().min(1);
const cronSchema = z.string().min(1).max(255);
const scheduleInputValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown())
]);
const createScheduleInputsSchema = nullableOptional(
  z.array(z.object({ name: z.string().min(1), value: scheduleInputValueSchema })).max(100)
);
const updateScheduleInputsSchema = nullableOptional(
  z
    .array(
      z.object({
        name: z.string().min(1),
        value: scheduleInputValueSchema.optional(),
        destroy: optionalBoolean
      })
    )
    .max(100)
);
const scheduleVariableTypeSchema = z.enum(["env_var", "file"]).optional();
const pipelineStatusSchema = z.enum([
  "created",
  "waiting_for_resource",
  "preparing",
  "waiting_for_callback",
  "pending",
  "running",
  "success",
  "failed",
  "canceling",
  "canceled",
  "skipped",
  "manual",
  "scheduled"
]);

const SCHEDULE_VARIABLE_SAFE_FIELDS = ["key", "variable_type", "raw"] as const;

export const pipelineScheduleToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_list_pipeline_schedules",
    title: "List Pipeline Schedules",
    description:
      "List scheduled pipelines with cron, timezone, next_run_at, owner, and active state. Use gitlab_get_pipeline_schedule for variables and inputs.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      scope: z.enum(["active", "inactive"]).optional(),
      ...paginationShape
    },
    handler: async (args, context) =>
      context.gitlab.get(
        projectApiPath(resolveProjectId(args, context, true), "pipeline_schedules"),
        {
          query: toQuery(omit(args, ["project_id"]))
        }
      )
  },
  {
    name: "gitlab_get_pipeline_schedule",
    title: "Get Pipeline Schedule",
    description:
      "Get one pipeline schedule with its last pipeline, inputs, and variable metadata. Variable values require GITLAB_ALLOW_CI_VARIABLE_VALUES=true and include_variable_values=true.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_schedule_id: scheduleIdSchema,
      include_variable_values: optionalBoolean
    },
    handler: async (args, context) => {
      const schedule = await context.gitlab.get(
        projectApiPath(
          resolveProjectId(args, context, true),
          "pipeline_schedules",
          getString(args, "pipeline_schedule_id")
        )
      );
      return redactScheduleVariableValues(
        schedule,
        context.env.GITLAB_ALLOW_CI_VARIABLE_VALUES &&
          getOptionalBoolean(args, "include_variable_values") === true
      );
    }
  },
  {
    name: "gitlab_list_pipeline_schedule_pipelines",
    title: "List Pipeline Schedule Pipelines",
    description:
      "List pipelines triggered by one pipeline schedule, with scope, status, sort, and date filters.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_schedule_id: scheduleIdSchema,
      scope: z.enum(["running", "pending", "finished", "branches", "tags"]).optional(),
      status: pipelineStatusSchema.optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      updated_after: optionalString,
      updated_before: optionalString,
      created_after: optionalString,
      created_before: optionalString,
      ...paginationShape
    },
    handler: async (args, context) =>
      context.gitlab.get(
        projectApiPath(
          resolveProjectId(args, context, true),
          "pipeline_schedules",
          getString(args, "pipeline_schedule_id"),
          "pipelines"
        ),
        { query: toQuery(omit(args, ["project_id", "pipeline_schedule_id"])) }
      )
  },
  {
    name: "gitlab_create_pipeline_schedule",
    title: "Create Pipeline Schedule",
    description:
      "Create a recurring pipeline from a cron expression. cron_timezone defaults to UTC; use a full ref such as refs/heads/main when a branch and tag share a name. inputs ([{name, value}]) need GitLab 18.1+.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      description: z.string().min(1).max(255),
      ref: z.string().min(1).max(255),
      cron: cronSchema,
      cron_timezone: optionalDisplayNameSchema,
      active: optionalBoolean,
      inputs: createScheduleInputsSchema
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(resolveProjectId(args, context, true), "pipeline_schedules"),
        jsonBody(
          pickPresentFields(args, [
            "description",
            "ref",
            "cron",
            "cron_timezone",
            "active",
            "inputs"
          ])
        )
      )
  },
  {
    name: "gitlab_update_pipeline_schedule",
    title: "Update Pipeline Schedule",
    description:
      "Change a pipeline schedule. Pass active=false to pause it. To remove an input, pass {name, destroy: true}. Take ownership first when the schedule belongs to another user.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_schedule_id: scheduleIdSchema,
      description: nullableOptional(z.string().min(1).max(255)),
      ref: optionalRefLikeSchema,
      cron: nullableOptional(cronSchema),
      cron_timezone: optionalDisplayNameSchema,
      active: optionalBoolean,
      inputs: updateScheduleInputsSchema
    },
    handler: async (args, context) => {
      const payload = pickPresentFields(args, [
        "description",
        "ref",
        "cron",
        "cron_timezone",
        "active",
        "inputs"
      ]);
      if (Object.keys(payload).length === 0) {
        throw new Error("Provide at least one pipeline schedule field to update");
      }

      return context.gitlab.put(
        projectApiPath(
          resolveProjectId(args, context, true),
          "pipeline_schedules",
          getString(args, "pipeline_schedule_id")
        ),
        jsonBody(payload)
      );
    }
  },
  {
    name: "gitlab_delete_pipeline_schedule",
    title: "Delete Pipeline Schedule",
    description:
      "Delete a pipeline schedule and its variables permanently. Irreversible; prefer gitlab_update_pipeline_schedule with active=false to pause. Requires pipeline_schedule_id.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_schedule_id: scheduleIdSchema
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const scheduleId = getString(args, "pipeline_schedule_id");
      await context.gitlab.delete(projectApiPath(projectId, "pipeline_schedules", scheduleId));
      return { status: "deleted", project_id: projectId, pipeline_schedule_id: scheduleId };
    }
  },
  {
    name: "gitlab_play_pipeline_schedule",
    title: "Play Pipeline Schedule",
    description:
      "Run a pipeline schedule now without changing next_run_at. GitLab rate-limits this per schedule.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_schedule_id: scheduleIdSchema
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(
          resolveProjectId(args, context, true),
          "pipeline_schedules",
          getString(args, "pipeline_schedule_id"),
          "play"
        )
      )
  },
  {
    name: "gitlab_take_ownership_pipeline_schedule",
    title: "Take Ownership of Pipeline Schedule",
    description:
      "Make the current user the owner of a pipeline schedule; scheduled pipelines then run as this user.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_schedule_id: scheduleIdSchema
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(
          resolveProjectId(args, context, true),
          "pipeline_schedules",
          getString(args, "pipeline_schedule_id"),
          "take_ownership"
        )
      )
  },
  {
    name: "gitlab_create_pipeline_schedule_variable",
    title: "Create Pipeline Schedule Variable",
    description:
      "Add a variable to a pipeline schedule. The supplied value is never returned or included in errors.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    requiresExplicitEnable: "ciVariables",
    sensitiveArguments: ["value"],
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_schedule_id: scheduleIdSchema,
      key: ciVariableKeySchema,
      value: z.string(),
      variable_type: scheduleVariableTypeSchema
    },
    handler: async (args, context) =>
      stripScheduleVariableValue(
        await context.gitlab.post(
          projectApiPath(
            resolveProjectId(args, context, true),
            "pipeline_schedules",
            getString(args, "pipeline_schedule_id"),
            "variables"
          ),
          jsonBody(pickPresentFields(args, ["key", "value", "variable_type"]))
        )
      )
  },
  {
    name: "gitlab_update_pipeline_schedule_variable",
    title: "Update Pipeline Schedule Variable",
    description:
      "Change the value or type of a pipeline schedule variable. The supplied value is never returned or included in errors.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    requiresExplicitEnable: "ciVariables",
    sensitiveArguments: ["value"],
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_schedule_id: scheduleIdSchema,
      key: ciVariableKeySchema,
      value: z.string(),
      variable_type: scheduleVariableTypeSchema
    },
    handler: async (args, context) =>
      stripScheduleVariableValue(
        await context.gitlab.put(
          projectApiPath(
            resolveProjectId(args, context, true),
            "pipeline_schedules",
            getString(args, "pipeline_schedule_id"),
            "variables",
            getString(args, "key")
          ),
          jsonBody(pickPresentFields(args, ["value", "variable_type"]))
        )
      )
  },
  {
    name: "gitlab_delete_pipeline_schedule_variable",
    title: "Delete Pipeline Schedule Variable",
    description:
      "Delete a pipeline schedule variable permanently. Later scheduled pipelines no longer receive it. Requires pipeline_schedule_id and key.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    requiresExplicitEnable: "ciVariables",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      pipeline_schedule_id: scheduleIdSchema,
      key: ciVariableKeySchema
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const scheduleId = getString(args, "pipeline_schedule_id");
      const key = getString(args, "key");
      await context.gitlab.delete(
        projectApiPath(projectId, "pipeline_schedules", scheduleId, "variables", key)
      );
      return {
        status: "deleted",
        project_id: projectId,
        pipeline_schedule_id: scheduleId,
        key
      };
    }
  }
];

/**
 * Pipeline schedule variables hold the same kind of secrets as CI/CD
 * variables, so values follow the same server-side opt-in.
 */
function redactScheduleVariableValues(schedule: unknown, includeValues: boolean): unknown {
  if (includeValues || !isRecord(schedule) || !Array.isArray(schedule.variables)) {
    return schedule;
  }

  return copyPaginationMetadata(schedule, {
    ...schedule,
    variables: schedule.variables.map((variable) => stripScheduleVariableValue(variable))
  });
}

function stripScheduleVariableValue(variable: unknown): unknown {
  if (!isRecord(variable)) {
    return variable;
  }

  const output: ToolArgs = {};
  for (const field of SCHEDULE_VARIABLE_SAFE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(variable, field)) {
      output[field] = variable[field];
    }
  }
  return output;
}
