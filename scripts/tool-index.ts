import { isToolEnabledByToolsets, toolsetsForTool } from "../src/lib/toolsets.js";
import type { GitLabToolDefinition } from "../src/tools/gitlab.js";

const EXPLICIT_ENABLE_FLAGS = {
  ciVariables: "GITLAB_ENABLE_CI_VARIABLE_TOOLS=true",
  dependencyProxy: "GITLAB_ENABLE_DEPENDENCY_PROXY_TOOLS=true"
} as const;

export function describeToolAvailability(definition: GitLabToolDefinition): string {
  const optIns: string[] = [];

  if (!isToolEnabledByToolsets(definition.name, ["core"])) {
    optIns.push(
      toolsetsForTool(definition.name).length > 0
        ? "select a listed toolset"
        : "select the all toolset"
    );
  }

  if (definition.requiresExplicitEnable) {
    optIns.push(EXPLICIT_ENABLE_FLAGS[definition.requiresExplicitEnable]);
  }

  if (definition.compatibilityAlias) {
    optIns.push("GITLAB_ENABLE_COMPATIBILITY_ALIASES=true");
  }

  return optIns.length === 0 ? "default" : `opt-in: ${optIns.join(" + ")}`;
}
