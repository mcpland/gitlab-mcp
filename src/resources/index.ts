import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { debug } from "../utils/logger";

/**
 * Register all resources with the MCP server
 *
 * @param server - The MCP server instance
 */
export const registerResources = (server: McpServer): void => {
  debug("Registering resources...");

  // TODO: Implement GitLab resources registration

  debug("Resources registered successfully");
};
