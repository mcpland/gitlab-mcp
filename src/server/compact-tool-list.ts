import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

type ProtocolRequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;

interface RequestHandlerRegistry {
  _requestHandlers?: Map<string, ProtocolRequestHandler>;
}

/**
 * Removes redundant JSON Schema dialect declarations from tools/list.
 *
 * The SDK currently adds the same `$schema` value to every Zod-generated tool
 * schema. It has no public response-transform hook, so this wraps only its
 * already-installed tools/list handler and leaves validation/call handling to
 * the SDK. The guard intentionally fails fast if that internal hook changes.
 */
export function installCompactToolListHandler(server: McpServer): void {
  const protocol = server.server as unknown as RequestHandlerRegistry;
  const originalHandler = protocol._requestHandlers?.get("tools/list");

  if (!originalHandler) {
    throw new Error("MCP SDK tools/list handler was not installed before schema compaction");
  }

  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = (await originalHandler(request, extra)) as ListToolsResult;

    return {
      ...result,
      tools: result.tools.map((tool) => ({
        ...tool,
        inputSchema: omitSchemaDialect(tool.inputSchema),
        ...(tool.outputSchema ? { outputSchema: omitSchemaDialect(tool.outputSchema) } : {})
      }))
    };
  });
}

function omitSchemaDialect<T extends Record<string, unknown>>(schema: T): T {
  if (!("$schema" in schema)) {
    return schema;
  }

  const compact = { ...schema };
  delete compact.$schema;
  return compact;
}
