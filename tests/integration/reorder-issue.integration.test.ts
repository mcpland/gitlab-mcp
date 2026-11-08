/**
 * Issue reordering.
 */
import { describe, expect, it, vi } from "vitest";

import { buildContext, callToolWithContext } from "./_helpers.js";

describe("gitlab_reorder_issue", () => {
  it("sends neighbor issue IDs to the reorder endpoint", async () => {
    const put = vi.fn().mockResolvedValue({ iid: 5, relative_position: 1023 });

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { put } }),
      "gitlab_reorder_issue",
      { project_id: "group/project", issue_iid: 5, move_after_id: "901", move_before_id: 900 }
    );

    expect(result.isError).toBeFalsy();
    expect(put).toHaveBeenCalledWith("/projects/group%2Fproject/issues/5/reorder", {
      body: JSON.stringify({ move_after_id: 901, move_before_id: 900 }),
      headers: { "Content-Type": "application/json" }
    });
  });

  it("requires at least one neighbor", async () => {
    const put = vi.fn();

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { put } }),
      "gitlab_reorder_issue",
      { project_id: "group/project", issue_iid: "5" }
    );

    expect(result.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });
});
