/**
 * Group-wide merge request listing.
 */
import { describe, expect, it, vi } from "vitest";

import { resolveToolScopeMetadata } from "../../src/tools/gitlab.js";
import { buildContext, callToolWithContext } from "./_helpers.js";

describe("gitlab_list_group_merge_requests", () => {
  it("normalizes ID/username pairs and keeps approver arrays", async () => {
    const listGroupMergeRequests = vi.fn().mockResolvedValue([]);

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { listGroupMergeRequests } }),
      "gitlab_list_group_merge_requests",
      {
        group_id: "my-org",
        state: "opened",
        reviewer_id: 5,
        reviewer_username: "carol",
        approved_by_usernames: ["dave"],
        labels: ["bug", "ui"],
        non_archived: true
      }
    );

    expect(result.isError).toBeFalsy();
    expect(listGroupMergeRequests).toHaveBeenCalledWith("my-org", {
      query: {
        state: "opened",
        reviewer_username: "carol",
        labels: "bug,ui",
        non_archived: true,
        approved_by_usernames: ["dave"]
      }
    });
  });

  it("is group scoped", () => {
    expect(resolveToolScopeMetadata("gitlab_list_group_merge_requests")).toMatchObject({
      kind: "group",
      projectScopedMode: "deny"
    });
  });
});
