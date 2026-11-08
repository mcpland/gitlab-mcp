/**
 * Repository tree keyset pagination parameters.
 */
import { describe, expect, it, vi } from "vitest";

import { buildContext, callToolWithContext } from "./_helpers.js";

describe("gitlab_get_repository_tree pagination", () => {
  it("forwards keyset pagination and the page token", async () => {
    const getRepositoryTree = vi.fn().mockResolvedValue({ items: [] });

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { getRepositoryTree } }),
      "gitlab_get_repository_tree",
      {
        project_id: "group/project",
        recursive: true,
        pagination: "keyset",
        page_token: "7f3a2b",
        per_page: 100
      }
    );

    expect(result.isError).toBeFalsy();
    expect(getRepositoryTree).toHaveBeenCalledWith("group/project", {
      query: { recursive: true, pagination: "keyset", page_token: "7f3a2b", per_page: 100 }
    });
  });

  it("rejects unsupported pagination modes", async () => {
    const getRepositoryTree = vi.fn();

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { getRepositoryTree } }),
      "gitlab_get_repository_tree",
      { project_id: "group/project", pagination: "cursor" }
    );

    expect(result.isError).toBe(true);
    expect(getRepositoryTree).not.toHaveBeenCalled();
  });
});
