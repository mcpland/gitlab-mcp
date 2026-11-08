/**
 * Protected tag tools.
 */
import { describe, expect, it, vi } from "vitest";

import { toolsetsForTool } from "../../src/lib/toolsets.js";
import { buildContext, callToolWithContext, createLinkedPair, parseToolText } from "./_helpers.js";

describe("protected tag tools", () => {
  it("lists and reads protected tag rules, encoding wildcard names", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const context = buildContext({ gitlabStub: { get } });

    await callToolWithContext(context, "gitlab_list_protected_tags", {
      project_id: "group/project",
      per_page: 50
    });
    await callToolWithContext(context, "gitlab_get_protected_tag", {
      project_id: "group/project",
      name: "release/v*"
    });

    expect(get.mock.calls).toEqual([
      ["/projects/group%2Fproject/protected_tags", { query: { per_page: 50 } }],
      ["/projects/group%2Fproject/protected_tags/release%2Fv*"]
    ]);
  });

  it("protects and unprotects tags", async () => {
    const post = vi.fn().mockResolvedValue({ name: "v*" });
    const del = vi.fn().mockResolvedValue("");
    const context = buildContext({ gitlabStub: { post, delete: del } });

    await callToolWithContext(context, "gitlab_protect_tag", {
      project_id: "group/project",
      name: "v*",
      create_access_level: 40,
      allowed_to_create: [{ user_id: 12 }, { access_level: 30 }]
    });
    const removed = parseToolText(
      await callToolWithContext(context, "gitlab_unprotect_tag", {
        project_id: "group/project",
        name: "v*"
      })
    );

    expect(post).toHaveBeenCalledWith("/projects/group%2Fproject/protected_tags", {
      body: JSON.stringify({
        name: "v*",
        create_access_level: 40,
        allowed_to_create: [{ user_id: 12 }, { access_level: 30 }]
      }),
      headers: { "Content-Type": "application/json" }
    });
    expect(del).toHaveBeenCalledWith("/projects/group%2Fproject/protected_tags/v*");
    expect(removed).toEqual({ status: "unprotected", project_id: "group/project", name: "v*" });
  });

  it("rejects invalid access levels and ambiguous allowed_to_create entries", async () => {
    const post = vi.fn();
    const context = buildContext({ gitlabStub: { post } });

    for (const args of [
      { create_access_level: 20 },
      { allowed_to_create: [{ user_id: 1, group_id: 2 }] },
      { allowed_to_create: [{}] }
    ]) {
      const result = await callToolWithContext(context, "gitlab_protect_tag", {
        project_id: "group/project",
        name: "v*",
        ...args
      });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
    expect(post).not.toHaveBeenCalled();
  });

  it("joins the releases and repository toolsets and hides unprotect in modify mode", async () => {
    expect(toolsetsForTool("gitlab_protect_tag")).toEqual(
      expect.arrayContaining(["releases", "repository"])
    );

    const { client, clientTransport, serverTransport } = await createLinkedPair(
      buildContext({ permissionMode: "modify" })
    );
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain("gitlab_protect_tag");
      expect(names).not.toContain("gitlab_unprotect_tag");
    } finally {
      await clientTransport.close();
      await serverTransport.close();
    }
  });
});
