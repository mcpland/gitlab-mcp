/**
 * Integration tests for the MCP server using InMemoryTransport.
 *
 * These tests exercise the full server lifecycle: creating an MCP server,
 * connecting a real MCP Client via InMemoryTransport, and verifying
 * tools/list, tools/call, and protocol-level behavior.
 *
 * No external network calls are made; the GitLabClient is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { resolveToolScopeMetadata } from "../../src/tools/gitlab.js";
import { buildContext, createLinkedPair } from "./_helpers.js";

/* ------------------------------------------------------------------ */
/*  Tests: Server lifecycle & tools/list                               */
/* ------------------------------------------------------------------ */

describe("MCP Server Integration (InMemoryTransport)", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeAll(async () => {
    const context = buildContext();
    const pair = await createLinkedPair(context);
    client = pair.client;
    clientTransport = pair.clientTransport;
    serverTransport = pair.serverTransport;
  });

  afterAll(async () => {
    await clientTransport.close();
    await serverTransport.close();
  });

  describe("protocol basics", () => {
    it("completes initialization handshake", () => {
      const serverVersion = client.getServerVersion();
      expect(serverVersion).toBeDefined();
      expect(serverVersion!.name).toBe("test-gitlab-mcp");
      expect(serverVersion!.version).toBe("0.0.1");
    });

    it("reports server capabilities including tools", () => {
      const caps = client.getServerCapabilities();
      expect(caps).toBeDefined();
      expect(caps!.tools).toBeDefined();
    });

    it("responds to ping", async () => {
      const result = await client.ping();
      expect(result).toBeDefined();
    });
  });

  describe("tools/list", () => {
    it("returns a non-empty list of tools", async () => {
      const result = await client.listTools();
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it("includes health_check tool", async () => {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);
      expect(names).toContain("health_check");
    });

    it("includes core gitlab tools", async () => {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      // Spot-check a few essential tools
      expect(names).toContain("gitlab_get_project");
      expect(names).toContain("gitlab_list_projects");
      expect(names).toContain("gitlab_get_file_contents");
      expect(names).toContain("gitlab_create_merge_request");
      expect(names).toContain("gitlab_get_merge_request_conflicts");
      expect(names).toContain("gitlab_list_issues");
      expect(names).toContain("gitlab_list_deployments");
      expect(names).toContain("gitlab_list_job_artifacts");
      expect(names).toContain("gitlab_get_job_artifact_file");
    });

    it("every tool has a name and inputSchema", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("omits redundant JSON Schema dialect declarations", async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.inputSchema).not.toHaveProperty("$schema");
        if (tool.outputSchema) {
          expect(tool.outputSchema).not.toHaveProperty("$schema");
        }
      }
    });

    it("every tool has a description", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
      }
    });

    it("publishes standard behavioral annotations for every tool", async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.annotations).toBeDefined();
        expect(tool.annotations?.readOnlyHint).toEqual(expect.any(Boolean));
        expect(tool.annotations?.destructiveHint).toEqual(expect.any(Boolean));
        expect(tool.annotations?.idempotentHint).toEqual(expect.any(Boolean));
        expect(tool.annotations?.openWorldHint).toEqual(expect.any(Boolean));
      }

      const readTool = result.tools.find((tool) => tool.name === "gitlab_get_project");
      expect(readTool?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      });

      const deleteTool = result.tools.find((tool) => tool.name === "gitlab_delete_issue");
      expect(deleteTool?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      });

      const healthTool = result.tools.find((tool) => tool.name === "health_check");
      expect(healthTool?.annotations?.openWorldHint).toBe(false);
    });

    it("tool names follow naming convention", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        // All tools should be either health_check or gitlab_*
        expect(tool.name === "health_check" || tool.name.startsWith("gitlab_")).toBe(true);
      }
    });

    it("hides compatibility aliases by default", async () => {
      const names = (await client.listTools()).tools.map((tool) => tool.name);

      expect(names).not.toContain("gitlab_mr_discussions");
      expect(names).not.toContain("gitlab_get_merge_request_notes");
      expect(names).not.toContain("gitlab_edit_milestone");
      expect(names).not.toContain("gitlab_execute_graphql");
    });

    it("classifies every project tool with a project_id schema", async () => {
      const result = await client.listTools();

      for (const tool of result.tools.filter((item) => item.name.startsWith("gitlab_"))) {
        const scope = resolveToolScopeMetadata(tool.name);
        if (scope.kind !== "project" || !scope.projectIdArguments?.includes("project_id")) {
          continue;
        }

        const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
        expect(properties?.project_id, `${tool.name} must declare project_id`).toBeDefined();
      }
    });
  });

  describe("tools/call - health_check", () => {
    it("returns ok status with timestamp", async () => {
      const result = await client.callTool({ name: "health_check", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);

      const textContent = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      );
      expect(textContent).toBeDefined();
      expect(textContent!.text).toContain("ok");
    });

    it("returns structuredContent with status and timestamp", async () => {
      const result = await client.callTool({ name: "health_check", arguments: {} });
      const structured = (result as { structuredContent?: Record<string, unknown> })
        .structuredContent;
      expect(structured).toBeDefined();
      expect(structured!.status).toBe("ok");
      expect(structured!.timestamp).toBeTruthy();

      // Timestamp should be valid ISO 8601
      const ts = structured!.timestamp as string;
      expect(new Date(ts).toISOString()).toBe(ts);
    });
  });
});

