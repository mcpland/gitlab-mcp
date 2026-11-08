/**
 * Deployment write, approval, and merge request tools.
 */
import { describe, expect, it, vi } from "vitest";

import { buildContext, callToolWithContext, parseToolText } from "./_helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("deployment tools", () => {
  it("creates and updates deployments", async () => {
    const post = vi.fn().mockResolvedValue({ id: 42, status: "running" });
    const put = vi.fn().mockResolvedValue({ id: 42, status: "success" });
    const context = buildContext({ gitlabStub: { post, put } });

    const created = await callToolWithContext(context, "gitlab_create_deployment", {
      project_id: "group/project",
      environment: "production",
      sha: "a1b2c3d4e5f6",
      ref: "main",
      tag: "false",
      status: "running"
    });
    await callToolWithContext(context, "gitlab_update_deployment", {
      project_id: "group/project",
      deployment_id: 42,
      status: "success"
    });

    expect(created.isError).toBeFalsy();
    expect(post).toHaveBeenCalledWith("/projects/group%2Fproject/deployments", {
      body: JSON.stringify({
        environment: "production",
        sha: "a1b2c3d4e5f6",
        ref: "main",
        tag: false,
        status: "running"
      }),
      headers: JSON_HEADERS
    });
    expect(put).toHaveBeenCalledWith("/projects/group%2Fproject/deployments/42", {
      body: JSON.stringify({ status: "success" }),
      headers: JSON_HEADERS
    });
  });

  it("rejects invalid deployment SHAs and statuses", async () => {
    const post = vi.fn();
    const context = buildContext({ gitlabStub: { post } });

    for (const args of [
      { sha: "not-a-sha", status: "running" },
      { sha: "a1b2c3d", status: "deployed" }
    ]) {
      const result = await callToolWithContext(context, "gitlab_create_deployment", {
        project_id: "group/project",
        environment: "production",
        ref: "main",
        tag: false,
        ...args
      });
      expect(result.isError).toBe(true);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("approves deployments, lists shipped merge requests, and deletes records", async () => {
    const post = vi.fn().mockResolvedValue({ status: "approved" });
    const get = vi.fn().mockResolvedValue([{ iid: 3 }]);
    const del = vi.fn().mockResolvedValue("");
    const context = buildContext({ gitlabStub: { post, get, delete: del } });

    await callToolWithContext(context, "gitlab_approve_deployment", {
      project_id: "group/project",
      deployment_id: "42",
      status: "approved",
      comment: "Ship it"
    });
    await callToolWithContext(context, "gitlab_list_deployment_merge_requests", {
      project_id: "group/project",
      deployment_id: "42",
      state: "merged",
      per_page: 50
    });
    const deleted = parseToolText(
      await callToolWithContext(context, "gitlab_delete_deployment", {
        project_id: "group/project",
        deployment_id: "41"
      })
    );

    expect(post).toHaveBeenCalledWith("/projects/group%2Fproject/deployments/42/approval", {
      body: JSON.stringify({ status: "approved", comment: "Ship it" }),
      headers: JSON_HEADERS
    });
    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/deployments/42/merge_requests", {
      query: { state: "merged", per_page: 50 }
    });
    expect(del).toHaveBeenCalledWith("/projects/group%2Fproject/deployments/41");
    expect(deleted).toMatchObject({ status: "deleted", deployment_id: "41" });
  });
});
