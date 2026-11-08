import { z } from "zod";

import {
  getOptionalString,
  getOptionalRecord,
  jsonBody,
  readCapabilities,
  type GitLabToolDefinitionInput
} from "./shared.js";

/**
 * GitLab Orbit: the SDLC knowledge graph (Beta, Premium/Ultimate). These are
 * instance-level reads; orbit_query consumes GitLab credits on every call,
 * so the family is gated behind GITLAB_ENABLE_ORBIT_TOOLS.
 */
export const orbitToolDefinitions: GitLabToolDefinitionInput[] = [
  {
    name: "gitlab_orbit_query",
    title: "Query GitLab Orbit",
    description:
      "Run one GitLab Orbit knowledge-graph query to answer cross-project relationship questions (projects, merge requests, pipelines, issues, vulnerabilities, code). Each call consumes GitLab credits; call gitlab_orbit_get_schema first when node or edge types are unknown. format llm (default) returns compact text, raw returns JSON. Beta, Premium/Ultimate.",
    capabilities: readCapabilities,
    requiresExplicitEnable: "orbit",
    inputSchema: {
      query: z.record(z.string(), z.unknown()),
      format: z.enum(["llm", "raw"]).optional()
    },
    handler: async (args, context) =>
      context.gitlab.post(
        "/orbit/query",
        jsonBody({
          query: getOptionalRecord(args, "query") ?? {},
          format: getOptionalString(args, "format") ?? "llm"
        })
      )
  },
  {
    name: "gitlab_orbit_get_schema",
    title: "Get GitLab Orbit Schema",
    description:
      "List the node and edge types available to gitlab_orbit_query. Free of credit charges. Beta, Premium/Ultimate.",
    capabilities: readCapabilities,
    requiresExplicitEnable: "orbit",
    handler: async (_args, context) => context.gitlab.get("/orbit/schema")
  },
  {
    name: "gitlab_orbit_get_status",
    title: "Get GitLab Orbit Status",
    description:
      "Report whether GitLab Orbit indexing has completed; query results reflect the last index cycle. Beta, Premium/Ultimate.",
    capabilities: readCapabilities,
    requiresExplicitEnable: "orbit",
    handler: async (_args, context) => context.gitlab.get("/orbit/status")
  },
  {
    name: "gitlab_orbit_list_tools",
    title: "List GitLab Orbit Tools",
    description:
      "List the tool definitions GitLab Orbit itself exposes. Use gitlab_orbit_query to run graph queries. Beta, Premium/Ultimate.",
    capabilities: readCapabilities,
    requiresExplicitEnable: "orbit",
    handler: async (_args, context) => context.gitlab.get("/orbit/tools")
  }
];

export const ORBIT_TOOL_NAMES = orbitToolDefinitions.map((definition) => definition.name);
