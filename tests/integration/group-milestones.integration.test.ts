/**
 * Group milestone tools.
 */
import { describe, expect, it, vi } from "vitest";

import { resolveToolScopeMetadata } from "../../src/tools/gitlab.js";
import { buildContext, callToolWithContext, createLinkedPair, parseToolText } from "./_helpers.js";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("group milestone tools", () => {
  it("lists group milestones with array and scalar filters", async () => {
    const get = vi.fn().mockResolvedValue([{ id: 1 }]);

    await callToolWithContext(
      buildContext({ gitlabStub: { get } }),
      "gitlab_list_group_milestones",
      {
        group_id: "my-org/platform",
        iids: [3, 4],
        state: "active",
        include_descendants: true,
        search: ""
      }
    );

    expect(get).toHaveBeenCalledWith("/groups/my-org%2Fplatform/milestones", {
      query: { state: "active", include_descendants: true, search: "", iids: [3, 4] }
    });
  });

  it("creates, updates, reads, and deletes group milestones", async () => {
    const get = vi.fn().mockResolvedValue({ id: 9 });
    const post = vi.fn().mockResolvedValue({ id: 9 });
    const put = vi.fn().mockResolvedValue({ id: 9, state: "closed" });
    const del = vi.fn().mockResolvedValue("");
    const context = buildContext({ gitlabStub: { get, post, put, delete: del } });

    await callToolWithContext(context, "gitlab_create_group_milestone", {
      group_id: "42",
      title: "Q4",
      due_date: "2026-12-31"
    });
    await callToolWithContext(context, "gitlab_update_group_milestone", {
      group_id: "42",
      milestone_id: 9,
      state_event: "close"
    });
    await callToolWithContext(context, "gitlab_get_group_milestone", {
      group_id: "42",
      milestone_id: "9"
    });
    const deleted = parseToolText(
      await callToolWithContext(context, "gitlab_delete_group_milestone", {
        group_id: "42",
        milestone_id: "9"
      })
    );

    expect(post).toHaveBeenCalledWith("/groups/42/milestones", {
      body: JSON.stringify({ title: "Q4", due_date: "2026-12-31" }),
      headers: JSON_HEADERS
    });
    expect(put).toHaveBeenCalledWith("/groups/42/milestones/9", {
      body: JSON.stringify({ state_event: "close" }),
      headers: JSON_HEADERS
    });
    expect(get).toHaveBeenCalledWith("/groups/42/milestones/9");
    expect(del).toHaveBeenCalledWith("/groups/42/milestones/9");
    expect(deleted).toEqual({ status: "deleted", group_id: "42", milestone_id: "9" });
  });

  it("lists milestone issues, merge requests, and burndown events", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const context = buildContext({ gitlabStub: { get } });

    for (const name of [
      "gitlab_list_group_milestone_issues",
      "gitlab_list_group_milestone_merge_requests",
      "gitlab_get_group_milestone_burndown_events"
    ]) {
      await callToolWithContext(context, name, { group_id: "42", milestone_id: "9", page: 2 });
    }

    expect(get.mock.calls).toEqual([
      ["/groups/42/milestones/9/issues", { query: { page: 2 } }],
      ["/groups/42/milestones/9/merge_requests", { query: { page: 2 } }],
      ["/groups/42/milestones/9/burndown_events", { query: { page: 2 } }]
    ]);
  });

  it("is group scoped and hidden under a project allowlist", async () => {
    expect(resolveToolScopeMetadata("gitlab_list_group_milestones")).toMatchObject({
      kind: "group",
      projectScopedMode: "deny"
    });

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ allowedProjectIds: ["group/project"] })
    );
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("gitlab_list_milestones");
      expect(names).not.toContain("gitlab_list_group_milestones");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });

  it("rejects an empty update and an unsupported state event", async () => {
    const put = vi.fn();
    const context = buildContext({ gitlabStub: { put } });

    const empty = await callToolWithContext(context, "gitlab_update_group_milestone", {
      group_id: "42",
      milestone_id: "9"
    });
    const badState = await callToolWithContext(context, "gitlab_update_group_milestone", {
      group_id: "42",
      milestone_id: "9",
      state_event: "reopen"
    });

    expect(empty.isError).toBe(true);
    expect(badState.isError).toBe(true);
    expect(put).not.toHaveBeenCalled();
  });
});
