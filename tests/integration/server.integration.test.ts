/**
 * Integration tests for the MCP server using InMemoryTransport.
 *
 * These tests exercise the full server lifecycle: creating an MCP server,
 * connecting a real MCP Client via InMemoryTransport, and verifying
 * tools/list, tools/call, and protocol-level behavior.
 *
 * No external network calls are made; the GitLabClient is stubbed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createMcpServer } from "../../src/server/build-server.js";
import { OutputFormatter } from "../../src/lib/output.js";
import { ToolPolicyEngine } from "../../src/lib/policy.js";
import type { AppContext } from "../../src/types/context.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const defaultFeatures = {
  wiki: true,
  milestone: true,
  pipeline: true,
  release: true
};

/** Build a minimal AppContext with a stubbed GitLabClient. */
function buildContext(overrides?: {
  readOnlyMode?: boolean;
  allowedTools?: string[];
  deniedToolsRegex?: RegExp;
  enabledFeatures?: typeof defaultFeatures;
  token?: string | null; // null = no token; undefined = use default
  allowedProjectIds?: string[];
  allowGraphqlWithProjectScope?: boolean;
}): AppContext {
  const features = overrides?.enabledFeatures ?? defaultFeatures;
  const readOnlyMode = overrides?.readOnlyMode ?? false;
  const token = overrides?.token === null ? undefined : (overrides?.token ?? "test-token");

  return {
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MCP_SERVER_NAME: "test-gitlab-mcp",
      MCP_SERVER_VERSION: "0.0.1",
      GITLAB_API_URL: "https://gitlab.example.com/api/v4",
      GITLAB_API_URLS: ["https://gitlab.example.com/api/v4"],
      GITLAB_PERSONAL_ACCESS_TOKEN: token,
      GITLAB_USE_OAUTH: false,
      GITLAB_OAUTH_AUTO_OPEN_BROWSER: false,
      GITLAB_OAUTH_SCOPES: "api",
      GITLAB_READ_ONLY_MODE: readOnlyMode,
      GITLAB_ALLOWED_PROJECT_IDS: overrides?.allowedProjectIds ?? [],
      GITLAB_ALLOWED_TOOLS: overrides?.allowedTools ?? [],
      GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE: overrides?.allowGraphqlWithProjectScope ?? false,
      GITLAB_RESPONSE_MODE: "json",
      GITLAB_MAX_RESPONSE_BYTES: 200_000,
      GITLAB_HTTP_TIMEOUT_MS: 20_000,
      GITLAB_ERROR_DETAIL_MODE: "full",
      GITLAB_CLOUDFLARE_BYPASS: false,
      GITLAB_ALLOW_INSECURE_TOKEN_FILE: false,
      GITLAB_ALLOW_INSECURE_TLS: false,
      GITLAB_COOKIE_WARMUP_PATH: "/user",
      USE_GITLAB_WIKI: features.wiki,
      USE_MILESTONE: features.milestone,
      USE_PIPELINE: features.pipeline,
      USE_RELEASE: features.release,
      REMOTE_AUTHORIZATION: false,
      ENABLE_DYNAMIC_API_URL: false,
      HTTP_JSON_ONLY: false,
      SSE: false,
      SESSION_TIMEOUT_SECONDS: 3600,
      MAX_SESSIONS: 1000,
      MAX_REQUESTS_PER_MINUTE: 300,
      HTTP_HOST: "127.0.0.1",
      HTTP_PORT: 3333,
      GITLAB_TOKEN_CACHE_SECONDS: 300,
      GITLAB_TOKEN_SCRIPT_TIMEOUT_MS: 10_000,
      GITLAB_OAUTH_GITLAB_URL: undefined,
      GITLAB_OAUTH_CLIENT_ID: undefined,
      GITLAB_OAUTH_CLIENT_SECRET: undefined,
      GITLAB_OAUTH_REDIRECT_URI: undefined,
      GITLAB_OAUTH_TOKEN_PATH: undefined,
      GITLAB_AUTH_COOKIE_PATH: undefined,
      GITLAB_USER_AGENT: undefined,
      GITLAB_ACCEPT_LANGUAGE: undefined,
      GITLAB_TOKEN_SCRIPT: undefined,
      GITLAB_TOKEN_FILE: undefined,
      GITLAB_CA_CERT_PATH: undefined,
      GITLAB_DENIED_TOOLS_REGEX: undefined,
      NODE_TLS_REJECT_UNAUTHORIZED: undefined,
      HTTP_PROXY: undefined,
      HTTPS_PROXY: undefined
    } as AppContext["env"],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => ({}) as never
    } as unknown as AppContext["logger"],
    gitlab: {} as AppContext["gitlab"], // Stubbed — individual tools/call tests mock as needed
    policy: new ToolPolicyEngine({
      readOnlyMode,
      allowedTools: overrides?.allowedTools ?? [],
      deniedToolsRegex: overrides?.deniedToolsRegex,
      enabledFeatures: features
    }),
    formatter: new OutputFormatter({
      responseMode: "json",
      maxBytes: 200_000
    })
  };
}

/** Create linked Client + Server pair and connect them. */
async function createLinkedPair(context: AppContext): Promise<{
  client: Client;
  server: McpServer;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
}> {
  const server = createMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client(
    { name: "integration-test-client", version: "0.0.1" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  return { client, server, clientTransport, serverTransport };
}

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
      expect(names).toContain("gitlab_list_issues");
    });

    it("every tool has a name and inputSchema", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.name).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe("object");
      }
    });

    it("every tool has a description", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        expect(tool.description).toBeTruthy();
      }
    });

    it("tool names follow naming convention", async () => {
      const result = await client.listTools();
      for (const tool of result.tools) {
        // All tools should be either health_check or gitlab_*
        expect(tool.name === "health_check" || tool.name.startsWith("gitlab_")).toBe(true);
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

  it("excludes mutating tools from tools/list", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);

    // These are mutating tools that should be excluded in read-only mode
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
  it("disables graphql tools when project scope is set without override", async () => {
    const context = buildContext({
      allowedProjectIds: ["group/project"],
      allowGraphqlWithProjectScope: false
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).not.toContain("gitlab_execute_graphql");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("keeps graphql tools when project scope is set with override", async () => {
    const context = buildContext({
      allowedProjectIds: ["group/project"],
      allowGraphqlWithProjectScope: true
    });
    const { client, clientTransport, serverTransport } = await createLinkedPair(context);

    try {
      const result = await client.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).toContain("gitlab_execute_graphql");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
