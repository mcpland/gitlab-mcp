/**
 * Pipeline test reports, variables, metadata, and deletion.
 */
import { describe, expect, it, vi } from "vitest";

import { attachPaginationMetadata } from "../../src/lib/pagination.js";
import { buildContext, callToolWithContext, parseToolText } from "./_helpers.js";

const report = {
  total_count: 3,
  failed_count: 1,
  success_count: 2,
  test_suites: [
    {
      name: "rspec",
      total_count: 2,
      suite_error: null,
      test_cases: [
        { name: "passes", status: "success" },
        { name: "breaks", status: "failed", stack_trace: "boom" }
      ]
    },
    {
      name: "jest",
      total_count: 1,
      suite_error: null,
      test_cases: [{ name: "ok", status: "success" }]
    }
  ]
};

describe("pipeline report tools", () => {
  it("returns the full test report by default", async () => {
    const get = vi.fn().mockResolvedValue(report);

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { get } }),
        "gitlab_get_pipeline_test_report",
        {
          project_id: "group/project",
          pipeline_id: 7
        }
      )
    );

    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/pipelines/7/test_report");
    expect(result).toEqual(report);
  });

  it("keeps only the requested test case statuses and their suites", async () => {
    const get = vi.fn().mockResolvedValue(report);

    const result = parseToolText(
      await callToolWithContext(
        buildContext({ gitlabStub: { get } }),
        "gitlab_get_pipeline_test_report",
        {
          project_id: "group/project",
          pipeline_id: "7",
          test_case_status: ["failed", "error"]
        }
      )
    ) as typeof report & { test_case_status_filter: string[] };

    expect(result.total_count).toBe(3);
    expect(result.test_suites).toEqual([
      {
        name: "rspec",
        total_count: 2,
        suite_error: null,
        test_cases: [{ name: "breaks", status: "failed", stack_trace: "boom" }]
      }
    ]);
    expect(result.test_case_status_filter).toEqual(["failed", "error"]);
  });

  it("reads the test report summary", async () => {
    const get = vi.fn().mockResolvedValue({ total: { count: 3 } });

    await callToolWithContext(
      buildContext({ gitlabStub: { get } }),
      "gitlab_get_pipeline_test_report_summary",
      { project_id: "group/project", pipeline_id: "7" }
    );

    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/pipelines/7/test_report_summary");
  });

  it("hides pipeline variable values unless the server and the call opt in", async () => {
    const variables = () =>
      attachPaginationMetadata(
        [{ key: "API_KEY", value: "hunter2", variable_type: "env_var", raw: false }],
        { page: 1, per_page: 20 }
      );
    const get = vi.fn().mockImplementation(async () => variables());

    const hidden = await callToolWithContext(
      buildContext({ gitlabStub: { get } }),
      "gitlab_get_pipeline_variables",
      { project_id: "group/project", pipeline_id: "7", include_value: true }
    );
    const shown = await callToolWithContext(
      buildContext({ gitlabStub: { get }, allowCiVariableValues: true }),
      "gitlab_get_pipeline_variables",
      { project_id: "group/project", pipeline_id: "7", include_value: true }
    );

    expect(parseToolText(hidden)).toEqual([
      { key: "API_KEY", variable_type: "env_var", raw: false }
    ]);
    expect(JSON.stringify(hidden)).not.toContain("hunter2");
    expect(
      (hidden.structuredContent as { meta?: { pagination?: unknown } }).meta?.pagination
    ).toMatchObject({ page: 1 });
    expect(JSON.stringify(parseToolText(shown))).toContain("hunter2");
    expect(get).toHaveBeenCalledWith("/projects/group%2Fproject/pipelines/7/variables", {
      query: {}
    });
  });

  it("renames and deletes pipelines", async () => {
    const put = vi.fn().mockResolvedValue({ id: 7, name: "Nightly" });
    const del = vi.fn().mockResolvedValue("");
    const context = buildContext({ gitlabStub: { put, delete: del } });

    await callToolWithContext(context, "gitlab_update_pipeline_metadata", {
      project_id: "group/project",
      pipeline_id: "7",
      name: "Nightly"
    });
    const deleted = parseToolText(
      await callToolWithContext(context, "gitlab_delete_pipeline", {
        project_id: "group/project",
        pipeline_id: "7"
      })
    );

    expect(put).toHaveBeenCalledWith("/projects/group%2Fproject/pipelines/7/metadata", {
      body: JSON.stringify({ name: "Nightly" }),
      headers: { "Content-Type": "application/json" }
    });
    expect(del).toHaveBeenCalledWith("/projects/group%2Fproject/pipelines/7");
    expect(deleted).toMatchObject({ status: "deleted", pipeline_id: "7" });
  });
});
