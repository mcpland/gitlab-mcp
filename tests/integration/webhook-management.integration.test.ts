/**
 * Webhook create, update, and delete tools.
 */
import { describe, expect, it, vi } from "vitest";

import { buildContext, callToolWithContext, createLinkedPair, parseToolText } from "./_helpers.js";

const SECRET = "hook-secret-token-value";

describe("webhook management tools", () => {
  it("creates project webhooks with selected events", async () => {
    const createWebhook = vi.fn().mockResolvedValue({ id: 3, url: "https://ci.example.com/hook" });

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { createWebhook } }),
      "gitlab_create_webhook",
      {
        project_id: "group/project",
        url: "https://ci.example.com/hook",
        token: SECRET,
        push_events: true,
        merge_requests_events: "true",
        branch_filter_strategy: "wildcard",
        push_events_branch_filter: "main"
      }
    );

    expect(result.isError).toBeFalsy();
    expect(createWebhook).toHaveBeenCalledWith(
      { projectId: "group/project" },
      {
        url: "https://ci.example.com/hook",
        token: SECRET,
        push_events_branch_filter: "main",
        branch_filter_strategy: "wildcard",
        push_events: true,
        merge_requests_events: true
      }
    );
  });

  it("updates and deletes group webhooks", async () => {
    const updateWebhook = vi.fn().mockResolvedValue({ id: 4 });
    const deleteWebhook = vi.fn().mockResolvedValue("");
    const context = buildContext({ gitlabStub: { updateWebhook, deleteWebhook } });

    await callToolWithContext(context, "gitlab_update_webhook", {
      group_id: "my-org",
      hook_id: 4,
      enable_ssl_verification: false
    });
    const deleted = parseToolText(
      await callToolWithContext(context, "gitlab_delete_webhook", {
        group_id: "my-org",
        hook_id: "4"
      })
    );

    expect(updateWebhook).toHaveBeenCalledWith({ groupId: "my-org" }, "4", {
      enable_ssl_verification: false
    });
    expect(deleteWebhook).toHaveBeenCalledWith({ groupId: "my-org" }, "4");
    expect(deleted).toEqual({ status: "deleted", group_id: "my-org", hook_id: "4" });
  });

  it("redacts the secret token and URL from errors", async () => {
    const createWebhook = vi
      .fn()
      .mockRejectedValue(new Error(`Rejected ${SECRET} for https://hooks.example.com/T0/B0/XYZ`));

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { createWebhook } }),
      "gitlab_create_webhook",
      { project_id: "group/project", url: "https://hooks.example.com/T0/B0/XYZ", token: SECRET }
    );

    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("T0/B0/XYZ");
  });

  it("rejects non-http URLs, ambiguous scopes, and empty updates", async () => {
    const createWebhook = vi.fn();
    const updateWebhook = vi.fn();
    const context = buildContext({ gitlabStub: { createWebhook, updateWebhook } });

    const badUrl = await callToolWithContext(context, "gitlab_create_webhook", {
      project_id: "group/project",
      url: "ftp://example.com/hook"
    });
    const bothScopes = await callToolWithContext(context, "gitlab_create_webhook", {
      project_id: "group/project",
      group_id: "my-org",
      url: "https://example.com/hook"
    });
    const empty = await callToolWithContext(context, "gitlab_update_webhook", {
      project_id: "group/project",
      hook_id: 1
    });

    expect([badUrl.isError, bothScopes.isError, empty.isError]).toEqual([true, true, true]);
    expect(createWebhook).not.toHaveBeenCalled();
    expect(updateWebhook).not.toHaveBeenCalled();
  });

  it("allows only project webhooks under a project allowlist and hides them in readonly", async () => {
    const createWebhook = vi.fn().mockResolvedValue({ id: 1 });
    const scoped = buildContext({
      gitlabStub: { createWebhook },
      allowedProjectIds: ["group/project"]
    });

    const groupResult = await callToolWithContext(scoped, "gitlab_create_webhook", {
      group_id: "my-org",
      url: "https://example.com/hook"
    });
    const otherProject = await callToolWithContext(scoped, "gitlab_create_webhook", {
      project_id: "other/project",
      url: "https://example.com/hook"
    });

    expect(groupResult.isError).toBe(true);
    expect(otherProject.isError).toBe(true);
    expect(createWebhook).not.toHaveBeenCalled();

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ permissionMode: "readonly" })
    );
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("gitlab_list_webhooks");
      expect(names).not.toContain("gitlab_create_webhook");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
