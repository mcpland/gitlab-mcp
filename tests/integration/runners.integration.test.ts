/**
 * Project runner tools.
 */
import { describe, expect, it, vi } from "vitest";

import { toolsetsForTool } from "../../src/lib/toolsets.js";
import { buildContext, callToolWithContext, parseToolText } from "./_helpers.js";

describe("runner tools", () => {
  it("lists project runners with filters", async () => {
    const get = vi.fn().mockResolvedValue([{ id: 5 }]);

    await callToolWithContext(
      buildContext({ gitlabStub: { get } }),
      "gitlab_list_project_runners",
      {
        project_id: "group/project",
        type: "group_type",
        status: "online",
        tag_list: ["docker", "linux"]
      }
    );

    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/runners", {
      query: { type: "group_type", status: "online", tag_list: "docker,linux" }
    });
  });

  it("returns a runner available to the project without its token", async () => {
    const get = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path === "/runners/5"
          ? { id: 5, tag_list: ["docker"], token: "glrt-secret", projects: [{ id: 1 }] }
          : [{ id: 4 }, { id: 5 }]
      );

    const runner = parseToolText(
      await callToolWithContext(buildContext({ gitlabStub: { get } }), "gitlab_get_runner", {
        project_id: "group/project",
        runner_id: 5
      })
    );

    expect(runner).toEqual({ id: 5, tag_list: ["docker"], projects: [{ id: 1 }] });
    expect(get).toHaveBeenNthCalledWith(1, "/projects/group%2Fproject/runners", {
      query: { per_page: 100, page: 1 }
    });
  });

  it("refuses runners the project cannot use and pages through long lists", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1000 }));
    const get = vi
      .fn()
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce([{ id: 7 }]);

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { get } }),
      "gitlab_get_runner",
      { project_id: "group/project", runner_id: "99" }
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not available to project");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).not.toHaveBeenCalledWith("/runners/99");
  });

  it("drops the runner's other projects and groups under a project allowlist", async () => {
    const get = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path === "/runners/5"
          ? { id: 5, projects: [{ id: 1 }, { id: 2 }], groups: [{ id: 3 }] }
          : [{ id: 5 }]
      );

    const runner = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { get }, allowedProjectIds: ["group/project"] }),
        "gitlab_get_runner",
        { runner_id: "5" }
      )
    );

    expect(runner).toEqual({ id: 5 });
  });

  it("rejects non-numeric runner IDs and belongs to the pipelines toolset", async () => {
    const get = vi.fn();
    const result = await callToolWithContext(
      buildContext({ gitlabStub: { get } }),
      "gitlab_get_runner",
      {
        project_id: "group/project",
        runner_id: "../users"
      }
    );

    expect(result.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(toolsetsForTool("gitlab_get_runner")).toEqual(["pipelines"]);
  });
});
