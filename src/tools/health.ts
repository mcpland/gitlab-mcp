import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerHealthTool(server: McpServer): void {
  server.registerTool(
    "health_check",
    {
      title: "Health Check",
      description: "Return server liveness and current timestamp."
    },
    async () => {
      const now = new Date().toISOString();

      return {
        content: [
          {
            type: "text" as const,
            text: `ok (${now})`
          }
        ],
        structuredContent: {
          status: "ok",
          timestamp: now
        }
      };
    }
  );
}
