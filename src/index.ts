#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio";
import { createServer, registerServerComponents } from "./server/server";
import { AppError } from "./utils/errors";
import {
  error,
  emergency,
  activateMcpContext,
  markServerConnected,
} from "./utils/logger";

// Log debug information about the environment and command line args before any processing
process.stderr.write(
  `[DEBUG] Process arguments: ${JSON.stringify(process.argv)}\n`
);
process.stderr.write(
  `[DEBUG] MCP Server version: ${
    process.env.npm_package_version || "unknown"
  }\n`
);
process.stderr.write(`[DEBUG] Node version: ${process.version}\n`);
process.stderr.write(`[DEBUG] Working directory: ${process.cwd()}\n`);

// Parse command line arguments and set as environment variables
const cmdLineArgs: Record<string, string> = {};
process.argv.slice(2).forEach((arg) => {
  if (arg.startsWith("--")) {
    const [key, value] = arg.slice(2).split("=");
    const upperKey = key.toUpperCase();
    process.env[upperKey] = value;
    cmdLineArgs[upperKey] = value;
  }
});

// Log parsed command line arguments
process.stderr.write(
  `[DEBUG] Parsed command line args: ${JSON.stringify(cmdLineArgs)}\n`
);

// Set default GitLab URL
process.env.GITLAB_URL = process.env.GITLAB_URL || "https://gitlab.com";

// Activate MCP context immediately to prevent any stdout logs
activateMcpContext();

/**
 * Main function to initialize and start the GitLab MCP server
 */
async function main() {
  try {
    process.stderr.write(`[DEBUG] Starting GitLab MCP server main function\n`);

    // Create the MCP server
    process.stderr.write(`[DEBUG] Creating MCP server...\n`);
    const server = await createServer();
    process.stderr.write(`[DEBUG] MCP server created successfully\n`);

    // IMPORTANT: Register all components BEFORE connecting to transport
    // Register all components (resources, tools, prompts)
    process.stderr.write(`[DEBUG] Registering server components...\n`);
    registerServerComponents(server);
    process.stderr.write(`[DEBUG] Server components registered successfully\n`);

    // Initialize the transport (STDIO)
    process.stderr.write(`[DEBUG] Initializing STDIO transport...\n`);
    const transport = new StdioServerTransport();
    process.stderr.write(`[DEBUG] STDIO transport initialized\n`);

    // Connect the server to the transport AFTER registering components
    process.stderr.write(`[DEBUG] Connecting server to transport...\n`);
    await server.connect(transport);
    process.stderr.write(
      `[DEBUG] Server connected to transport successfully\n`
    );

    // Mark the server as connected for safe logging
    markServerConnected();
    process.stderr.write(`[DEBUG] Server marked as connected for logging\n`);

    // Server is now running with STDIO transport
    // All communication happens through stdin/stdout
    // No console.log allowed from this point on!
  } catch (err) {
    // Detailed error logging
    process.stderr.write(
      `[ERROR] Failed to start server: ${
        err instanceof Error ? err.message : String(err)
      }\n`
    );
    if (err instanceof Error && err.stack) {
      process.stderr.write(`[ERROR] Stack trace: ${err.stack}\n`);
    }

    // Send a proper JSON-RPC error response to stdout for Cursor
    const errorResponse = {
      jsonrpc: "2.0",
      error: {
        code: -32099,
        message: err instanceof Error ? err.message : String(err),
      },
      id: null,
    };
    console.log(JSON.stringify(errorResponse));

    // Also log to stderr for debugging
    if (err instanceof AppError) {
      error(`Server error: ${err.message}`);
    } else if (err instanceof Error) {
      error(`Unexpected error: ${err.message}`);
      if (err.stack) {
        error(err.stack);
      }
    } else {
      error(`Unknown error: ${String(err)}`);
    }

    process.exit(1);
  }
}

// Handle uncaught exceptions and unhandled promise rejections
process.on("uncaughtException", (err: Error) => {
  // Enhanced logging for uncaught exceptions
  process.stderr.write(`[FATAL] Uncaught exception: ${err.message}\n`);
  if (err.stack) {
    process.stderr.write(`[FATAL] Stack trace: ${err.stack}\n`);
  }

  // Send JSON-RPC error for uncaught exceptions
  const errorResponse = {
    jsonrpc: "2.0",
    error: {
      code: -32099,
      message: `Uncaught exception: ${err.message}`,
    },
    id: null,
  };
  console.log(JSON.stringify(errorResponse));

  emergency(`Uncaught exception: ${err.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  // Enhanced logging for unhandled rejections
  process.stderr.write(`[FATAL] Unhandled rejection: ${String(reason)}\n`);
  if (reason instanceof Error && reason.stack) {
    process.stderr.write(`[FATAL] Stack trace: ${reason.stack}\n`);
  }

  // Send JSON-RPC error for unhandled rejections
  const errorResponse = {
    jsonrpc: "2.0",
    error: {
      code: -32099,
      message: `Unhandled rejection: ${String(reason)}`,
    },
    id: null,
  };
  console.log(JSON.stringify(errorResponse));

  emergency(`Unhandled rejection: ${String(reason)}`);
  process.exit(1);
});

// Run the main function
main().catch((err: unknown) => {
  // Enhanced logging for main function failures
  process.stderr.write(
    `[FATAL] Main function failure: ${
      err instanceof Error ? err.message : String(err)
    }\n`
  );
  if (err instanceof Error && err.stack) {
    process.stderr.write(`[FATAL] Stack trace: ${err.stack}\n`);
  }

  // Send JSON-RPC error for main function failures
  const errorResponse = {
    jsonrpc: "2.0",
    error: {
      code: -32099,
      message: err instanceof Error ? err.message : String(err),
    },
    id: null,
  };
  console.log(JSON.stringify(errorResponse));

  emergency(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
