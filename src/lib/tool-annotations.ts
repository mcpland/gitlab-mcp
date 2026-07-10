import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import type { ToolCapability } from "./tool-capabilities.js";

export function annotationsForCapabilities(
  capabilities: readonly ToolCapability[]
): ToolAnnotations {
  const isReadOnly = !capabilities.some((capability) =>
    ["write", "delete", "admin"].includes(capability)
  );

  return {
    readOnlyHint: isReadOnly,
    destructiveHint: capabilities.includes("delete"),
    idempotentHint: isReadOnly,
    openWorldHint: true
  };
}

export const healthToolAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
};
