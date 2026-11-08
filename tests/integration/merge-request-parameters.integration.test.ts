/**
 * Merge request write parameters that map directly onto GitLab REST fields.
 */
import { describe, expect, it, vi } from "vitest";

import type { AppContext } from "../../src/types/context.js";
import { buildContext, callToolWithContext } from "./_helpers.js";

function callTool(
  gitlabStub: Partial<AppContext["gitlab"]>,
  name: string,
  args: Record<string, unknown>
) {
  return callToolWithContext(buildContext({ gitlabStub }), name, args);
}

describe("gitlab_update_merge_request parameters", () => {
  it("sends milestone, incremental labels, collaboration, and lock fields", async () => {
    const updateMergeRequest = vi.fn().mockResolvedValue({ iid: 7 });

    const result = await callTool({ updateMergeRequest }, "gitlab_update_merge_request", {
      project_id: "group/project",
      merge_request_iid: "7",
      milestone_id: "12",
      add_labels: ["bug", "", "ui"],
      remove_labels: "stale",
      allow_collaboration: "true",
      discussion_locked: false,
      state_event: "close"
    });

    expect(result.isError).toBeFalsy();
    expect(updateMergeRequest).toHaveBeenCalledWith("group/project", "7", {
      milestone_id: 12,
      add_labels: "bug,ui",
      remove_labels: "stale",
      allow_collaboration: true,
      discussion_locked: false,
      state_event: "close"
    });
  });

  it("unassigns the milestone with 0 but ignores a blank milestone_id", async () => {
    const updateMergeRequest = vi.fn().mockResolvedValue({ iid: 7 });

    await callTool({ updateMergeRequest }, "gitlab_update_merge_request", {
      project_id: "group/project",
      merge_request_iid: "7",
      milestone_id: 0
    });
    await callTool({ updateMergeRequest }, "gitlab_update_merge_request", {
      project_id: "group/project",
      merge_request_iid: "7",
      milestone_id: "",
      title: "Renamed"
    });

    expect(updateMergeRequest).toHaveBeenNthCalledWith(1, "group/project", "7", {
      milestone_id: 0
    });
    expect(updateMergeRequest).toHaveBeenNthCalledWith(2, "group/project", "7", {
      title: "Renamed"
    });
  });

  it("rejects unsupported state events before calling GitLab", async () => {
    const updateMergeRequest = vi.fn();

    const result = await callTool({ updateMergeRequest }, "gitlab_update_merge_request", {
      project_id: "group/project",
      merge_request_iid: "7",
      state_event: "merge"
    });

    expect(result.isError).toBe(true);
    expect(updateMergeRequest).not.toHaveBeenCalled();
  });
});

describe("gitlab_create_merge_request milestone", () => {
  it("passes milestone_id to GitLab", async () => {
    const createMergeRequest = vi.fn().mockResolvedValue({ iid: 8 });

    await callTool({ createMergeRequest }, "gitlab_create_merge_request", {
      project_id: "group/project",
      source_branch: "feature",
      target_branch: "main",
      title: "Feature",
      milestone_id: 4
    });

    expect(createMergeRequest).toHaveBeenCalledWith(
      "group/project",
      expect.objectContaining({ milestone_id: 4 })
    );
  });
});
