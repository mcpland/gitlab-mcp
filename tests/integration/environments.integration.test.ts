/**
 * Environment lifecycle tools.
 */
import { describe, expect, it, vi } from "vitest";

import { buildContext, callToolWithContext, createLinkedPair, parseToolText } from "./_helpers.js";

describe("environment lifecycle tools", () => {
  it("creates and updates environments with allowlisted settings", async () => {
    const post = vi.fn().mockResolvedValue({ id: 5, name: "review/feature" });
    const put = vi.fn().mockResolvedValue({ id: 5 });
    const context = buildContext({ gitlabStub: { post, put } });

    await callToolWithContext(context, "gitlab_create_environment", {
      project_id: "group/project",
      name: "review/feature",
      external_url: "https://feature.review.example.com",
      tier: "development",
      auto_stop_setting: "with_action"
    });
    await callToolWithContext(context, "gitlab_update_environment", {
      project_id: "group/project",
      environment_id: 5,
      description: "Feature review app"
    });

    expect(post).toHaveBeenCalledWith("/projects/group%2Fproject/environments", {
      body: JSON.stringify({
        name: "review/feature",
        external_url: "https://feature.review.example.com",
        tier: "development",
        auto_stop_setting: "with_action"
      }),
      headers: { "Content-Type": "application/json" }
    });
    expect(put).toHaveBeenCalledWith("/projects/group%2Fproject/environments/5", {
      body: JSON.stringify({ description: "Feature review app" }),
      headers: { "Content-Type": "application/json" }
    });
  });

  it("rejects non-http external URLs and empty updates", async () => {
    const post = vi.fn();
    const put = vi.fn();
    const context = buildContext({ gitlabStub: { post, put } });

    const badUrl = await callToolWithContext(context, "gitlab_create_environment", {
      project_id: "group/project",
      name: "prod",
      external_url: "javascript:alert(1)"
    });
    const empty = await callToolWithContext(context, "gitlab_update_environment", {
      project_id: "group/project",
      environment_id: "5"
    });

    expect(badUrl.isError).toBe(true);
    expect(empty.isError).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("stops environments, stops stale ones, and deletes by id", async () => {
    const post = vi.fn().mockResolvedValue({ id: 5, state: "stopping" });
    const del = vi.fn().mockResolvedValue("");
    const context = buildContext({ gitlabStub: { post, delete: del } });

    await callToolWithContext(context, "gitlab_stop_environment", {
      project_id: "group/project",
      environment_id: "5",
      force: true
    });
    await callToolWithContext(context, "gitlab_stop_stale_environments", {
      project_id: "group/project",
      before: "2026-01-01T00:00:00Z"
    });
    const deleted = parseToolText(
      await callToolWithContext(context, "gitlab_delete_environment", {
        project_id: "group/project",
        environment_id: "5"
      })
    );

    expect(post).toHaveBeenNthCalledWith(1, "/projects/group%2Fproject/environments/5/stop", {
      query: { force: true }
    });
    expect(post).toHaveBeenNthCalledWith(2, "/projects/group%2Fproject/environments/stop_stale", {
      query: { before: "2026-01-01T00:00:00Z" }
    });
    expect(del).toHaveBeenCalledWith("/projects/group%2Fproject/environments/5");
    expect(deleted).toMatchObject({ status: "deleted", environment_id: "5" });
  });

  it("previews review app cleanup unless dry_run is explicitly false", async () => {
    const del = vi.fn().mockResolvedValue({ scheduled_entries: [], unprocessable_entries: [] });
    const context = buildContext({ gitlabStub: { delete: del } });

    await callToolWithContext(context, "gitlab_delete_review_app_environments", {
      project_id: "group/project"
    });
    await callToolWithContext(context, "gitlab_delete_review_app_environments", {
      project_id: "group/project",
      before: "2026-06-01",
      limit: 50,
      dry_run: "false"
    });

    expect(del).toHaveBeenNthCalledWith(1, "/projects/group%2Fproject/environments/review_apps", {
      query: { dry_run: true }
    });
    expect(del).toHaveBeenNthCalledWith(2, "/projects/group%2Fproject/environments/review_apps", {
      query: { before: "2026-06-01", limit: 50, dry_run: false }
    });
  });

  it("hides teardown tools in modify mode and marks them destructive", async () => {
    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ permissionMode: "modify" })
    );
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("gitlab_create_environment");
      expect(names).toContain("gitlab_update_environment");
      for (const name of [
        "gitlab_stop_environment",
        "gitlab_stop_stale_environments",
        "gitlab_delete_environment",
        "gitlab_delete_review_app_environments"
      ]) {
        expect(names).not.toContain(name);
      }
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
