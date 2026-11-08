/**
 * Group member listing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../../src/lib/gitlab-client.js";
import { resolveToolScopeMetadata } from "../../src/tools/gitlab.js";
import { buildContext, callToolWithContext } from "./_helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gitlab_list_group_members", () => {
  it("forwards search, ID filters, and inheritance selection", async () => {
    const listGroupMembers = vi.fn().mockResolvedValue([{ id: 1, username: "alice" }]);

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { listGroupMembers } }),
      "gitlab_list_group_members",
      {
        group_id: "my-org/platform",
        query: "ali",
        user_ids: [1, 2],
        include_inheritance: true,
        per_page: 50
      }
    );

    expect(result.isError).toBeFalsy();
    expect(listGroupMembers).toHaveBeenCalledWith("my-org/platform", {
      query: { query: "ali", per_page: 50, user_ids: [1, 2] },
      includeInheritance: true
    });
  });

  it("uses /members or /members/all on the group endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new GitLabClient("https://gitlab.example.com", "token");

    await client.listGroupMembers("my-org/platform");
    await client.listGroupMembers("42", { includeInheritance: true });

    const paths = (fetchMock.mock.calls as unknown as Array<[URL | string]>).map(
      ([url]) => new URL(String(url)).pathname
    );
    expect(paths).toEqual([
      "/api/v4/groups/my-org%2Fplatform/members",
      "/api/v4/groups/42/members/all"
    ]);
  });

  it("is group scoped", () => {
    expect(resolveToolScopeMetadata("gitlab_list_group_members")).toMatchObject({
      kind: "group",
      projectScopedMode: "deny"
    });
  });
});
