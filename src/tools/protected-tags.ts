import { z } from "zod";

import {
  nullableOptional,
  optionalProjectIdSchema,
  protectedBranchNameSchema
} from "../lib/tool-schema.js";
import {
  adminCapabilities,
  deleteCapabilities,
  getString,
  jsonBody,
  paginationShape,
  pickPresentFields,
  projectApiPath,
  readCapabilities,
  resolveProjectId,
  toQuery,
  type GitLabToolDefinitionInput
} from "./shared.js";

const protectedTagNameSchema = protectedBranchNameSchema;
const createAccessLevelSchema = z.union([
  z.literal(0),
  z.literal(30),
  z.literal(40),
  z.literal(60)
]);
const allowedToCreateSchema = z
  .object({
    user_id: z.number().int().positive().optional(),
    group_id: z.number().int().positive().optional(),
    deploy_key_id: z.number().int().positive().optional(),
    access_level: createAccessLevelSchema.optional()
  })
  .refine(
    (entry) =>
      [entry.user_id, entry.group_id, entry.deploy_key_id, entry.access_level].filter(
        (value) => value !== undefined
      ).length === 1,
    {
      message:
        "each allowed_to_create entry needs exactly one of user_id, group_id, deploy_key_id, or access_level"
    }
  );

export const protectedTagToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_list_protected_tags",
    title: "List Protected Tags",
    description:
      "List protected tag rules (names or wildcards such as v*) with their create access levels.",
    capabilities: readCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      ...paginationShape
    },
    handler: async (args, context) =>
      context.gitlab.get(projectApiPath(resolveProjectId(args, context, true), "protected_tags"), {
        query: toQuery(pickPresentFields(args, ["page", "per_page"]))
      })
  },
  {
    name: "gitlab_get_protected_tag",
    title: "Get Protected Tag",
    description: "Get one protected tag rule by tag name or wildcard.",
    capabilities: readCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      name: protectedTagNameSchema
    },
    handler: async (args, context) =>
      context.gitlab.get(
        projectApiPath(
          resolveProjectId(args, context, true),
          "protected_tags",
          getString(args, "name")
        )
      )
  },
  {
    name: "gitlab_protect_tag",
    title: "Protect Tag",
    description:
      "Protect a tag name or wildcard (for example v*) so only allowed roles can create it and protected CI/CD variables reach its pipelines. create_access_level: 0 no one, 30 Developer, 40 Maintainer (default), 60 Admin.",
    capabilities: adminCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      name: protectedTagNameSchema,
      create_access_level: nullableOptional(createAccessLevelSchema),
      allowed_to_create: nullableOptional(z.array(allowedToCreateSchema).min(1).max(50))
    },
    handler: async (args, context) =>
      context.gitlab.post(
        projectApiPath(resolveProjectId(args, context, true), "protected_tags"),
        jsonBody(pickPresentFields(args, ["name", "create_access_level", "allowed_to_create"]))
      )
  },
  {
    name: "gitlab_unprotect_tag",
    title: "Unprotect Tag",
    description:
      "Remove protection from a tag name or wildcard, allowing any developer to create matching tags. Requires name. Recommended pre-check: gitlab_get_protected_tag.",
    capabilities: deleteCapabilities,
    inputSchema: {
      project_id: optionalProjectIdSchema,
      name: protectedTagNameSchema
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const name = getString(args, "name");
      await context.gitlab.delete(projectApiPath(projectId, "protected_tags", name));
      return { status: "unprotected", project_id: projectId, name };
    }
  }
];
