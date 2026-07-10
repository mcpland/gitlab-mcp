import { describe, expect, it } from "vitest";

import type { ToolCapability } from "../src/lib/tool-capabilities.js";
import { ToolPolicyEngine, type ToolPolicyMeta } from "../src/lib/policy.js";

const defaultFeatures = {
  wiki: true,
  milestone: true,
  pipeline: true,
  release: true
};

function tool(
  name: string,
  capabilities: ToolCapability[],
  requiresFeature?: ToolPolicyMeta["requiresFeature"]
): ToolPolicyMeta {
  return { name, capabilities, requiresFeature };
}

describe("ToolPolicyEngine", () => {
  describe("filterTools", () => {
    it("blocks write, delete, and admin capabilities in readonly mode", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: true,
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          tool("read", ["read"]),
          tool("graphql_query", ["read", "graphql"]),
          tool("write", ["write"]),
          tool("delete", ["delete"]),
          tool("admin", ["admin"])
        ])
      ).toEqual([tool("read", ["read"]), tool("graphql_query", ["read", "graphql"])]);
    });

    it("allows read, write, and admin but blocks delete capabilities in modify mode", () => {
      const engine = new ToolPolicyEngine({
        permissionMode: "modify",
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          tool("read", ["read"]),
          tool("write", ["write"]),
          tool("admin", ["admin"]),
          tool("admin_delete", ["admin", "delete"]),
          tool("delete", ["delete"])
        ])
      ).toEqual([tool("read", ["read"]), tool("write", ["write"]), tool("admin", ["admin"])]);
    });

    it("allows all tools when no restrictions are set", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      const tools: ToolPolicyMeta[] = [
        tool("tool_a", ["read"]),
        tool("tool_b", ["write"]),
        tool("tool_c", ["delete"])
      ];

      expect(engine.filterTools(tools)).toEqual(tools);
    });

    it("applies allowlist and deny regex", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: [],
        allowedTools: ["gitlab_get_project", "gitlab_list_projects"],
        deniedToolsRegex: /^gitlab_list_/,
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          tool("gitlab_get_project", ["read"]),
          tool("gitlab_list_projects", ["read"]),
          tool("gitlab_create_issue", ["write"])
        ])
      ).toEqual([tool("gitlab_get_project", ["read"])]);
    });

    it("supports allowlist names without gitlab_ prefix", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: [],
        allowedTools: ["get_project"],
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          tool("gitlab_get_project", ["read"]),
          tool("gitlab_list_projects", ["read"])
        ])
      ).toEqual([tool("gitlab_get_project", ["read"])]);
    });

    it("respects feature flags", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: {
          wiki: false,
          milestone: false,
          pipeline: true,
          release: true
        }
      });

      expect(
        engine.filterTools([tool("wiki", ["read"], "wiki"), tool("pipeline", ["read"], "pipeline")])
      ).toEqual([tool("pipeline", ["read"], "pipeline")]);
    });

    it("blocks explicitly disabled capabilities", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: ["delete", "graphql"],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(
        engine.filterTools([
          tool("read", ["read"]),
          tool("delete_issue", ["delete"]),
          tool("graphql_query", ["read", "graphql"]),
          tool("write_issue", ["write"])
        ])
      ).toEqual([tool("read", ["read"]), tool("write_issue", ["write"])]);
    });
  });

  describe("assertCanExecute", () => {
    it("does not throw for enabled tools", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute(tool("any_tool", ["read"]));
      }).not.toThrow();
    });

    it("throws for blocked capabilities in readonly mode", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: true,
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute(tool("create_issue", ["write"]));
      }).toThrow("disabled by policy");
    });

    it("guards direct delete execution in modify mode", () => {
      const engine = new ToolPolicyEngine({
        permissionMode: "modify",
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute(tool("delete_issue", ["delete"]));
      }).toThrow("disabled by policy");
      expect(() => {
        engine.assertCanExecute(tool("update_project", ["admin"]));
      }).not.toThrow();
    });

    it("throws for explicitly disabled capabilities", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: ["graphql"],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute(tool("graphql_query", ["read", "graphql"]));
      }).toThrow("disabled by policy");
    });

    it("throws for tools not in allowlist", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: [],
        allowedTools: ["gitlab_get_project"],
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute(tool("gitlab_list_projects", ["read"]));
      }).toThrow("disabled by policy");
    });

    it("throws for tools matching denied regex", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: [],
        allowedTools: [],
        deniedToolsRegex: /^gitlab_delete_/,
        enabledFeatures: defaultFeatures
      });

      expect(() => {
        engine.assertCanExecute(tool("gitlab_delete_issue", ["delete"]));
      }).toThrow("disabled by policy");
    });

    it("throws for tools requiring disabled features", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: {
          wiki: false,
          milestone: true,
          pipeline: true,
          release: true
        }
      });

      expect(() => {
        engine.assertCanExecute(tool("wiki_tool", ["read"], "wiki"));
      }).toThrow("disabled by policy");
    });
  });

  describe("isToolEnabled", () => {
    it("returns true for unrestricted tools", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(engine.isToolEnabled(tool("any_tool", ["read"]))).toBe(true);
    });

    it("returns false for blocked capabilities in readonly mode", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: true,
        disabledCapabilities: [],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(engine.isToolEnabled(tool("create_something", ["write"]))).toBe(false);
      expect(engine.isToolEnabled(tool("read_something", ["read"]))).toBe(true);
    });

    it("returns false when a capability is explicitly disabled", () => {
      const engine = new ToolPolicyEngine({
        readOnlyMode: false,
        disabledCapabilities: ["delete"],
        allowedTools: [],
        enabledFeatures: defaultFeatures
      });

      expect(engine.isToolEnabled(tool("delete_something", ["delete"]))).toBe(false);
      expect(engine.isToolEnabled(tool("update_something", ["write"]))).toBe(true);
    });
  });
});
