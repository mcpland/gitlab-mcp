import {
  PERMISSION_MODE_BLOCKED_CAPABILITIES,
  type GitLabPermissionMode,
  type ToolCapability
} from "./tool-capabilities.js";

export interface ToolPolicyMeta {
  name: string;
  capabilities: ToolCapability[];
  requiresFeature?: "wiki" | "milestone" | "pipeline" | "release";
}

export interface ToolPolicyConfig {
  permissionMode?: GitLabPermissionMode;
  readOnlyMode?: boolean;
  disabledCapabilities: ToolCapability[];
  allowedTools: string[];
  deniedToolsRegex?: RegExp;
  enabledFeatures: {
    wiki: boolean;
    milestone: boolean;
    pipeline: boolean;
    release: boolean;
  };
}

export class ToolPolicyEngine {
  private readonly normalizedAllowedTools: Set<string>;
  private readonly disabledCapabilities: Set<ToolCapability>;
  private readonly permissionMode: GitLabPermissionMode;

  constructor(private readonly config: ToolPolicyConfig) {
    this.normalizedAllowedTools = new Set(
      config.allowedTools.flatMap((name) => normalizeAllowedToolName(name))
    );
    this.disabledCapabilities = new Set(config.disabledCapabilities);
    this.permissionMode = config.readOnlyMode ? "readonly" : (config.permissionMode ?? "full");
  }

  filterTools(tools: ToolPolicyMeta[]): ToolPolicyMeta[] {
    return tools.filter((tool) => this.isToolEnabled(tool));
  }

  assertCanExecute(tool: ToolPolicyMeta): void {
    if (!this.isToolEnabled(tool)) {
      throw new Error(`Tool '${tool.name}' is disabled by policy`);
    }
  }

  isToolEnabled(tool: ToolPolicyMeta): boolean {
    if (this.hasBlockedCapabilities(tool)) {
      return false;
    }

    if (!this.isFeatureEnabled(tool)) {
      return false;
    }

    if (this.normalizedAllowedTools.size > 0 && !this.normalizedAllowedTools.has(tool.name)) {
      return false;
    }

    if (this.config.deniedToolsRegex && this.config.deniedToolsRegex.test(tool.name)) {
      return false;
    }

    return true;
  }

  private isFeatureEnabled(tool: ToolPolicyMeta): boolean {
    if (!tool.requiresFeature) {
      return true;
    }

    return this.config.enabledFeatures[tool.requiresFeature];
  }

  private hasBlockedCapabilities(tool: ToolPolicyMeta): boolean {
    const permissionBlockedCapabilities = PERMISSION_MODE_BLOCKED_CAPABILITIES[this.permissionMode];
    if (tool.capabilities.some((capability) => permissionBlockedCapabilities.has(capability))) {
      return true;
    }

    return tool.capabilities.some((capability) => this.disabledCapabilities.has(capability));
  }
}

function normalizeAllowedToolName(name: string): string[] {
  const value = name.trim();
  if (value.length === 0) {
    return [];
  }

  if (value.startsWith("gitlab_")) {
    return [value];
  }

  return [value, `gitlab_${value}`];
}
