import { z } from "zod";

import {
  booleanLikeSchema,
  nullableOptional,
  optionalProjectIdSchema,
  refLikeSchema
} from "../lib/tool-schema.js";
import {
  deleteCapabilities,
  getString,
  jsonBody,
  omit,
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

const deploymentIdSchema = z.coerce.string().min(1);
const deploymentStatusSchema = z.enum(["running", "success", "failed", "canceled"]);
const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/iu, "sha must be a hexadecimal commit SHA");

export const deploymentToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_create_deployment",
    title: "Create Deployment",
    description:
      "Record a deployment of a commit to an environment, for deploys performed outside GitLab CI/CD. The environment is created if it does not exist.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      environment: z.string().min(1).max(255),
      sha: commitShaSchema,
      ref: refLikeSchema,
      tag: booleanLikeSchema,
      status: deploymentStatusSchema
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(resolveProjectId(args, context, true), "deployments"),
        jsonBody(pickPresentFields(args, ["environment", "sha", "ref", "tag", "status"]))
      )
  },
  {
    name: "gitlab_update_deployment",
    title: "Update Deployment",
    description: "Change the status of a deployment created outside GitLab CI/CD.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      deployment_id: deploymentIdSchema,
      status: deploymentStatusSchema
    },
    handler: async (args, context) =>
      context.gitlab.put(
        projectApiPath(
          resolveProjectId(args, context, true),
          "deployments",
          getString(args, "deployment_id")
        ),
        jsonBody(pickPresentFields(args, ["status"]))
      )
  },
  {
    name: "gitlab_delete_deployment",
    title: "Delete Deployment",
    description:
      "Delete a deployment record permanently. GitLab refuses running deployments and the latest deployment of an environment. Requires deployment_id. Recommended pre-check: gitlab_get_deployment.",
    capabilities: deleteCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      deployment_id: deploymentIdSchema
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const deploymentId = getString(args, "deployment_id");
      await context.gitlab.delete(projectApiPath(projectId, "deployments", deploymentId));
      return { status: "deleted", project_id: projectId, deployment_id: deploymentId };
    }
  },
  {
    name: "gitlab_approve_deployment",
    title: "Approve or Reject Deployment",
    description:
      "Approve or reject a blocked deployment to a protected environment. Approving can let a production deploy proceed. Premium/Ultimate.",
    capabilities: writeCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      deployment_id: deploymentIdSchema,
      status: z.enum(["approved", "rejected"]),
      comment: nullableOptional(z.string().max(10_000)),
      represented_as: optionalString
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(
          resolveProjectId(args, context, true),
          "deployments",
          getString(args, "deployment_id"),
          "approval"
        ),
        jsonBody(pickPresentFields(args, ["status", "comment", "represented_as"]))
      )
  },
  {
    name: "gitlab_list_deployment_merge_requests",
    title: "List Deployment Merge Requests",
    description:
      "List merge requests shipped with a deployment, for release notes and change tracking. Supports state, ordering, and pagination.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      deployment_id: deploymentIdSchema,
      state: z.enum(["opened", "closed", "locked", "merged", "all"]).optional(),
      order_by: z.enum(["created_at", "updated_at", "merged_at", "title"]).optional(),
      sort: z.enum(["asc", "desc"]).optional(),
      ...paginationShape
    },
    handler: async (args, context) =>
      context.gitlab.get(
        projectApiPath(
          resolveProjectId(args, context, true),
          "deployments",
          getString(args, "deployment_id"),
          "merge_requests"
        ),
        { query: toQuery(omit(args, ["project_id", "deployment_id"])) }
      )
  }
];
