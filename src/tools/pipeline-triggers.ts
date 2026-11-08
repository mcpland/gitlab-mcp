import { z } from "zod";

import { copyPaginationMetadata } from "../lib/pagination.js";
import { nullableOptional, optionalProjectIdSchema, refLikeSchema } from "../lib/tool-schema.js";
import {
  deleteCapabilities,
  getOptionalRecord,
  getString,
  isRecord,
  jsonBody,
  optionalString,
  paginationShape,
  pickPresentFields,
  projectApiPath,
  readCapabilities,
  resolveProjectId,
  toQuery,
  writeCapabilities,
  type GitLabToolDefinitionInput
} from "./shared.js";

const triggerIdSchema = z.coerce.string().min(1);
const triggerDescriptionSchema = z.string().min(1).max(255);

export const pipelineTriggerToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_list_pipeline_triggers",
    title: "List Pipeline Trigger Tokens",
    description:
      "List pipeline trigger tokens with description, owner, and last_used. Token values are never returned.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      ...paginationShape
    },
    handler: async (args, context) =>
      omitTriggerTokens(
        await context.gitlab.get(
          projectApiPath(resolveProjectId(args, context, true), "triggers"),
          { query: toQuery(pickPresentFields(args, ["page", "per_page"])) }
        )
      )
  },
  {
    name: "gitlab_get_pipeline_trigger",
    title: "Get Pipeline Trigger Token",
    description: "Get one pipeline trigger token's metadata. The token value is never returned.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      trigger_id: triggerIdSchema
    },
    handler: async (args, context) =>
      omitTriggerTokens(
        await context.gitlab.get(
          projectApiPath(
            resolveProjectId(args, context, true),
            "triggers",
            getString(args, "trigger_id")
          )
        )
      )
  },
  {
    name: "gitlab_create_pipeline_trigger",
    title: "Create Pipeline Trigger Token",
    description:
      "Create a pipeline trigger token for external systems. The response contains the new token once; store it securely because list, get, and update never return it.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      description: triggerDescriptionSchema,
      expires_at: optionalString
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(resolveProjectId(args, context, true), "triggers"),
        jsonBody(pickPresentFields(args, ["description", "expires_at"]))
      )
  },
  {
    name: "gitlab_update_pipeline_trigger",
    title: "Update Pipeline Trigger Token",
    description:
      "Change a pipeline trigger token's description. The token value is never returned.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      trigger_id: triggerIdSchema,
      description: triggerDescriptionSchema
    },
    handler: async (args, context) =>
      omitTriggerTokens(
        await context.gitlab.put(
          projectApiPath(
            resolveProjectId(args, context, true),
            "triggers",
            getString(args, "trigger_id")
          ),
          jsonBody(pickPresentFields(args, ["description"]))
        )
      )
  },
  {
    name: "gitlab_delete_pipeline_trigger",
    title: "Delete Pipeline Trigger Token",
    description:
      "Delete a pipeline trigger token permanently; systems that use it can no longer start pipelines. Requires trigger_id. Recommended pre-check: gitlab_list_pipeline_triggers.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      trigger_id: triggerIdSchema
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const triggerId = getString(args, "trigger_id");
      await context.gitlab.delete(projectApiPath(projectId, "triggers", triggerId));
      return { status: "deleted", project_id: projectId, trigger_id: triggerId };
    }
  },
  {
    name: "gitlab_trigger_pipeline",
    title: "Trigger Pipeline With Token",
    description:
      "Start a pipeline with a pipeline trigger token or CI/CD job token, as used by external systems and multi-project pipelines. Use gitlab_create_pipeline when acting with your own credentials. The token is sent in the request body and never echoed.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    sensitiveArguments: ["token"],
    inputSchema: {
      project_id: optionalProjectIdSchema,
      token: z.string().min(1),
      ref: refLikeSchema,
      variables: nullableOptional(z.record(z.string(), z.string())),
      inputs: nullableOptional(z.record(z.string(), z.unknown()))
    },
    handler: async (args, context) => {
      const payload: Record<string, unknown> = {
        token: getString(args, "token"),
        ref: getString(args, "ref")
      };
      const variables = getOptionalRecord(args, "variables");
      const inputs = getOptionalRecord(args, "inputs");
      if (variables) {
        payload.variables = variables;
      }
      if (inputs) {
        payload.inputs = inputs;
      }

      return context.gitlab.post(
        projectApiPath(resolveProjectId(args, context, true), "trigger", "pipeline"),
        jsonBody(payload)
      );
    }
  }
];

/** Trigger tokens are credentials: drop the value from every read and update response. */
function omitTriggerTokens(value: unknown): unknown {
  if (Array.isArray(value)) {
    return copyPaginationMetadata(
      value,
      value.map((item) => omitTriggerTokens(item))
    );
  }

  if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "token")) {
    return value;
  }

  const rest: Record<string, unknown> = { ...value };
  delete rest.token;
  return copyPaginationMetadata(value, rest);
}
