/**
 * Project iteration listing and GraphQL-backed iteration/cadence management.
 */
import { describe, expect, it, vi } from "vitest";

import { resolveToolScopeMetadata } from "../../src/tools/gitlab.js";
import { toCadenceGid, toIterationGid } from "../../src/tools/iterations.js";
import { buildContext, callToolWithContext, parseToolText } from "./_helpers.js";

type GraphqlCall = [string, Record<string, unknown>];

function graphqlCalls(executeGraphql: ReturnType<typeof vi.fn>): GraphqlCall[] {
  return executeGraphql.mock.calls as GraphqlCall[];
}

describe("iteration identifiers", () => {
  it("accepts numeric IDs and matching global IDs only", () => {
    expect(toIterationGid("12")).toBe("gid://gitlab/Iteration/12");
    expect(toIterationGid("gid://gitlab/Iteration/12")).toBe("gid://gitlab/Iteration/12");
    expect(toCadenceGid("7")).toBe("gid://gitlab/Iterations::Cadence/7");
    expect(() => toIterationGid("gid://gitlab/Issue/12")).toThrow("iteration_id");
    expect(() => toCadenceGid("abc")).toThrow("iteration_cadence_id");
  });
});

describe("iteration tools", () => {
  it("lists project iterations with search_in mapped to GitLab's in parameter", async () => {
    const get = vi.fn().mockResolvedValue([]);

    await callToolWithContext(
      buildContext({ gitlabStub: { get } }),
      "gitlab_list_project_iterations",
      {
        project_id: "group/project",
        state: "current",
        search: "Sprint",
        search_in: ["title", "cadence_title"]
      }
    );

    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/iterations", {
      query: { state: "current", search: "Sprint", in: "title,cadence_title" }
    });
  });

  it("creates an iteration in the group resolved from a numeric ID", async () => {
    const getGroup = vi.fn().mockResolvedValue({ id: 42, full_path: "my-org/platform" });
    const executeGraphql = vi.fn().mockResolvedValue({
      data: { iterationCreate: { iteration: { id: "gid://gitlab/Iteration/5" }, errors: [] } }
    });

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { getGroup, executeGraphql } }),
        "gitlab_create_group_iteration",
        {
          group_id: "42",
          title: "Sprint 1",
          start_date: "2026-11-09",
          due_date: "2026-11-22",
          iterations_cadence_id: "7"
        }
      )
    );

    expect(result).toEqual({ id: "gid://gitlab/Iteration/5" });
    expect(graphqlCalls(executeGraphql)[0]?.[1]).toEqual({
      input: {
        groupPath: "my-org/platform",
        title: "Sprint 1",
        startDate: "2026-11-09",
        dueDate: "2026-11-22",
        iterationsCadenceId: "gid://gitlab/Iterations::Cadence/7"
      }
    });
  });

  it("surfaces GraphQL mutation errors and rejects malformed dates", async () => {
    const executeGraphql = vi.fn().mockResolvedValue({
      data: { updateIteration: { iteration: null, errors: ["Due date must be after start"] } }
    });
    const context = buildContext({ gitlabStub: { executeGraphql } });

    const failed = await callToolWithContext(context, "gitlab_update_group_iteration", {
      group_id: "my-org/platform",
      iteration_id: "5",
      due_date: "2026-01-01"
    });
    const badDate = await callToolWithContext(context, "gitlab_update_group_iteration", {
      group_id: "my-org/platform",
      iteration_id: "5",
      due_date: "next friday"
    });

    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain("Due date must be after start");
    expect(badDate.isError).toBe(true);
    expect(executeGraphql).toHaveBeenCalledTimes(1);
  });

  it("refuses to delete an iteration that belongs to another group", async () => {
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({ data: { group: { iterations: { nodes: [] } } } });

    const result = await callToolWithContext(
      buildContext({ gitlabStub: { executeGraphql } }),
      "gitlab_delete_group_iteration",
      { group_id: "my-org/platform", iteration_id: "5" }
    );

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("does not belong to group");
    expect(executeGraphql).toHaveBeenCalledTimes(1);
  });

  it("deletes an iteration after confirming group ownership", async () => {
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        data: { group: { iterations: { nodes: [{ id: "gid://gitlab/Iteration/5" }] } } }
      })
      .mockResolvedValueOnce({ data: { iterationDelete: { errors: [] } } });

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { executeGraphql } }),
        "gitlab_delete_group_iteration",
        { group_id: "my-org/platform", iteration_id: "5" }
      )
    );

    expect(result).toEqual({
      status: "deleted",
      group_path: "my-org/platform",
      iteration_id: "gid://gitlab/Iteration/5"
    });
    expect(graphqlCalls(executeGraphql)[1]?.[1]).toEqual({ id: "gid://gitlab/Iteration/5" });
  });

  it("pages through iteration cadences and maps filters to GraphQL variables", async () => {
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          group: {
            iterationCadences: {
              nodes: [{ id: "gid://gitlab/Iterations::Cadence/1" }],
              pageInfo: { hasNextPage: true, endCursor: "c1" }
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          group: {
            iterationCadences: {
              nodes: [{ id: "gid://gitlab/Iterations::Cadence/2" }],
              pageInfo: { hasNextPage: false, endCursor: null }
            }
          }
        }
      });

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { executeGraphql } }),
        "gitlab_list_group_iteration_cadences",
        { group_id: "my-org/platform", active: true }
      )
    );

    expect(result).toEqual([
      { id: "gid://gitlab/Iterations::Cadence/1" },
      { id: "gid://gitlab/Iterations::Cadence/2" }
    ]);
    expect(graphqlCalls(executeGraphql).map((call) => call[1])).toEqual([
      { fullPath: "my-org/platform", active: true, after: undefined },
      { fullPath: "my-org/platform", active: true, after: "c1" }
    ]);
  });

  it("creates cadences and updates only cadences owned by the group", async () => {
    const cadence = { id: "gid://gitlab/Iterations::Cadence/3", title: "Sprints" };
    const executeGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        data: { iterationCadenceCreate: { iterationCadence: cadence, errors: [] } }
      })
      .mockResolvedValueOnce({
        data: {
          group: { iterationCadences: { nodes: [cadence], pageInfo: { hasNextPage: false } } }
        }
      })
      .mockResolvedValueOnce({
        data: { iterationCadenceUpdate: { iterationCadence: cadence, errors: [] } }
      });
    const context = buildContext({ gitlabStub: { executeGraphql } });

    await callToolWithContext(context, "gitlab_create_group_iteration_cadence", {
      group_id: "my-org/platform",
      title: "Sprints",
      automatic: true,
      active: true,
      start_date: "2026-11-09",
      duration_in_weeks: 2,
      iterations_in_advance: 2
    });
    await callToolWithContext(context, "gitlab_update_group_iteration_cadence", {
      group_id: "my-org/platform",
      iteration_cadence_id: "3",
      roll_over: true
    });

    const calls = graphqlCalls(executeGraphql);
    expect(calls[0]?.[1]).toEqual({
      input: {
        groupPath: "my-org/platform",
        title: "Sprints",
        automatic: true,
        active: true,
        startDate: "2026-11-09",
        durationInWeeks: 2,
        iterationsInAdvance: 2
      }
    });
    expect(calls[1]?.[1]).toMatchObject({ id: "gid://gitlab/Iterations::Cadence/3" });
    expect(calls[2]?.[1]).toEqual({
      input: { id: "gid://gitlab/Iterations::Cadence/3", rollOver: true }
    });
  });

  it("scopes group iteration tools to groups and project iterations to projects", () => {
    expect(resolveToolScopeMetadata("gitlab_delete_group_iteration_cadence")).toMatchObject({
      kind: "group",
      projectScopedMode: "deny"
    });
    expect(resolveToolScopeMetadata("gitlab_list_project_iterations")).toMatchObject({
      kind: "project"
    });
  });
});
