import { z } from "zod";

import {
  booleanLikeSchema,
  displayNameSchema,
  nullableOptional,
  optionalProjectIdSchema
} from "../lib/tool-schema.js";
import {
  deleteCapabilities,
  getOptionalBoolean,
  getString,
  jsonBody,
  optionalBoolean,
  optionalNumber,
  optionalString,
  pickPresentFields,
  projectApiPath,
  resolveProjectId,
  toQuery,
  writeCapabilities,
  type GitLabToolDefinitionInput
} from "./shared.js";

const environmentIdSchema = z.coerce.string().min(1);
const environmentTierSchema = z
  .enum(["production", "staging", "testing", "development", "other"])
  .optional();
const autoStopSettingSchema = z.enum(["always", "with_action"]).optional();
const externalUrlSchema = nullableOptional(
  z
    .string()
    .url()
    .max(2048)
    .regex(/^https?:\/\//iu, "external_url must use http or https")
);
const environmentSettingsShape = {
  external_url: externalUrlSchema,
  tier: environmentTierSchema,
  description: nullableOptional(z.string().max(10_000)),
  cluster_agent_id: optionalNumber,
  kubernetes_namespace: optionalString,
  flux_resource_path: optionalString,
  auto_stop_setting: autoStopSettingSchema
};
const ENVIRONMENT_SETTING_FIELDS = Object.keys(environmentSettingsShape);

export const environmentToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_create_environment",
    title: "Create Environment",
    description:
      "Create a project environment with optional external URL, tier, description, Kubernetes settings, and auto-stop behavior.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      name: displayNameSchema,
      ...environmentSettingsShape
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(resolveProjectId(args, context, true), "environments"),
        jsonBody(pickPresentFields(args, ["name", ...ENVIRONMENT_SETTING_FIELDS]))
      )
  },
  {
    name: "gitlab_update_environment",
    title: "Update Environment",
    description:
      "Update an environment's external URL, tier, description, Kubernetes settings, or auto-stop behavior. GitLab does not allow renaming environments.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      environment_id: environmentIdSchema,
      ...environmentSettingsShape
    },
    handler: async (args, context) => {
      const payload = pickPresentFields(args, ENVIRONMENT_SETTING_FIELDS);
      if (Object.keys(payload).length === 0) {
        throw new Error("Provide at least one environment field to update");
      }

      return context.gitlab.put(
        projectApiPath(
          resolveProjectId(args, context, true),
          "environments",
          getString(args, "environment_id")
        ),
        jsonBody(payload)
      );
    }
  },
  {
    name: "gitlab_stop_environment",
    title: "Stop Environment",
    description:
      "Stop an environment, which runs its on_stop job and typically tears down the deployed app. force=true stops it without running on_stop. Recommended pre-check: gitlab_get_environment.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      environment_id: environmentIdSchema,
      force: optionalBoolean
    },
    handler: async (args, context) => {
      const force = getOptionalBoolean(args, "force");
      return context.gitlab.post(
        projectApiPath(
          resolveProjectId(args, context, true),
          "environments",
          getString(args, "environment_id"),
          "stop"
        ),
        force === undefined ? {} : { query: { force } }
      );
    }
  },
  {
    name: "gitlab_stop_stale_environments",
    title: "Stop Stale Environments",
    description:
      "Stop every environment last modified or deployed before an ISO 8601 date (between 10 years and 1 week ago). GitLab skips protected environments; this stops but does not delete.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      before: z.string().min(1)
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(resolveProjectId(args, context, true), "environments", "stop_stale"),
        { query: { before: getString(args, "before") } }
      )
  },
  {
    name: "gitlab_delete_environment",
    title: "Delete Environment",
    description:
      "Delete a stopped environment permanently. Irreversible. Requires environment_id. Recommended pre-check: gitlab_get_environment, then gitlab_stop_environment.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      environment_id: environmentIdSchema
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const environmentId = getString(args, "environment_id");
      await context.gitlab.delete(projectApiPath(projectId, "environments", environmentId));
      return { status: "deleted", project_id: projectId, environment_id: environmentId };
    }
  },
  {
    name: "gitlab_delete_review_app_environments",
    title: "Delete Review App Environments",
    description:
      "Find stopped review-app environments older than before (default 30 days ago) and, with dry_run=false, schedule their deletion one week later. dry_run defaults to true and only previews.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      before: optionalString,
      limit: nullableOptional(z.number().int().min(1).max(1000)),
      dry_run: booleanLikeSchema.default(true)
    },
    handler: async (args, context) =>
      context.gitlab.delete(
        projectApiPath(resolveProjectId(args, context, true), "environments", "review_apps"),
        { query: toQuery(pickPresentFields(args, ["before", "limit", "dry_run"])) }
      )
  }
];
