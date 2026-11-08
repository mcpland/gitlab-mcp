import { z } from "zod";

import { encodeGitLabPathSegment } from "../lib/gitlab-path.js";
import { optionalProjectIdSchema } from "../lib/tool-schema.js";
import type { AppContext } from "../types/context.js";
import {
  getString,
  isRecord,
  omit,
  optionalBoolean,
  optionalStringArray,
  paginationShape,
  projectApiPath,
  readCapabilities,
  resolveProjectId,
  toQuery,
  type GitLabToolDefinitionInput
} from "./shared.js";

const RUNNER_LOOKUP_PAGE_SIZE = 100;
const RUNNER_LOOKUP_MAX_PAGES = 20;

export const runnerToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_list_project_runners",
    title: "List Project Runners",
    description:
      "List runners a project can use, including group and instance runners. Supports type, status, paused, and tag_list filters. Use gitlab_get_runner for tags and settings of one runner.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      type: z.enum(["instance_type", "group_type", "project_type"]).optional(),
      status: z.enum(["online", "offline", "stale", "never_contacted"]).optional(),
      paused: optionalBoolean,
      tag_list: optionalStringArray,
      ...paginationShape
    },
    handler: async (args, context) =>
      context.gitlab.get(projectApiPath(resolveProjectId(args, context, true), "runners"), {
        query: toQuery(omit(args, ["project_id"]))
      })
  },
  {
    name: "gitlab_get_runner",
    title: "Get Runner",
    description:
      "Get one runner's tag_list, run_untagged, locked, access_level, status, and version. The runner must be available to project_id; runner authentication tokens are never returned.",
    capabilities: readCapabilities,
    requiresFeature: "pipeline",
    inputSchema: {
      project_id: optionalProjectIdSchema,
      runner_id: z.coerce.string().regex(/^\d+$/u, "runner_id must be numeric")
    },
    handler: async (args, context) => {
      const projectId = resolveProjectId(args, context, true);
      const runnerId = getString(args, "runner_id");
      await assertRunnerAvailableToProject(context, projectId, runnerId);

      const runner = await context.gitlab.get(`/runners/${encodeGitLabPathSegment(runnerId)}`);
      return withoutRunnerSecretsAndForeignScopes(runner, context);
    }
  }
];

/**
 * GET /runners/:id is an instance-level endpoint. Confirm the runner is one
 * the requested (and allowlisted) project can use, so the tool cannot be used
 * to inspect arbitrary runners by ID.
 */
async function assertRunnerAvailableToProject(
  context: AppContext,
  projectId: string,
  runnerId: string
): Promise<void> {
  for (let page = 1; page <= RUNNER_LOOKUP_MAX_PAGES; page += 1) {
    const runners = await context.gitlab.get(projectApiPath(projectId, "runners"), {
      query: { per_page: RUNNER_LOOKUP_PAGE_SIZE, page }
    });
    const records = Array.isArray(runners) ? runners : [];
    if (records.some((runner) => isRecord(runner) && String(runner.id) === runnerId)) {
      return;
    }
    if (records.length < RUNNER_LOOKUP_PAGE_SIZE) {
      break;
    }
  }

  throw new Error(`Runner ${runnerId} is not available to project '${projectId}'`);
}

function withoutRunnerSecretsAndForeignScopes(runner: unknown, context: AppContext): unknown {
  if (!isRecord(runner)) {
    return runner;
  }

  const output: Record<string, unknown> = { ...runner };
  delete output.token;
  if (context.env.GITLAB_ALLOWED_PROJECT_IDS.length > 0) {
    // The runner's other projects and groups are outside the configured scope.
    delete output.projects;
    delete output.groups;
  }
  return output;
}
