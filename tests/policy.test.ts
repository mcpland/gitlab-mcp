import { describe, expect, it } from "vitest";

import { ToolPolicyEngine, type ToolPolicyMeta } from "../src/lib/policy.js";

const defaultFeatures = {
  wiki: true,
  milestone: true,
  pipeline: true,
  release: true
};

describe("ToolPolicyEngine", () => {
  describe("filterTools", () => {
    it("blocks mutating tools in readonly mode", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: true,
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          { name: "readonly", mutating: false },
          { name: "mutate", mutating: true }
        ])
      ).toEqual([{ name: "readonly", mutating: false }]);
    });

    it("allows all tools when no restrictions are set", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      const tools: ToolPolicyMeta[] = [
        { name: "tool_a", mutating: false },
        { name: "tool_b", mutating: true },
        { name: "tool_c", mutating: false }
      ];

      expect(engine.filterTools(tools)).toEqual(tools);
    });

    it("applies allowlist and deny regex", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: ["gitlab_get_project", "gitlab_list_projects"],
        deniedToolsRegex: /^gitlab_list_/,
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          { name: "gitlab_get_project", mutating: false },
          { name: "gitlab_list_projects", mutating: false },
          { name: "gitlab_create_issue", mutating: true }
        ])
      ).toEqual([{ name: "gitlab_get_project", mutating: false }]);
    });

    it("supports allowlist names without gitlab_ prefix", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: ["get_project"],
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          { name: "gitlab_get_project", mutating: false },
          { name: "gitlab_list_projects", mutating: false }
        ])
      ).toEqual([{ name: "gitlab_get_project", mutating: false }]);
    });

    it("supports allowlist names with gitlab_ prefix", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: ["gitlab_get_project"],
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          { name: "gitlab_get_project", mutating: false },
          { name: "gitlab_list_projects", mutating: false }
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

    it("allows tools without requiresFeature even when features are disabled", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: [],
        enabledFeatures: {
          wiki: false,
          milestone: false,
          pipeline: false,
          release: false
        }
      });

      expect(
        engine.filterTools([
          { name: "generic_tool", mutating: false },
          { name: "wiki_tool", mutating: false, requiresFeature: "wiki" }
        ])
      ).toEqual([{ name: "generic_tool", mutating: false }]);
    });

    it("applies deniedToolsRegex without allowlist", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: [],
        deniedToolsRegex: /^gitlab_delete_/,
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          { name: "gitlab_get_project", mutating: false },
          { name: "gitlab_delete_project", mutating: true },
          { name: "gitlab_delete_issue", mutating: true }
        ])
      ).toEqual([{ name: "gitlab_get_project", mutating: false }]);
    });

    it("handles empty tools array", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(engine.filterTools([])).toEqual([]);
    });

    it("combines readOnly mode with feature flags", () => {
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
          { name: "read_wiki", mutating: false, requiresFeature: "wiki" },
          { name: "create_wiki", mutating: true, requiresFeature: "wiki" },
          { name: "get_project", mutating: false }
        ])
      ).toEqual([
        { name: "read_wiki", mutating: false, requiresFeature: "wiki" },
        { name: "get_project", mutating: false }
      ]);
    });

    it("handles allowlist with whitespace-padded names", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: ["  get_project  "],
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          { name: "gitlab_get_project", mutating: false },
          { name: "gitlab_list_projects", mutating: false }
        ])
      ).toEqual([{ name: "gitlab_get_project", mutating: false }]);
    });

    it("handles allowlist with empty strings", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: ["", "  ", "get_project"],
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          { name: "gitlab_get_project", mutating: false },
          { name: "gitlab_list_projects", mutating: false }
        ])
      ).toEqual([{ name: "gitlab_get_project", mutating: false }]);
    });

    it("respects release feature flag", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: [],
        enabledFeatures: {
          wiki: true,
          milestone: true,
          pipeline: true,
          release: false
        }
      });

      expect(
        engine.filterTools([
          { name: "list_releases", mutating: false, requiresFeature: "release" },
          { name: "list_pipelines", mutating: false, requiresFeature: "pipeline" }
        ])
      ).toEqual([{ name: "list_pipelines", mutating: false, requiresFeature: "pipeline" }]);
    });
  });

  describe("assertCanExecute", () => {
    it("does not throw for enabled tools", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute({ name: "any_tool", mutating: false });
      }).not.toThrow();
    });

    it("throws for disabled tools in readonly mode", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: true,
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute({ name: "create_issue", mutating: true });
      }).toThrow("disabled by policy");
    });

    it("throws for tools not in allowlist", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: ["gitlab_get_project"],
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute({ name: "gitlab_list_projects", mutating: false });
      }).toThrow("disabled by policy");
    });

    it("throws for tools matching denied regex", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: [],
        deniedToolsRegex: /^gitlab_delete_/,
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute({ name: "gitlab_delete_issue", mutating: true });
      }).toThrow("disabled by policy");
    });

    it("throws for tools requiring disabled features", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: [],
        enabledFeatures: {
          wiki: false,
          milestone: true,
          pipeline: true,
          release: true
        }
      });

      expect(() => {
        engine.assertCanExecute({ name: "wiki_tool", mutating: false, requiresFeature: "wiki" });
      }).toThrow("disabled by policy");
    });
  });

  describe("isToolEnabled", () => {
    it("returns true for unrestricted tools", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(engine.isToolEnabled({ name: "any_tool", mutating: false })).toBe(true);
    });

    it("returns false for mutating tools in readonly mode", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: true,
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(engine.isToolEnabled({ name: "create_something", mutating: true })).toBe(false);
      expect(engine.isToolEnabled({ name: "read_something", mutating: false })).toBe(true);
    });
  });
});
