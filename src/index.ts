import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { env } from "./config/env.js";
import { GitLabClient } from "./lib/gitlab-client.js";
import { logger } from "./lib/logger.js";
import { OutputFormatter } from "./lib/output.js";
import { ToolPolicyEngine } from "./lib/policy.js";
import { GitLabRequestRuntime } from "./lib/request-runtime.js";
import { createMcpServer } from "./server/build-server.js";
import type { AppContext } from "./types/context.js";

async function main(): Promise<void> {
  const deniedToolsRegex = env.GITLAB_DENIED_TOOLS_REGEX
    ? new RegExp(env.GITLAB_DENIED_TOOLS_REGEX)
    : undefined;
  const requestRuntime = new GitLabRequestRuntime(env, logger);

  const context: AppContext = {
    env,
    logger,
    gitlab: new GitLabClient(env.GITLAB_API_URL, env.GITLAB_PERSONAL_ACCESS_TOKEN, {
      timeoutMs: env.GITLAB_HTTP_TIMEOUT_MS,
      beforeRequest: (requestContext) => requestRuntime.beforeRequest(requestContext)
    }),
    policy: new ToolPolicyEngine({
      readOnlyMode: env.GITLAB_READ_ONLY_MODE,
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
    })
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
