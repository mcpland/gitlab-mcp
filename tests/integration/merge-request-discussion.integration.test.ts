/**
 * Single merge request discussion lookup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GitLabClient } from "../../src/lib/gitlab-client.js";
import { toolsetsForTool } from "../../src/lib/toolsets.js";
import { buildContext, callToolWithContext, parseToolText } from "./_helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("gitlab_get_merge_request_discussion", () => {
  it("returns one discussion thread", async () => {
    const discussion = { id: "6a9c1750b37d513a43987b574953fceb50b03ce7", notes: [{ id: 1 }] };
    const getMergeRequestDiscussion = vi.fn().mockResolvedValue(discussion);

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { getMergeRequestDiscussion } }),
        "gitlab_get_merge_request_discussion",
        {
          project_id: "group/project",
          merge_request_iid: "7",
          discussion_id: discussion.id
        }
      )
    );

    expect(result).toEqual(discussion);
    expect(getMergeRequestDiscussion).toHaveBeenCalledWith("group/project", "7", discussion.id);
    expect(toolsetsForTool("gitlab_get_merge_request_discussion")).toContain("merge-requests");
  });

  it("requests the discussion endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new GitLabClient("https://gitlab.example.com", "token").getMergeRequestDiscussion(
      "group/project",
      "7",
      "abc123"
    );

    const [url] = fetchMock.mock.calls[0] as unknown as [URL | string];
    expect(new URL(String(url)).pathname).toBe(
      "/api/v4/projects/group%2Fproject/merge_requests/7/discussions/abc123"
    );
  });
});
