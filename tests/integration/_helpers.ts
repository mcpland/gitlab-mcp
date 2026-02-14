/**
 * Shared test utilities for MCP integration tests.
 *
 * Provides `buildContext` (creates a stubbed `AppContext`) and
 * `createLinkedPair` (connects a Client ↔ Server via InMemoryTransport).
 */
import { vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createMcpServer } from "../../src/server/build-server.js";
import { OutputFormatter } from "../../src/lib/output.js";
import { ToolPolicyEngine } from "../../src/lib/policy.js";
import type { AppContext } from "../../src/types/context.js";

/* ------------------------------------------------------------------ */
/*  Default values                                                     */
/* ------------------------------------------------------------------ */

export const defaultFeatures = {
  wiki: true,
  milestone: true,
  pipeline: true,
  release: true
};

const defaultEnv: AppContext["env"] = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MCP_SERVER_NAME: "test-gitlab-mcp",
  MCP_SERVER_VERSION: "0.0.1",
  GITLAB_API_URL: "https://gitlab.example.com/api/v4",
  GITLAB_API_URLS: ["https://gitlab.example.com/api/v4"],
  GITLAB_PERSONAL_ACCESS_TOKEN: "test-token",
  GITLAB_USE_OAUTH: false,
  GITLAB_OAUTH_AUTO_OPEN_BROWSER: false,
  GITLAB_OAUTH_SCOPES: "api",
  GITLAB_READ_ONLY_MODE: false,
  GITLAB_ALLOWED_PROJECT_IDS: [],
  GITLAB_ALLOWED_TOOLS: [],
  GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE: false,
  GITLAB_RESPONSE_MODE: "json",
  GITLAB_MAX_RESPONSE_BYTES: 200_000,
  GITLAB_HTTP_TIMEOUT_MS: 20_000,
  GITLAB_ERROR_DETAIL_MODE: "full",
  GITLAB_CLOUDFLARE_BYPASS: false,
  GITLAB_ALLOW_INSECURE_TOKEN_FILE: false,
  GITLAB_ALLOW_INSECURE_TLS: false,
  GITLAB_COOKIE_WARMUP_PATH: "/user",
  USE_GITLAB_WIKI: true,
  USE_MILESTONE: true,
  USE_PIPELINE: true,
  USE_RELEASE: true,
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
} as AppContext["env"];

/* ------------------------------------------------------------------ */
/*  buildContext                                                        */
/* ------------------------------------------------------------------ */

export interface BuildContextOptions {
  readOnlyMode?: boolean;
  allowedTools?: string[];
  deniedToolsRegex?: RegExp;
  enabledFeatures?: typeof defaultFeatures;
  token?: string | null; // null = no token; undefined = use default
  allowedProjectIds?: string[];
  allowGraphqlWithProjectScope?: boolean;
  gitlabStub?: Partial<AppContext["gitlab"]>;
  maxBytes?: number;
  serverName?: string;
}

export function buildContext(overrides?: BuildContextOptions): AppContext {
  const features = overrides?.enabledFeatures ?? defaultFeatures;
  const readOnlyMode = overrides?.readOnlyMode ?? false;
  const token = overrides?.token === null ? undefined : (overrides?.token ?? "test-token");

  return {
    env: {
      ...defaultEnv,
      MCP_SERVER_NAME: overrides?.serverName ?? defaultEnv.MCP_SERVER_NAME,
      GITLAB_PERSONAL_ACCESS_TOKEN: token,
      GITLAB_READ_ONLY_MODE: readOnlyMode,
      GITLAB_ALLOWED_PROJECT_IDS: overrides?.allowedProjectIds ?? [],
      GITLAB_ALLOWED_TOOLS: overrides?.allowedTools ?? [],
      GITLAB_ALLOW_GRAPHQL_WITH_PROJECT_SCOPE: overrides?.allowGraphqlWithProjectScope ?? false,
      GITLAB_MAX_RESPONSE_BYTES: overrides?.maxBytes ?? 200_000,
      USE_GITLAB_WIKI: features.wiki,
      USE_MILESTONE: features.milestone,
      USE_PIPELINE: features.pipeline,
      USE_RELEASE: features.release
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
    gitlab: {
      ...overrides?.gitlabStub
    } as AppContext["gitlab"],
    policy: new ToolPolicyEngine({
      readOnlyMode,
      allowedTools: overrides?.allowedTools ?? [],
      deniedToolsRegex: overrides?.deniedToolsRegex,
      enabledFeatures: features
    }),
    formatter: new OutputFormatter({
      responseMode: "json",
      maxBytes: overrides?.maxBytes ?? 200_000
    })
  };
}

/* ------------------------------------------------------------------ */
/*  createLinkedPair                                                    */
/* ------------------------------------------------------------------ */

export async function createLinkedPair(context: AppContext): Promise<{
  client: Client;
  server: McpServer;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
  context: AppContext;
}> {
  const server = createMcpServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client(
    { name: "integration-test-client", version: "0.0.1" },
    { capabilities: {} }
  );
  await client.connect(clientTransport);

  return { client, server, clientTransport, serverTransport, context };
}
