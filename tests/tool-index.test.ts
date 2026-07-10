import { describe, expect, it } from "vitest";

import { describeToolAvailability } from "../scripts/tool-index.js";
import { isToolEnabledByToolsets } from "../src/lib/toolsets.js";
import { getGitLabToolDefinitions } from "../src/tools/gitlab.js";

describe("generated tool availability", () => {
  const definitions = getGitLabToolDefinitions();
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));

  it("marks only default-core tools without extra gates as default", () => {
    for (const definition of definitions) {
      const expectedDefault =
        isToolEnabledByToolsets(definition.name, ["core"]) &&
        definition.requiresExplicitEnable === undefined &&
        definition.compatibilityAlias !== true;

      expect(describeToolAvailability(definition) === "default", definition.name).toBe(
        expectedDefault
      );
    }
  });

  it("documents every opt-in gate for representative tool families", () => {
    expect(describeToolAvailability(requiredDefinition("gitlab_discover_tools"))).toBe("default");
    expect(describeToolAvailability(requiredDefinition("gitlab_approve_merge_request"))).toBe(
      "opt-in: select a listed toolset"
    );
    expect(describeToolAvailability(requiredDefinition("gitlab_create_project_variable"))).toBe(
      "opt-in: select a listed toolset + GITLAB_ENABLE_CI_VARIABLE_TOOLS=true"
    );
    expect(describeToolAvailability(requiredDefinition("gitlab_get_merge_request_notes"))).toBe(
      "opt-in: select a listed toolset + GITLAB_ENABLE_COMPATIBILITY_ALIASES=true"
    );
  });

  function requiredDefinition(name: string) {
    const definition = byName.get(name);
    expect(definition, `missing tool definition: ${name}`).toBeDefined();
    return definition!;
  }
});
