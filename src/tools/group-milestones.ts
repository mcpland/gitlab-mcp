import { z } from "zod";

import { nullableOptional } from "../lib/tool-schema.js";
import {
  deleteCapabilities,
  getOptionalNumberArray,
  getString,
  groupApiPath,
  jsonBody,
  omit,
  optionalBoolean,
  optionalNumberArray,
  optionalString,
  paginationShape,
  pickPresentFields,
  readCapabilities,
  toQuery,
  writeCapabilities,
  type GitLabToolDefinitionInput
} from "./shared.js";

const groupIdSchema = z.string().min(1).max(1024);
const milestoneIdSchema = z.coerce.string().min(1);
const milestoneStateSchema = z.enum(["active", "closed"]).optional();

export const groupMilestoneToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_list_group_milestones",
    title: "List Group Milestones",
    description:
      "List milestones defined on a group. Supports iids, state, title, search, ancestor/descendant inclusion, and date filters.",
    capabilities: readCapabilities,
    requiresFeature: "milestone",
    inputSchema: {
      group_id: groupIdSchema,
      iids: optionalNumberArray,
      state: milestoneStateSchema,
      title: optionalString,
      search: optionalString,
      search_title: optionalString,
      include_ancestors: optionalBoolean,
      include_descendants: optionalBoolean,
      updated_before: optionalString,
      updated_after: optionalString,
      containing_date: optionalString,
      start_date: optionalString,
      end_date: optionalString,
      ...paginationShape
    },
    handler: async (args, context) => {
      const iids = getOptionalNumberArray(args, "iids");
      return context.gitlab.get(groupApiPath(getString(args, "group_id"), "milestones"), {
        query: {
          ...toQuery(omit(args, ["group_id", "iids"])),
          ...(iids && iids.length > 0 ? { iids } : {})
        }
      });
    }
  },
  {
    name: "gitlab_get_group_milestone",
    title: "Get Group Milestone",
    description: "Get one group milestone by its ID.",
    capabilities: readCapabilities,
    requiresFeature: "milestone",
    inputSchema: {
      group_id: groupIdSchema,
      milestone_id: milestoneIdSchema
    },
    handler: async (args, context) =>
      context.gitlab.get(
        groupApiPath(getString(args, "group_id"), "milestones", getString(args, "milestone_id"))
      )
  },
  {
    name: "gitlab_create_group_milestone",
    title: "Create Group Milestone",
    description:
      "Create a group milestone that projects and subgroups in the group can use. Dates use YYYY-MM-DD.",
    capabilities: writeCapabilities,
    requiresFeature: "milestone",
    inputSchema: {
      group_id: groupIdSchema,
      title: z.string().min(1).max(255),
      description: optionalString,
      due_date: optionalString,
      start_date: optionalString
    },
    handler: async (args, context) =>
      context.gitlab.post(
        groupApiPath(getString(args, "group_id"), "milestones"),
        jsonBody(pickPresentFields(args, ["title", "description", "due_date", "start_date"]))
      )
  },
  {
    name: "gitlab_update_group_milestone",
    title: "Update Group Milestone",
    description:
      "Update a group milestone's title, description, dates, or state (state_event close or activate).",
    capabilities: writeCapabilities,
    requiresFeature: "milestone",
    inputSchema: {
      group_id: groupIdSchema,
      milestone_id: milestoneIdSchema,
      title: nullableOptional(z.string().min(1).max(255)),
      description: optionalString,
      due_date: optionalString,
      start_date: optionalString,
      state_event: z.enum(["close", "activate"]).optional()
    },
    handler: async (args, context) => {
      const payload = pickPresentFields(args, [
        "title",
        "description",
        "due_date",
        "start_date",
        "state_event"
      ]);
      if (Object.keys(payload).length === 0) {
        throw new Error("Provide at least one group milestone field to update");
      }

      return context.gitlab.put(
        groupApiPath(getString(args, "group_id"), "milestones", getString(args, "milestone_id")),
        jsonBody(payload)
      );
    }
  },
  {
    name: "gitlab_delete_group_milestone",
    title: "Delete Group Milestone",
    description:
      "Delete a group milestone permanently; issues and merge requests lose the milestone. Irreversible. Requires group_id and milestone_id. Recommended pre-check: gitlab_get_group_milestone.",
    capabilities: deleteCapabilities,
    requiresFeature: "milestone",
    inputSchema: {
      group_id: groupIdSchema,
      milestone_id: milestoneIdSchema
    },
    handler: async (args, context) => {
      const groupId = getString(args, "group_id");
      const milestoneId = getString(args, "milestone_id");
      await context.gitlab.delete(groupApiPath(groupId, "milestones", milestoneId));
      return { status: "deleted", group_id: groupId, milestone_id: milestoneId };
    }
  },
  {
    name: "gitlab_list_group_milestone_issues",
    title: "List Group Milestone Issues",
    description: "List issues assigned to a group milestone across the group's projects.",
    capabilities: readCapabilities,
    requiresFeature: "milestone",
    inputSchema: {
      group_id: groupIdSchema,
      milestone_id: milestoneIdSchema,
      ...paginationShape
    },
    handler: async (args, context) =>
      context.gitlab.get(
        groupApiPath(
          getString(args, "group_id"),
          "milestones",
          getString(args, "milestone_id"),
          "issues"
        ),
        { query: toQuery(pickPresentFields(args, ["page", "per_page"])) }
      )
  },
  {
    name: "gitlab_list_group_milestone_merge_requests",
    title: "List Group Milestone Merge Requests",
    description: "List merge requests assigned to a group milestone across the group's projects.",
    capabilities: readCapabilities,
    requiresFeature: "milestone",
    inputSchema: {
      group_id: groupIdSchema,
      milestone_id: milestoneIdSchema,
      ...paginationShape
    },
    handler: async (args, context) =>
      context.gitlab.get(
        groupApiPath(
          getString(args, "group_id"),
          "milestones",
          getString(args, "milestone_id"),
          "merge_requests"
        ),
        { query: toQuery(pickPresentFields(args, ["page", "per_page"])) }
      )
  },
  {
    name: "gitlab_get_group_milestone_burndown_events",
    title: "Get Group Milestone Burndown Events",
    description: "Get burndown chart events for a group milestone. Premium/Ultimate.",
    capabilities: readCapabilities,
    requiresFeature: "milestone",
    inputSchema: {
      group_id: groupIdSchema,
      milestone_id: milestoneIdSchema,
      ...paginationShape
    },
    handler: async (args, context) =>
      context.gitlab.get(
        groupApiPath(
          getString(args, "group_id"),
          "milestones",
          getString(args, "milestone_id"),
          "burndown_events"
        ),
        { query: toQuery(pickPresentFields(args, ["page", "per_page"])) }
      )
  }
];

/** Names of the group milestone tools, which are group scoped. */
export const GROUP_MILESTONE_TOOL_NAMES = groupMilestoneToolDefinitions.map(
  (definition) => definition.name
);