describe("MCP Server Integration - Compatibility aliases", () => {
  it("can expose legacy aliases explicitly", async () => {
    const pair = await createLinkedPair(buildContext({ enableCompatibilityAliases: true }));

    try {
      const names = (await pair.client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("gitlab_mr_discussions");
      expect(names).toContain("gitlab_get_merge_request_notes");
      expect(names).toContain("gitlab_edit_milestone");
      expect(names).toContain("gitlab_execute_graphql");
    } finally {
      await pair.clientTransport.close();
      await pair.serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: Policy enforcement through full MCP protocol                */
/* ------------------------------------------------------------------ */

describe("MCP Server Integration - Read-only mode", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeAll(async () => {
    const context = buildContext({ readOnlyMode: true });
    const pair = await createLinkedPair(context);
    client = pair.client;
    clientTransport = pair.clientTransport;
    serverTransport = pair.serverTransport;
  });

  afterAll(async () => {
    await clientTransport.close();
    await serverTransport.close();
  });

  it("excludes write/delete/admin tools from tools/list", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    // These tools require write/delete/admin capabilities and should be excluded in read-only mode
    expect(names).not.toContain("gitlab_create_merge_request");
    expect(names).not.toContain("gitlab_create_issue");
    expect(names).not.toContain("gitlab_delete_issue");
    expect(names).not.toContain("gitlab_create_or_update_file");
    expect(names).not.toContain("gitlab_push_files");
  });

  it("still includes read-only tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    expect(names).toContain("health_check");
    expect(names).toContain("gitlab_get_project");
    expect(names).toContain("gitlab_list_projects");
    expect(names).toContain("gitlab_get_file_contents");
  });
});

describe("MCP Server Integration - Capability filtering", () => {
  it("can disable delete tools without removing write tools", async () => {
    const context = buildContext({
      disabledCapabilities: ["delete"]
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).not.toContain("gitlab_delete_issue");
      expect(names).not.toContain("gitlab_delete_release");
      expect(names).toContain("gitlab_create_issue");
      expect(names).toContain("gitlab_update_merge_request");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("can disable graphql tools independently of read tools", async () => {
    const context = buildContext({
      disabledCapabilities: ["graphql"]
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).not.toContain("gitlab_execute_graphql_query");
      expect(names).not.toContain("gitlab_execute_graphql_mutation");
      expect(names).not.toContain("gitlab_execute_graphql");
      expect(names).toContain("gitlab_get_project");
      expect(names).toContain("gitlab_list_projects");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

describe("MCP Server Integration - Feature flag filtering", () => {
  it("excludes wiki tools when wiki feature is disabled", async () => {
    const context = buildContext({
      enabledFeatures: { wiki: false, milestone: true, pipeline: true, release: true }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).not.toContain("gitlab_list_wiki_pages");
      expect(names).not.toContain("gitlab_get_wiki_page");
      expect(names).not.toContain("gitlab_create_wiki_page");
      expect(names).not.toContain("gitlab_list_group_wiki_pages");
      expect(names).not.toContain("gitlab_get_group_wiki_page");
      expect(names).not.toContain("gitlab_create_group_wiki_page");
      // But other tools remain
      expect(names).toContain("gitlab_get_project");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("excludes pipeline tools when pipeline feature is disabled", async () => {
    const context = buildContext({
      enabledFeatures: { wiki: true, milestone: true, pipeline: false, release: true }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).not.toContain("gitlab_list_pipelines");
      expect(names).not.toContain("gitlab_get_pipeline");
      expect(names).not.toContain("gitlab_validate_ci_lint");
      expect(names).not.toContain("gitlab_validate_project_ci_lint");
      expect(names).not.toContain("gitlab_list_deployments");
      expect(names).not.toContain("gitlab_list_job_artifacts");
      expect(names).not.toContain("gitlab_get_job_artifact_file");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("excludes local artifact write tools when local file tools are disabled", async () => {
    const context = buildContext({ allowLocalFileTools: false });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).toContain("gitlab_download_job_artifacts");
      expect(names).not.toContain("gitlab_download_job_artifacts_local");
      expect(names).toContain("gitlab_get_job_artifact_file");
      expect(names).not.toContain("gitlab_get_job_artifact_file_local");
      expect(names).not.toContain("gitlab_get_job_artifact_file_inline");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("excludes release tools when release feature is disabled", async () => {
    const context = buildContext({
      enabledFeatures: { wiki: true, milestone: true, pipeline: true, release: false }
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).not.toContain("gitlab_list_releases");
      expect(names).not.toContain("gitlab_get_release");
      expect(names).not.toContain("gitlab_create_release");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

describe("MCP Server Integration - Toolsets", () => {
  it("exposes the curated core without unrelated domain tools", async () => {
    const context = buildContext({ toolsets: ["core"] });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);

      expect(names).toContain("health_check");
      expect(names).toContain("gitlab_get_project");
      expect(names).toContain("gitlab_get_merge_request_code_context");
      expect(names).toContain("gitlab_get_issue");
      expect(names).not.toContain("gitlab_create_group");
      expect(names).not.toContain("gitlab_delete_wiki_page");
      expect(names.length).toBeLessThan(50);
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("combines selected domain toolsets as a union", async () => {
    const context = buildContext({ toolsets: ["wiki", "milestones"] });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);

      expect(names).toContain("gitlab_get_wiki_page");
      expect(names).toContain("gitlab_get_milestone");
      expect(names).not.toContain("gitlab_get_issue");
      expect(names).not.toContain("gitlab_get_pipeline");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

describe("MCP Server Integration - Allowlist filtering", () => {
  it("only exposes tools in the allowlist (plus health_check)", async () => {
    const context = buildContext({
      allowedTools: ["get_project", "list_projects"]
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).toContain("health_check"); // always present
      expect(names).toContain("gitlab_get_project");
      expect(names).toContain("gitlab_list_projects");

      // Other tools should be excluded
      expect(names).not.toContain("gitlab_create_issue");
      expect(names).not.toContain("gitlab_get_file_contents");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

describe("MCP Server Integration - Denied tools regex", () => {
  it("excludes tools matching denied regex pattern", async () => {
    const context = buildContext({
      deniedToolsRegex: /.*wiki.*/
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      // Wiki tools should be excluded by regex
      const wikiTools = names.filter((n) => n.includes("wiki"));
      expect(wikiTools).toHaveLength(0);

      // Other tools remain
      expect(names).toContain("gitlab_get_project");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: Error handling through full MCP protocol                    */
/* ------------------------------------------------------------------ */

describe("MCP Server Integration - Error handling", () => {
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;

  beforeAll(async () => {
    const context = buildContext();
    const pair = await createLinkedPair(context);
    client = pair.client;
    clientTransport = pair.clientTransport;
    serverTransport = pair.serverTransport;
  });

  afterAll(async () => {
    await clientTransport.close();
    await serverTransport.close();
  });

  it("returns error for unknown tool", async () => {
    const result = await client.callTool({ name: "nonexistent_tool", arguments: {} });
    expect(result.isError).toBe(true);
    const textContent = (result.content as Array<{ type: string; text: string }>).find(
      (c) => c.type === "text"
    );
    expect(textContent!.text).toContain("not found");
  });

  it("gitlab tools return error content when API call fails", async () => {
    // gitlab_get_project will attempt to call context.gitlab.getProject
    // which is a stub ({}) and will throw a TypeError.
    // The tool handler catches errors and returns isError: true
    const result = await client.callTool({
      name: "gitlab_get_project",
      arguments: { project_id: "test/project" }
    });

    expect(result.isError).toBe(true);
    expect(result.content).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: Multiple server configurations                              */
/* ------------------------------------------------------------------ */

describe("MCP Server Integration - No auth configured", () => {
  it("returns error when calling tool that requires auth without token", async () => {
    const context = buildContext({ token: null });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.callTool({
        name: "gitlab_get_project",
        arguments: { project_id: "test/project" }
      });

      expect(result.isError).toBe(true);
      const textContent = (result.content as Array<{ type: string; text: string }>).find(
        (c) => c.type === "text"
      );
      expect(textContent!.text).toContain("Authentication required");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("health_check still works without auth", async () => {
    const context = buildContext({ token: null });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.callTool({ name: "health_check", arguments: {} });
      expect(result.isError).toBeFalsy();
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Tests: GraphQL tool filtering                                      */
/* ------------------------------------------------------------------ */

describe("MCP Server Integration - GraphQL tool filtering", () => {
  it("disables raw GraphQL but keeps project-bound work-item tools", async () => {
    const context = buildContext({
      allowedProjectIds: ["group/project"],
      allowGraphqlWithProjectScope: false
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).not.toContain("gitlab_execute_graphql");
      expect(names).not.toContain("gitlab_execute_graphql_query");
      expect(names).not.toContain("gitlab_execute_graphql_mutation");
      expect(names).toContain("gitlab_get_work_item");
      expect(names).toContain("gitlab_create_timeline_event");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("does not let the legacy override expose raw GraphQL", async () => {
    const context = buildContext({
      allowedProjectIds: ["group/project"],
      allowGraphqlWithProjectScope: true
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).not.toContain("gitlab_execute_graphql");
      expect(names).not.toContain("gitlab_execute_graphql_query");
      expect(names).not.toContain("gitlab_execute_graphql_mutation");
      expect(names).toContain("gitlab_get_work_item");
      expect(names).toContain("gitlab_create_timeline_event");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});

describe("MCP Server Integration - Strict project scope visibility", () => {
  it("applies the declared project-scope mode to every registered GitLab tool", async () => {
    const unrestrictedPair = await createLinkedPair(buildContext());
    const scopedPair = await createLinkedPair(
      buildContext({ allowedProjectIds: ["group/project"] })
    );

    try {
      const unrestrictedTools = (await unrestrictedPair.client.listTools()).tools.filter((tool) =>
        tool.name.startsWith("gitlab_")
      );
      const scopedNames = new Set(
        (await scopedPair.client.listTools()).tools.map((tool) => tool.name)
      );

      for (const tool of unrestrictedTools) {
        const scope = resolveToolScopeMetadata(tool.name);

        if (scope.projectScopedMode === "deny") {
          expect(scopedNames, `${tool.name} should be hidden`).not.toContain(tool.name);
        } else {
          expect(scopedNames, `${tool.name} should remain visible`).toContain(tool.name);
        }
      }
    } finally {
      await unrestrictedPair.clientTransport.close();
      await unrestrictedPair.serverTransport.close();
      await scopedPair.clientTransport.close();
      await scopedPair.serverTransport.close();
    }
  });

  it("keeps only project tools and explicitly safe or filterable global tools", async () => {
    const context = buildContext({ allowedProjectIds: ["group/project"] });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);

      for (const name of [
        "gitlab_get_project",
        "gitlab_list_projects",
        "gitlab_search_repositories",
        "gitlab_search_code",
        "gitlab_list_todos",
        "gitlab_mark_todo_done",
        "gitlab_whoami",
        "gitlab_validate_ci_lint",
        "gitlab_list_webhooks",
        "gitlab_get_work_item"
      ]) {
        expect(names, `${name} should remain visible`).toContain(name);
      }

      for (const name of [
        "gitlab_create_repository",
        "gitlab_create_group",
        "gitlab_fork_repository",
        "gitlab_list_group_projects",
        "gitlab_list_group_iterations",
        "gitlab_search_group_code",
        "gitlab_list_group_wiki_pages",
        "gitlab_create_group_wiki_page",
        "gitlab_mark_all_todos_done",
        "gitlab_list_namespaces",
        "gitlab_get_users",
        "gitlab_list_events",
        "gitlab_execute_graphql"
      ]) {
        expect(names, `${name} should be hidden`).not.toContain(name);
      }
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
