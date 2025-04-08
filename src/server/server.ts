import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { verifyGitLabConnection } from "../api/gitlab";
import { AppError } from "../utils/errors";
import { registerTools } from "../tools/index";
import { registerResources } from "../resources/index";
import { registerPrompts } from "../prompts/index";
import { setLoggerServer } from "../utils/logger";

/**
 * Creates and configures the MCP server for GitLab
 *
 * @returns Configured MCP server instance
 */
export const createServer = async (): Promise<McpServer> => {
  try {
    process.stderr.write(`[DEBUG] Starting server creation process\n`);

    // Verify GitLab connection before starting the server
    process.stderr.write(`[DEBUG] Verifying GitLab connection...\n`);
    try {
      await verifyGitLabConnection();
      process.stderr.write(`[DEBUG] GitLab connection verified successfully\n`);
    } catch (connError) {
      process.stderr.write(
        `[ERROR] GitLab connection verification failed: ${
          connError instanceof Error ? connError.message : String(connError)
        }\n`
      );
      throw connError;
    }

    // Create MCP server instance with capabilities
    process.stderr.write(
      `[DEBUG] Creating MCP server instance with capabilities\n`
    );
    const packageVersion = process.env.npm_package_version || "1.0.0";
    process.stderr.write(`[DEBUG] Using package version: ${packageVersion}\n`);

    const server = new McpServer({
      name: "GitLab MCP Server",
      version: packageVersion,
      capabilities: {
        resources: { enabled: true, listChanges: true },
        tools: { enabled: true, listChanges: true },
        prompts: { enabled: true, listChanges: true },
        logging: { enabled: true },
      },
    });
    process.stderr.write(`[DEBUG] MCP server instance created successfully\n`);

    // Set the server instance for logging
    process.stderr.write(`[DEBUG] Setting server instance for logging\n`);
    setLoggerServer(server);
    process.stderr.write(`[DEBUG] Server instance set for logging\n`);

    // Return configured server
    return server;
  } catch (error) {
    process.stderr.write(
      `[ERROR] Failed to create server: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    if (error instanceof Error && error.stack) {
      process.stderr.write(`[ERROR] Stack trace: ${error.stack}\n`);
    }

    if (error instanceof Error) {
      throw new AppError(`Failed to create MCP server: ${error.message}`);
    }
    throw error;
  }
};

/**
 * Registers all resources, tools, and prompts with the MCP server
 *
 * @param server - The MCP server instance
 */
export const registerServerComponents = (server: McpServer): void => {
  try {
    process.stderr.write(`[DEBUG] Starting component registration process\n`);

    // Register all components using their respective registration functions
    process.stderr.write(`[DEBUG] Registering tools...\n`);
    registerTools(server);
    process.stderr.write(`[DEBUG] Tools registered successfully\n`);

    process.stderr.write(`[DEBUG] Registering resources...\n`);
    registerResources(server);
    process.stderr.write(`[DEBUG] Resources registered successfully\n`);

    process.stderr.write(`[DEBUG] Registering prompts...\n`);
    registerPrompts(server);
    process.stderr.write(`[DEBUG] Prompts registered successfully\n`);

    process.stderr.write(`[DEBUG] All components registered successfully\n`);
  } catch (error) {
    process.stderr.write(
      `[ERROR] Failed to register components: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    if (error instanceof Error && error.stack) {
      process.stderr.write(`[ERROR] Stack trace: ${error.stack}\n`);
    }
    throw error;
  }
};
