import { describe, expect, it } from "vitest";

import { ToolPolicyEngine } from "../src/lib/policy.js";

describe("ToolPolicyEngine", () => {
  it("blocks mutating tools in readonly mode", () => {
    const engine = new ToolPolicyEngine({
      readOnlyMode: true,
      allowedTools: [],
      enabledFeatures: {
        wiki: true,
        milestone: true,
        pipeline: true,
        release: true
      }
    });

    expect(
      engine.filterTools([
        { name: "readonly", mutating: false },
        { name: "mutate", mutating: true }
      ])
    ).toEqual([{ name: "readonly", mutating: false }]);
  });

  it("applies allowlist and deny regex", () => {
    const engine = new ToolPolicyEngine({
      readOnlyMode: false,
      allowedTools: ["gitlab_get_project", "gitlab_list_projects"],
      deniedToolsRegex: /^gitlab_list_/,
      enabledFeatures: {
        wiki: true,
        milestone: true,
        pipeline: true,
        release: true
      }
    });

    expect(
      engine.filterTools([
        { name: "gitlab_get_project", mutating: false },
        { name: "gitlab_list_projects", mutating: false },
        { name: "gitlab_create_issue", mutating: true }
      ])
    ).toEqual([{ name: "gitlab_get_project", mutating: false }]);
  });

  it("respects feature flags", () => {
    const engine = new ToolPolicyEngine({
      readOnlyMode: false,
      allowedTools: [],
      enabledFeatures: {
        wiki: false,
        milestone: false,
        pipeline: true,
        release: true
      }
    });

    expect(
      engine.filterTools([
        { name: "wiki", mutating: false, requiresFeature: "wiki" },
        { name: "pipeline", mutating: false, requiresFeature: "pipeline" }
      ])
    ).toEqual([{ name: "pipeline", mutating: false, requiresFeature: "pipeline" }]);
  });
});
