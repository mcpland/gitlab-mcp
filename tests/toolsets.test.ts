import { describe, expect, it } from "vitest";

import {
  isToolEnabledByToolsets,
  parseGitLabToolsets,
  toolsetsForTool
} from "../src/lib/toolsets.js";

describe("GitLab toolsets", () => {
  it("normalizes configured names and rejects unknown toolsets", () => {
    expect(parseGitLabToolsets(["CORE", "merge_requests", "core"])).toEqual([
      "core",
      "merge-requests"
    ]);
    expect(() => parseGitLabToolsets(["unknown"])).toThrow("Invalid GITLAB_TOOLSETS");
  });

  it("assigns tools to all applicable domains", () => {
    expect(toolsetsForTool("gitlab_get_merge_request_file_diff")).toEqual(
      expect.arrayContaining(["core", "merge-requests", "repository"])
    );
    expect(toolsetsForTool("gitlab_list_group_wiki_pages")).toEqual(
      expect.arrayContaining(["wiki", "groups"])
    );
    expect(toolsetsForTool("gitlab_list_ci_catalog_resources")).toEqual(["ci-catalog"]);
    expect(toolsetsForTool("gitlab_get_project_variable")).toEqual(
      expect.arrayContaining(["ci-variables", "projects"])
    );
  });

  it("treats an empty selection and all as the complete registry", () => {
    expect(isToolEnabledByToolsets("gitlab_get_issue", [])).toBe(true);
    expect(isToolEnabledByToolsets("gitlab_get_issue", ["all"])).toBe(true);
    expect(isToolEnabledByToolsets("gitlab_get_issue", ["wiki"])).toBe(false);
  });
});
