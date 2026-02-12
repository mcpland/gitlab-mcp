import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { GitLabApiError, type GitLabProject } from "../lib/gitlab-client.js";
import type { AppContext } from "../types/context.js";

export function registerGitLabTools(server: McpServer, context: AppContext): void {
  server.registerTool(
    "gitlab_get_project",
    {
      title: "Get GitLab Project",
      description: "Get project metadata by project ID or full path.",
      inputSchema: {
        project: z
          .string()
          .min(1)
          .describe("Project numeric ID or full path. Example: `group/subgroup/project`")
      }
    },
    async ({ project }) => {
      try {
        const item = (await context.gitlab.getProject(project)) as GitLabProject;

        return {
          content: [
            {
              type: "text" as const,
              text: formatProject(item)
            }
          ],
          structuredContent: toStructuredContent(item)
        };
      } catch (error) {
        context.logger.error({ err: error, project }, "gitlab_get_project failed");
        return toToolError(error);
      }
    }
  );

  server.registerTool(
    "gitlab_search_projects",
    {
      title: "Search GitLab Projects",
      description: "Search projects by keyword.",
      inputSchema: {
        query: z.string().min(1).describe("Keyword to search project names and descriptions."),
        limit: z.number().int().min(1).max(50).default(10)
      }
    },
    async ({ query, limit }) => {
      try {
        const projects = (await context.gitlab.searchProjects(query, limit)) as GitLabProject[];

        const lines = projects.length
          ? projects.map((project) => `${project.path_with_namespace} (${project.web_url})`)
          : ["No projects found."];

        return {
          content: [
            {
              type: "text" as const,
              text: lines.join("\n")
            }
          ],
          structuredContent: {
            count: projects.length,
            projects
          }
        };
      } catch (error) {
        context.logger.error({ err: error, query, limit }, "gitlab_search_projects failed");
        return toToolError(error);
      }
    }
  );
}

function formatProject(project: GitLabProject): string {
  return [
    `${project.path_with_namespace} (${project.visibility})`,
    `URL: ${project.web_url}`,
    `Default branch: ${project.default_branch ?? "N/A"}`,
    `Last activity: ${project.last_activity_at}`,
    `Description: ${project.description ?? "N/A"}`
  ].join("\n");
}

function toToolError(error: unknown): CallToolResult {
  if (error instanceof GitLabApiError) {
    const details = stringifyDetails(error.details);

    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `GitLab API error (${error.status}): ${details}`
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
        text: "Unknown error occurred while calling GitLab API"
      }
    ]
  };
}

function stringifyDetails(details: unknown): string {
  if (typeof details === "string") {
    return details;
  }

  if (details === undefined || details === null) {
    return "No details";
  }

  try {
    return JSON.stringify(details);
  } catch {
    return "Unable to serialize error details";
  }
}

function toStructuredContent(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {
    value
  };
}
