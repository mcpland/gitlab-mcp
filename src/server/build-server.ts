import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerGitLabTools } from "../tools/gitlab.js";
import { registerHealthTool } from "../tools/health.js";
import type { AppContext } from "../types/context.js";

export function createMcpServer(context: AppContext): McpServer {
  const server = new McpServer({
    name: context.env.MCP_SERVER_NAME,
    version: context.env.MCP_SERVER_VERSION
  });

  registerHealthTool(server);
  registerGitLabTools(server, context);

  return server;
}
