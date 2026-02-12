export interface ToolPolicyMeta {
  name: string;
  mutating: boolean;
  requiresFeature?: "wiki" | "milestone" | "pipeline" | "release";
}

export interface ToolPolicyConfig {
  readOnlyMode: boolean;
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
  constructor(private readonly config: ToolPolicyConfig) {}

  filterTools(tools: ToolPolicyMeta[]): ToolPolicyMeta[] {
    return tools.filter((tool) => this.isToolEnabled(tool));
  }

  assertCanExecute(tool: ToolPolicyMeta): void {
    if (!this.isToolEnabled(tool)) {
      throw new Error(`Tool '${tool.name}' is disabled by policy`);
    }
  }

  isToolEnabled(tool: ToolPolicyMeta): boolean {
    if (this.config.readOnlyMode && tool.mutating) {
      return false;
    }

    if (!this.isFeatureEnabled(tool)) {
      return false;
    }

    if (this.config.allowedTools.length > 0 && !this.config.allowedTools.includes(tool.name)) {
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
}
