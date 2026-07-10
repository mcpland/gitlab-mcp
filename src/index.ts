#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { env } from "./config/env.js";
import { GitLabClient } from "./lib/gitlab-client.js";
import { logger } from "./lib/logger.js";
import { configureNetworkRuntime } from "./lib/network.js";
import { OutputFormatter } from "./lib/output.js";
import { ToolPolicyEngine } from "./lib/policy.js";
import { compileDeniedToolsRegex } from "./lib/regex.js";
import { GitLabRequestRuntime } from "./lib/request-runtime.js";
import { createMcpServer } from "./server/build-server.js";
import type { AppContext } from "./types/context.js";

async function main(): Promise<void> {
  const deniedToolsRegex = compileDeniedToolsRegex(env.GITLAB_DENIED_TOOLS_REGEX, logger);
  configureNetworkRuntime(env, logger);
  const requestRuntime = new GitLabRequestRuntime(env, logger);
  const defaultToken = env.GITLAB_PERSONAL_ACCESS_TOKEN ?? env.GITLAB_JOB_TOKEN;
  const defaultAuthHeader = env.GITLAB_PERSONAL_ACCESS_TOKEN
    ? undefined
    : env.GITLAB_JOB_TOKEN
      ? "job-token"
      : undefined;

  const context: AppContext = {
    env,
    logger,
    gitlab: new GitLabClient(env.GITLAB_API_URL, defaultToken, {
      apiUrls: env.GITLAB_API_URLS,
      timeoutMs: env.GITLAB_HTTP_TIMEOUT_MS,
      maxGetRetries: env.GITLAB_HTTP_MAX_RETRIES,
      getRetryBaseDelayMs: env.GITLAB_HTTP_RETRY_BASE_MS,
      getRetryMaxDelayMs: env.GITLAB_HTTP_RETRY_MAX_DELAY_MS,
      maxLocalFileBytes: env.GITLAB_MAX_LOCAL_FILE_BYTES,
      localFileRoots: env.GITLAB_LOCAL_FILE_ROOTS,
      defaultAuthHeader,
      beforeRequest: (requestContext) => requestRuntime.beforeRequest(requestContext)
    }),
    policy: new ToolPolicyEngine({
      permissionMode: env.GITLAB_PERMISSION_MODE,
      disabledCapabilities: env.GITLAB_DISABLED_CAPABILITIES,
      allowedTools: env.GITLAB_ALLOWED_TOOLS,
      deniedToolsRegex,
      enabledFeatures: {
        wiki: env.USE_GITLAB_WIKI,
        milestone: env.USE_MILESTONE,
        pipeline: env.USE_PIPELINE,
        release: env.USE_RELEASE
      }
    }),
    formatter: new OutputFormatter({
      responseMode: env.GITLAB_RESPONSE_MODE,
      maxBytes: env.GITLAB_MAX_RESPONSE_BYTES
    }),
    allowLocalFileTools: true
  };

  const server = createMcpServer(context);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info({ transport: "stdio" }, "MCP server started");

  const handleSignal = (signal: NodeJS.Signals) => {
    void shutdown(signal, server);
  };

  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));
}

async function shutdown(
  signal: NodeJS.Signals,
  server: ReturnType<typeof createMcpServer>
): Promise<void> {
  logger.info({ signal }, "Shutting down MCP server");

  try {
    await server.close();
  } catch (error) {
    logger.error({ err: error }, "Server close failed");
  }

  process.exit(0);
}

void main().catch((error) => {
  logger.error({ err: error }, "Failed to start MCP server");
  process.exit(1);
});
