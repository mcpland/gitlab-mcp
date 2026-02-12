import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { env } from "./config/env.js";
import { GitLabClient } from "./lib/gitlab-client.js";
import { logger } from "./lib/logger.js";
import { createMcpServer } from "./server/build-server.js";
import type { AppContext } from "./types/context.js";

async function main(): Promise<void> {
  const context: AppContext = {
    env,
    logger,
    gitlab: new GitLabClient(env.GITLAB_BASE_URL, env.GITLAB_TOKEN)
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
